import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorDistanceCos, vector32 } from "../src/engine/dialect";
import { SqliteDriver, type Driver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { VectorTable } from "../src/engine/vectors";
import { action, defineSchema, defineTable, mutation } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime, quiet } from "./helpers";

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

describe("sqlite: vector indexes in memory", () => {
  const DIMENSIONS = 5; // not a multiple of 4: rows are padded for SIMD
  const itemFields = { kind: v.optional(v.any()), other: v.optional(v.string()), meta: v.optional(v.any()), embedding: v.optional(v.array(v.number())) };
  const items = (filterFields: any[] = ["kind", "meta.tag"], dimensions = DIMENSIONS) =>
    defineSchema({ items: defineTable(itemFields).vectorIndex("by_embedding", { vectorField: "embedding", dimensions, filterFields }) });

  const itemModules = {
    items: {
      add: mutation({ args: itemFields, handler: (ctx, args) => ctx.db.insert("items", args as any) }),
      addMany: mutation({
        args: { docs: v.array(v.any()) },
        handler: async (ctx, { docs }) => {
          for (const doc of docs) await ctx.db.insert("items", doc);
        },
      }),
      addThenFail: mutation({
        args: itemFields,
        handler: async (ctx, args) => {
          await ctx.db.insert("items", args as any);
          throw new Error("no");
        },
      }),
      /** Keeps its own write when the mutation it calls fails. */
      addAfterFailure: mutation({
        args: itemFields,
        handler: async (ctx, args) => {
          await (ctx as any).runMutation("items:addThenFail", { ...args, other: "rolled back" }).catch(() => {});
          return ctx.db.insert("items", args as any);
        },
      }),
      setKind: mutation({ args: { id: v.string(), kind: v.any() }, handler: (ctx, { id, kind }) => ctx.db.patch(id as any, { kind }) }),
      removeOne: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
      removeAll: mutation({
        args: { keep: v.number() },
        handler: async (ctx, { keep }) => {
          const docs = await ctx.db.query("items").collect();
          for (const doc of docs.slice(keep)) await ctx.db.delete(doc._id);
        },
      }),
      similar: action({
        args: { vector: v.array(v.number()), limit: v.optional(v.number()), field: v.optional(v.string()), values: v.optional(v.array(v.any())) },
        handler: (ctx, { vector, limit, field, values }) =>
          (ctx as any).vectorSearch("items", "by_embedding", {
            vector,
            limit,
            filter: values ? (q: any) => (values.length === 1 ? q.eq(field, values[0]) : q.or(...values.map((x: unknown) => q.eq(field, x)))) : undefined,
          }),
      }),
    },
  };

  let dir: string;
  const open: { driver: Driver; runtime: Runtime }[] = [];
  const memoryEnv = process.env.ONEBASE_VECTOR_MEMORY_MB;
  const workersEnv = process.env.ONEBASE_VECTOR_WORKERS;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "onebase-vector-"));
  });

  afterEach(async () => {
    if (memoryEnv === undefined) delete process.env.ONEBASE_VECTOR_MEMORY_MB;
    else process.env.ONEBASE_VECTOR_MEMORY_MB = memoryEnv;
    if (workersEnv === undefined) delete process.env.ONEBASE_VECTOR_WORKERS;
    else process.env.ONEBASE_VECTOR_WORKERS = workersEnv;
    await nextTurn();
    for (const { driver, runtime } of open.splice(0)) {
      runtime.stop();
      await driver.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two drivers on one thread: a commit waiting for the next turn would block the other's writes, and this thread with them. */
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

  /** A runtime on the test's database; `memoryMb` sets ONEBASE_VECTOR_MEMORY_MB for its driver. */
  async function start(memoryMb?: string, schema = items()) {
    if (memoryMb === undefined) delete process.env.ONEBASE_VECTOR_MEMORY_MB;
    else process.env.ONEBASE_VECTOR_MEMORY_MB = memoryMb;
    const opened = await openRuntime(() => new SqliteDriver(join(dir, "db.sqlite")), { schema, modules: itemModules });
    open.push(opened);
    return { runtime: opened.runtime, driver: opened.driver as SqliteDriver };
  }

  /** Repeatable pseudo-random numbers from -0.5 to 0.5. */
  function randoms(seed: number) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
    };
  }
  const randomVector = (next: () => number, n = DIMENSIONS) => Array.from({ length: n }, next);
  const similar = (runtime: Runtime, args: { vector: number[]; limit?: number; field?: string; values?: unknown[] }) =>
    runtime.runAction("items:similar", args) as Promise<{ _id: string; _score: number }[]>;
  const ids = (results: { _id: string }[]) => results.map((r) => r._id);
  const axis = (i: number) => Array.from({ length: DIMENSIONS }, (_, j) => (j === i ? 1 : 0));
  /** A runtime whose vector searches all go to `count` workers, however small the index. */
  async function startWithWorkers(count = 2) {
    process.env.ONEBASE_VECTOR_WORKERS = String(count);
    const started = await start();
    driver(started).minWorkerFloats = 0;
    return started;
  }
  const driver = (started: { driver: SqliteDriver }) => started.driver.vectors!;
  const workersOf = (started: { driver: SqliteDriver }) => (driver(started) as any).workers;
  const cosine = (a: number[], b: number[]) => {
    let dot = 0;
    let x = 0;
    let y = 0;
    a.forEach((n, i) => {
      dot += n * b[i]!;
      x += n * n;
      y += b[i]! * b[i]!;
    });
    return dot / Math.sqrt(x * y);
  };

  for (const workers of [0, 2]) test(`ranks and filters exactly like SQL (${workers} workers)`, async () => {
    process.env.ONEBASE_VECTOR_WORKERS = String(workers);
    const started = await start();
    const { runtime, driver } = started;
    driver.vectors!.minWorkerFloats = 0;
    const next = randoms(7);
    const kinds = ["a", "b", 1, 2.5, true, false, null, undefined, ["x", 1], { y: 1 }, "1", '["x",1]'];
    const docs: Record<string, unknown>[] = [];
    for (let i = 0; i < 400; i++) {
      const kind = kinds[i % kinds.length];
      const tag = ["red", "blue", undefined][i % 3];
      docs.push({
        ...(kind === undefined ? {} : { kind }),
        ...(tag ? { meta: { tag } } : {}),
        // Same vectors (ties are ordered by id), an all-zero one, and a few without any.
        ...(i % 37 === 0 ? {} : { embedding: i % 50 === 1 ? [1, 2, 3, 4, 5] : i === 2 ? [0, 0, 0, 0, 0] : randomVector(next) }),
      });
    }
    await runtime.runMutation("items:addMany", { docs });

    const memoryMb = process.env.ONEBASE_VECTOR_MEMORY_MB;
    const { runtime: sql, driver: sqlDriver } = await start("0");
    process.env.ONEBASE_VECTOR_MEMORY_MB = memoryMb;
    expect(sqlDriver.vectors).toBeNull();
    expect(driver.vectors).not.toBeNull();

    const queries: { vector: number[]; limit?: number; field?: string; values?: unknown[] }[] = [
      { vector: [1, 2, 3, 4, 5], limit: 20 },
      { vector: randomVector(next), limit: 256 },
      { vector: randomVector(next), limit: 1 },
      { vector: randomVector(next) },
    ];
    for (const value of [...kinds.filter((k) => k !== undefined), 0, "c", [], {}]) queries.push({ vector: randomVector(next), limit: 40, field: "kind", values: [value] });
    queries.push({ vector: randomVector(next), limit: 40, field: "kind", values: ["a", 1, null] });
    queries.push({ vector: randomVector(next), limit: 40, field: "meta.tag", values: ["red"] });
    queries.push({ vector: randomVector(next), limit: 40, field: "meta.tag", values: [null] });

    for (const query of queries) {
      const memory = await similar(runtime, query);
      const expected = await similar(sql, query);
      expect(ids(memory)).toEqual(ids(expected));
      memory.forEach((r, i) => expect(r._score).toBeCloseTo(expected[i]!._score, 5));
    }
    expect(driver.vectors!.usedBytes).toBeGreaterThan(0);
    expect(workersOf(started) !== null).toBe(workers > 0);

    // More rows than the memory the workers first attached to.
    await nextTurn();
    await runtime.runMutation("items:addMany", { docs: Array.from({ length: 1000 }, () => ({ kind: "late", embedding: randomVector(next) })) });
    for (const query of [{ vector: [1, 2, 3, 4, 5], limit: 256 }, { vector: randomVector(next), limit: 100, field: "kind", values: ["late"] }]) {
      expect(ids(await similar(runtime, query))).toEqual(ids(await similar(sql, query)));
    }
  });

  test("small indexes don't start workers", async () => {
    process.env.ONEBASE_VECTOR_WORKERS = "2";
    const started = await start();
    await started.runtime.runMutation("items:add", { embedding: axis(0) });
    expect(await similar(started.runtime, { vector: axis(0) })).toHaveLength(1);
    expect(workersOf(started)).toBeNull();
  });

  test("no workers when asked for none", async () => {
    const started = await startWithWorkers(0);
    await started.runtime.runMutation("items:add", { embedding: axis(0) });
    expect(await similar(started.runtime, { vector: axis(0) })).toHaveLength(1);
    expect(workersOf(started)).toBeNull();
  });

  test("searches running while documents come and go never mix up documents", async () => {
    const started = await startWithWorkers(4);
    const { runtime } = started;
    const next = randoms(21);
    const vectors = new Map<string, number[]>();
    const add = async () => {
      const embedding = randomVector(next);
      const id = (await runtime.runMutation("items:add", { embedding })) as string;
      vectors.set(id, embedding);
      return { id, embedding };
    };
    for (let i = 0; i < 100; i++) await add();

    const seen: { vector: number[]; hits: { _id: string; _score: number }[] }[] = [];
    const search = async () => {
      const vector = randomVector(next);
      seen.push({ vector, hits: await similar(runtime, { vector, limit: 20 }) });
    };
    // Each sees its own write as soon as it's answered, and its delete too; deletes free slots for others to reuse.
    await Promise.all(
      Array.from({ length: 12 }, async () => {
        for (let round = 0; round < 15; round++) {
          const { id, embedding } = await add();
          const [hits] = await Promise.all([similar(runtime, { vector: embedding, limit: 1 }), search(), search(), search()]);
          expect(hits[0]!._id).toBe(id);
          await runtime.runMutation("items:removeOne", { id });
          expect(ids(await similar(runtime, { vector: embedding, limit: 1 }))).not.toContain(id);
          await search();
        }
      }),
    );

    expect(seen.length).toBe(12 * 15 * 4);
    for (const { vector, hits } of seen) {
      expect(hits).toHaveLength(20);
      for (const hit of hits) expect(hit._score).toBeCloseTo(cosine(vector, vectors.get(hit._id)!), 4);
      for (let i = 1; i < hits.length; i++) expect(hits[i - 1]!._score).toBeGreaterThanOrEqual(hits[i]!._score);
    }
  });

  test("a search sees one version, and slots are reused only once nothing can see them", () => {
    const index = { name: "x", vectorField: "e", dimensions: 3, filterFields: [] };
    const table = new VectorTable(index, { left: 1 << 20 });
    const blob = (...x: number[]) => new Uint8Array(Float32Array.from(x).buffer);
    table.put("a", blob(1, 0, 0), []);
    table.publish();

    const reading = table.enter();
    table.put("a", blob(0, 1, 0), []); // moved away from the query
    table.put("b", blob(1, 0, 0), []);
    const scores = (version: number) => table.search(version, [1, 0, 0], 10, null).map((h) => [h._id, Math.round(h._score)]);
    expect(scores(reading)).toEqual([["a", 1]]); // nothing written since is visible yet
    expect(scores(table.current)).toEqual([["a", 1]]);
    table.publish();
    expect(scores(table.current)).toEqual([["b", 1], ["a", 0]]);
    expect(scores(reading)).toEqual([["a", 1]]); // still there for the search that started before

    // While that search runs, each change takes a new slot.
    const rows = () => (table as any).ids.length;
    for (let i = 0; i < 5; i++) {
      table.put("c", blob(0, 0, 1), []);
      table.publish();
    }
    const used = rows();
    expect(used).toBe(8);
    expect(scores(reading)).toEqual([["a", 1]]);

    // Once it's done they're free again.
    table.leave(reading);
    for (let i = 0; i < 20; i++) {
      table.put("c", blob(0, 0, 1), []);
      table.publish();
    }
    expect(rows()).toBe(used);
    expect(table.size).toBe(3);
    expect(table.search(table.current, [0, 0, 1], 10, null).map((h) => h._id)[0]).toBe("c");
  });

  test("searches carry on, correctly, if the workers die", async () => {
    const started = await startWithWorkers(2);
    const { runtime } = started;
    const next = randoms(31);
    await runtime.runMutation("items:addMany", { docs: Array.from({ length: 200 }, () => ({ embedding: randomVector(next) })) });
    const vector = randomVector(next);
    const expected = await similar(runtime, { vector, limit: 5 });
    expect(workersOf(started)).not.toBeNull();

    const errors: string[] = [];
    const original = console.error;
    console.error = (message: string) => void errors.push(message);
    try {
      const running = Array.from({ length: 8 }, () => similar(runtime, { vector, limit: 5 }));
      await Bun.sleep(0);
      for (const thread of workersOf(started).threads) thread.worker.terminate();
      for (const hits of await Promise.all(running)) expect(ids(hits)).toEqual(ids(expected));
      await Bun.sleep(20);
      expect(ids(await similar(runtime, { vector, limit: 5 }))).toEqual(ids(expected));
      expect(workersOf(started)).toBeNull();
    } finally {
      console.error = original;
    }
    expect(errors.join()).toContain("vector search workers stopped");
  });

  test("workers stop with the last idle index, and start again", async () => {
    const started = await startWithWorkers(2);
    await started.runtime.runMutation("items:add", { embedding: axis(0) });
    expect(await similar(started.runtime, { vector: axis(0) })).toHaveLength(1);
    expect(workersOf(started)).not.toBeNull();
    driver(started).evictIdle(Date.now() + 60 * 60 * 1000);
    expect(workersOf(started)).toBeNull();
    expect(await similar(started.runtime, { vector: axis(0) })).toHaveLength(1);
    expect(workersOf(started)).not.toBeNull();
  });

  test("closing waits for running searches", async () => {
    const started = await startWithWorkers(2);
    const { runtime, driver: db } = started;
    const next = randoms(41);
    await runtime.runMutation("items:addMany", { docs: Array.from({ length: 500 }, () => ({ embedding: randomVector(next) })) });
    await similar(runtime, { vector: axis(0) });
    const running = Array.from({ length: 16 }, () => similar(runtime, { vector: randomVector(next), limit: 3 }));
    await Bun.sleep(0);
    const { driver: same, runtime: rt } = open.pop()!;
    expect(same).toBe(db);
    rt.stop();
    await db.close();
    for (const hits of await Promise.all(running)) expect(hits).toHaveLength(3);
  });

  test("workers don't keep the process alive", async () => {
    const script = join(dir, "exits.ts");
    await Bun.write(
      script,
      `import { SqliteDriver } from ${JSON.stringify(join(import.meta.dir, "../src/engine/driver"))};
       const db = new SqliteDriver(${JSON.stringify(join(dir, "exit.sqlite"))});
       db.vectors.minWorkerFloats = 0;
       await db.write((tx) => tx.run('CREATE TABLE "ix" (doc_id TEXT PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID'));
       await db.write((tx) => tx.run('INSERT INTO "ix" VALUES (?, vector32(?))', ["a", "[1, 0, 0]"]));
       const index = { name: "x", vectorField: "e", dimensions: 3, filterFields: [] };
       const ranked = await db.read((tx) => db.dialect.rankVectors(tx, "ix", index, [1, 0, 0], 1, null));
       console.log((await ranked.results)[0]._id, db.vectors.workers !== null);`,
    );
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, ONEBASE_VECTOR_WORKERS: "2" }, stdout: "pipe", stderr: "inherit" });
    const code = await Promise.race([child.exited, Bun.sleep(4000).then(() => "still running")]);
    if (code === "still running") child.kill();
    expect(code).toBe(0);
    expect((await new Response(child.stdout).text()).trim()).toBe("a true");
  });

  test("scores the same without WebAssembly SIMD", () => {
    const next = randoms(11);
    const index = { name: "x", vectorField: "e", dimensions: 7, filterFields: ["kind"] };
    const simd = new VectorTable(index, { left: 1 << 24 }, true);
    const plainJs = new VectorTable(index, { left: 1 << 24 }, false);
    for (let i = 0; i < 300; i++) {
      const vec = new Uint8Array(Float32Array.from(i % 10 === 0 ? [1, 2, 3, 4, 5, 6, 7] : randomVector(next, 7)).buffer);
      for (const table of [simd, plainJs]) table.put(`id${String(i).padStart(3, "0")}`, vec, [i % 3]);
    }
    for (const table of [simd, plainJs]) {
      table.remove("id005");
      table.publish();
    }
    for (const filter of [null, { op: "eq" as const, field: "kind", value: 1 }]) {
      const query = randomVector(next, 7);
      const a = simd.search(simd.current, query, 50, filter);
      expect(a).toHaveLength(50);
      expect(ids(a)).not.toContain("id005");
      expect(ids(plainJs.search(plainJs.current, query, 50, filter))).toEqual(ids(a));
    }
  });

  test("never shows what was rolled back, even in a commit shared with other writes", async () => {
    const { runtime } = await start();
    const kept = (await runtime.runMutation("items:add", { other: "first", embedding: axis(0) })) as string;
    expect(ids(await similar(runtime, { vector: axis(0) }))).toEqual([kept]); // now in memory

    await expect(runtime.runMutation("items:addThenFail", { other: "failed", embedding: axis(0) })).rejects.toThrow("no");
    expect(ids(await similar(runtime, { vector: axis(0) }))).toEqual([kept]);

    const inner = (await runtime.runMutation("items:addAfterFailure", { other: "kept", embedding: axis(1) })) as string;
    expect(ids(await similar(runtime, { vector: axis(1), limit: 1 }))).toEqual([inner]);
    expect(await similar(runtime, { vector: axis(1) })).toHaveLength(2);

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => runtime.runMutation(i % 2 ? "items:addThenFail" : "items:add", { other: "group", embedding: axis(2) })),
    );
    const added = results.flatMap((r) => (r.status === "fulfilled" ? [r.value as string] : []));
    expect(added).toHaveLength(10);
    const found = ids(await similar(runtime, { vector: axis(2), limit: 256 }));
    expect(found).toHaveLength(12);
    for (const id of [kept, inner, ...added]) expect(found).toContain(id);
  });

  test("follows changes to filter fields when the vector stays the same", async () => {
    const { runtime } = await start();
    const id = (await runtime.runMutation("items:add", { kind: "old", embedding: axis(0) })) as string;
    expect(ids(await similar(runtime, { vector: axis(0), field: "kind", values: ["old"] }))).toEqual([id]);
    await runtime.runMutation("items:setKind", { id, kind: "new" });
    expect(await similar(runtime, { vector: axis(0), field: "kind", values: ["old"] })).toEqual([]);
    expect(ids(await similar(runtime, { vector: axis(0), field: "kind", values: ["new"] }))).toEqual([id]);
  });

  test("catches up however far behind it fell, and keeps the log short", async () => {
    const { runtime, driver } = await start();
    await runtime.runMutation("items:add", { embedding: axis(0) });
    await similar(runtime, { vector: axis(0) });

    const next = randoms(3);
    for (let batch = 0; batch < 3; batch++) {
      await runtime.runMutation("items:addMany", { docs: Array.from({ length: 1500 }, () => ({ embedding: randomVector(next) })) });
    }
    const target = (await runtime.runMutation("items:add", { embedding: [1, 1, 1, 1, 1] })) as string;
    const rows = driver.writer.query("SELECT COUNT(*) AS n FROM _vector_log").get() as { n: number };
    expect(rows.n).toBeLessThanOrEqual(2048);

    const found = await similar(runtime, { vector: [1, 1, 1, 1, 1], limit: 256 });
    expect(found[0]!._id).toBe(target);
    expect(found).toHaveLength(256);
    await runtime.runMutation("items:removeAll", { keep: 1 });
    expect(await similar(runtime, { vector: axis(0), limit: 256 })).toHaveLength(1);
  });

  test("rebuilds when the index changes", async () => {
    const { runtime, driver } = await start();
    const id = (await runtime.runMutation("items:add", { kind: "k", other: "o", embedding: axis(0) })) as string;
    await similar(runtime, { vector: axis(0) });

    // The same side table, but a filter field the copy in memory doesn't hold.
    runtime.stop();
    const refiltered = new Runtime({ driver, schema: items(["other"]), modules: itemModules, log: quiet });
    await refiltered.init();
    expect(ids(await similar(refiltered, { vector: axis(0), field: "other", values: ["o"] }))).toEqual([id]);
    expect(await similar(refiltered, { vector: axis(0), field: "other", values: ["k"] })).toEqual([]);

    // Another size: the side table is rebuilt without this document.
    refiltered.stop();
    const resized = new Runtime({ driver, schema: items(["other"], 3), modules: itemModules, log: quiet });
    await resized.init();
    expect(await similar(resized, { vector: [1, 0, 0] })).toEqual([]);
    const added = (await resized.runMutation("items:add", { embedding: [1, 0, 0] })) as string;
    expect(ids(await similar(resized, { vector: [1, 0, 0] }))).toEqual([added]);
    resized.stop();
    open[0]!.runtime = resized;
  });

  test("leaves an index to SQL once it outgrows the memory budget", async () => {
    const { runtime, driver } = await start("0.001"); // about 1 KB: 21 rows of 12 floats
    const next = randoms(5);
    const docs = () => Array.from({ length: 20 }, () => ({ embedding: randomVector(next) }));
    await runtime.runMutation("items:addMany", { docs: docs() });
    expect(await similar(runtime, { vector: axis(0), limit: 256 })).toHaveLength(20);
    expect(driver.vectors!.usedBytes).toBeGreaterThan(0);

    // Past the budget while following writes, and on the next load.
    await runtime.runMutation("items:addMany", { docs: docs() });
    expect(await similar(runtime, { vector: axis(0), limit: 256 })).toHaveLength(40);
    expect(driver.vectors!.usedBytes).toBe(0);
    await runtime.runMutation("items:addMany", { docs: docs() });
    expect(await similar(runtime, { vector: axis(0), limit: 256 })).toHaveLength(60);
    expect(driver.vectors!.usedBytes).toBe(0);
  });

  test("gives memory back when idle, and when most of it is free", async () => {
    const { runtime, driver } = await start();
    const next = randoms(9);
    await runtime.runMutation("items:addMany", { docs: Array.from({ length: 1000 }, () => ({ embedding: randomVector(next) })) });
    await similar(runtime, { vector: axis(0) });
    const full = driver.vectors!.usedBytes;
    expect(full).toBeGreaterThan(0);

    driver.vectors!.evictIdle(); // used just now
    expect(driver.vectors!.usedBytes).toBe(full);
    driver.vectors!.evictIdle(Date.now() + 60 * 60 * 1000);
    expect(driver.vectors!.usedBytes).toBe(0);
    expect(await similar(runtime, { vector: axis(0) })).toHaveLength(10);
    expect(driver.vectors!.usedBytes).toBe(full);

    await runtime.runMutation("items:removeAll", { keep: 10 });
    expect(await similar(runtime, { vector: axis(0), limit: 256 })).toHaveLength(10);
    expect(driver.vectors!.usedBytes).toBeLessThan(full / 4);
    await driver.maintain();
  });

  test("picks up where it left off after a restart", async () => {
    const first = await start();
    const id = (await first.runtime.runMutation("items:add", { embedding: axis(0) })) as string;
    await similar(first.runtime, { vector: axis(0) });
    const { driver, runtime } = open.pop()!;
    runtime.stop();
    await driver.close();

    const second = await start();
    expect(ids(await similar(second.runtime, { vector: axis(0) }))).toEqual([id]);
    const added = (await second.runtime.runMutation("items:add", { embedding: axis(1) })) as string;
    expect(ids(await similar(second.runtime, { vector: axis(1), limit: 1 }))).toEqual([added]);
  });
});
