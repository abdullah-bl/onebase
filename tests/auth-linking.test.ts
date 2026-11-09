// One verified user per email address: a confirmed password sign-up joins the user who already
// proved the inbox, a reset doesn't make a second verified user, and the lookup isn't fooled by
// unverified users with the same address. Profile hooks never see passwords or codes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { emailCode, password } from "../src/auth";
import { authTables, defineSchema } from "../src/server";

type Sent = { email: string; code: string; purpose: string };

describe("account linking by email", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dir: string;
  let base: string;
  const sent: Sent[] = [];
  const profileSaw: Record<string, unknown>[] = [];
  const codeFor = async (email: string, purpose: string) => {
    for (let i = 0; i < 50; i++) {
      const found = sent.findLast((m) => m.email === email && m.purpose === purpose);
      if (found) return found.code;
      await Bun.sleep(20);
    }
    throw new Error(`no ${purpose} code for ${email}`);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-linking-"));
    app = await startApp({
      schema: defineSchema({ ...authTables }),
      modules: {},
      dataDir: dir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      auth: {
        methods: [
          emailCode({
            sendCode: (m) => void sent.push(m),
            profile: (info) => {
              profileSaw.push(info.params);
              return {};
            },
          }),
          password({
            verifyEmail: true,
            sendCode: (m) => void sent.push(m),
            profile: (params) => {
              profileSaw.push(params);
              return {};
            },
          }),
        ],
      },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = async (provider: string, params: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/auth/signin`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider, params }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const users = (email: string) => app.runtime.adminRead(async (db) => (await db.query("users").collect()).filter((u: any) => u.email === email));
  const emailSignIn = async (email: string) => {
    await post("email", { flow: "start", email });
    return post("email", { flow: "verify", email, code: await codeFor(email, "signin") });
  };

  test("a confirmed password sign-up joins the user who signed in with an email code", async () => {
    const first = await emailSignIn("one@example.com");
    expect(first.status).toBe(200);
    expect((await post("password", { flow: "signUp", email: "one@example.com", password: "correct horse" })).body.codeSent).toBe(true);
    const confirmed = await post("password", { flow: "email-verification", email: "one@example.com", code: await codeFor("one@example.com", "verify"), password: "correct horse" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.userId).toBe(first.body.userId);
    expect((await users("one@example.com")).map((u: any) => u._id)).toEqual([first.body.userId]);
    // From now on the password signs in to that same user.
    const again = await post("password", { flow: "signIn", email: "one@example.com", password: "correct horse" });
    expect(again.body.userId).toBe(first.body.userId);
  });

  test("a password reset doesn't make a second verified user for the address", async () => {
    const owner = await emailSignIn("two@example.com");
    await post("password", { flow: "signUp", email: "two@example.com", password: "correct horse" }); // left unconfirmed
    await post("password", { flow: "reset", email: "two@example.com" });
    const reset = await post("password", { flow: "reset-verification", email: "two@example.com", code: await codeFor("two@example.com", "reset"), newPassword: "battery staple" });
    expect(reset.status).toBe(200);
    const verified = (await users("two@example.com")).filter((u: any) => typeof u.emailVerificationTime === "number");
    expect(verified.map((u: any) => u._id)).toEqual([owner.body.userId]);
  });

  test("many unverified users with the address don't hide the verified one", async () => {
    await app.runtime.authWrite(async ({ db }) => {
      for (let i = 0; i < 25; i++) await db.insert("users", { email: "crowd@example.com" });
    });
    const owner = await emailSignIn("crowd@example.com");
    await post("password", { flow: "signUp", email: "crowd@example.com", password: "correct horse" });
    const confirmed = await post("password", { flow: "email-verification", email: "crowd@example.com", code: await codeFor("crowd@example.com", "verify"), password: "correct horse" });
    expect(confirmed.body.userId).toBe(owner.body.userId);
  });

  test("profile hooks never see the password or the code", async () => {
    await post("password", { flow: "signUp", email: "three@example.com", password: "correct horse", name: "Three" });
    await emailSignIn("four@example.com");
    for (const params of profileSaw) {
      expect(params).not.toHaveProperty("password");
      expect(params).not.toHaveProperty("code");
    }
    expect(profileSaw.some((p) => p.name === "Three")).toBe(true);
  });
});
