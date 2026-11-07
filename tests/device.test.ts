// Device pairing (RFC 8628): a device signing in through another, and MCP agents connecting without
// a browser. Approval needs a signed-in user, codes work once, polling too fast slows the device down.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { password } from "../src/auth";
import { OnebaseClient } from "../src/client/index";
import { DeviceService, normalizeUserCode } from "../src/engine/device";
import { defineMcp, tool } from "../src/mcp";
import { authTables, defineSchema, query } from "../src/server";

const modules = {
  me: { email: query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.email ?? null }) },
  mcp: {
    default: defineMcp({ name: "Notes", deviceUrl: "/device", scopes: { read: "Read your notes", write: "Edit your notes" } }),
    whoami: tool({ description: "Who is connected.", scope: "read", handler: async (ctx) => (await ctx.auth.getUserIdentity())?.email ?? null }),
    edit: tool({ description: "Edits.", scope: "write", handler: async () => "edited" }),
  },
};

describe("device pairing", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let base: string;
  let dataDir: string;
  const interval = DeviceService.intervalSeconds;

  beforeAll(async () => {
    DeviceService.intervalSeconds = 0.05;
    dataDir = mkdtempSync(join(tmpdir(), "onebase-device-"));
    app = await startApp({
      schema: defineSchema({ ...authTables }),
      modules,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      auth: { methods: [password()], deviceUrl: "/device" },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    DeviceService.intervalSeconds = interval;
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown, token?: string, form = false) => {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const get = async (path: string, token?: string) => {
    const res = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const signUp = async (email: string) => (await post("/api/auth/signin", { provider: "password", params: { flow: "signUp", email, password: "correct horse" } })).body.token as string;
  const wait = () => Bun.sleep(80);

  test("a device signs in once a signed-in user approves its code", async () => {
    const session = await signUp("tv@example.com");
    const start = await post("/api/auth/device/start", { name: "Living room TV" });
    expect(start.status).toBe(200);
    expect(start.body.userCode).toMatch(/^[BCDFGHJKMNPQRSTVWXZ]{4}-[BCDFGHJKMNPQRSTVWXZ]{4}$/);
    expect(start.body.verificationUri).toBe(`${base}/device`);
    expect(start.body.verificationUriComplete).toBe(`${base}/device?code=${start.body.userCode}`);

    await wait();
    expect((await post("/api/auth/device/poll", { deviceCode: start.body.deviceCode })).body).toEqual({ status: "pending" });
    // Polling again at once: slow down.
    expect((await post("/api/auth/device/poll", { deviceCode: start.body.deviceCode })).body.status).toBe("slow_down");

    expect((await get(`/api/auth/device/request?code=${start.body.userCode}`)).status).toBe(401);
    const typed = start.body.userCode.toLowerCase().replace("-", " ");
    const info = await get(`/api/auth/device/request?code=${encodeURIComponent(typed)}`, session);
    expect(info.body).toMatchObject({ kind: "session", name: "Living room TV", scopes: [] });

    expect((await post("/api/auth/device/approve", { code: start.body.userCode, approve: true }, session)).body).toEqual({ ok: true });
    expect((await post("/api/auth/device/approve", { code: start.body.userCode, approve: true }, session)).status).toBe(404);

    const done = await post("/api/auth/device/poll", { deviceCode: start.body.deviceCode });
    expect(done.body.status).toBe("approved");
    const me = await post("/api/query", { path: "me:email", args: {} }, done.body.token);
    expect(me.body.value).toBe("tv@example.com");
    // The device code works once.
    expect((await post("/api/auth/device/poll", { deviceCode: start.body.deviceCode })).body.status).toBe("expired");
  });

  test("a declined device is told so", async () => {
    const session = await signUp("no@example.com");
    const start = await post("/api/auth/device/start", {});
    await post("/api/auth/device/approve", { code: start.body.userCode, approve: false }, session);
    await wait();
    expect((await post("/api/auth/device/poll", { deviceCode: start.body.deviceCode })).body.status).toBe("denied");
  });

  test("wrong codes lock the user out after ten tries", async () => {
    const session = await signUp("guess@example.com");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await get(`/api/auth/device/request?code=BBBB-BBB${"BCDFGHJKMNP"[i]}`, session)).status);
    expect(statuses.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  test("the client signs in with signInWithDevice", async () => {
    const session = await signUp("cli@example.com");
    const client = new OnebaseClient(base, { authStorage: null });
    try {
      const signedIn = client.signInWithDevice({
        name: "CLI",
        onCode: ({ userCode }) => void post("/api/auth/device/approve", { code: userCode, approve: true }, session),
      });
      await signedIn;
      expect(await client.query("me:email" as any, {})).toBe("cli@example.com");
    } finally {
      client.close();
    }
  });

  test("an MCP agent connects through the device flow, with the scopes the user kept", async () => {
    const meta = (await get("/.well-known/oauth-authorization-server")).body;
    expect(meta.device_authorization_endpoint).toBe(`${base}/api/mcp/oauth/device`);
    expect(meta.grant_types_supported).toContain("urn:ietf:params:oauth:grant-type:device_code");

    // An agent given only the URL learns how to connect.
    const hello = await get("/mcp");
    expect(hello.status).toBe(401);
    expect(hello.body.steps[0]).toContain("/api/mcp/oauth/device");

    const session = await signUp("agent@example.com");
    const start = await post("/api/mcp/oauth/device", { client_id: "mcp-agent", client_name: "Script" }, undefined, true);
    expect(start.status).toBe(200);
    const grant = { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.body.device_code, client_id: "mcp-agent" };
    await wait();
    expect((await post("/api/mcp/oauth/token", grant, undefined, true)).body.error).toBe("authorization_pending");

    const info = await get(`/api/auth/device/request?code=${start.body.user_code}`, session);
    expect(info.body).toMatchObject({
      kind: "mcp",
      name: "Script",
      scopes: [
        { scope: "read", description: "Read your notes" },
        { scope: "write", description: "Edit your notes" },
      ],
    });
    await post("/api/auth/device/approve", { code: start.body.user_code, approve: true, scopes: ["read"] }, session);
    await wait();
    const tokens = await post("/api/mcp/oauth/token", grant, undefined, true);
    expect(tokens.status).toBe(200);
    expect(tokens.body.scope).toBe("read");
    expect(tokens.body.refresh_token).toBeUndefined();

    const rpc = (method: string, params?: unknown) => post("/mcp", { jsonrpc: "2.0", id: 1, method, params }, tokens.body.access_token);
    expect((await rpc("tools/list")).body.result.tools.map((t: any) => t.name)).toEqual(["whoami"]);
    expect((await rpc("tools/call", { name: "whoami" })).body.result.content[0].text).toBe("agent@example.com");

    // A session-kind poll can't redeem an agent's code, and a device code is single use.
    expect((await post("/api/mcp/oauth/token", grant, undefined, true)).body.error).toBe("expired_token");
    // Unknown registered clients are refused.
    expect((await post("/api/mcp/oauth/device", { client_id: "mcp_nope" }, undefined, true)).status).toBe(401);
  });

  test("user codes ignore case, spaces and dashes", () => {
    expect(normalizeUserCode("wdjb mjht")).toBe("WDJBMJHT");
    expect(normalizeUserCode("WDJB-MJHT")).toBe("WDJBMJHT");
  });
});
