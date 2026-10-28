import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentServer, defineComponent, defineComponents } from "../src/components";
import { isRateLimitError, MINUTE, rateLimiter } from "../src/components/rate-limiter";
import { indexIdent } from "../src/engine/catalog";
import { isIdForTable } from "../src/engine/dialect";
import type { Driver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { action, defineSchema, defineTable, mutation, query, type DataModelFromSchema } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime, quiet } from "./helpers";

// A small component: notes, with a prefix from its configuration.
const noteSchema = defineSchema({ notes: defineTable({ text: v.string() }).index("by_text", ["text"]) });
const c = componentServer<DataModelFromSchema<typeof noteSchema>, { prefix: string }>();
const add = c.mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text: ctx.config.prefix + text }) });
const list = c.query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) });
const secret = c.internalMutation({ args: {}, handler: () => "secret" });
const notes = defineComponent({
  name: "notes",
  schema: noteSchema,
  functions: {
    add,
    list,
    secret,
    nested: { list },
    fail: c.mutation({
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        await ctx.db.insert("notes", { text });
        throw new Error("component failed");
      },
    }),
    whoAmI: c.query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null }),
    callsSecret: c.mutation({ args: {}, handler: (ctx) => ctx.runMutation(secret, {}) }),
    peek: c.query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.get(id as any) }),
    touch: c.mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.patch(id as any, { text: "x" }) }),
    readApp: c.query({ args: {}, handler: (ctx) => (ctx.db as any).query("messages").collect() }),
    badInsert: c.mutation({ args: {}, handler: (ctx) => ctx.db.insert("notes", { text: 5 } as any) }),
    addLater: c.mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(0, add, { text: "later" }) }),
    roundTrip: c.action({
      args: {},
      handler: async (ctx) => {
        await ctx.runMutation(add, { text: "from action" });
        return ctx.runQuery(list, {});
      },
    }),
  },
  checkConfig: (config: { prefix: string }) => {
    if (typeof config?.prefix !== "string") throw new Error("notes needs a prefix");
  },
});

const components = defineComponents({
  a: notes.mount({ prefix: "a:" }),
  b: notes.mount({ prefix: "b:" }, { auth: true }),
  limiter: rateLimiter({ rates: { send: { kind: "token bucket", rate: 2, period: MINUTE } } }),
});
type C = typeof components;

const schema = defineSchema({ messages: defineTable({ body: v.string() }) });
const m = <T>(x: T) => x as any;

const modules = {
  messages: {
    send: mutation({
      args: { body: v.string() },
      handler: async (ctx: any, { body }) => {
        await ctx.components.limiter.limit({ name: "send", throws: true });
        return ctx.db.insert("messages", { body });
      },
    }),
    addNote: mutation({ args: { mount: v.string(), text: v.string() }, handler: (ctx: any, { mount, text }) => ctx.components[mount].add({ text }) }),
    notes: query({ args: { mount: v.string() }, handler: (ctx: any, { mount }) => ctx.components[mount].list() }),
    nestedNotes: query({ args: {}, handler: (ctx: any) => ctx.components.a.nested.list() }),
    keepGoing: mutation({
      args: {},
      handler: async (ctx: any) => {
        await ctx.db.insert("messages", { body: "kept" });
        await ctx.components.a.fail({ text: "rolled back" }).catch(() => {});
      },
    }),
    giveUp: mutation({
      args: {},
      handler: async (ctx: any) => {
        await ctx.db.insert("messages", { body: "lost" });
        await ctx.components.a.fail({ text: "lost too" });
      },
    }),
    queryCallsMutation: query({ args: {}, handler: (ctx: any) => ctx.components.a.add({ text: "x" }) }),
    readComponentTable: query({ args: { table: v.string() }, handler: (ctx: any, { table }) => ctx.db.query(table).collect() }),
    get: query({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.db.get(id) }),
    patch: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.db.patch(id, { body: "x" }) }),
    who: query({ args: { mount: v.string() }, handler: (ctx: any, { mount }) => ctx.components[mount].whoAmI() }),
    callInternal: mutation({ args: {}, handler: (ctx: any) => ctx.runMutation("components/a:secret", {}) }),
    callInternalByProxy: mutation({ args: {}, handler: (ctx: any) => ctx.components.a.secret() }),
    viaComponent: mutation({ args: {}, handler: (ctx: any) => ctx.components.a.callsSecret() }),
    later: mutation({ args: {}, handler: (ctx: any) => ctx.components.a.addLater() }),
    fromAction: action({
      args: {},
      handler: async (ctx: any) => {
        await ctx.components.a.add({ text: "act" });
        return { notes: await ctx.components.a.list(), roundTrip: await ctx.components.b.roundTrip() };
      },
    }),
    badArgs: mutation({ args: {}, handler: (ctx: any) => ctx.components.a.add({ text: 5 }) }),
    badInsert: mutation({ args: {}, handler: (ctx: any) => ctx.components.a.badInsert() }),
    unknown: mutation({ args: {}, handler: (ctx: any) => ctx.components.nope.add({}) }),
    peek: query({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.a.peek({ id }) }),
    touch: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.a.touch({ id }) }),
    readApp: query({ args: {}, handler: (ctx: any) => ctx.components.a.readApp() }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: components`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-components-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: m(components) }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const mutate = (name: string, args: Record<string, unknown> = {}, opts = {}) => runtime.runMutation(`messages:${name}`, args, opts);
  const read = async (name: string, args: Record<string, unknown> = {}, opts = {}): Promise<any> => (await runtime.runQuery(`messages:${name}`, args, opts)).value;

  test("the app calls a component's functions; each mount keeps its own tables", async () => {
    const id = (await mutate("addNote", { mount: "a", text: "one" })) as string;
    await mutate("addNote", { mount: "b", text: "two" });
    expect(await read("notes", { mount: "a" })).toEqual(["a:one"]);
    expect(await read("notes", { mount: "b" })).toEqual(["b:two"]);
    expect(await read("nestedNotes")).toEqual(["a:one"]);
    expect(isIdForTable(id, "a.notes")).toBe(true);
    expect(isIdForTable(id, "b.notes")).toBe(false);
    const tables = await runtime.adminRead((_db, tx) => tx.all("SELECT DISTINCT tbl FROM documents ORDER BY tbl"));
    expect(tables.map((r) => r.tbl)).toEqual(["a.notes", "b.notes"]);
  });

  test("the app can't touch a component's tables, nor a component the app's", async () => {
    const noteId = (await mutate("addNote", { mount: "a", text: "one" })) as string;
    const messageId = (await mutate("send", { body: "hi" })) as string;
    await expect(read("readComponentTable", { table: "a.notes" })).rejects.toThrow('belongs to component "a"');
    await expect(read("readComponentTable", { table: "notes" })).rejects.toThrow('Table "notes" is not in schema.ts');
    expect(await read("get", { id: noteId })).toBeNull();
    await expect(mutate("patch", { id: noteId })).rejects.toThrow('belongs to component "a"');
    expect(await read("peek", { id: messageId })).toBeNull();
    await expect(mutate("touch", { id: messageId })).rejects.toThrow("isn't in this component's tables");
    await expect(read("readApp")).rejects.toThrow(`Table "messages" isn't in component "a"'s schema. Its tables: notes.`);
  });

  test("a failing component call rolls back only its own writes when the app catches it", async () => {
    await mutate("keepGoing");
    expect(await read("readComponentTable", { table: "messages" })).toMatchObject([{ body: "kept" }]);
    expect(await read("notes", { mount: "a" })).toEqual([]);
    await expect(mutate("giveUp")).rejects.toThrow("component failed");
    expect(await read("readComponentTable", { table: "messages" })).toHaveLength(1);
  });

  test("queries that call components are reactive to the component's tables", async () => {
    const { readSet } = await runtime.runQuery("messages:notes", { mount: "a" });
    expect(readSet.ranges.map((r) => r.table)).toEqual(["a.notes"]);
  });

  test("queries can only call component queries", async () => {
    await expect(read("queryCallsMutation")).rejects.toThrow("ctx.components.a.add is a mutation; a query can only call component queries.");
  });

  test("components see the caller's identity only when mounted with auth", async () => {
    const identity = { subject: "u1", tokenIdentifier: "test|u1" };
    expect(await read("who", { mount: "a" }, { identity })).toBeNull();
    expect(await read("who", { mount: "b" }, { identity })).toBe("u1");
  });

  test("internal component functions are reachable only from the component", async () => {
    await expect(mutate("callInternal")).rejects.toThrow('"components/a:secret" is internal to component "a"');
    await expect(mutate("callInternalByProxy")).rejects.toThrow("ctx.components.a.secret is internal to the component.");
    expect(await mutate("viaComponent")).toBe("secret");
  });

  test("clients can't call component functions directly", async () => {
    await expect(runtime.runMutation("components/a:add", { text: "x" })).rejects.toThrow("is internal");
  });

  test("actions call components, each call in its own transaction", async () => {
    const result = (await runtime.runAction("messages:fromAction", {})) as any;
    expect(result.notes).toEqual(["a:act"]);
    expect(result.roundTrip).toEqual(["b:from action"]);
  });

  test("a component schedules its own functions", async () => {
    await mutate("later");
    await runtime.startScheduler();
    for (let i = 0; i < 50 && !(await read("notes", { mount: "a" })).length; i++) await Bun.sleep(20);
    expect(await read("notes", { mount: "a" })).toEqual(["a:later"]);
  });

  test("errors name the component function and its table", async () => {
    await expect(mutate("badArgs")).rejects.toThrow('Invalid arguments for "components/a:add"');
    await expect(mutate("badInsert")).rejects.toThrow('Invalid "a.notes" document');
    await expect(mutate("unknown")).rejects.toThrow('No component "nope" in components.ts. Mounted: a, b, limiter.');
  });

  test("the rate limiter allows a burst up to capacity, then refuses until tokens refill", async () => {
    await mutate("send", { body: "1" });
    await mutate("send", { body: "2" });
    const err: any = await mutate("send", { body: "3" }).catch((e) => e);
    expect(isRateLimitError(err)).toBe(true);
    expect(err.data).toMatchObject({ kind: "RateLimited", name: "send" });
    expect(err.data.retryAfter).toBeGreaterThan(0);
    expect(err.data.retryAfter).toBeLessThanOrEqual(30_000);
    // The refused call's message was rolled back with it.
    expect(await read("readComponentTable", { table: "messages" })).toHaveLength(2);
    await runtime.runMutation("components/limiter:reset", { name: "send" }, { allowInternal: true, source: "dashboard" });
    await mutate("send", { body: "4" });
  });

  test("the dashboard reads and edits component tables", async () => {
    await mutate("addNote", { mount: "a", text: "one" });
    const docs = await runtime.adminRead((db) => db.query("a.notes").collect());
    expect(docs.map((d) => d.text)).toEqual(["a:one"]);
    await expect(runtime.adminWrite((db) => db.insert("a.notes", { text: 1 }))).rejects.toThrow('Invalid "a.notes" document');
  });

  test("unmounting a component keeps its data and says so", async () => {
    await mutate("addNote", { mount: "a", text: "kept" });
    runtime.stop();
    const warnings: string[] = [];
    const log = { ...quiet, warn: (w: string) => warnings.push(w) };
    const without = defineComponents({ b: notes.mount({ prefix: "b:" }) });
    runtime = new Runtime({ driver, schema, modules: { messages: { notes: modules.messages.notes } }, components: m(without), log });
    const { dropped } = await runtime.init();
    for (const w of [...warnings]) log.warn(w);
    expect(dropped).toContain(indexIdent("cl", "a.notes", "by_text"));
    expect(warnings.join("\n")).toContain('Component "a" isn\'t mounted in components.ts anymore, but its tables (a.notes) keep their documents.');
    const count = await runtime.adminRead((_db, tx) => tx.get("SELECT COUNT(*) AS n FROM documents WHERE tbl = 'a.notes'"));
    expect(Number(count!.n)).toBe(1);
  });
});

describe("components.ts", () => {
  test("checks mount names and configuration", () => {
    expect(() => defineComponents({ "bad-name": notes.mount({ prefix: "" }) })).toThrow('Invalid component name "bad-name"');
    expect(() => defineComponents({ a: {} as any })).toThrow('"a" must be a mounted component');
    expect(() => notes.mount({} as any)).toThrow("notes needs a prefix");
    expect(() => notes.mount({ prefix: "" }, { nope: true } as any)).toThrow('unknown mount option "nope"');
    expect(() => rateLimiter({ rates: { x: { kind: "token bucket", rate: 0, period: MINUTE } } })).toThrow('Rate limit "x": rate must be a positive number.');
  });

  test("a functions folder can't use the components/ path when components are mounted", () => {
    expect(
      () => new Runtime({ driver: {} as any, schema: null, modules: { "components/x": { f: query({ args: {}, handler: () => 1 }) } }, components: m(components), log: quiet }),
    ).toThrow("reserved for the components mounted in components.ts");
  });

  test("index names stay within Postgres's 63-byte limit and keep their old form when short", () => {
    expect(indexIdent("cl", "messages", "by_author")).toBe("cl_messages__by_author");
    expect(indexIdent("sx", "limiter.rateLimits", "by_name")).toBe("sx_limiter$rateLimits__by_name");
    const long = indexIdent("cl", "a".repeat(40), "b".repeat(40));
    expect(Buffer.byteLength(long)).toBe(63);
    expect(long).not.toBe(indexIdent("cl", "a".repeat(40), "b".repeat(39) + "c"));
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").MutationCtx<any, C>, q: import("../src/server").QueryCtx<any, C>) {
  await ctx.components.limiter.limit({ name: "send" });
  await ctx.components.limiter.limit({ name: "other", config: { kind: "fixed window", rate: 1, period: MINUTE } });
  // @ts-expect-error: not a limit defined in components.ts
  await ctx.components.limiter.limit({ name: "nope" });
  const notes: string[] = await ctx.components.a.list();
  await ctx.components.a.nested.list();
  // @ts-expect-error: internal to the component
  await ctx.components.a.secret();
  // @ts-expect-error: queries can't call component mutations
  await q.components.limiter.limit({ name: "send" });
  await q.components.limiter.check({ name: "send" });
  return notes;
}
void _types;
