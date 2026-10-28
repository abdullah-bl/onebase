// Components beyond calls: exposing functions to clients, function handles, the scheduler,
// cron jobs, HTTP routes, and the sharded counter.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { componentServer, defineComponent, defineComponents, type ComponentsApi } from "../src/components";
import { shardedCounter } from "../src/components/sharded-counter";
import type { Driver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { anyApi, createFunctionHandle, defineSchema, defineTable, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime, quiet } from "./helpers";

const pingerSchema = defineSchema({ ticks: defineTable({ n: v.number() }) });
const c = componentServer<any, {}>();
const tick = c.internalMutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db.query("ticks").first();
    if (row) await ctx.db.patch(row._id, { n: row.n + 1 });
    else await ctx.db.insert("ticks", { n: 1 });
    return null;
  },
});
const pinger = defineComponent({
  name: "pinger",
  schema: pingerSchema,
  functions: {
    hello: c.query({ args: {}, handler: () => "hello" }),
    whoami: c.query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null }),
    ping: c.mutation({ args: {}, handler: () => "pong" }),
    secret: c.internalQuery({ args: {}, handler: () => "secret" }),
    tick,
    ticks: c.query({ args: {}, handler: async (ctx) => (await ctx.db.query("ticks").first())?.n ?? 0 }),
    callBack: c.mutation({ args: { fn: v.string(), text: v.string() }, handler: (ctx, { fn, text }) => ctx.runMutation(fn as any, { text }) }),
    later: c.mutation({ args: { fn: v.string(), text: v.string() }, handler: (ctx, { fn, text }) => ctx.scheduler.runAfter(0, fn as any, { text }) }),
    forge: c.mutation({ args: {}, handler: (ctx) => ctx.runMutation("function://notes:add#AAAAAAAAAAAAAAAAAAAAAA" as any, { text: "forged" }) }),
    byName: c.mutation({ args: {}, handler: (ctx) => (ctx.runMutation as any)("notes:add", { text: "by name" }) }),
    scheduleTick: c.mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(60_000, tick, {}) }),
    cancel: c.mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.scheduler.cancel(id) }),
    ownHandle: c.mutation({ args: {}, handler: async (ctx) => ctx.runMutation(await createFunctionHandle(tick), {}) }),
  },
  crons: () => [{ name: "tick", schedule: { seconds: 1 }, fn: tick }],
  http: () => [
    {
      path: "/hello",
      method: "GET",
      handler: c.httpAction(async (ctx) => new Response(`hello from ${ctx.component.mount}, ${(await ctx.auth.getUserIdentity())?.subject ?? "anonymous"}`)),
    },
  ],
});

const components = defineComponents({
  p: pinger.mount({}, { expose: ["hello", "whoami"], auth: true }),
  q: pinger.mount({}, { httpPrefix: "/custom" }),
  r: pinger.mount({}, { httpPrefix: false }),
  counter: shardedCounter({ shards: 4, perName: { hot: 8 } }),
});

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const modules = {
  notes: {
    add: internalMutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) }),
    list: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) }),
    viaReference: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.callBack({ fn: anyApi.notes.add, text: "via reference" }) }),
    viaHandle: mutation({
      args: {},
      handler: async (ctx: any) => ctx.components.p.callBack({ fn: await createFunctionHandle(anyApi.notes.add), text: "via handle" }),
    }),
    later: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.later({ fn: anyApi.notes.add, text: "later" }) }),
    forge: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.forge() }),
    byName: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.byName() }),
    appJob: mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(60_000, "notes:add" as any, { text: "job" }) }),
    componentCancels: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.p.cancel({ id }) }),
    componentJob: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.scheduleTick() }),
    ownHandle: mutation({ args: {}, handler: (ctx: any) => ctx.components.p.ownHandle() }),
    handle: mutation({ args: {}, handler: () => createFunctionHandle(anyApi.notes.add) }),
    count: query({ args: { name: v.string() }, handler: (ctx: any, { name }) => ctx.components.counter.count({ name }) }),
    estimate: query({ args: { name: v.string(), readShards: v.number() }, handler: (ctx: any, a) => ctx.components.counter.estimateCount(a) }),
    bump: mutation({ args: { op: v.string(), args: v.any() }, handler: (ctx: any, { op, args }) => ctx.components.counter[op](args) }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: component platform`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-platform-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const notes = async () => (await runtime.runQuery("notes:list", {})).value as string[];
  const jobState = async (id: string) => (await runtime.adminRead((_db, tx) => tx.get("SELECT state FROM _scheduled WHERE id = ?", [id])))?.state;

  test("clients call exposed functions only", async () => {
    expect((await runtime.runQuery("components/p:hello", {})).value).toBe("hello");
    await expect(runtime.runMutation("components/p:ping", {})).rejects.toThrow("is internal");
    await expect(runtime.runQuery("components/q:hello", {})).rejects.toThrow("is internal");
    // Exposed and mounted with auth: the client's identity reaches the component.
    const identity = { subject: "u1", tokenIdentifier: "test|u1" };
    expect((await runtime.runQuery("components/p:whoami", {}, { identity })).value).toBe("u1");
  });

  test("components call app functions only through handles the app gave them", async () => {
    await runtime.runMutation("notes:viaReference", {});
    await runtime.runMutation("notes:viaHandle", {});
    expect(await notes()).toEqual(["via reference", "via handle"]);
    await expect(runtime.runMutation("notes:forge", {})).rejects.toThrow("Invalid function handle");
    await expect(runtime.runMutation("notes:byName", {})).rejects.toThrow('Component "p" can\'t call the app\'s "notes:add"');
    expect(await runtime.runMutation("notes:ownHandle", {})).toBeNull();
  });

  test("handles can't be called by clients, and work on another instance of the same database", async () => {
    const handle = (await runtime.runMutation("notes:handle", {})) as string;
    expect(handle).toMatch(/^function:\/\/notes:add#/);
    await expect(runtime.runMutation(handle, { text: "x" })).rejects.toThrow("can only be called from other functions");
    const other = new Runtime({ driver, schema, modules, components: components as any, log: quiet });
    await other.init();
    await other.runMutation(handle, { text: "elsewhere" }, { allowInternal: true });
    other.stop();
    expect(await notes()).toEqual(["elsewhere"]);
  });

  test("a component schedules a handle; it cancels only its own jobs", async () => {
    await runtime.runMutation("notes:later", {});
    await runtime.startScheduler();
    for (let i = 0; i < 50 && !(await notes()).length; i++) await Bun.sleep(20);
    expect(await notes()).toEqual(["later"]);

    const appJob = (await runtime.runMutation("notes:appJob", {})) as string;
    await runtime.runMutation("notes:componentCancels", { id: appJob });
    expect(await jobState(appJob)).toBe("pending");
    const ownJob = (await runtime.runMutation("notes:componentJob", {})) as string;
    await runtime.runMutation("notes:componentCancels", { id: ownJob });
    expect(await jobState(ownJob)).toBe("canceled");
  });

  test("component cron jobs run under the mount's name", async () => {
    await runtime.startScheduler();
    const ticks = async () => (await runtime.runQuery("components/p:ticks", {}, { allowInternal: true, source: "dashboard" })).value as number;
    for (let i = 0; i < 60 && !(await ticks()); i++) await Bun.sleep(50);
    expect(await ticks()).toBeGreaterThan(0);
    const names = (await runtime.adminRead((_db, tx) => tx.all("SELECT name FROM _crons ORDER BY name"))).map((r) => r.name);
    expect(names).toEqual(["components/p/tick", "components/q/tick", "components/r/tick"]);
  }, 10_000);

  test("the sharded counter", async () => {
    const bump = (op: string, args: object) => runtime.runMutation("notes:bump", { op, args });
    for (let i = 0; i < 20; i++) await bump("inc", { name: "views" });
    await bump("add", { name: "views", count: 5, shard: 3 });
    await bump("dec", { name: "views" });
    expect((await runtime.runQuery("notes:count", { name: "views" })).value).toBe(24);
    expect((await runtime.runQuery("notes:estimate", { name: "views", readShards: 4 })).value).toBe(24);
    await expect(bump("add", { name: "views", shard: 4 })).rejects.toThrow('Counter "views" has shards 0 to 3, not 4.');
    await bump("add", { name: "hot", shard: 7 });
    const shards = await runtime.adminRead((_db, tx) => tx.all("SELECT COUNT(*) AS n FROM documents WHERE tbl = 'counter.counters'"));
    expect(Number(shards[0]!.n)).toBeLessThanOrEqual(5);
    await bump("reset", { name: "views" });
    expect((await runtime.runQuery("notes:count", { name: "views" })).value).toBe(0);
  });
});

test("component HTTP routes are served under the mount's prefix", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-platform-http-"));
  const app = await startApp({ schema, modules, components: components as any, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  try {
    const base = `http://127.0.0.1:${app.server.port}`;
    expect(await (await fetch(`${base}/p/hello`)).text()).toBe("hello from p, anonymous");
    expect(await (await fetch(`${base}/custom/hello`)).text()).toBe("hello from q, anonymous");
    expect((await fetch(`${base}/q/hello`)).status).toBe(404);
    expect((await fetch(`${base}/r/hello`)).status).toBe(404);
    // Exposed functions go through the usual HTTP API.
    const res = await fetch(`${base}/api/query`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "components/p:hello", args: {} }) });
    expect(await res.json()).toMatchObject({ status: "success", value: "hello" });
    readFileSync(join(dataDir, "admin.key"));
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("mount options are checked", () => {
  expect(() => pinger.mount({}, { expose: ["nope" as any] })).toThrow('can\'t expose "nope": it has no such function.');
  expect(() => pinger.mount({}, { expose: ["secret" as any] })).toThrow('can\'t expose "secret": it\'s internal to the component.');
  expect(() => pinger.mount({}, { httpPrefix: "/trailing/" })).toThrow("httpPrefix must be a path");
  expect(() => new Runtime({ driver: {} as any, schema, modules: {}, components: defineComponents({ x: pinger.mount({}, { httpPrefix: "/api/x" }) }) as any, log: quiet })).toThrow(
    'httpPrefix "/api/x" is taken by onebase itself',
  );
});

// Type checks: never run, only compiled by `bun run typecheck`.
function _types(api: ComponentsApi<typeof components, "public">, internal: ComponentsApi<typeof components, "internal">) {
  const hello = api.p.hello;
  // @ts-expect-error: not exposed
  void api.p.ping;
  // @ts-expect-error: q exposes nothing
  void api.q.hello;
  const ping = internal.q.ping;
  // @ts-expect-error: internal to the component
  void internal.p.secret;
  return [hello, ping];
}
void _types;
