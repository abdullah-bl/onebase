// Built-in auth: password sign-up/sign-in, sessions, OAuth (against a fake provider), the
// client API, and authenticate(token, ctx) reading the database.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { emailCode, oauth, password } from "../src/auth";
import { OnebaseClient, type AuthStorage } from "../src/client/index";
import { AuthService, sha256 } from "../src/engine/auth";
import { createDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { action, authTables, defineSchema, defineTable, getAuthUserId, mutation, query } from "../src/server";
import { OneBaseError, v } from "../src/values";
import { quiet } from "./helpers";

const schema = defineSchema({
  ...authTables,
  apiKeys: defineTable({ key: v.string(), owner: v.string() }).index("by_key", ["key"]),
});

const modules = {
  auth: {
    me: query({
      args: {},
      handler: async (ctx) => {
        const identity = await ctx.auth.getUserIdentity();
        if (!identity) return null;
        return { userId: await getAuthUserId(ctx), subject: identity.subject, email: identity.email ?? null, name: identity.name ?? null };
      },
    }),
    whoami: query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null }),
    addKey: mutation({ args: { key: v.string(), owner: v.string() }, handler: (ctx, args) => ctx.db.insert("apiKeys", args) }),
    deleteUser: mutation({ args: { id: v.id("users") }, handler: (ctx, { id }) => ctx.db.delete(id) }),
    // What an app builds on ctx.auth: changing your own password, an admin's reset, disabling an account.
    createUser: mutation({ args: { email: v.optional(v.string()), name: v.optional(v.string()) }, handler: (ctx, args) => ctx.db.insert("users", args) }),
    changePassword: action({
      args: { current: v.string(), next: v.string() },
      handler: async (ctx, { current, next }) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) throw new OneBaseError("Sign in first.");
        if (!(await ctx.auth.verifyPassword(userId, current))) throw new OneBaseError("That isn't your current password.");
        await ctx.auth.setPassword(userId, next);
        return "changed";
      },
    }),
    adminSetPassword: action({ args: { id: v.string(), password: v.string() }, handler: (ctx, { id, password }) => ctx.auth.setPassword(id as any, password) }),
    checkPassword: action({ args: { id: v.id("users"), password: v.string() }, handler: (ctx, { id, password }) => ctx.auth.verifyPassword(id, password) }),
    signOutEverywhere: action({ args: { id: v.id("users") }, handler: (ctx, { id }) => ctx.auth.endSessions(id) }),
    disable: mutation({
      args: { id: v.id("users"), fail: v.optional(v.boolean()) },
      handler: async (ctx, { id, fail }) => {
        await ctx.db.patch(id, { name: "disabled" });
        await ctx.auth.endSessions(id);
        if (fail) throw new OneBaseError("changed my mind");
      },
    }),
    disableNested: mutation({
      args: { id: v.id("users") },
      handler: async (ctx, { id }) => {
        await ctx.runMutation("auth:disable" as any, { id, fail: true }).catch(() => {});
        return "kept";
      },
    }),
    hashInMutation: mutation({ args: { id: v.id("users") }, handler: (ctx, { id }) => (ctx.auth as any).setPassword(id, "whatever else") }),
  },
};

/** A stand-in OAuth provider: the test issues codes, the server exchanges them and reads the profile. */
function fakeProvider() {
  const codes = new Map<string, { profile: Record<string, unknown>; challenge: string }>();
  const tokens = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        const code = form.get("code") ?? "";
        const entry = codes.get(code);
        codes.delete(code);
        const pkceOk = entry && sha256(form.get("code_verifier") ?? "") === entry.challenge;
        if (!entry || !pkceOk || form.get("client_secret") !== "fake-secret") return Response.json({ error: "invalid_grant" }, { status: 400 });
        const accessToken = crypto.randomUUID();
        tokens.set(accessToken, entry.profile);
        return Response.json({ access_token: accessToken, token_type: "bearer" });
      }
      if (url.pathname === "/userinfo") {
        const profile = tokens.get(req.headers.get("Authorization")?.slice(7) ?? "");
        return profile ? Response.json(profile) : new Response("unauthorized", { status: 401 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return { url, server, issue: (code: string, profile: Record<string, unknown>, challenge: string) => codes.set(code, { profile, challenge }) };
}

/** In-memory stand-in for localStorage. */
function memoryStorage(): AuthStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const DATABASES: { name: string; url?: string }[] = [
  { name: "sqlite" },
  ...(process.env.TEST_POSTGRES_URL ? [{ name: "postgres", url: process.env.TEST_POSTGRES_URL }] : []),
  ...(process.env.TEST_LIBSQL_URL ? [{ name: "libsql", url: process.env.TEST_LIBSQL_URL }] : []),
];

const SYSTEM_TABLES = ["documents", "_meta", "_auth_accounts", "_auth_sessions", "_auth_codes", "_auth_attempts"];

type SentCode = { email: string; code: string; purpose: "verify" | "reset" };

/** sendCode for tests: records codes instead of emailing them; addresses starting with "fail" can't be reached. */
function codeInbox() {
  const sent: SentCode[] = [];
  const sendCode = (message: SentCode) => {
    if (message.email.startsWith("fail")) throw new Error("mailbox unavailable");
    sent.push(message);
  };
  /** The newest code for an address (reset codes are sent in the background, so wait a little). */
  const codeFor = async (email: string, purpose: SentCode["purpose"]) => {
    for (let i = 0; i < 50; i++) {
      const found = sent.findLast((m) => m.email === email && m.purpose === purpose);
      if (found) return found.code;
      await Bun.sleep(20);
    }
    throw new Error(`no ${purpose} code was sent to ${email}`);
  };
  return { sent, sendCode, codeFor };
}

const postTo = async (base: string, path: string, body: unknown, token?: string) => {
  const res = await fetch(`${base}/api/auth/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};

for (const DB of DATABASES) describe(`${DB.name}: built-in auth`, () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  const fake = fakeProvider();
  const inbox = codeInbox();
  const fakeMethod = () =>
    oauth({
      id: "fake",
      name: "Fake",
      clientId: "fake-client",
      clientSecret: "fake-secret",
      authorizationUrl: `${fake.url}/authorize`,
      tokenUrl: `${fake.url}/token`,
      scopes: ["email"],
      profile: async ({ access_token }) => (await fetch(`${fake.url}/userinfo`, { headers: { Authorization: `Bearer ${access_token}` } })).json() as any,
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-auth-"));
    if (DB.url) {
      const driver = createDriver(DB.url);
      await driver.init();
      await driver.write(async (tx) => {
        for (const t of SYSTEM_TABLES) await tx.run(`DELETE FROM ${t}`).catch(() => {});
      });
      await driver.close();
    }
    app = await startApp({
      schema,
      modules,
      db: DB.url,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      auth: {
        methods: [password({ sendCode: inbox.sendCode }), fakeMethod()],
        redirects: ["https://app.example.com"],
        authenticate: async (token, ctx) => {
          const key = await ctx.db.query("apiKeys").withIndex("by_key", (q: any) => q.eq("key", token)).unique();
          return key ? { subject: key.owner, tokenIdentifier: `apikey|${key._id}` } : null;
        },
      },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    await app.close();
    fake.server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, token?: string) => postTo(base, path, body, token);
  const signUp = (email: string, pw = "correct horse", extra: Record<string, unknown> = {}) =>
    post("signin", { provider: "password", params: { flow: "signUp", email, password: pw, ...extra } });
  const signIn = (email: string, pw: string) => post("signin", { provider: "password", params: { flow: "signIn", email, password: pw } });
  /** Calls a query over HTTP as the holder of `token`. */
  const ask = async (fn: string, token?: string) => {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path: fn, args: {} }),
    });
    const body = (await res.json()) as any;
    return body.status === "success" ? body.value : { error: body.errorMessage as string };
  };
  /** Calls a mutation or action over HTTP as the holder of `token`. */
  const run = async (kind: "mutation" | "action", fn: string, args: Record<string, unknown>, token?: string) => {
    const res = await fetch(`${base}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ path: fn, args }),
    });
    const body = (await res.json()) as any;
    return body.status === "success" ? body.value : { error: body.errorMessage as string };
  };
  const verifierPair = () => {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    return { verifier, challenge: sha256(verifier) };
  };
  /** Runs the OAuth dance up to the provider sending the browser back to the app. */
  const oauthRoundTrip = async (profile: Record<string, unknown>, redirectTo = "https://app.example.com/after") => {
    const { verifier, challenge } = verifierPair();
    const start = await post("signin", { provider: "fake", redirectTo, challenge });
    expect(start.status).toBe(200);
    const authorize = new URL(start.body.redirect);
    const code = crypto.randomUUID();
    fake.issue(code, profile, authorize.searchParams.get("code_challenge")!);
    const state = authorize.searchParams.get("state")!;
    const callback = await fetch(`${base}/api/auth/callback/fake?code=${code}&state=${state}`, { redirect: "manual" });
    return { verifier, authorize, state, callback, back: new URL(callback.headers.get("Location") ?? "about:blank") };
  };
  const oauthSignIn = async (profile: Record<string, unknown>) => {
    const { back, verifier } = await oauthRoundTrip(profile);
    const done = await post("signin", { code: back.searchParams.get("onebase_code"), verifier });
    expect(done.status).toBe(200);
    return done.body as { token: string; userId: string };
  };
  const passwordFlow = (flow: string, params: Record<string, unknown>) => post("signin", { provider: "password", params: { flow, ...params } });

  test("password sign-up and sign-in; functions see the user", async () => {
    const created = await signUp("Ann@Example.com", "correct horse", { name: " Ann " });
    expect(created.status).toBe(200);
    expect(created.body.token).toStartWith("ob_s_");
    expect(await ask("auth:me", created.body.token)).toEqual({ userId: created.body.userId, subject: created.body.userId, email: "ann@example.com", name: "Ann" });
    expect(await app.runtime.adminRead((db) => db.get(created.body.userId))).toMatchObject({ email: "ann@example.com", name: "Ann" });

    // Sign-up never says an account exists: the right password signs in (the reply a new address
    // gets), a wrong one fails exactly like sign-in does.
    const retaken = await signUp("ann@example.com");
    expect(retaken.status).toBe(200);
    expect(retaken.body.userId).toBe(created.body.userId);
    expect(retaken.body.token).toStartWith("ob_s_");
    expect(await signUp("ann@example.com", "wrong password")).toMatchObject({ status: 401, body: { error: "Invalid email or password." } });
    expect(await signUp("new@example.com", "short")).toMatchObject({ status: 400, body: { error: "Use a password with at least 8 characters." } });
    expect(await signUp("not-an-email")).toMatchObject({ status: 400 });
    expect(await signIn("ann@example.com", "wrong password")).toMatchObject({ status: 401, body: { error: "Invalid email or password." } });
    expect(await signIn("nobody@example.com", "whatever1")).toMatchObject({ status: 401, body: { error: "Invalid email or password." } });

    const again = await signIn(" ANN@example.com", "correct horse");
    expect(again.status).toBe(200);
    expect(again.body.userId).toBe(created.body.userId);
    expect(await ask("auth:whoami", again.body.token)).toBe(created.body.userId);
    expect(await ask("auth:whoami", created.body.token)).toBe(created.body.userId); // both sessions work
  });

  test("checking an email address takes the same short time whatever is sent", async () => {
    expect(await signUp("a@b.c")).toMatchObject({ status: 200 });
    for (const email of ["a@b", "a@.b", "a@b..c", "a@b.c.", `${"x".repeat(250)}@b.co`]) {
      expect(await signIn(email, "whatever1")).toMatchObject({ status: 400, body: { error: "Enter a valid email address." } });
    }
    // Used to backtrack quadratically: about a second of blocked event loop for 32k dots.
    const started = performance.now();
    expect(await signIn(`a@${".".repeat(32_000)}@`, "x")).toMatchObject({ status: 400 });
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("repeated failed sign-ins for an email are locked out for a while", async () => {
    await signUp("locked@example.com");
    for (let i = 0; i < 10; i++) expect((await signIn("locked@example.com", "nope nope")).status).toBe(401);
    const blocked = await signIn("locked@example.com", "correct horse");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toContain("Too many failed sign-in attempts");
  });

  test("parallel wrong passwords can't get past the lockout", async () => {
    await signUp("burst@example.com");
    const statuses = await Promise.all(Array.from({ length: 30 }, () => signIn("burst@example.com", "nope nope").then((r) => r.status)));
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20);
  });

  test("signing out ends that session; everywhere ends all of them", async () => {
    const { userId } = (await signUp("multi@example.com")).body;
    const t1 = (await signIn("multi@example.com", "correct horse")).body.token;
    const t2 = (await signIn("multi@example.com", "correct horse")).body.token;
    const t3 = (await signIn("multi@example.com", "correct horse")).body.token;
    expect((await post("signout", {}, t1)).status).toBe(200);
    expect((await ask("auth:whoami", t1)).error).toContain("session has expired or you were signed out");
    expect(await ask("auth:whoami", t2)).toBe(userId);
    expect((await post("signout", { everywhere: true }, t2)).status).toBe(200);
    expect((await ask("auth:whoami", t3)).error).toContain("signed out");
    expect((await post("signout", {})).status).toBe(401); // needs the token
  });

  test("ctx.auth: changing your own password checks the current one, keeps this session and ends the others", async () => {
    const { userId, token: here } = (await signUp("changer@example.com")).body;
    const elsewhere = (await signIn("changer@example.com", "correct horse")).body.token;
    expect(await run("action", "auth:changePassword", { current: "not this one", next: "battery staple" }, here)).toEqual({ error: "That isn't your current password." });
    expect(await run("action", "auth:changePassword", { current: "correct horse", next: "short" }, here)).toEqual({ error: "Use a password with at least 8 characters." });
    expect((await signIn("changer@example.com", "correct horse")).status).toBe(200); // nothing changed yet
    expect(await run("action", "auth:changePassword", { current: "correct horse", next: "battery staple" }, here)).toBe("changed");

    expect(await ask("auth:whoami", here)).toBe(userId); // still signed in where the password was changed
    expect((await ask("auth:whoami", elsewhere)).error).toContain("signed out");
    expect((await signIn("changer@example.com", "correct horse")).status).toBe(401);
    expect((await signIn("changer@example.com", "battery staple")).body.userId).toBe(userId);
    expect(await run("action", "auth:changePassword", { current: "x", next: "battery staple" })).toEqual({ error: "Sign in first." });
  });

  test("ctx.auth.setPassword: an admin's reset ends every session and the lockout; users made by code get a password", async () => {
    const { userId, token } = (await signUp("forgetful@example.com")).body;
    for (let i = 0; i < 11; i++) await signIn("forgetful@example.com", "nope nope");
    expect((await signIn("forgetful@example.com", "correct horse")).status).toBe(429);
    expect(await run("action", "auth:adminSetPassword", { id: userId, password: "temporary one" })).toBeNull();
    expect((await ask("auth:whoami", token)).error).toContain("signed out"); // nobody asked as this user, so no session is kept
    expect((await signIn("forgetful@example.com", "correct horse")).status).toBe(401);
    expect((await signIn("forgetful@example.com", "temporary one")).body.userId).toBe(userId);

    // A user your own code created has no password until one is set; then they sign in with their email.
    const made = await run("mutation", "auth:createUser", { email: "Hired@Example.com", name: "Hired" });
    expect(await run("action", "auth:checkPassword", { id: made, password: "first password" })).toBe(false);
    expect(await run("action", "auth:adminSetPassword", { id: made, password: "first password" })).toBeNull();
    expect((await signIn("hired@example.com", "first password")).body.userId).toBe(made);
    expect(await run("action", "auth:checkPassword", { id: made, password: "first password" })).toBe(true);

    const noEmail = await run("mutation", "auth:createUser", { name: "No email" });
    expect((await run("action", "auth:adminSetPassword", { id: noEmail, password: "first password" })).error).toContain("no email address to sign in with");
    const twin = await run("mutation", "auth:createUser", { email: "hired@example.com" });
    expect((await run("action", "auth:adminSetPassword", { id: twin, password: "first password" })).error).toContain("another user already signs in with hired@example.com");
    const key = await app.runtime.runMutation("auth:addKey", { key: "not-a-user", owner: "x" });
    expect((await run("action", "auth:adminSetPassword", { id: key, password: "first password" })).error).toContain("no user with that id");
    expect((await run("mutation", "auth:hashInMutation", { id: made })).error).toContain("Call it from an action");
  });

  test("ctx.auth.verifyPassword: wrong answers are counted per user, and a right one starts the count again", async () => {
    const { userId } = (await signUp("guessed@example.com")).body;
    const check = (password: string) => run("action", "auth:checkPassword", { id: userId, password });
    for (let i = 0; i < 9; i++) expect(await check("nope nope")).toBe(false);
    expect(await check("correct horse")).toBe(true);
    for (let i = 0; i < 10; i++) expect(await check("nope nope")).toBe(false);
    expect((await check("correct horse")).error).toContain("Too many wrong passwords");
    expect((await signIn("guessed@example.com", "correct horse")).status).toBe(200); // sign-in keeps its own count
    await app.runtime.runAction("auth:adminSetPassword", { id: userId, password: "brand new one" });
    expect(await check("brand new one")).toBe(true); // a new password is a fresh start
  });

  test("ctx.auth.endSessions signs a user out everywhere, with the mutation's other writes or not at all", async () => {
    const { userId, token: t1 } = (await signUp("leaver@example.com")).body;
    const t2 = (await signIn("leaver@example.com", "correct horse")).body.token;
    const storage = memoryStorage();
    const client = new OnebaseClient(base, { authStorage: storage });
    await client.signIn("password", { flow: "signIn", email: "leaver@example.com", password: "correct horse" });
    const seen: (string | null)[] = [];
    client.onUpdate("auth:whoami", {}, (v) => seen.push(v));
    for (let i = 0; i < 100 && seen.at(-1) !== userId; i++) await Bun.sleep(20);

    // A mutation that fails, on its own or inside another that carries on, signs nobody out.
    expect(await run("mutation", "auth:disable", { id: userId, fail: true })).toEqual({ error: "changed my mind" });
    expect(await run("mutation", "auth:disableNested", { id: userId })).toBe("kept");
    await Bun.sleep(100);
    expect(await ask("auth:whoami", t1)).toBe(userId);
    expect(seen.at(-1)).toBe(userId);
    expect(client.authState.isAuthenticated).toBe(true);

    expect(await run("mutation", "auth:disable", { id: userId })).toBeNull();
    expect((await ask("auth:whoami", t1)).error).toContain("signed out");
    expect((await ask("auth:whoami", t2)).error).toContain("signed out");
    for (let i = 0; i < 100 && seen.at(-1) !== null; i++) await Bun.sleep(20);
    expect(seen.at(-1)).toBeNull(); // the open connection was signed out at once
    expect(client.authState.isAuthenticated).toBe(false);
    client.close();

    // From an action too; the password still works, so it's for the app to refuse a disabled user.
    const t3 = (await signIn("leaver@example.com", "correct horse")).body.token;
    expect(await run("action", "auth:signOutEverywhere", { id: userId })).toBeNull();
    expect((await ask("auth:whoami", t3)).error).toContain("signed out");
  });

  test("sessions expire, and end with their user", async () => {
    const { token, userId } = (await signUp("short-lived@example.com")).body;
    await app.runtime.withWriter((tx) => tx.run("UPDATE _auth_sessions SET expires = ? WHERE user_id = ?", [Date.now() - 1, userId]));
    expect((await ask("auth:whoami", token)).error).toContain("expired");

    const other = (await signUp("deleted@example.com")).body;
    await app.runtime.runMutation("auth:deleteUser", { id: other.userId });
    expect((await ask("auth:whoami", other.token)).error).toContain("signed out");
    expect((await signUp("deleted@example.com")).status).toBe(200); // the email is free again
  });

  test("authenticate(token, ctx) can look tokens up in the database", async () => {
    await app.runtime.runMutation("auth:addKey", { key: "key-123", owner: "service-a" });
    expect(await ask("auth:me", "key-123")).toEqual({ userId: null, subject: "service-a", email: null, name: null });
    expect(await ask("auth:whoami", "unknown-key")).toBeNull();
  });

  test("OAuth: sign in, come back with a one-time code, redeem it with this browser's verifier", async () => {
    const { authorize, callback, back, verifier } = await oauthRoundTrip({ id: "gh-1", email: "Bob@Example.com", emailVerified: true, name: "Bob" });
    expect(authorize.origin + authorize.pathname).toBe(`${fake.url}/authorize`);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/api/auth/callback/fake`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(callback.status).toBe(302);
    expect(back.origin + back.pathname).toBe("https://app.example.com/after");
    const code = back.searchParams.get("onebase_code")!;

    expect(await post("signin", { code, verifier: "someone-else" })).toMatchObject({ status: 401, body: { error: expect.stringContaining("different browser") } });
    const first = await oauthSignIn({ id: "gh-1", email: "bob@example.com", emailVerified: true, name: "Bob" });
    expect(await ask("auth:me", first.token)).toMatchObject({ userId: first.userId, email: "bob@example.com", name: "Bob" });
    expect(await post("signin", { code, verifier })).toMatchObject({ status: 401 }); // each code works once
    const user = await app.runtime.adminRead((db) => db.get(first.userId));
    expect(typeof user?.emailVerificationTime).toBe("number");

    // The same account signs in to the same user; another account with the same verified email joins it.
    expect((await oauthSignIn({ id: "gh-1", email: "bob@example.com", emailVerified: true })).userId).toBe(first.userId);
    expect((await oauthSignIn({ id: "gh-2", email: "BOB@example.com", emailVerified: true })).userId).toBe(first.userId);
  });

  test("OAuth never joins an account through an unverified email", async () => {
    const password = (await signUp("carol@example.com")).body.userId; // nobody verified this email
    const viaOAuth = await oauthSignIn({ id: "gh-carol", email: "carol@example.com", emailVerified: true });
    expect(viaOAuth.userId).not.toBe(password);
    const unverified = await oauthSignIn({ id: "gh-dave", email: "dave@example.com", emailVerified: false });
    expect((await oauthSignIn({ id: "gh-dave-2", email: "dave@example.com", emailVerified: true })).userId).not.toBe(unverified.userId);
  });

  test("OAuth refuses unknown return URLs, replayed states and provider errors", async () => {
    const { challenge } = verifierPair();
    const evil = await post("signin", { provider: "fake", redirectTo: "https://evil.example/steal", challenge });
    expect(evil).toMatchObject({ status: 400, body: { error: expect.stringContaining("isn't allowed") } });
    expect((await post("signin", { provider: "fake", redirectTo: "https://app.example.com/" })).status).toBe(400); // no challenge
    expect((await post("signin", { provider: "nope", params: {} })).body.error).toContain("Enabled: password, fake");

    const { state } = await oauthRoundTrip({ id: "gh-replay" });
    const replay = await fetch(`${base}/api/auth/callback/fake?code=x&state=${state}`, { redirect: "manual" });
    expect(replay.status).toBe(400);

    const start = await post("signin", { provider: "fake", redirectTo: "https://app.example.com/x", challenge });
    const denied = await fetch(`${base}/api/auth/callback/fake?error=access_denied&state=${new URL(start.body.redirect).searchParams.get("state")}`, {
      redirect: "manual",
    });
    expect(new URL(denied.headers.get("Location")!).searchParams.get("auth_error")).toBe("access_denied");

    // Allowed URLs are compared parsed, never as text prefixes, however they're written.
    const auth = app.runtime.auth as any;
    const saved = auth.redirects;
    auth.redirects = ["https://App.example.com", "https://other.example.com:443", "https://third.example.com/app/"];
    try {
      for (const ok of ["https://app.example.com/x", "https://other.example.com/y", "https://third.example.com/app", "https://third.example.com/app/z?q=1"]) {
        expect(auth.redirectAllowed(ok, null)).toBe(true);
      }
      for (const bad of ["https://App.example.com.evil.test/x", "https://other.example.com:4433/y", "https://third.example.com/appx", "https://third.example.com/"]) {
        expect(auth.redirectAllowed(bad, null)).toBe(false);
      }
    } finally {
      auth.redirects = saved;
    }
  });

  test("password reset: an emailed code, a new password, and every old session ends", async () => {
    const { token: oldToken, userId } = (await signUp("reset@example.com")).body;
    expect(await passwordFlow("reset", { email: "Reset@Example.com" })).toEqual({ status: 200, body: { codeSent: true } });
    const code = await inbox.codeFor("reset@example.com", "reset");
    expect(code).toMatch(/^\d{8}$/);
    const reset = (params: Record<string, unknown>) => passwordFlow("reset-verification", { email: "reset@example.com", ...params });

    expect((await reset({ code: code === "12345678" ? "87654321" : "12345678", newPassword: "brand new pass" })).status).toBe(401);
    expect(await reset({ code, newPassword: "short" })).toMatchObject({ status: 400, body: { error: "Use a password with at least 8 characters." } });
    const done = await reset({ code: ` ${code.slice(0, 4)} ${code.slice(4)} `, newPassword: "brand new pass" }); // spaces are fine
    expect(done).toMatchObject({ status: 200, body: { userId } });
    expect((await ask("auth:whoami", oldToken)).error).toContain("signed out");
    expect((await signIn("reset@example.com", "correct horse")).status).toBe(401);
    expect((await signIn("reset@example.com", "brand new pass")).status).toBe(200);
    expect((await reset({ code, newPassword: "another pass!" })).status).toBe(401); // each code works once
    expect(typeof (await app.runtime.adminRead((db) => db.get(userId)))?.emailVerificationTime).toBe("number");
  });

  test("reset requests look the same for unknown emails, and codes per email are limited", async () => {
    for (let i = 0; i < 5; i++) expect(await passwordFlow("reset", { email: "ghost@example.com" })).toEqual({ status: 200, body: { codeSent: true } });
    // Over the limit the answer doesn't change (a refusal would let anyone lock the address out); nothing is sent.
    expect(await passwordFlow("reset", { email: "ghost@example.com" })).toEqual({ status: 200, body: { codeSent: true } });
    await Bun.sleep(50);
    expect(inbox.sent.some((m) => m.email === "ghost@example.com")).toBe(false);
  });

  test("wrong codes are locked out like wrong passwords", async () => {
    await signUp("guess@example.com");
    await passwordFlow("reset", { email: "guess@example.com" });
    const code = await inbox.codeFor("guess@example.com", "reset");
    const wrong = code === "00000000" ? "11111111" : "00000000";
    for (let i = 0; i < 10; i++) {
      expect((await passwordFlow("reset-verification", { email: "guess@example.com", code: wrong, newPassword: "brand new pass" })).status).toBe(401);
    }
    const blocked = await passwordFlow("reset-verification", { email: "guess@example.com", code, newPassword: "brand new pass" });
    expect(blocked).toMatchObject({ status: 429, body: { error: expect.stringContaining("Too many wrong codes") } });
  });

  test("expired sessions, codes and attempts are tidied as auth writes happen", async () => {
    const chance = AuthService.cleanupChance;
    AuthService.cleanupChance = 1; // normally each write tidies with a small chance
    try {
      await app.runtime.withWriter(async (tx) => {
        await tx.run("INSERT INTO _auth_sessions (id, token_hash, user_id, created, expires, last_used) VALUES ('tidy1', 'tidy-hash', 'tidy-user', 0, 1, 0)");
        await tx.run("INSERT INTO _auth_codes (code_hash, kind, data, expires) VALUES ('tidy2', 'k', '{}', 1)");
        await tx.run("INSERT INTO _auth_attempts (key, count, window_start) VALUES ('tidy3', 5, 1)");
      });
      await signIn("tidy@example.com", "nope nope"); // any auth write will do
      const left = await app.runtime.adminRead((_db, tx) =>
        tx.get(
          "SELECT (SELECT COUNT(*) FROM _auth_sessions WHERE id = 'tidy1') + (SELECT COUNT(*) FROM _auth_codes WHERE code_hash = 'tidy2') + (SELECT COUNT(*) FROM _auth_attempts WHERE key = 'tidy3') AS n",
        ),
      );
      expect(Number(left?.n)).toBe(0);
    } finally {
      AuthService.cleanupChance = chance;
    }
  });

  describe("with verifyEmail", () => {
    let app2: Awaited<ReturnType<typeof startApp>>;
    let dataDir2: string;
    let base2: string;
    const post2 = (path: string, body: unknown, token?: string) => postTo(base2, path, body, token);
    const flow2 = (flow: string, params: Record<string, unknown>) => post2("signin", { provider: "password", params: { flow, ...params } });

    beforeAll(async () => {
      dataDir2 = mkdtempSync(join(tmpdir(), "onebase-auth-verify-"));
      app2 = await startApp({
        schema,
        modules,
        db: DB.url,
        dataDir: dataDir2,
        port: 0,
        hostname: "127.0.0.1",
        dev: false,
        quiet: true,
        auth: { methods: [password({ sendCode: inbox.sendCode, verifyEmail: true }), fakeMethod()], redirects: ["https://app.example.com"] },
      });
      base2 = `http://127.0.0.1:${app2.server.port}`;
    });
    afterAll(async () => {
      await app2.close();
      rmSync(dataDir2, { recursive: true, force: true });
    });

    test("new accounts confirm their email with a code before they get a session", async () => {
      expect(await flow2("signUp", { email: "verify@example.com", password: "correct horse" })).toEqual({ status: 200, body: { codeSent: true } });
      const first = await inbox.codeFor("verify@example.com", "verify");
      // Signing in before confirming sends a fresh code instead of a session.
      expect((await flow2("signIn", { email: "verify@example.com", password: "correct horse" })).body).toEqual({ codeSent: true });
      expect((await flow2("signIn", { email: "verify@example.com", password: "wrong password" })).status).toBe(401);
      const second = inbox.sent.findLast((m) => m.email === "verify@example.com")!.code;
      if (first !== second) expect((await flow2("email-verification", { email: "verify@example.com", code: first, password: "correct horse" })).status).toBe(401); // replaced
      const confirmed = await flow2("email-verification", { email: "verify@example.com", code: second, password: "correct horse" });
      expect(confirmed.status).toBe(200);
      expect(typeof (await app2.runtime.adminRead((db) => db.get(confirmed.body.userId)))?.emailVerificationTime).toBe("number");
      expect((await flow2("signIn", { email: "verify@example.com", password: "correct horse" })).body.token).toStartWith("ob_s_");
    });

    test("the client goes through the code step", async () => {
      const client = new OnebaseClient(base2, { authStorage: memoryStorage() });
      expect(await client.signIn("password", { flow: "signUp", email: "walk@example.com", password: "correct horse" })).toEqual({ signingIn: false });
      expect(client.authState.isAuthenticated).toBe(false);
      const code = await inbox.codeFor("walk@example.com", "verify");
      expect(await client.signIn("password", { flow: "email-verification", email: "walk@example.com", code, password: "correct horse" })).toEqual({ signingIn: true });
      expect(await client.query("auth:whoami", {})).toBeString();
      client.close();
    });

    test("a confirmed email lets OAuth join the same user", async () => {
      await flow2("signUp", { email: "link@example.com", password: "correct horse" });
      const { userId } = (await flow2("email-verification", { email: "link@example.com", code: await inbox.codeFor("link@example.com", "verify"), password: "correct horse" })).body;
      const { verifier, challenge } = verifierPair();
      const start = await post2("signin", { provider: "fake", redirectTo: "https://app.example.com/", challenge });
      const authorize = new URL(start.body.redirect);
      const code = crypto.randomUUID();
      fake.issue(code, { id: "gh-link", email: "link@example.com", emailVerified: true }, authorize.searchParams.get("code_challenge")!);
      const back = await fetch(`${base2}/api/auth/callback/fake?code=${code}&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
      const done = await post2("signin", { code: new URL(back.headers.get("Location")!).searchParams.get("onebase_code"), verifier });
      expect(done.body.userId).toBe(userId);
    });

    test("signing up a taken address answers exactly like a new one", async () => {
      await flow2("signUp", { email: "taken@example.com", password: "correct horse" });
      const existing = (await flow2("email-verification", { email: "taken@example.com", code: await inbox.codeFor("taken@example.com", "verify"), password: "correct horse" })).body.userId;

      // A wrong password still gets the same reply (and the same emailed code) as a new address.
      expect(await flow2("signUp", { email: "taken@example.com", password: "totally wrong" })).toEqual({ status: 200, body: { codeSent: true } });
      const confirmed = await flow2("email-verification", { email: "taken@example.com", code: await inbox.codeFor("taken@example.com", "verify"), password: "totally wrong" });
      expect(confirmed.status).toBe(200);
      expect(confirmed.body.userId).toBe(existing); // the code signs into the existing account
    });

    test("someone who signs up another person's email first loses that account's password when the owner confirms", async () => {
      // The attacker registers the address first and can't confirm it (they don't read the inbox).
      await flow2("signUp", { email: "pre@example.com", password: "attacker pass" });
      // The owner signs up later and confirms the code they were sent.
      await flow2("signUp", { email: "pre@example.com", password: "owner password" });
      const owner = await flow2("email-verification", { email: "pre@example.com", code: await inbox.codeFor("pre@example.com", "verify"), password: "owner password" });
      expect(owner.status).toBe(200);

      expect((await flow2("signIn", { email: "pre@example.com", password: "attacker pass" })).status).toBe(401);
      const again = await flow2("signIn", { email: "pre@example.com", password: "owner password" });
      expect(again.status).toBe(200);
      expect(again.body.userId).toBe(owner.body.userId);
    });

    test("signing up again while the owner confirms can't choose the password their confirmation sets", async () => {
      await flow2("signUp", { email: "mid@example.com", password: "owner password" });
      // An attacker signs the same address up again: the newest code in the owner's inbox carries
      // the attacker's password, and it replaces the owner's code.
      await flow2("signUp", { email: "mid@example.com", password: "attacker pass" });
      const code = await inbox.codeFor("mid@example.com", "verify");
      expect(await flow2("email-verification", { email: "mid@example.com", code })).toMatchObject({ status: 400, body: { error: "Enter a password." } });
      expect(await flow2("email-verification", { email: "mid@example.com", code, password: "owner password" })).toMatchObject({
        status: 401,
        body: { error: "Enter the code together with the password you signed up with." },
      });
      expect((await flow2("signIn", { email: "mid@example.com", password: "attacker pass" })).status).toBe(401);

      // The owner asks for a fresh code and confirms it with their own password.
      await flow2("signUp", { email: "mid@example.com", password: "owner password" });
      const owner = await flow2("email-verification", { email: "mid@example.com", code: await inbox.codeFor("mid@example.com", "verify"), password: "owner password" });
      expect(owner.status).toBe(200);
      expect((await flow2("signIn", { email: "mid@example.com", password: "attacker pass" })).status).toBe(401);
      expect((await flow2("signIn", { email: "mid@example.com", password: "owner password" })).body.userId).toBe(owner.body.userId);
    });

    test("a code that can't be sent is reported", async () => {
      expect(await flow2("signUp", { email: "fail@example.com", password: "correct horse" })).toMatchObject({
        status: 502,
        body: { error: "The code couldn't be sent. Try again in a moment." },
      });
    });
  });

  test("the client signs in, keeps the session, follows sign-outs from elsewhere, and signs out", async () => {
    const storage = memoryStorage();
    const client = new OnebaseClient(base, { authStorage: storage });
    const states: boolean[] = [];
    client.onAuthChange((s) => !s.isLoading && states.push(s.isAuthenticated));
    expect(client.authState).toEqual({ isLoading: false, isAuthenticated: false, error: null });

    await client.signIn("password", { flow: "signUp", email: "erin@example.com", password: "correct horse" });
    const seen: unknown[] = [];
    client.onUpdate("auth:whoami", {}, (v) => seen.push(v));
    const userId = await client.query("auth:whoami", {});
    expect(userId).toBeString();
    expect(client.authState.isAuthenticated).toBe(true);
    expect([...storage.data.values()][0]).toStartWith("ob_s_");

    // A new client (a reload) picks the session up from storage.
    const reloaded = new OnebaseClient(base, { authStorage: storage });
    expect(reloaded.authState.isLoading).toBe(true);
    expect(await reloaded.query("auth:whoami", {})).toBe(userId);
    reloaded.close();

    // Signing out everywhere from another device signs this connection out live.
    const other = (await signIn("erin@example.com", "correct horse")).body.token;
    await post("signout", { everywhere: true }, other);
    await Bun.sleep(100);
    expect(seen.at(-1)).toBeNull();
    expect(client.authState).toMatchObject({ isLoading: false, isAuthenticated: false });
    expect(storage.data.size).toBe(0);

    await client.signIn("password", { flow: "signIn", email: "erin@example.com", password: "correct horse" });
    await Bun.sleep(50);
    expect(seen.at(-1)).toBe(userId);
    const token = [...storage.data.values()][0]!;
    await client.signOut();
    await Bun.sleep(50);
    expect(seen.at(-1)).toBeNull();
    expect((await ask("auth:whoami", token)).error).toContain("signed out");
    expect(states).toEqual([true, false, true, false]);
    await expect(client.signIn("password", { flow: "signIn", email: "erin@example.com", password: "bad password" })).rejects.toThrow("Invalid email or password.");
    client.close();
  });

  test("the client keeps its session when the server can't check it for a moment", async () => {
    const storage = memoryStorage();
    const first = new OnebaseClient(base, { authStorage: storage });
    await first.signIn("password", { flow: "signUp", email: "flaky@example.com", password: "correct horse" });
    expect(await first.query("auth:whoami", {})).toBeString(); // its connection has checked the session
    first.close();
    const auth = app.runtime.auth as any;
    const identify = auth.identifySession;
    auth.identifySession = async () => {
      auth.identifySession = identify;
      throw new Error("database timed out");
    };
    const client = new OnebaseClient(base, { authStorage: storage });
    for (let i = 0; i < 60 && !client.authState.isAuthenticated; i++) await Bun.sleep(50);
    expect(client.authState.isAuthenticated).toBe(true);
    expect(storage.data.size).toBe(1);
    client.close();
  });
});

describe("built-in auth checks the schema at startup", () => {
  const start = (s: any) => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-auth-check-"));
    const rt = new Runtime({ driver: createDriver(join(dir, "db.sqlite")), schema: s, modules: {}, log: quiet, auth: { methods: [password()] } });
    return rt.init().finally(() => {
      rt.stop();
      rmSync(dir, { recursive: true, force: true });
    });
  };

  test("verifyEmail needs sendCode and somewhere to record verification", async () => {
    expect(() => password({ verifyEmail: true })).toThrow("needs a sendCode function");
    const dir = mkdtempSync(join(tmpdir(), "onebase-auth-check-"));
    const rt = new Runtime({
      driver: createDriver(join(dir, "db.sqlite")),
      schema: defineSchema({ users: defineTable({ email: v.optional(v.string()) }) }),
      modules: {},
      log: quiet,
      auth: { methods: [password({ verifyEmail: true, sendCode: () => {} })] },
    });
    await expect(rt.init()).rejects.toThrow("users.emailVerificationTime");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a users table is required, and new users must fit it", async () => {
    await expect(start(defineSchema({ notes: defineTable({ text: v.string() }) }))).rejects.toThrow('keeps users in a "users" table');
    await expect(start(defineSchema({ users: defineTable({ email: v.string(), plan: v.string() }) }))).rejects.toThrow("user.plan is required");
    await start(defineSchema({ users: defineTable({ email: v.string(), plan: v.optional(v.string()) }) }));
  });

  test("one method's profile doesn't excuse another that has none", async () => {
    const check = (methods: any[]) => {
      const dir = mkdtempSync(join(tmpdir(), "onebase-auth-check-"));
      const rt = new Runtime({
        driver: createDriver(join(dir, "db.sqlite")),
        schema: defineSchema({ users: defineTable({ email: v.string(), plan: v.string() }) }),
        modules: {},
        log: quiet,
        auth: { methods },
      });
      return rt.init().finally(() => {
        rt.stop();
        rmSync(dir, { recursive: true, force: true });
      });
    };
    const withPlan = () => ({ plan: "free" });
    const codes = emailCode({ sendCode: () => {}, profile: withPlan });
    await expect(check([codes, password()])).rejects.toThrow("user.plan is required");
    await check([codes, password({ profile: withPlan })]);
  });
});

for (const DB of DATABASES) describe(`${DB.name}: lockouts are per network, so nobody can lock anyone else out`, () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-auth-ip-"));
    app = await startApp({
      schema: defineSchema({ ...authTables }),
      modules: {},
      db: DB.url,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      trustProxy: true,
      auth: { methods: [password()] },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("guessing from another network can't lock the account for its owner", async () => {
    // Behind a proxy (trustProxy), each X-Forwarded-For is its own network.
    const withIp = (body: unknown, ip: string | null) =>
      fetch(`${base}/api/auth/signin`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}) },
        body: JSON.stringify(body),
      }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));
    const signUp = (email: string) => withIp({ provider: "password", params: { flow: "signUp", email, password: "correct horse" } }, null);
    expect((await signUp("victim@example.com")).status).toBe(200);

    // An attacker burns through the lockout from their own address…
    for (let i = 0; i < 10; i++) await withIp({ provider: "password", params: { flow: "signIn", email: "victim@example.com", password: "wrong password" } }, "203.0.113.9");
    const attacker = await withIp({ provider: "password", params: { flow: "signIn", email: "victim@example.com", password: "wrong password" } }, "203.0.113.9");
    expect(attacker.status).toBe(429);

    // …but the owner, signing in from their own network, is unaffected.
    const owner = await withIp({ provider: "password", params: { flow: "signIn", email: "victim@example.com", password: "correct horse" } }, "198.51.100.7");
    expect(owner.status).toBe(200);
    expect(owner.body.token).toStartWith("ob_s_");

    // From the same network as the attacker, the lockout does apply.
    const accomplice = await withIp({ provider: "password", params: { flow: "signIn", email: "victim@example.com", password: "correct horse" } }, "203.0.113.9");
    expect(accomplice.status).toBe(429);
  });
});

describe("closed sign-up", () => {
  const modules = {
    admin: {
      invite: mutation({ args: { email: v.string() }, handler: (ctx, { email }) => ctx.db.insert("users", { email }) }),
      setPassword: action({ args: { id: v.id("users"), password: v.string() }, handler: (ctx, { id, password }) => ctx.auth.setPassword(id, password) }),
    },
  };
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-auth-closed-"));
    app = await startApp({ schema: defineSchema({ ...authTables }), modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, auth: { methods: [password({ signUp: false })] } });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("password({ signUp: false }): the server refuses sign-up, and accounts made by your code sign in", async () => {
    const flow = (flow: string, email: string, pw: string) => postTo(base, "signin", { provider: "password", params: { flow, email, password: pw } });
    expect(await flow("signUp", "walk-in@example.com", "correct horse")).toEqual({ status: 403, body: { error: "Sign-up is closed. Ask an administrator for an account." } });
    expect(await app.runtime.adminRead((db) => db.query("users").collect())).toEqual([]);
    expect(await (await fetch(`${base}/api/auth/methods`)).json()).toEqual({ methods: [{ id: "password", kind: "password", name: "Password", signUp: false }] });

    const id = await app.runtime.runMutation("admin:invite", { email: "invited@example.com" });
    await app.runtime.runAction("admin:setPassword", { id, password: "temporary one" });
    expect((await flow("signIn", "invited@example.com", "temporary one")).body.userId).toBe(id);
    // Sign-up of an address that has an account is refused like any other: it says nothing about the address.
    expect((await flow("signUp", "invited@example.com", "temporary one")).status).toBe(403);
  });

  test("ctx.auth's password and session calls need built-in sign-in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-auth-none-"));
    const rt = new Runtime({ driver: createDriver(join(dir, "db.sqlite")), schema: defineSchema({ ...authTables }), modules, log: quiet });
    await rt.init();
    const id = await rt.runMutation("admin:invite", { email: "a@example.com" });
    await expect(rt.runAction("admin:setPassword", { id, password: "temporary one" })).rejects.toThrow("needs built-in sign-in");
    rt.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("open connections re-check their session", () => {
  const modules = { auth: { whoami: query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null }) } };
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-auth-recheck-"));
    app = await startApp({
      schema: defineSchema({ ...authTables }),
      modules,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      sessionRecheckMs: 150,
      auth: { methods: [password()] },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a session that expires or is deleted signs the open connection out, without reconnecting", async () => {
    const storage = memoryStorage();
    const client = new OnebaseClient(base, { authStorage: storage });
    await client.signIn("password", { flow: "signUp", email: "stale@example.com", password: "correct horse" });
    const seen: (string | null)[] = [];
    client.onUpdate("auth:whoami", {}, (v) => seen.push(v));
    const userId = await client.query("auth:whoami", {});
    expect(userId).toBeString();
    expect(client.authState.isAuthenticated).toBe(true);

    // The session expires while the connection stays open.
    await app.runtime.withWriter((tx) => tx.run("UPDATE _auth_sessions SET expires = ? WHERE user_id = ?", [Date.now() - 1, userId]));
    for (let i = 0; i < 100 && seen.at(-1) !== null; i++) await Bun.sleep(50);
    expect(seen.at(-1)).toBeNull(); // its queries re-ran signed out
    expect(client.authState.isAuthenticated).toBe(false);
    expect(storage.data.size).toBe(0); // the client forgot the dead session

    // A connection whose user is deleted is signed out the same way.
    await client.signIn("password", { flow: "signUp", email: "gone@example.com", password: "correct horse" });
    const gone = await client.query("auth:whoami", {});
    seen.length = 0;
    await app.runtime.adminWrite((db) => db.delete(gone));
    for (let i = 0; i < 100 && seen.at(-1) !== null; i++) await Bun.sleep(50);
    expect(seen.at(-1)).toBeNull();
    expect(client.authState.isAuthenticated).toBe(false);
    client.close();
  });
});
