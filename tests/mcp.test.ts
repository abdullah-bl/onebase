// MCP: the /mcp endpoint, OAuth 2.1 (discovery, registration, consent, PKCE, refresh rotation and
// replay detection, revocation), API keys, scopes, and tools running as the approving user.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { password } from "../src/auth";
import { sha256 } from "../src/engine/auth";
import { createDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { defineMcp, getMcpCaller, inputSchema, tool, toJsonSchema } from "../src/mcp";
import { authTables, defineSchema, defineTable, getAuthUserId, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({
  ...authTables,
  notes: defineTable({ owner: v.id("users"), text: v.string() }).index("by_owner", ["owner"]),
});

const modules = {
  notes: {
    mine: query({
      args: {},
      handler: async (ctx) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) throw new Error("Not signed in");
        return (await ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("owner", userId)).collect()).map((n) => n.text);
      },
    }),
    add: mutation({
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        const userId = await getAuthUserId(ctx);
        if (!userId) throw new Error("Not signed in");
        await ctx.db.insert("notes", { owner: userId, text });
        return null;
      },
    }),
  },
  mcp: {
    default: defineMcp({
      name: "Notes",
      version: "1.2.3",
      instructions: "Use listNotes before addNote.",
      consentUrl: "/connect",
      scopes: { read: "Read your notes", write: "Add notes" },
    }),
    listNotes: tool({
      description: "Lists the user's notes.",
      scope: "read",
      annotations: { readOnlyHint: true },
      returns: v.object({ notes: v.array(v.string()), via: v.string() }),
      handler: async (ctx) => {
        const caller = await getMcpCaller(ctx);
        return { notes: (await ctx.runQuery("notes:mine" as any, {})) as string[], via: caller!.clientName };
      },
    }),
    addNote: tool({
      description: "Adds a note.",
      scope: "write",
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        await ctx.runMutation("notes:add" as any, { text });
        return "added";
      },
    }),
    whoami: tool({ name: "who-am-i", description: "Says who is connected.", handler: async (ctx) => (await ctx.auth.getUserIdentity())?.email ?? null }),
  },
};

describe("mcp", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-mcp-"));
    app = await startApp({ schema, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, auth: { methods: [password()] } });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const postJson = async (path: string, body: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  const postForm = async (path: string, form: Record<string, string>) => {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  let rpcId = 0;
  const rpc = (token: string, method: string, params?: unknown) => postJson("/mcp", { jsonrpc: "2.0", id: ++rpcId, method, params }, token);
  const signUp = async (email: string) => {
    const res = await postJson("/api/auth/signin", { provider: "password", params: { flow: "signUp", email, password: "correct horse" } });
    return res.body.token as string;
  };
  const pkce = () => {
    const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    return { verifier, challenge: sha256(verifier) };
  };
  const redirectUri = "http://127.0.0.1:33418/callback";

  /** Registers an agent and runs the whole OAuth flow as `session`'s user. */
  const connect = async (session: string, opts: { scope?: string; grant?: string[] } = {}) => {
    const reg = await postJson("/api/mcp/oauth/register", { client_name: "Test Agent", redirect_uris: [redirectUri] });
    expect(reg.status).toBe(201);
    const clientId = reg.body.client_id as string;
    const { verifier, challenge } = pkce();
    const authorize = new URL(`${base}/api/mcp/oauth/authorize`);
    for (const [k, val] of Object.entries({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
      resource: `${base}/mcp`,
      ...(opts.scope ? { scope: opts.scope } : {}),
    })) {
      authorize.searchParams.set(k, val);
    }
    const start = await fetch(authorize, { redirect: "manual" });
    expect(start.status).toBe(302);
    const consent = new URL(start.headers.get("Location")!);
    expect(consent.pathname).toBe("/connect");
    const request = consent.searchParams.get("request")!;
    const answer = await postJson("/api/mcp/authorize", { request, approve: true, ...(opts.grant ? { scopes: opts.grant } : {}) }, session);
    expect(answer.status).toBe(200);
    const back = new URL(answer.body.redirect);
    expect(back.searchParams.get("state")).toBe("xyz");
    expect(back.searchParams.get("iss")).toBe(base);
    const code = back.searchParams.get("code")!;
    const tokens = await postForm("/api/mcp/oauth/token", { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });
    expect(tokens.status).toBe(200);
    return { clientId, request, code, verifier, ...(tokens.body as { access_token: string; refresh_token: string; scope: string; expires_in: number }) };
  };

  test("advertises OAuth through discovery documents", async () => {
    const unauth = await postJson("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);

    const resource = (await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json()) as any;
    expect(resource).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["read", "write"] });
    const server = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as any;
    expect(server).toMatchObject({ issuer: base, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
    expect(server.registration_endpoint).toBe(`${base}/api/mcp/oauth/register`);

    const preflight = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("MCP-Protocol-Version");
  });

  test("connects with OAuth and runs tools as the approving user, limited to granted scopes", async () => {
    const session = await signUp("ada@example.com");
    await postJson("/api/mutation", { path: "notes:add", args: { text: "first" } }, session);

    const info = await fetch(`${base}/api/mcp/request?id=`);
    expect(info.status).toBe(404);

    const conn = await connect(session, { scope: "read write", grant: ["read"] });
    expect(conn.scope).toBe("read");

    const init = await rpc(conn.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "Notes", version: "1.2.3" }, instructions: "Use listNotes before addNote." });
    const note = await postJson("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" }, conn.access_token);
    expect(note.status).toBe(202);

    const list = await rpc(conn.access_token, "tools/list");
    const names = list.body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(["listNotes", "who-am-i"]); // addNote needs "write"
    const listNotes = list.body.result.tools.find((t: any) => t.name === "listNotes");
    expect(listNotes.annotations).toEqual({ readOnlyHint: true });
    expect(listNotes.inputSchema).toEqual({ type: "object", properties: {} });
    expect(listNotes.outputSchema.required).toEqual(["notes", "via"]);

    const call = await rpc(conn.access_token, "tools/call", { name: "listNotes", arguments: {} });
    expect(call.body.result.isError).toBe(false);
    expect(call.body.result.structuredContent).toEqual({ notes: ["first"], via: "Test Agent" });
    const who = await rpc(conn.access_token, "tools/call", { name: "who-am-i" });
    expect(who.body.result.content[0].text).toBe("ada@example.com");

    const denied = await rpc(conn.access_token, "tools/call", { name: "addNote", arguments: { text: "x" } });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("WWW-Authenticate")).toContain('error="insufficient_scope"');
    expect(denied.headers.get("WWW-Authenticate")).toContain('scope="read write"');

    const unknown = await rpc(conn.access_token, "tools/call", { name: "nope" });
    expect(unknown.body.error.code).toBe(-32602);
    const method = await rpc(conn.access_token, "resources/list");
    expect(method.body.error.code).toBe(-32601);

    // The token is for /mcp only: the regular API refuses it.
    const api = await postJson("/api/query", { path: "notes:mine", args: {} }, conn.access_token);
    expect(api.body.status).toBe("error");
    expect(api.body.errorMessage).toContain("only works at /mcp");

    // Codes work once, and only with the right verifier.
    const again = await postForm("/api/mcp/oauth/token", { grant_type: "authorization_code", code: conn.code, client_id: conn.clientId, code_verifier: conn.verifier });
    expect(again.body.error).toBe("invalid_grant");
    const request = await postJson("/api/mcp/authorize", { request: conn.request, approve: true }, session);
    expect(request.status).toBe(404);
  });

  test("bad arguments come back as a tool error the agent can fix", async () => {
    const session = await signUp("bob@example.com");
    const conn = await connect(session);
    expect(conn.scope).toBe("read write");
    const bad = await rpc(conn.access_token, "tools/call", { name: "addNote", arguments: { text: 42 } });
    expect(bad.status).toBe(200);
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toMatch(/text/);
    const good = await rpc(conn.access_token, "tools/call", { name: "addNote", arguments: { text: "from agent" } });
    expect(good.body.result.content[0].text).toBe("added");
    const notes = await rpc(conn.access_token, "tools/call", { name: "listNotes", arguments: {} });
    expect(notes.body.result.structuredContent.notes).toEqual(["from agent"]);
  });

  test("rejects a wrong PKCE verifier and unregistered redirects", async () => {
    const session = await signUp("eve@example.com");
    const reg = await postJson("/api/mcp/oauth/register", { client_name: "Agent", redirect_uris: [redirectUri] });
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: reg.body.client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256" });
    const start = await fetch(`${base}/api/mcp/oauth/authorize?${q}`, { redirect: "manual" });
    const request = new URL(start.headers.get("Location")!).searchParams.get("request")!;
    const answer = await postJson("/api/mcp/authorize", { request, approve: true }, session);
    const code = new URL(answer.body.redirect).searchParams.get("code")!;
    const wrong = await postForm("/api/mcp/oauth/token", { grant_type: "authorization_code", code, client_id: reg.body.client_id, code_verifier: pkce().verifier });
    expect(wrong.body.error).toBe("invalid_grant");

    q.set("redirect_uri", "https://evil.example/cb");
    const evil = await fetch(`${base}/api/mcp/oauth/authorize?${q}`, { redirect: "manual" });
    expect(evil.status).toBe(400); // an error page, never a redirect to the unregistered address

    const js = await postJson("/api/mcp/oauth/register", { redirect_uris: ["javascript:alert(1)"] });
    expect(js.body.error).toBe("invalid_redirect_uri");
    const plainHttp = await postJson("/api/mcp/oauth/register", { redirect_uris: ["http://example.com/cb"] });
    expect(plainHttp.body.error).toBe("invalid_redirect_uri");

    // Loopback redirects may come back on another port (RFC 8252).
    q.set("redirect_uri", "http://127.0.0.1:50000/callback");
    const port = await fetch(`${base}/api/mcp/oauth/authorize?${q}`, { redirect: "manual" });
    expect(port.status).toBe(302);
    expect(port.headers.get("Location")).toContain("/connect?request=");
  });

  test("a declined request sends the agent access_denied", async () => {
    const session = await signUp("dan@example.com");
    const reg = await postJson("/api/mcp/oauth/register", { client_name: "Agent", redirect_uris: [redirectUri] });
    const q = new URLSearchParams({ response_type: "code", client_id: reg.body.client_id, redirect_uri: redirectUri, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1" });
    const start = await fetch(`${base}/api/mcp/oauth/authorize?${q}`, { redirect: "manual" });
    const request = new URL(start.headers.get("Location")!).searchParams.get("request")!;
    const info = (await (await fetch(`${base}/api/mcp/request?id=${request}`)).json()) as any;
    expect(info).toEqual({
      server: { name: "Notes" },
      client: { id: reg.body.client_id, name: "Agent", redirectHost: "127.0.0.1:33418" },
      scopes: [
        { scope: "read", description: "Read your notes" },
        { scope: "write", description: "Add notes" },
      ],
    });
    const anonymous = await postJson("/api/mcp/authorize", { request, approve: true });
    expect(anonymous.status).toBe(401);
    const answer = await postJson("/api/mcp/authorize", { request, approve: false }, session);
    const back = new URL(answer.body.redirect);
    expect(back.searchParams.get("error")).toBe("access_denied");
    expect(back.searchParams.get("state")).toBe("s1");
  });

  test("refresh tokens rotate, and a replayed one ends the connection", async () => {
    const session = await signUp("rot@example.com");
    const conn = await connect(session);
    const next = await postForm("/api/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: conn.refresh_token, client_id: conn.clientId });
    expect(next.status).toBe(200);
    expect(next.body.refresh_token).not.toBe(conn.refresh_token);
    expect((await rpc(next.body.access_token, "ping")).body.result).toEqual({});

    const replay = await postForm("/api/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: conn.refresh_token, client_id: conn.clientId });
    expect(replay.body.error).toBe("invalid_grant");
    expect((await rpc(next.body.access_token, "ping")).status).toBe(401);
    const after = await postForm("/api/mcp/oauth/token", { grant_type: "refresh_token", refresh_token: next.body.refresh_token, client_id: conn.clientId });
    expect(after.body.error).toBe("invalid_grant");
  });

  test("revoking a refresh token ends the connection", async () => {
    const session = await signUp("rev@example.com");
    const conn = await connect(session);
    const res = await postForm("/api/mcp/oauth/revoke", { token: conn.refresh_token });
    expect(res.status).toBe(200);
    expect((await rpc(conn.access_token, "ping")).status).toBe(401);
  });

  test("API keys: created once, listed with connections, revoked", async () => {
    const session = await signUp("key@example.com");
    expect((await postJson("/api/mcp/keys", { name: "CI" })).status).toBe(401);
    const bad = await postJson("/api/mcp/keys", { name: "CI", scopes: ["admin"] }, session);
    expect(bad.body.error).toBe("invalid_scope");
    const created = await postJson("/api/mcp/keys", { name: "CI", scopes: ["read"] }, session);
    expect(created.body.key).toStartWith("ob_mcpk_");
    expect(created.body.scopes).toEqual(["read"]);

    const tools = await rpc(created.body.key, "tools/list");
    expect(tools.body.result.tools.map((t: any) => t.name).sort()).toEqual(["listNotes", "who-am-i"]);

    await connect(session);
    const list = await fetch(`${base}/api/mcp/connections`, { headers: { Authorization: `Bearer ${session}` } });
    const { connections } = (await list.json()) as any;
    expect(connections.map((c: any) => [c.kind, c.name]).sort()).toEqual([
      ["key", "CI"],
      ["oauth", "Test Agent"],
    ]);

    // Someone else can't revoke it.
    const other = await signUp("other@example.com");
    expect((await postJson("/api/mcp/connections/revoke", { id: created.body.id }, other)).body.removed).toBe(false);
    expect((await postJson("/api/mcp/connections/revoke", { id: created.body.id }, session)).body.removed).toBe(true);
    expect((await rpc(created.body.key, "tools/list")).status).toBe(401);
  });

  test("a deleted user's connections stop working", async () => {
    const session = await signUp("gone@example.com");
    const conn = await connect(session);
    const userId = (await app.runtime.identify(session))!.subject;
    await app.runtime.authWrite(({ db }) => db.delete(userId));
    expect((await rpc(conn.access_token, "ping")).status).toBe(401);
  });
});

describe("mcp definitions", () => {
  const base = { driver: createDriver(":memory:"), schema: null, log: { info() {}, warn() {}, error() {} } };

  test("a tool's scope must be declared", () => {
    expect(
      () =>
        new Runtime({
          ...base,
          modules: { mcp: { default: defineMcp({ name: "X", scopes: { read: "Read" } }), t: tool({ description: "d", scope: "write", handler: async () => 1 }) } },
        }),
    ).toThrow('scope "write" isn\'t in defineMcp');
  });

  test("tools need defineMcp", () => {
    expect(() => new Runtime({ ...base, modules: { tools: { t: tool({ description: "d", handler: async () => 1 }) } } })).toThrow("defineMcp");
  });

  test("tool names are unique", () => {
    expect(
      () =>
        new Runtime({
          ...base,
          modules: {
            mcp: { default: defineMcp({ name: "X" }), a: tool({ name: "same", description: "d", handler: async () => 1 }) },
            other: { b: tool({ name: "same", description: "d", handler: async () => 1 }) },
          },
        }),
    ).toThrow('Two tools are named "same"');
  });

  test("validators become JSON Schema", () => {
    expect(inputSchema(v.object({ id: v.id("notes"), tags: v.optional(v.array(v.string())), mode: v.union(v.literal("a"), v.literal("b")) }))).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: 'An id from the "notes" table.' },
        tags: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["a", "b"] },
      },
      required: ["id", "mode"],
      additionalProperties: false,
    });
    expect(toJsonSchema(v.union(v.string(), v.null()))).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(toJsonSchema(v.record(v.string(), v.number()))).toEqual({ type: "object", additionalProperties: { type: "number" } });
  });
});
