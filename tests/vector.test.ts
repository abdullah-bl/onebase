import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorDistanceCos, vector32 } from "../src/engine/dialect";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { action, defineSchema, defineTable, mutation } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const fields = { name: v.string(), kind: v.optional(v.string()), embedding: v.optional(v.array(v.number())) };
const plain = defineSchema({ foods: defineTable(fields) });
const schema = defineSchema({
  foods: defineTable(fields).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 3, filterFields: ["kind"] }),
});

const modules = {
  foods: {
    add: mutation({ args: fields, handler: (ctx, args) => ctx.db.insert("foods", args as any) }),
    setEmbedding: mutation({
      args: { id: v.string(), embedding: v.optional(v.array(v.number())) },
      handler: (ctx, { id, embedding }) => ctx.db.patch(id as any, { embedding }),
    }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
    similar: action({
      args: { vector: v.array(v.number()), limit: v.optional(v.number()), kinds: v.optional(v.array(v.string())) },
      handler: (ctx, { vector, limit, kinds }) =>
        ctx.vectorSearch("foods", "by_embedding", {
          vector,
          limit,
          filter: kinds ? (q) => (kinds.length === 1 ? q.eq("kind", kinds[0]) : q.or(...kinds.map((k) => q.eq("kind", k)))) : undefined,
        }),
    }),
    raw: action({
      args: { index: v.string(), query: v.any() },
      handler: (ctx, { index, query }) => (ctx as any).vectorSearch("foods", index, query),
    }),
  },
};

describe("vector functions for bun:sqlite", () => {
  test("store float32 vectors and measure cosine distance like libSQL", () => {
    const a = vector32("[1, 0, 0]");
    expect(a.byteLength).toBe(12);
    expect(vectorDistanceCos(a, vector32("[2, 0, 0]"))).toBeCloseTo(0);
    expect(vectorDistanceCos(a, vector32("[0, 3, 0]"))).toBeCloseTo(1);
    expect(vectorDistanceCos(a, vector32("[-1, 0, 0]"))).toBeCloseTo(2);
    expect(vectorDistanceCos(a, vector32("[0, 0, 0]"))).toBe(1);
    expect(vectorDistanceCos(a, vector32("[1, 0]"))).toBeNull();
    expect(() => vector32('["a", 1]')).toThrow();
  });
});

for (const D of DRIVERS) describe(`${D.name}: vector indexes`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-vector-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (name: string, embedding?: number[], kind = "fruit") =>
    runtime.runMutation("foods:add", { name, kind, ...(embedding ? { embedding } : {}) }) as Promise<string>;
  const similar = (args: { vector: number[]; limit?: number; kinds?: string[] }) =>
    runtime.runAction("foods:similar", args) as Promise<{ _id: string; _score: number }[]>;

  test("returns the nearest documents by cosine similarity, most similar first", async () => {
    const apple = await add("apple", [1, 0, 0]);
    const pear = await add("pear", [0.9, 0.1, 0]);
    const kale = await add("kale", [0, 1, 0]);
    const tar = await add("tar", [-1, 0, 0]);
    await add("unknown"); // no embedding: not indexed

    const results = await similar({ vector: [1, 0, 0] });
    expect(results.map((r) => r._id)).toEqual([apple, pear, kale, tar]);
    expect(results[0]!._score).toBeCloseTo(1, 5);
    expect(results[1]!._score).toBeCloseTo(0.9 / Math.sqrt(0.82), 5);
    expect(results[2]!._score).toBeCloseTo(0, 5);
    expect(results[3]!._score).toBeCloseTo(-1, 5);
    // Scale doesn't matter, only direction.
    expect((await similar({ vector: [5, 0, 0], limit: 1 })).map((r) => r._id)).toEqual([apple]);
  });

  test("limit defaults to 10", async () => {
    for (let i = 0; i < 12; i++) await add(`f${i}`, [1, i, 0]);
    expect(await similar({ vector: [1, 0, 0] })).toHaveLength(10);
    expect(await similar({ vector: [1, 0, 0], limit: 12 })).toHaveLength(12);
  });

  test("filters on filterFields with eq and or", async () => {
    const apple = await add("apple", [1, 0, 0], "fruit");
    const kale = await add("kale", [1, 0.2, 0], "vegetable");
    const ham = await add("ham", [1, 0.4, 0], "meat");

    expect((await similar({ vector: [1, 0, 0], kinds: ["vegetable"] })).map((r) => r._id)).toEqual([kale]);
    expect((await similar({ vector: [1, 0, 0], kinds: ["meat", "fruit"] })).map((r) => r._id)).toEqual([apple, ham]);
    expect(await similar({ vector: [1, 0, 0], kinds: ["fish"] })).toEqual([]);
  });

  test("follows inserts, edits and deletes", async () => {
    const a = await add("a", [1, 0, 0]);
    const b = await add("b", [0, 1, 0]);
    expect((await similar({ vector: [0, 1, 0], limit: 1 }))[0]!._id).toBe(b);

    await runtime.runMutation("foods:setEmbedding", { id: a, embedding: [0, 1, 0.01] });
    await runtime.runMutation("foods:setEmbedding", { id: b, embedding: [1, 0, 0] });
    expect((await similar({ vector: [0, 1, 0], limit: 1 }))[0]!._id).toBe(a);

    await runtime.runMutation("foods:setEmbedding", { id: a }); // removed from the index
    expect((await similar({ vector: [0, 1, 0] })).map((r) => r._id)).toEqual([b]);

    await runtime.runMutation("foods:remove", { id: b });
    expect(await similar({ vector: [0, 1, 0] })).toEqual([]);
  });

  test("rejects vectors of the wrong size when they're written", async () => {
    await expect(add("bad", [1, 2])).rejects.toThrow('"foods".embedding must be an array of 3 numbers for vector index "by_embedding", got an array of 2');
    expect(await similar({ vector: [1, 0, 0] })).toEqual([]);
  });

  test("explains mistakes", async () => {
    await add("apple", [1, 0, 0]);
    const raw = (index: string, query: unknown) => runtime.runAction("foods:raw", { index, query });
    await expect(raw("nope", { vector: [1, 0, 0] })).rejects.toThrow('Vector index "nope" doesn\'t exist on "foods". Available: by_embedding.');
    await expect(raw("by_embedding", { vector: [1, 0] })).rejects.toThrow("needs a vector of 3 numbers, got an array of 2");
    await expect(raw("by_embedding", { vector: [0, 0, 0] })).rejects.toThrow("all zeros");
    await expect(raw("by_embedding", { vector: [1, 0, 0], limit: 257 })).rejects.toThrow("limit must be a whole number from 1 to 256");
    await expect(runtime.runAction("foods:similar", { vector: [1, 0, 0] }).then(() => null)).resolves.toBeNull();
  });

  test("filters only on filterFields", async () => {
    const { Runtime } = await import("../src/engine/runtime");
    const bad = {
      foods: {
        byName: action({
          args: {},
          handler: (ctx) => ctx.vectorSearch("foods", "by_embedding", { vector: [1, 0, 0], filter: (q) => (q as any).eq("name", "apple") }),
        }),
      },
    };
    runtime.stop();
    runtime = new Runtime({ driver, schema, modules: bad, log: runtime.log });
    await runtime.init();
    await expect(runtime.runAction("foods:byName", {})).rejects.toThrow('"name" isn\'t a filter field of vector index "by_embedding" on "foods" (filterFields: kind)');
  });

  test("an index added later covers existing documents; removing it drops it", async () => {
    runtime.stop();
    await driver.close();
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema: plain, modules }));
    const old = await add("written before the index existed", [0, 0, 1]);
    await add("wrong size, left out", [0, 1]);
    runtime.stop();
    await driver.close();

    driver = D.make(dir);
    const { Runtime } = await import("../src/engine/runtime");
    runtime = new Runtime({ driver, schema, modules, log: runtime.log });
    expect((await runtime.init()).created).toEqual(["vx_foods__by_embedding"]);
    expect((await similar({ vector: [0, 0, 1] })).map((r) => r._id)).toEqual([old]);
    runtime.stop();

    runtime = new Runtime({ driver, schema: plain, modules, log: runtime.log });
    expect((await runtime.init()).dropped).toEqual(["vx_foods__by_embedding"]);
  });
});

describe("vectorIndex() in schema.ts", () => {
  test("checks its config", () => {
    const t = () => defineTable(fields);
    expect(() => t().vectorIndex("x", { vectorField: "embedding", dimensions: 1 })).toThrow("dimensions must be a whole number from 2 to 4096");
    expect(() => t().vectorIndex("x", { vectorField: "embedding", dimensions: 4097 })).toThrow("from 2 to 4096");
    expect(() => t().vectorIndex("bad-name", { vectorField: "embedding", dimensions: 3 })).toThrow("Invalid vector index name");
    expect(() => (t() as any).vectorIndex("x", { dimensions: 3 })).toThrow("needs a vectorField");
    expect(() =>
      defineSchema({ foods: t().index("same", ["name"]).vectorIndex("same", { vectorField: "embedding", dimensions: 3 }) }),
    ).toThrow('two indexes named "same"');
  });
});
