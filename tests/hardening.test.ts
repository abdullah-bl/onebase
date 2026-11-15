// Defaults that keep a server safe and predictable when nobody configured anything: who may read
// a sign-in answer, the dashboard's headers and key checks, jobs cut off by a restart, and a
// shutdown that lets running work finish.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { password } from "../src/auth";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { action, authTables, defineSchema, defineTable, internalAction, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { quiet } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const schema = defineSchema({ ...authTables, notes: defineTable({ text: v.string() }) });

const modules = {
  notes: {
    list: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) }),
    add: mutation({ args: { text: v.string() }, handler: (ctx, args) => ctx.db.insert("notes", args) }),
    addLater: internalMutation({ args: { text: v.string() }, handler: (ctx, args) => ctx.db.insert("notes", args) }),
    ping: internalAction({ args: {}, handler: async () => "pong" }),
    slow: action({
      args: { ms: v.number() },
      handler: async (_ctx, { ms }) => {
        await sleep(ms);
        return "finished";
      },
    }),
  },
};

describe("a server with nothing configured", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-hardening-"));
    app = await startApp({ schema, modules, auth: { methods: [password()] }, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, actionWorkers: 0 });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const signUp = (origin?: string) =>
    fetch(`${base}/api/auth/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ provider: "password", params: { flow: "signUp", email: `${crypto.randomUUID()}@example.com`, password: "correct horse" } }),
    });

  test("a page on another site can't read a sign-in answer; the site itself and this machine can", async () => {
    const other = await signUp("https://evil.example");
    expect(other.status).toBe(200); // the request works: it is the browser that withholds the answer
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(other.headers.get("Vary")).toBe("Origin");
    const preflight = await fetch(`${base}/api/auth/signin`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();

    for (const origin of ["http://localhost:5173", app.runtime.siteUrl]) {
      expect((await signUp(origin)).headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
    // No Origin at all (a mobile app, curl): nothing to allow, and the answer is there.
    expect(((await (await signUp()).json()) as any).token).toStartWith("ob_s_");
    // Function calls stay open to any origin, as before.
    const query = await fetch(`${base}/api/query`, { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ path: "notes:list", args: {} }) });
    expect(query.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("health asks the database", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, deployment: null });
  });

  test("the dashboard page runs only its own scripts and can't be framed", async () => {
    const page = await fetch(`${base}/_admin`);
    const csp = page.headers.get("Content-Security-Policy")!;
    expect(csp).toContain("script-src 'self' 'sha256-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    // The one inline script is the one the policy's hash allows.
    const inline = /<script>(.*?)<\/script>/s.exec(await page.text())![1]!;
    expect(csp).toContain(`'sha256-${new Bun.CryptoHasher("sha256").update(inline).digest("base64")}'`);
  });

  test("wrong admin keys are slowed down, and the right one still works", async () => {
    const key = (await Bun.file(join(dataDir, "admin.key")).text()).trim();
    const overview = (k: string) => fetch(`${base}/_admin/api/overview`, { method: "POST", headers: { Authorization: `Bearer ${k}` }, body: "{}" });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await overview(`guess-${i}`)).status);
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect((await overview(key)).status).toBe(200);
  });

  test("many clients watching one query all get the same result", async () => {
    const open = async () => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/api/sync`);
      const updates: any[] = [];
      ws.onmessage = (e) => updates.push(JSON.parse(String(e.data)));
      await new Promise((r) => (ws.onopen = r));
      ws.send(JSON.stringify({ type: "sub", id: 7, path: "notes:list", args: {} }));
      return { ws, updates };
    };
    const clients = [await open(), await open(), await open()];
    await app.runtime.runMutation("notes:add", { text: "hello" });
    await sleep(100);
    for (const c of clients) {
      expect(c.updates.at(-1)).toEqual({ type: "update", id: 7, ok: true, value: ["hello"] });
      c.ws.close();
    }
  });

  test("one connection can't hold an unlimited number of live queries", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/sync`);
    const refused: any[] = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.ok === false) refused.push(msg);
    };
    await new Promise((r) => (ws.onopen = r));
    for (let id = 0; id < 1002; id++) ws.send(JSON.stringify({ type: "sub", id, path: "notes:list", args: {} }));
    await sleep(300);
    expect(refused.map((m) => m.id)).toEqual([1000, 1001]);
    expect(refused[0].error).toContain("Too many live queries on one connection (limit: 1000)");
    ws.close();
  });
});

test("a short $ONEBASE_ADMIN_KEY is refused, with how to make a good one", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-hardening-"));
  process.env.ONEBASE_ADMIN_KEY = "hunter2";
  try {
    const start = (dev: boolean) => startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev, quiet: true });
    await expect(start(false)).rejects.toThrow("needs at least 16");
    await (await start(true)).close(); // fine while developing
  } finally {
    delete process.env.ONEBASE_ADMIN_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("jobs cut off by a restart run again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-hardening-"));
  const open = async () => {
    const driver = new SqliteDriver(`${dataDir}/db.sqlite`);
    const runtime = new Runtime({ driver, log: quiet, schema, modules });
    await runtime.init();
    return { driver, runtime };
  };
  try {
    // What a server killed mid-job leaves behind: claimed, never finished.
    const before = await open();
    await before.runtime.withWriter(async (tx) => {
      await tx.run("INSERT INTO _scheduled (id, fn, args, run_at, state) VALUES ('m1', 'notes:addLater', ?, ?, 'running')", [JSON.stringify({ text: "after the crash" }), Date.now()]);
      await tx.run("INSERT INTO _scheduled (id, fn, args, run_at, state) VALUES ('a1', 'notes:ping', '{}', ?, 'running')", [Date.now()]);
    });
    before.runtime.stop();
    await before.driver.close();

    const after = await open();
    await after.runtime.startScheduler();
    await sleep(200);
    const jobs = await after.runtime.withReader((tx) => tx.all("SELECT id, state, error FROM _scheduled ORDER BY id"));
    expect(jobs).toEqual([
      { id: "a1", state: "done", error: null },
      { id: "m1", state: "done", error: null },
    ]);
    expect((await after.runtime.runQuery("notes:list", {})).value).toEqual(["after the crash"]);
    after.runtime.stop();
    await after.driver.close();
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("shutting down lets a running call finish, and gives up after the grace period", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-hardening-"));
  const start = () => startApp({ schema, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, actionWorkers: 0 });
  const call = (app: Awaited<ReturnType<typeof start>>, ms: number) =>
    fetch(`http://127.0.0.1:${app.server.port}/api/action`, { method: "POST", body: JSON.stringify({ path: "notes:slow", args: { ms } }) }).then(
      (r) => r.json() as Promise<any>,
      () => "cut off",
    );
  try {
    const first = await start();
    const answer = call(first, 300);
    await sleep(50);
    const began = Date.now();
    await first.close();
    expect(await answer).toEqual({ status: "success", value: "finished" });
    expect(Date.now() - began).toBeGreaterThanOrEqual(200);

    const second = await start();
    const lost = call(second, 5000);
    await sleep(50);
    const began2 = Date.now();
    await second.close(100);
    expect(Date.now() - began2).toBeLessThan(2000);
    expect(await lost).toBe("cut off");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
