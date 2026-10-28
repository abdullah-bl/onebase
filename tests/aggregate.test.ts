import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentServer, defineComponent, defineComponents, tableChangesValidator } from "../src/components";
import { aggregate } from "../src/components/aggregate";
import { at, compareItems, compareKeys, countBefore, insert, remove, type Item, type NodeDoc, type Store } from "../src/components/aggregate/btree";
import type { Driver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime, quiet } from "./helpers";

// ---- The tree on its own, against a sorted array ----

function memoryStore(): Store & { size(): number } {
  const nodes = new Map<string, NodeDoc>();
  let next = 0;
  return {
    size: () => nodes.size,
    node: async (id) => structuredClone(nodes.get(id)!),
    newNode: async (fields) => {
      const id = `n${next++}`;
      nodes.set(id, { _id: id, ...structuredClone(fields) });
      return id;
    },
    saveNode: async (id, fields) => void nodes.set(id, { ...nodes.get(id)!, ...structuredClone(fields) }),
    deleteNode: async (id) => void nodes.delete(id),
  };
}

test("keys have one total order across types", () => {
  const sorted = [null, false, true, -1, 0, 2.5, "", "a", "b", [], [1], [1, "a"], [2], { a: 1 }];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = 0; j < sorted.length; j++) expect(Math.sign(compareKeys(sorted[i], sorted[j]))).toBe(Math.sign(i - j));
  }
});

test("random inserts and removals keep counts, sums, ranks and positions right", async () => {
  const store = memoryStore();
  let root = await store.newNode({ leaf: true, items: [], children: [] });
  let model: Item[] = [];
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  for (let step = 0; step < 2000; step++) {
    if (model.length && rand(3) === 0) {
      const victim = model[rand(model.length)]!;
      const r = await remove(store, root, victim);
      expect(r.removed).toEqual(victim);
      root = r.root;
      model = model.filter((x) => x !== victim);
    } else {
      const x: Item = { k: rand(50), id: `d${step}`, s: rand(10) };
      root = await insert(store, root, x, 4);
      model.push(x);
      model.sort(compareItems);
    }
    if (step % 97 === 0 || step === 1999) {
      for (let i = 0; i < model.length; i += 7) expect(await at(store, root, i)).toEqual(model[i]!);
      expect(await at(store, root, model.length)).toBeNull();
      for (const key of [0, 10, 25, 49, 60]) {
        const before = model.filter((x) => compareKeys(x.k, key) < 0);
        expect(await countBefore(store, root, (x) => compareKeys(x.k, key) < 0)).toEqual({ count: before.length, sum: before.reduce((n, x) => n + x.s, 0) });
      }
    }
  }
  expect((await remove(store, root, { k: 999, id: "nope" })).removed).toBeNull();
  // Emptying the tree leaves one empty leaf.
  for (const x of model) root = (await remove(store, root, x)).root;
  expect(await store.node(root)).toMatchObject({ leaf: true, items: [] });
  expect(store.size()).toBe(1);
});

// ---- The component, following a table ----

const schema = defineSchema({
  scores: defineTable({ player: v.string(), points: v.number(), game: v.optional(v.string()), hidden: v.optional(v.boolean()) }),
});

type Score = { player: string; points: number; game?: string; hidden?: boolean };
const components = defineComponents({
  board: aggregate({
    table: "scores",
    sortKey: (d: Score) => d.points,
    sumValue: (d) => d.points,
    filter: (d: { hidden?: boolean }) => !d.hidden,
  }),
  byGame: aggregate({ table: "scores", sortKey: (d: Score) => d.points, namespace: (d) => d.game ?? "none" }),
  manual: aggregate<string>({ maxNodeSize: 4 }),
});

const call = (fn: string, kind: "query" | "mutation" = "query") =>
  (kind === "query" ? (query as any) : (mutation as any))({
    args: { mount: v.string(), args: v.any() },
    handler: (ctx: any, { mount, args }: { mount: string; args: unknown }) => ctx.components[mount][fn](args),
  });

const modules = {
  scores: {
    add: mutation({ args: { player: v.string(), points: v.number(), game: v.optional(v.string()), hidden: v.optional(v.boolean()) }, handler: (ctx, a) => ctx.db.insert("scores", a) }),
    set: mutation({ args: { id: v.string(), points: v.number() }, handler: (ctx, { id, points }) => ctx.db.patch(id as any, { points }) }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
    /** Read-your-writes: the aggregate sees this mutation's own insert. */
    addAndCount: mutation({
      args: { points: v.number() },
      handler: async (ctx: any, { points }) => {
        await ctx.db.insert("scores", { player: "x", points });
        return ctx.components.board.count();
      },
    }),
    addAndFail: mutation({
      args: { points: v.number() },
      handler: async (ctx: any, { points }) => {
        await ctx.db.insert("scores", { player: "x", points });
        await ctx.components.board.count();
        throw new Error("changed my mind");
      },
    }),
    nestedFail: mutation({
      args: {},
      handler: async (ctx: any) => {
        await ctx.runMutation("scores:addAndFail", { points: 1000 }).catch(() => {});
        return ctx.components.board.max();
      },
    }),
    manualByHand: mutation({ args: {}, handler: (ctx: any) => ctx.components.board.insert({ key: 1, id: "x" }) }),
    count: call("count"),
    sum: call("sum"),
    indexOf: call("indexOf"),
    at: call("at"),
    min: call("min"),
    max: call("max"),
    paginate: call("paginate"),
    status: call("status"),
    insert: call("insert", "mutation"),
    delete: call("delete", "mutation"),
    replace: call("replace", "mutation"),
    clear: call("clear", "mutation"),
  },
};

for (const D of DRIVERS) describe(`${D.name}: aggregate`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-aggregate-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.hooksReady();
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (player: string, points: number, extra: object = {}) => runtime.runMutation("scores:add", { player, points, ...extra }) as Promise<string>;
  const q = async (fn: string, args: object = {}, mount = "board") => (await runtime.runQuery(`scores:${fn}`, { mount, args })).value as any;
  const m = (fn: string, args: object = {}, mount = "board") => runtime.runMutation(`scores:${fn}`, { mount, args }) as Promise<any>;

  test("follows inserts, patches and deletes", async () => {
    const a = await add("ana", 30);
    const b = await add("bo", 10);
    await add("cy", 20);
    await add("di", 99, { hidden: true }); // filtered out
    expect(await q("count")).toBe(3);
    expect(await q("sum")).toBe(60);
    expect(await q("min")).toEqual({ key: 10, id: b, sumValue: 10 });
    expect(await q("max")).toEqual({ key: 30, id: a, sumValue: 30 });
    expect(await q("indexOf", { key: 20 })).toBe(1);
    expect(await q("indexOf", { key: 20, order: "desc" })).toBe(1);
    expect(await q("indexOf", { key: 30, order: "desc" })).toBe(0);
    expect(await q("at", { index: 0, order: "desc" })).toMatchObject({ id: a });

    await runtime.runMutation("scores:set", { id: b, points: 50 });
    expect(await q("max")).toMatchObject({ id: b, key: 50 });
    expect(await q("sum")).toBe(100);
    await runtime.runMutation("scores:remove", { id: a });
    expect(await q("count")).toBe(2);
    expect(await q("sum")).toBe(70);
  });

  test("bounds, pagination and namespaces", async () => {
    for (let i = 1; i <= 10; i++) await add(`p${i}`, i * 10, { game: i % 2 ? "odd" : "even" });
    expect(await q("count", { bounds: { lower: { key: 30, inclusive: true }, upper: { key: 60, inclusive: false } } })).toBe(3);
    expect(await q("sum", { bounds: { lower: { key: 30, inclusive: false } } })).toBe(40 + 50 + 60 + 70 + 80 + 90 + 100);
    const first = await q("paginate", { numItems: 4, order: "desc" });
    expect(first.page.map((x: any) => x.key)).toEqual([100, 90, 80, 70]);
    expect(first.isDone).toBe(false);
    const second = await q("paginate", { numItems: 4, order: "desc", cursor: first.continueCursor });
    expect(second.page.map((x: any) => x.key)).toEqual([60, 50, 40, 30]);
    const third = await q("paginate", { numItems: 4, order: "desc", cursor: second.continueCursor });
    expect(third.page.map((x: any) => x.key)).toEqual([20, 10]);
    expect(third.isDone).toBe(true);
    const asc = await q("paginate", { numItems: 3, bounds: { lower: { key: 50, inclusive: true } } });
    expect(asc.page.map((x: any) => x.key)).toEqual([50, 60, 70]);
    expect(await q("count", { namespace: "odd" }, "byGame")).toBe(5);
    expect(await q("max", { namespace: "even" }, "byGame")).toMatchObject({ key: 100 });
    expect(await q("count", { namespace: "nope" }, "byGame")).toBe(0);
  });

  test("a mutation sees its own writes in the aggregate; rolled-back writes never reach it", async () => {
    await add("a", 1);
    expect(await runtime.runMutation("scores:addAndCount", { points: 5 })).toBe(2);
    await expect(runtime.runMutation("scores:addAndFail", { points: 7 })).rejects.toThrow("changed my mind");
    expect(await q("count")).toBe(2);
    // A nested mutation that fails after the aggregate saw its write: both are rolled back.
    expect(await runtime.runMutation("scores:nestedFail", {})).toMatchObject({ key: 5 });
    expect(await q("count")).toBe(2);
  });

  test("dashboard edits update it too", async () => {
    await runtime.adminWrite((db) => db.insert("scores", { player: "admin", points: 3 }));
    expect(await q("count")).toBe(1);
  });

  test("queries over it are live: they read its tables", async () => {
    const { readSet } = await runtime.runQuery("scores:count", { mount: "board", args: {} });
    expect(readSet.ranges.map((r) => r.table)).toEqual(["board.trees"]);
  });

  test("manual mode: insert, delete, replace, clear; table mode refuses them", async () => {
    for (const [i, name] of ["d", "a", "c", "b", "e", "f"].entries()) await m("insert", { key: name, id: `i${i}`, sumValue: i }, "manual");
    expect((await q("paginate", { numItems: 10 }, "manual")).page.map((x: any) => x.key)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(await m("delete", { key: "a", id: "i1" }, "manual")).toBe(true);
    expect(await m("delete", { key: "a", id: "i1" }, "manual")).toBe(false);
    await m("replace", { from: { key: "f", id: "i5" }, to: { key: "0", id: "i5", sumValue: 1 } }, "manual");
    expect(await q("min", {}, "manual")).toMatchObject({ key: "0", id: "i5" });
    await m("clear", {}, "manual");
    expect(await q("count", {}, "manual")).toBe(0);
    await expect(runtime.runMutation("scores:manualByHand", {})).rejects.toThrow('follows table "scores" and updates itself');
  });

  test("documents written before it was mounted are added in the background", async () => {
    runtime.stop();
    await driver.close();
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
    // More than one backfill batch (200 rows).
    for (let i = 0; i < 250; i++) await add(`p${i}`, i);
    runtime.stop();

    runtime = new Runtime({ driver, schema, modules, components: components as any, log: quiet });
    await runtime.init();
    // Writes while it catches up: one inside what the backfill has read, one past it.
    const early = (await runtime.adminRead((db) => db.query("scores").first()))!._id;
    await runtime.runMutation("scores:set", { id: early, points: 1000 });
    await add("late", 2000);
    await runtime.hooksReady();
    expect(await q("status")).toMatchObject({ ready: true, state: "ready" });
    expect(await q("count")).toBe(251);
    expect(await q("max")).toMatchObject({ key: 2000 });
    expect(await q("indexOf", { key: 1000, order: "desc" })).toBe(1);
    expect(await q("count", { namespace: "none" }, "byGame")).toBe(251);
  }, 30_000);

  test("a different sortKey rebuilds it", async () => {
    await add("a", 1);
    await add("b", 2);
    runtime.stop();
    const flipped = defineComponents({ board: aggregate({ table: "scores", sortKey: (d: { points: number }) => -d.points }) });
    runtime = new Runtime({ driver, schema, modules, components: flipped as any, log: quiet });
    await runtime.init();
    await runtime.hooksReady();
    expect(await q("count")).toBe(2);
    expect(await q("min")).toMatchObject({ key: -2 });
  });
});

describe("table hooks", () => {
  // A hook that refuses some documents: the whole mutation must fail with it.
  const s = defineSchema({ notes: defineTable({ text: v.string() }) });
  const c = componentServer<any, {}>();
  const seen = defineSchema({ log: defineTable({ text: v.string() }) });
  const onChange = c.internalMutation({
    args: tableChangesValidator,
    handler: async (ctx, { changes }) => {
      for (const ch of changes) {
        if (ch.after?.text === "bad") throw new Error("hook refused it");
        await ctx.db.insert("log", { text: `${ch.op}:${ch.after?.text ?? ch.before?.text}` });
      }
      return null;
    },
  });
  const log = c.query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).map((d: any) => d.text) });
  const watcher = defineComponent({ name: "watcher", schema: seen, functions: { onChange, log }, hooks: () => [{ table: "notes", onChange }] });
  const mods = {
    notes: {
      add: mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) }),
      churn: mutation({
        args: {},
        handler: async (ctx: any) => {
          const id = await ctx.db.insert("notes", { text: "one" });
          await ctx.db.patch(id, { text: "two" });
          const gone = await ctx.db.insert("notes", { text: "temp" });
          await ctx.db.delete(gone);
        },
      }),
      log: query({ args: {}, handler: (ctx: any) => ctx.components.w.log() }),
    },
  };

  test("changes are coalesced per document; a failing hook fails the mutation", async () => {
    const runtime = new Runtime({ driver: new (await import("../src/engine/driver")).SqliteDriver(":memory:"), schema: s, modules: mods, components: defineComponents({ w: watcher.mount({}) }) as any, log: quiet });
    await runtime.init();
    await runtime.hooksReady();
    await runtime.runMutation("notes:churn", {});
    expect((await runtime.runQuery("notes:log", {})).value).toEqual(["insert:two"]);
    await expect(runtime.runMutation("notes:add", { text: "bad" })).rejects.toThrow("hook refused it");
    expect(await runtime.adminRead((db) => db.query("notes").collect())).toHaveLength(1);
    runtime.stop();
  });

  test("hooks must follow app tables and run the component's own mutations", () => {
    const other = c.internalMutation({ args: tableChangesValidator, handler: () => null });
    const bad = defineComponent({ name: "bad", schema: seen, functions: { onChange }, hooks: () => [{ table: "nope", onChange }] });
    const stray = defineComponent({ name: "stray", schema: seen, functions: { onChange }, hooks: () => [{ table: "notes", onChange: other }] });
    const make = (comp: any) => new Runtime({ driver: {} as any, schema: s, modules: {}, components: defineComponents({ x: comp.mount({}) }) as any, log: quiet });
    expect(() => make(bad)).toThrow('Component "x" (bad) follows table "nope", which isn\'t in schema.ts. Known tables: notes.');
    expect(() => make(stray)).toThrow("a table hook's onChange must be one of its own mutations");
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").QueryCtx<any, typeof components>) {
  const n: number = await ctx.components.board.count({ bounds: { lower: { key: 10, inclusive: true } } });
  const top = await ctx.components.board.max();
  const points: number | undefined = top?.key;
  // @ts-expect-error: keys are numbers here
  await ctx.components.board.indexOf({ key: "ten" });
  const games: number = await ctx.components.byGame.count({ namespace: "odd" });
  // @ts-expect-error: insert is for aggregates without a table
  await ctx.components.board.insert;
  return [n, points, games];
}
void _types;
