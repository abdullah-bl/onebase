// Guard rails: existing data is checked against schema changes, queries and mutations can't
// call fetch(), and the HTTP layer enforces CORS origins and rate limits.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import type { Driver } from "../src/engine/driver";
import { parseRateLimit, RateLimiter } from "../src/engine/http";
import { Runtime } from "../src/engine/runtime";
import { action, defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime, quiet } from "./helpers";

for (const D of DRIVERS) describe(`${D.name}: schema changes are checked against existing data`, () => {
  const loose = defineSchema({ people: defineTable({ name: v.string(), age: v.optional(v.number()) }) });
  const strict = defineSchema({ people: defineTable({ name: v.string(), age: v.number() }) });
  const relaxed = defineSchema({ people: defineTable({ name: v.string(), age: v.number() }) }, { schemaValidation: false });
  const modules = {
    people: {
      add: mutation({ args: { name: v.string(), age: v.optional(v.number()) }, handler: (ctx, a) => ctx.db.insert("people", a as any) }),
      setAge: mutation({ args: { id: v.string(), age: v.number() }, handler: (ctx, { id, age }) => ctx.db.patch(id as any, { age }) }),
    },
  };
  let dir: string;
  let driver: Driver;
  const open = async (schema: any) => {
    const runtime = new Runtime({ driver, schema, modules, log: quiet });
    await runtime.init();
    return runtime;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onebase-schema-"));
  });
  afterEach(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stricter schema is refused until the data matches", async () => {
    const first = await openRuntime(() => D.make(dir), { schema: loose, modules });
    driver = first.driver;
    await first.runtime.runMutation("people:add", { name: "ali", age: 30 });
    const sara = (await first.runtime.runMutation("people:add", { name: "sara" })) as string;
    first.runtime.stop();

    const err = (await open(strict).catch((e) => e)) as Error;
    expect(err.message).toContain("schema.ts doesn't match 1 existing document");
    expect(err.message).toContain(`people ${sara}: document.age is required`);
    expect(err.message).toContain("schemaValidation: false");

    // The documented way out: turn validation off, fix the data, turn it back on.
    const fixing = await open(relaxed);
    await fixing.runMutation("people:setAge", { id: sara, age: 25 });
    fixing.stop();
    (await open(strict)).stop();
    // Once a schema has been checked, its fingerprint is stored.
    expect(await driver.read((tx) => tx.get("SELECT value FROM _meta WHERE key = 'schema'"))).not.toBeNull();
  });
});

describe("fetch() is only for actions", () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;

  beforeAll(() => {
    server = Bun.serve({ port: 0, fetch: () => new Response("pong") });
    url = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-guard-"));
    const modules = {
      net: {
        inQuery: query({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() }),
        inMutation: mutation({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() }),
        inAction: action({ args: { url: v.string() }, handler: async (_ctx, { url }) => (await fetch(url)).text() }),
        viaQuery: action({ args: { url: v.string() }, handler: (ctx, args) => ctx.runQuery("net:inQuery" as any, args) }),
      },
    };
    ({ driver, runtime } = await openRuntime(() => DRIVERS[0]!.make(dir), { schema: null, modules }));
  });
  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("queries and mutations get an explanation; actions work", async () => {
    const q = (await runtime.runQuery("net:inQuery", { url }).catch((e) => e)) as Error;
    expect(q.message).toContain('fetch() isn\'t allowed in query "net:inQuery"');
    expect(q.message).toContain("Call it from an action");
    const m = (await runtime.runMutation("net:inMutation", { url }).catch((e) => e)) as Error;
    expect(m.message).toContain('fetch() isn\'t allowed in mutation "net:inMutation"');
    expect(await runtime.runAction("net:inAction", { url })).toBe("pong");
    // The rule follows the function that's running, not the caller.
    expect(((await runtime.runAction("net:viaQuery", { url }).catch((e) => e)) as Error).message).toContain("isn't allowed in query");
    // onebase's own code (and code outside functions) is unaffected.
    expect(await (await fetch(url)).text()).toBe("pong");
  });
});

describe("HTTP: CORS origins and rate limits", () => {
  const modules = { ping: { ping: query({ args: {}, handler: () => "pong" }) } };
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-http-"));
    app = await startApp({
      schema: null,
      modules,
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
      cors: ["https://app.example.com"],
      rateLimit: { max: 3, windowMs: 60_000 },
    });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const call = (origin?: string) =>
    fetch(`${base}/api/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ path: "ping:ping", args: {} }),
    });

  test("only listed origins get CORS headers, and WebSockets from other origins are refused", async () => {
    const preflight = await fetch(`${base}/api/query`, { method: "OPTIONS", headers: { Origin: "https://app.example.com" } });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    const other = await fetch(`${base}/api/query`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(other.headers.get("Vary")).toBe("Origin");
    const ws = await fetch(`${base}/api/sync`, { headers: { Origin: "https://evil.example", Upgrade: "websocket" } });
    expect(ws.status).toBe(403);
  });

  test("function calls beyond the limit get 429 with Retry-After", async () => {
    // The CORS test above made no counted calls; three are allowed per minute.
    for (let i = 0; i < 3; i++) expect((await call("https://app.example.com")).status).toBe(200);
    const res = await call("https://app.example.com");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(((await res.json()) as any).errorMessage).toContain("Too many requests (limit: 3 per minute)");
    // Health checks and file downloads aren't counted.
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  test("WebSocket frames that are JSON but not messages are ignored", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/sync`);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(String(e.data)));
    await new Promise((resolve) => (ws.onopen = resolve));
    for (const frame of ["null", "5", "true", '"x"', "[]"]) ws.send(frame);
    // The connection still works afterwards: an auth message gets its answer.
    ws.send(JSON.stringify({ type: "auth", token: null }));
    for (let i = 0; i < 50 && !messages.some((m) => m.type === "auth"); i++) await Bun.sleep(10);
    expect(messages.find((m) => m.type === "auth")).toMatchObject({ ok: true, identity: null });
    ws.close();
  });
});

describe("rate limiter", () => {
  test("parses limits", () => {
    expect(parseRateLimit("100/10s")).toEqual({ max: 100, windowMs: 10_000 });
    expect(parseRateLimit("600/m")).toEqual({ max: 600, windowMs: 60_000 });
    expect(parseRateLimit("5000/h")).toEqual({ max: 5000, windowMs: 3_600_000 });
    expect(() => parseRateLimit("lots")).toThrow("use requests/window");
  });

  test("refills continuously per client", () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.take("a", 0)).toBe(0);
    expect(limiter.take("a", 0)).toBe(0);
    expect(limiter.take("a", 0)).toBe(500); // one token every 500ms
    expect(limiter.take("b", 0)).toBe(0); // other clients have their own bucket
    expect(limiter.take("a", 500)).toBe(0);
    expect(limiter.describe()).toBe("2 per second");
  });
});
