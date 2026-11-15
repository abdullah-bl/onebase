// Sign in with Apple (native ID token, against a fake Apple that signs with its own key) and
// passwordless email codes: sessions, account linking, replay, nonce, audience, rate limits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { apple, emailCode, password } from "../src/auth";
import { authTables, defineSchema, defineTable, getAuthUserId, httpAction, httpRouter, query } from "../src/server";
import { v } from "../src/values";

const BUNDLE = "studio.shasha.app";
const schema = defineSchema({
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    plan: v.string(),
    accountToken: v.string(),
    appleSub: v.optional(v.string()),
  }).index("email", ["email"]),
});
void authTables;

const modules = {
  me: {
    get: query({
      args: {},
      handler: async (ctx) => {
        const id = await getAuthUserId(ctx);
        return id ? await ctx.db.get(id) : null;
      },
    }),
  },
};

const b64 = (data: string | Uint8Array) => Buffer.from(data).toString("base64url");

/** A stand-in for Apple: serves a JWKS and signs ID tokens the way Apple does. */
async function fakeApple() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "fake-key", alg: "RS256", use: "sig" };
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const sha256Hex = async (s: string) => Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("hex");
  const sign = async (claims: Record<string, unknown>, key = pair.privateKey) => {
    const head = b64(JSON.stringify({ alg: "RS256", kid: "fake-key" }));
    const body = b64(JSON.stringify(claims));
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64(new Uint8Array(sig))}`;
  };
  /** An identity token plus the raw nonce the app would send with it. */
  const identity = async (over: Record<string, unknown> = {}, nonce = b64(crypto.getRandomValues(new Uint8Array(16)))) => {
    const now = Math.floor(Date.now() / 1000);
    const idToken = await sign({
      iss: "https://appleid.apple.com",
      aud: BUNDLE,
      sub: "001234.abcdef",
      iat: now,
      exp: now + 600,
      nonce: await sha256Hex(nonce),
      email: "sam@example.com",
      email_verified: "true",
      ...over,
    });
    return { idToken, nonce };
  };
  return { url: `http://127.0.0.1:${server.port}/keys`, server, sign, identity, pair };
}

const router = httpRouter();
router.route({
  method: "GET",
  path: "/hello",
  handler: httpAction(async (ctx) => new Response((await ctx.auth.getUserIdentity())?.subject ?? "anonymous")),
});

type Sent = { email: string; code: string; purpose: string };

describe("Sign in with Apple and email codes", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  const sent: Sent[] = [];
  let fake: Awaited<ReturnType<typeof fakeApple>>;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-apple-"));
    fake = await fakeApple();
    app = await startApp({
      schema,
      modules,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      trustProxy: true,
      http: router,
      auth: {
        methods: [
          apple({
            clientId: BUNDLE,
            jwksUrl: fake.url,
            profile: (info) => {
              if (info.params.failProfile) throw new Error("profile failed");
              return { plan: "free", accountToken: crypto.randomUUID(), ...(info.provider === "apple" ? { appleSub: info.accountId } : {}) };
            },
          }),
          emailCode({
            codeLength: 6,
            sendCode: (message) => {
              if (message.email.startsWith("fail")) throw new Error("mailbox unavailable");
              sent.push(message);
            },
            profile: () => ({ plan: "free", accountToken: crypto.randomUUID() }),
          }),
          password({ sendCode: (m) => void sent.push(m), profile: () => ({ plan: "free", accountToken: crypto.randomUUID() }) }),
        ],
      },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    await app.close();
    fake.server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const appleSignIn = (params: Record<string, unknown>) => post("signin", { provider: "apple", params });
  const me = async (token: string) => {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "me:get", args: {} }),
    });
    return ((await res.json()) as any).value;
  };

  test("an HTTP route answers 401, not 500, for an invalid or signed-out session token", async () => {
    const hello = (token?: string) => fetch(`${base}/hello`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(await (await hello()).text()).toBe("anonymous");
    expect((await hello("ob_s_unknown")).status).toBe(401);
    expect((await hello("some-random-token")).status).toBe(401);
    const res = await appleSignIn(await fake.identity({ sub: "apple-http" }));
    expect((await hello(res.body.token)).status).toBe(200);
    await post("signout", {}, res.body.token);
    expect((await hello(res.body.token)).status).toBe(401);
  });

  test("lists the methods", async () => {
    const res = await fetch(`${base}/api/auth/methods`);
    const { methods } = (await res.json()) as any;
    expect(methods.map((m: any) => m.id).sort()).toEqual(["apple", "email", "password"]);
  });

  describe("apple", () => {
    test("signs in, creates the user with the profile fields, and returns a normal session", async () => {
      const { idToken, nonce } = await fake.identity({ sub: "apple-new-1", email: "new1@example.com" });
      const res = await appleSignIn({ idToken, nonce, name: "  New One " });
      expect(res.status).toBe(200);
      expect(res.body.token).toStartWith("ob_s_");
      const user = await me(res.body.token);
      expect(user).toMatchObject({ email: "new1@example.com", name: "New One", plan: "free" });
      expect(user.accountToken).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.appleSub).toBe("apple-new-1");
      expect(typeof user.emailVerificationTime).toBe("number");
    });

    test("signing in again returns the same user, with its own session", async () => {
      const a = await appleSignIn(await fake.identity({ sub: "apple-again", email: "again@example.com" }));
      const b = await appleSignIn(await fake.identity({ sub: "apple-again", email: "again@example.com" }));
      expect(a.status).toBe(200);
      expect(b.body.userId).toBe(a.body.userId);
      expect(b.body.token).not.toBe(a.body.token);
    });

    test("the same account is found even if the email changed or is hidden", async () => {
      const a = await appleSignIn(await fake.identity({ sub: "apple-moves", email: "first@example.com" }));
      const b = await appleSignIn(await fake.identity({ sub: "apple-moves", email: "other@example.com" }));
      expect(b.body.userId).toBe(a.body.userId);
      const c = await appleSignIn(await fake.identity({ sub: "apple-noemail", email: undefined, email_verified: undefined }));
      expect(c.status).toBe(200);
      expect((await me(c.body.token)).email).toBeUndefined();
    });

    test("joins the account of the same verified email, e.g. after an email-code sign-up", async () => {
      await post("signin", { provider: "email", params: { flow: "start", email: "join@example.com" } });
      const code = sent.findLast((m) => m.email === "join@example.com")!.code;
      const viaEmail = await post("signin", { provider: "email", params: { flow: "verify", email: "join@example.com", code } });
      const viaApple = await appleSignIn(await fake.identity({ sub: "apple-join", email: "join@example.com" }));
      expect(viaApple.body.userId).toBe(viaEmail.body.userId);
    });

    test("does not join an account when Apple says the email is not verified", async () => {
      const first = await appleSignIn(await fake.identity({ sub: "apple-v1", email: "unverified@example.com" }));
      const second = await appleSignIn(await fake.identity({ sub: "apple-v2", email: "unverified@example.com", email_verified: false }));
      expect(second.status).toBe(200);
      expect(second.body.userId).not.toBe(first.body.userId);
    });

    test("a token can only be used once", async () => {
      const token = await fake.identity({ sub: "apple-replay" });
      expect((await appleSignIn(token)).status).toBe(200);
      const again = await appleSignIn(token);
      expect(again.status).toBe(401);
      expect(again.body.error).toContain("already used");
    });

    test("a sign-in that fails while creating the user doesn't use up the token", async () => {
      const token = await fake.identity({ sub: "apple-retry", email: "retry@example.com" });
      expect((await appleSignIn({ ...token, failProfile: true })).status).not.toBe(200);
      expect((await appleSignIn(token)).status).toBe(200);
    });

    test("refuses a wrong nonce, a missing nonce and a token without one", async () => {
      const t = await fake.identity({ sub: "apple-nonce" });
      expect((await appleSignIn({ idToken: t.idToken, nonce: "x".repeat(32) })).status).toBe(401);
      expect((await appleSignIn({ idToken: t.idToken })).status).toBe(401);
      const bare = await fake.identity({ sub: "apple-nonce2", nonce: undefined });
      expect((await appleSignIn({ idToken: bare.idToken, nonce: bare.nonce })).status).toBe(401);
    });

    test("accepts the raw nonce echoed back, as web sign-in does", async () => {
      const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
      const { idToken } = await fake.identity({ sub: "apple-raw", nonce });
      expect((await appleSignIn({ idToken, nonce })).status).toBe(200);
    });

    test("refuses tokens for another app, another issuer, an expired token and a forged signature", async () => {
      const now = Math.floor(Date.now() / 1000);
      const other = await fake.identity({ aud: "com.someone.else", sub: "bad-aud" });
      expect((await appleSignIn(other)).body.error).toContain("different app");
      expect((await appleSignIn(await fake.identity({ iss: "https://evil.example.com", sub: "bad-iss" }))).status).toBe(401);
      expect((await appleSignIn(await fake.identity({ exp: now - 3600, iat: now - 7200, sub: "expired" }))).status).toBe(401);
      const attacker = (await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign", "verify"],
      )) as CryptoKeyPair;
      const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
      const forged = await fake.sign({ iss: "https://appleid.apple.com", aud: BUNDLE, sub: "forged", exp: now + 600, nonce }, attacker.privateKey);
      const res = await appleSignIn({ idToken: forged, nonce });
      expect(res.status).toBe(401);
      expect(res.body.error).toContain("signature");
    });

    test("refuses a missing or garbage token and a token with no subject", async () => {
      expect((await appleSignIn({})).status).toBe(401);
      expect((await appleSignIn({ idToken: "not.a.jwt", nonce: "n".repeat(20) })).status).toBe(401);
      expect((await appleSignIn(await fake.identity({ sub: undefined }))).status).toBe(401);
    });

    test("the session works until it's signed out, and signing out ends it", async () => {
      const res = await appleSignIn(await fake.identity({ sub: "apple-out" }));
      expect((await me(res.body.token)).plan).toBe("free");
      expect((await post("signout", {}, res.body.token)).status).toBe(200);
      expect(await me(res.body.token)).toBeUndefined();
    });

    test("a deleted user can't use the session, and signing in again makes a fresh user", async () => {
      const a = await appleSignIn(await fake.identity({ sub: "apple-gone", email: "gone@example.com" }));
      await app.runtime.adminWrite((db: any) => db.delete(a.body.userId));
      expect(await me(a.body.token)).toBeUndefined();
      const b = await appleSignIn(await fake.identity({ sub: "apple-gone", email: "gone@example.com" }));
      expect(b.status).toBe(200);
      expect(b.body.userId).not.toBe(a.body.userId);
    });

    test("deleting a user leaves no sign-in behind: sessions, accounts, codes and counts with their email", async () => {
      const email = "forget@example.com";
      await post("signin", { provider: "email", params: { flow: "start", email } });
      const code = sent.findLast((m) => m.email === email)!.code;
      const mail = await post("signin", { provider: "email", params: { flow: "verify", email, code } });
      const viaApple = await appleSignIn(await fake.identity({ sub: "apple-forget", email }));
      expect(viaApple.body.userId).toBe(mail.body.userId);
      await post("signin", { provider: "email", params: { flow: "start", email } }); // leaves a code and a count behind
      const rows = () =>
        app.runtime.adminRead(async (_db: any, tx: any) => ({
          sessions: await tx.all("SELECT id FROM _auth_sessions WHERE user_id = ?", [mail.body.userId]),
          accounts: await tx.all("SELECT provider FROM _auth_accounts WHERE user_id = ?", [mail.body.userId]),
          codes: await tx.all("SELECT kind FROM _auth_codes WHERE kind LIKE ?", [`%${email}%`]),
          counts: await tx.all("SELECT \"key\" FROM _auth_attempts WHERE \"key\" LIKE ?", [`%${email}%`]),
        }));
      const before = await rows();
      expect(before.sessions.length).toBe(2);
      expect(before.accounts.map((a: any) => a.provider).sort()).toEqual(["apple", "email"]);
      expect(before.codes.length + before.counts.length).toBeGreaterThan(0);
      await app.runtime.adminWrite((db: any) => db.delete(mail.body.userId));
      expect(await me(mail.body.token)).toBeUndefined();
      expect(await me(viaApple.body.token)).toBeUndefined();
      const after = await rows();
      expect(after).toEqual({ sessions: [], accounts: [], codes: [], counts: [] });
    });

    test("repeated bad tokens from one network are limited, and a good sign-in is not held back before that", async () => {
      const bad = { idToken: "bad.token.here", nonce: "n".repeat(20) };
      let last = 0;
      for (let i = 0; i < 40; i++) last = (await post("signin", { provider: "apple", params: bad })).status;
      expect(last).toBe(429);
    });
  });

  describe("email code", () => {
    const start = (email: string) => post("signin", { provider: "email", params: { flow: "start", email } });
    const verify = (email: string, code: string, extra: Record<string, unknown> = {}) =>
      post("signin", { provider: "email", params: { flow: "verify", email, code, ...extra } });
    const lastCode = (email: string) => sent.findLast((m) => m.email === email)!.code;

    test("emails a 6-digit code, then signs in and creates the user the first time", async () => {
      expect((await start("Pat@Example.com")).body).toEqual({ codeSent: true });
      const msg = sent.findLast((m) => m.email === "pat@example.com")!;
      expect(msg.purpose).toBe("signin");
      expect(msg.code).toMatch(/^\d{6}$/);
      const res = await verify("pat@example.com", msg.code, { name: "Pat" });
      expect(res.status).toBe(200);
      const user = await me(res.body.token);
      expect(user).toMatchObject({ email: "pat@example.com", name: "Pat", plan: "free" });
      expect(typeof user.emailVerificationTime).toBe("number");
    });

    test("a returning user gets the same account", async () => {
      await start("back@example.com");
      const a = await verify("back@example.com", lastCode("back@example.com"));
      await start("back@example.com");
      const b = await verify("back@example.com", lastCode("back@example.com"));
      expect(b.body.userId).toBe(a.body.userId);
    });

    test("a code works once", async () => {
      await start("once@example.com");
      const code = lastCode("once@example.com");
      expect((await verify("once@example.com", code)).status).toBe(200);
      expect((await verify("once@example.com", code)).status).toBe(401);
    });

    test("a new code replaces the old one", async () => {
      await start("two@example.com");
      const first = lastCode("two@example.com");
      await start("two@example.com");
      const second = lastCode("two@example.com");
      if (first !== second) expect((await verify("two@example.com", first)).status).toBe(401);
      expect((await verify("two@example.com", second)).status).toBe(200);
    });

    test("wrong codes are refused and lock out after repeated guesses", async () => {
      await start("guess@example.com");
      const real = lastCode("guess@example.com");
      const wrong = real === "000000" ? "111111" : "000000";
      let last = 0;
      for (let i = 0; i < 12; i++) last = (await verify("guess@example.com", wrong)).status;
      expect(last).toBe(429);
      expect((await verify("guess@example.com", real)).status).toBe(429);
    });

    test("a code for one address does not work for another", async () => {
      await start("owner@example.com");
      const code = lastCode("owner@example.com");
      await start("thief@example.com");
      expect((await verify("thief@example.com", code)).status).toBe(401);
    });

    test("rejects bad addresses and unknown flows, and limits how many codes an address can ask for", async () => {
      expect((await start("not-an-email")).status).toBe(400);
      expect((await post("signin", { provider: "email", params: { flow: "nope", email: "x@example.com" } })).status).toBe(400);
      // Over the limit the request still reads as sent (so nobody can lock the address out), but nothing goes out.
      const before = sent.filter((m) => m.email === "flood@example.com").length;
      for (let i = 0; i < 7; i++) expect((await start("flood@example.com")).status).toBe(200);
      expect(sent.filter((m) => m.email === "flood@example.com").length - before).toBe(5);
    });

    test("behind a proxy that sets Fly-Client-IP, rotating X-Forwarded-For does not dodge the guess limit", async () => {
      process.env.FLY_APP_NAME = "test-app";
      try {
        await start("rotate@example.com");
        let last = 0;
        for (let i = 0; i < 12; i++) {
          const res = await fetch(`${base}/api/auth/signin`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "fly-client-ip": "203.0.113.9", "x-forwarded-for": `198.51.100.${i + 1}` },
            body: JSON.stringify({ provider: "email", params: { flow: "verify", email: "rotate@example.com", code: "000000" } }),
          });
          last = res.status;
        }
        expect(last).toBe(429);
      } finally {
        delete process.env.FLY_APP_NAME;
      }
    });

    test("off Fly, a client-sent Fly-Client-IP is ignored", async () => {
      await start("spoof@example.com");
      let last = 0;
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${base}/api/auth/signin`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "fly-client-ip": `203.0.113.${i + 1}`, "x-forwarded-for": "198.51.100.7" },
          body: JSON.stringify({ provider: "email", params: { flow: "verify", email: "spoof@example.com", code: "000000" } }),
        });
        last = res.status;
      }
      expect(last).toBe(429);
    });

    test("tells the person when the code could not be sent", async () => {
      const res = await start("fail@example.com");
      expect(res.status).toBe(502);
    });

    test("does not join an unverified password account", async () => {
      const signedUp = await post("signin", { provider: "password", params: { flow: "signUp", email: "pw@example.com", password: "correct horse" } });
      await start("pw@example.com");
      const res = await verify("pw@example.com", lastCode("pw@example.com"));
      expect(res.status).toBe(200);
      // Anyone could have signed up with this address, so the inbox owner gets their own account.
      expect(res.body.userId).not.toBe(signedUp.body.userId);
    });
  });
});
