// The OAuth core's provider quirks: Apple's web sign-in (form_post callback, a signed JWT as the
// client secret, the profile in an id_token), HTTP Basic token auth, form-encoded token replies,
// providers without PKCE, and the built-in providers' authorization URLs.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { apple, discord, facebook, github, google, microsoft, oauth, twitter } from "../src/auth";
import { sha256 } from "../src/engine/auth";
import { authTables, defineSchema, getAuthUserId, query } from "../src/server";

const schema = defineSchema({ ...authTables });
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

const b64 = (data: string | Uint8Array | ArrayBuffer) =>
  Buffer.from(typeof data === "string" ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("base64url");
const SERVICES_ID = "com.example.web";
const BUNDLE = "com.example.app";

/** A stand-in for Apple's web sign-in: checks the ES256 client secret, then hands out an RS256 id_token. */
async function fakeAppleWeb() {
  const signing = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  // The developer's .p8 key: Apple holds the public half.
  const p8 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", p8.privateKey)).toString("base64");
  const privateKey = `-----BEGIN PRIVATE KEY-----\\n${pkcs8.match(/.{1,64}/g)!.join("\\n")}\\n-----END PRIVATE KEY-----`;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", signing.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map<string, Record<string, unknown>>();
  const seen: { secretClaims?: any; form?: URLSearchParams } = {};
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${b64(JSON.stringify({ alg: "RS256", kid: "k1" }))}.${b64(JSON.stringify(claims))}`;
    return `${input}.${b64(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signing.privateKey, new TextEncoder().encode(input)))}`;
  };
  let issuer = "";
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/auth/keys") return Response.json({ keys: [jwk] });
      if (url.pathname === "/auth/token") {
        const form = new URLSearchParams(await req.text());
        seen.form = form;
        const [head, body, sig] = (form.get("client_secret") ?? "").split(".");
        const ok =
          head &&
          (await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, p8.publicKey, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${head}.${body}`)));
        if (!ok) return Response.json({ error: "invalid_client" }, { status: 400 });
        seen.secretClaims = { ...JSON.parse(Buffer.from(head!, "base64url").toString()), ...JSON.parse(Buffer.from(body!, "base64url").toString()) };
        const claims = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!claims || form.get("client_id") !== SERVICES_ID) return Response.json({ error: "invalid_grant" }, { status: 400 });
        const now = Math.floor(Date.now() / 1000);
        const id_token = await sign({ iss: issuer, aud: SERVICES_ID, iat: now, exp: now + 600, ...claims });
        return Response.json({ access_token: "a", token_type: "bearer", id_token });
      }
      return new Response("not found", { status: 404 });
    },
  });
  issuer = `http://127.0.0.1:${server.port}`;
  return { server, issuer, privateKey, seen, sign, issue: (code: string, claims: Record<string, unknown>) => codes.set(code, claims) };
}

/** A provider that wants HTTP Basic client auth, no PKCE, comma-separated scopes, and answers form-encoded. */
function fakeOldSchool() {
  const codes = new Map<string, string>();
  const seen: { auth?: string | null; form?: URLSearchParams } = {};
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        seen.auth = req.headers.get("Authorization");
        seen.form = form;
        const expected = `Basic ${btoa(`${encodeURIComponent("old client")}:${encodeURIComponent("s3cret:+/")}`)}`;
        const user = codes.get(form.get("code") ?? "");
        if (req.headers.get("Authorization") !== expected || form.has("client_secret") || form.has("code_verifier") || !user) {
          return new Response("error=invalid_client", { status: 401, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
        }
        return new Response(`access_token=${user}&token_type=bearer`, { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, seen, issue: (code: string, user: string) => codes.set(code, user) };
}

describe("OAuth providers", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  let fake: Awaited<ReturnType<typeof fakeAppleWeb>>;
  const old = fakeOldSchool();

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-oauth-"));
    fake = await fakeAppleWeb();
    app = await startApp({
      schema,
      modules,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      auth: {
        redirects: ["https://app.example.com"],
        methods: [
          apple({
            clientId: BUNDLE,
            issuer: fake.issuer,
            jwksUrl: `${fake.issuer}/auth/keys`,
            web: { servicesId: SERVICES_ID, teamId: "TEAM123456", keyId: "KEY1234567", privateKey: fake.privateKey },
          }),
          oauth({
            id: "old",
            name: "Old",
            clientId: "old client",
            clientSecret: "s3cret:+/",
            authorizationUrl: `${old.url}/authorize`,
            tokenUrl: `${old.url}/token`,
            scopes: ["a", "b"],
            scopeSeparator: ",",
            tokenAuth: "basic",
            pkce: false,
            profile: async ({ access_token }) => ({ id: access_token, name: `User ${access_token}` }),
          }),
        ],
      },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    await app.close();
    fake.server.stop(true);
    old.server.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/api/auth/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };
  const me = async (token: string) => {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ path: "me:get", args: {} }),
    });
    return ((await res.json()) as any).value;
  };
  const pair = () => {
    const verifier = b64(crypto.getRandomValues(new Uint8Array(32)));
    return { verifier, challenge: sha256(verifier) };
  };

  describe("Sign in with Apple on the web", () => {
    const start = async () => {
      const { verifier, challenge } = pair();
      const res = await post("signin", { provider: "apple", redirectTo: "https://app.example.com/back", challenge });
      expect(res.status).toBe(200);
      return { verifier, authorize: new URL(res.body.redirect) };
    };
    /** Apple posts the code back as a form, like a browser would. */
    const formPost = (fields: Record<string, string>) =>
      fetch(`${base}/api/auth/callback/apple`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields),
      });

    test("redirects to Apple with form_post, the Services ID and no PKCE", async () => {
      const { authorize } = await start();
      expect(authorize.origin + authorize.pathname).toBe(`${fake.issuer}/auth/authorize`);
      expect(authorize.searchParams.get("client_id")).toBe(SERVICES_ID);
      expect(authorize.searchParams.get("response_mode")).toBe("form_post");
      expect(authorize.searchParams.get("scope")).toBe("name email");
      expect(authorize.searchParams.get("redirect_uri")).toBe(`${base}/api/auth/callback/apple`);
      expect(authorize.searchParams.has("code_challenge")).toBe(false);
    });

    test("the posted callback signs in with the name Apple sends once, and a signed client secret", async () => {
      const { verifier, authorize } = await start();
      fake.issue("c1", { sub: "web-sub-1", email: "web1@example.com", email_verified: "true" });
      const back = await formPost({
        code: "c1",
        state: authorize.searchParams.get("state")!,
        user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" }, email: "web1@example.com" }),
      });
      expect(back.status).toBe(302);
      const location = new URL(back.headers.get("Location")!);
      expect(location.origin + location.pathname).toBe("https://app.example.com/back");
      const done = await post("signin", { code: location.searchParams.get("onebase_code"), verifier });
      expect(done.status).toBe(200);
      expect(await me(done.body.token)).toMatchObject({ email: "web1@example.com", name: "Ada Lovelace" });
      expect(fake.seen.secretClaims).toMatchObject({ alg: "ES256", kid: "KEY1234567", iss: "TEAM123456", sub: SERVICES_ID, aud: "https://appleid.apple.com" });
      expect(fake.seen.form?.has("code_verifier")).toBe(false);
    });

    test("the iPhone app and the website sign in to the same account", async () => {
      const { verifier, authorize } = await start();
      fake.issue("c2", { sub: "shared-sub", email: "shared@privaterelay.appleid.com", email_verified: true });
      const back = await formPost({ code: "c2", state: authorize.searchParams.get("state")! });
      const web = await post("signin", { code: new URL(back.headers.get("Location")!).searchParams.get("onebase_code"), verifier });
      expect(web.status).toBe(200);

      const rawNonce = b64(crypto.getRandomValues(new Uint8Array(16)));
      const nonce = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawNonce))).toString("hex");
      const now = Math.floor(Date.now() / 1000);
      const idToken = await fake.sign({ iss: fake.issuer, aud: BUNDLE, sub: "shared-sub", iat: now, exp: now + 600, nonce });
      const native = await post("signin", { provider: "apple", params: { idToken, nonce: rawNonce } });
      expect(native.status).toBe(200);
      expect(native.body.userId).toBe(web.body.userId);
    });

    test("an id_token for another Services ID is refused", async () => {
      const { authorize } = await start();
      // The fake signs for SERVICES_ID; swap in a token for some other app by issuing a bad audience.
      fake.issue("c3", { sub: "x", aud: "com.someone.else" });
      const back = await formPost({ code: "c3", state: authorize.searchParams.get("state")! });
      expect(new URL(back.headers.get("Location")!).searchParams.get("auth_error")).toContain("failed");
    });

    test("a posted callback with a used or unknown state is refused", async () => {
      const res = await formPost({ code: "nope", state: "not-a-state" });
      expect(res.status).toBe(400);
    });

    test("cancelling on Apple's page sends the person back with a readable error", async () => {
      const { authorize } = await start();
      const back = await formPost({ error: "user_cancelled_authorize", state: authorize.searchParams.get("state")! });
      expect(new URL(back.headers.get("Location")!).searchParams.get("auth_error")).toBe("Sign-in was cancelled.");
    });
  });

  test("a provider with Basic client auth, no PKCE, comma scopes and a form-encoded token reply", async () => {
    const { verifier, challenge } = pair();
    const start = await post("signin", { provider: "old", redirectTo: "https://app.example.com/", challenge });
    const authorize = new URL(start.body.redirect);
    expect(authorize.searchParams.get("scope")).toBe("a,b");
    expect(authorize.searchParams.has("code_challenge")).toBe(false);
    old.issue("k1", "u-42");
    const back = await fetch(`${base}/api/auth/callback/old?code=k1&state=${authorize.searchParams.get("state")}`, { redirect: "manual" });
    const location = new URL(back.headers.get("Location")!);
    expect(location.searchParams.get("auth_error")).toBeNull();
    const done = await post("signin", { code: location.searchParams.get("onebase_code"), verifier });
    expect(done.status).toBe(200);
    expect((await me(done.body.token)).name).toBe("User u-42");
    expect(old.seen.form?.get("client_id")).toBeNull();
  });

  test("lists apple once, as an id-token method", async () => {
    const { methods } = (await (await fetch(`${base}/api/auth/methods`)).json()) as any;
    expect(methods.map((m: any) => m.id).sort()).toEqual(["apple", "old"]);
  });
});

describe("built-in providers", () => {
  const creds = { clientId: "id", clientSecret: "secret" };
  test.each([
    ["github", () => github(creds), "https://github.com/login/oauth/authorize", " "],
    ["google", () => google(creds), "https://accounts.google.com/o/oauth2/v2/auth", " "],
    ["microsoft", () => microsoft({ ...creds, tenant: "contoso.onmicrosoft.com" }), "https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize", " "],
    ["discord", () => discord(creds), "https://discord.com/oauth2/authorize", " "],
    ["facebook", () => facebook(creds), "https://www.facebook.com/v21.0/dialog/oauth", ","],
    ["twitter", () => twitter(creds), "https://x.com/i/oauth2/authorize", " "],
  ] as const)("%s", async (id, make, authorizationUrl, separator) => {
    const method = make();
    expect(method.id).toBe(id);
    expect((await method.endpoints()).authorizationUrl).toBe(authorizationUrl);
    expect(method.scopeSeparator ?? " ").toBe(separator);
  });

  test("X authenticates the token request with HTTP Basic", () => {
    expect(twitter(creds).tokenAuth).toBe("basic");
  });

  test("a bad Microsoft tenant is refused", () => {
    expect(() => microsoft({ ...creds, tenant: "../evil" })).toThrow("tenant");
  });

  test("apple() on the web says which settings are missing", () => {
    expect(() => apple({ web: { servicesId: "com.example.web" } })).toThrow("teamId, keyId, privateKey");
  });

  test("ids reserved for built-in methods can't be taken", () => {
    const base = { clientSecret: "s", clientId: "c", authorizationUrl: "https://x", tokenUrl: "https://x", profile: async () => ({ id: "1" }) };
    expect(() => oauth({ ...base, id: "email" })).toThrow("reserved");
    expect(() => oauth({ ...base, id: "password" })).toThrow("reserved");
  });
});
