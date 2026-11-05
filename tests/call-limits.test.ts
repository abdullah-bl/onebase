// Read and write limits: a query or mutation that reads or writes too much fails, a mutation's
// writes are rolled back, and catching the error doesn't let the function carry on.

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { SqliteDriver } from "../src/engine/driver";
import { DEFAULT_CALL_LIMITS } from "../src/engine/limits";
import type { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { openRuntime } from "./helpers";

const LIMITS = { documentsRead: 10, documentsWritten: 5, bytesWritten: 4000, documentBytes: 1000 };

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const caught: string[] = [];
const modules = {
  notes: {
    addMany: mutation({
      args: { n: v.number(), size: v.optional(v.number()) },
      handler: async (ctx, { n, size }) => {
        for (let i = 0; i < n; i++) await ctx.db.insert("notes", { text: "x".repeat(size ?? 1) });
      },
    }),
    /** Catches the limit error and tries to commit anyway. */
    addManyCaught: mutation({
      args: { n: v.number() },
      handler: async (ctx, { n }) => {
        try {
          for (let i = 0; i < n; i++) await ctx.db.insert("notes", { text: "x" });
        } catch (err) {
          caught.push((err as Error).message);
        }
        try {
          await ctx.db.insert("notes", { text: "after" });
        } catch (err) {
          caught.push((err as Error).message);
        }
        return "done";
      },
    }),
    /** A too-big document is refused on its own; the rest of the mutation commits. */
    bigThenSmall: mutation({
      args: {},
      handler: async (ctx) => {
        try {
          await ctx.db.insert("notes", { text: "x".repeat(2000) });
        } catch (err) {
          caught.push((err as Error).message);
        }
        await ctx.db.insert("notes", { text: "small" });
      },
    }),
    /** Writes through a nested mutation, which shares this one's budget. */
    nested: mutation({
      args: { outer: v.number(), inner: v.number() },
      handler: async (ctx, { outer, inner }) => {
        for (let i = 0; i < outer; i++) await ctx.db.insert("notes", { text: "outer" });
        await ctx.runMutation("notes:addMany" as any, { n: inner });
      },
    }),
    removeAll: mutation({
      args: {},
      handler: async (ctx) => {
        for (const n of await ctx.db.query("notes").take(5)) await ctx.db.delete(n._id);
      },
    }),
    count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).length }),
    take: query({ args: { n: v.number() }, handler: async (ctx, { n }) => (await ctx.db.query("notes").take(n)).length }),
    /** Reads every note one by one with db.get(). */
    getEach: query({
      args: { ids: v.array(v.string()) },
      handler: async (ctx, { ids }) => {
        for (const id of ids) await ctx.db.get(id as any);
        return ids.length;
      },
    }),
    countCaught: query({
      args: {},
      handler: async (ctx) => {
        try {
          return (await ctx.db.query("notes").collect()).length;
        } catch {
          return -1;
        }
      },
    }),
  },
};

let runtime: Runtime;
let driver: SqliteDriver;

beforeAll(async () => {
  ({ runtime, driver } = (await openRuntime(() => new SqliteDriver(":memory:"), { schema, modules, callLimits: LIMITS })) as {
    runtime: Runtime;
    driver: SqliteDriver;
  });
});

afterAll(async () => {
  await driver.close();
});

beforeEach(async () => {
  caught.length = 0;
  await runtime.withWriter((tx) => tx.run("DELETE FROM documents"));
});

const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: Error) => err,
  );
const stored = async () => (await runtime.withReader((tx) => tx.get("SELECT COUNT(*) AS n FROM documents")))!.n as number;
/** Inserts `n` notes, in mutations under the write limit. */
const seed = async (n: number) => {
  for (let left = n; left > 0; left -= LIMITS.documentsWritten) {
    await runtime.runMutation("notes:addMany", { n: Math.min(left, LIMITS.documentsWritten) });
  }
};

test("a query may read up to the limit, and fails past it", async () => {
  await seed(10);
  expect((await runtime.runQuery("notes:count", {})).value).toBe(10);
  await seed(1);
  const err = await failure(runtime.runQuery("notes:count", {}));
  expect(err.message).toBe(
    "notes:count read more than 10 documents, the limit for one query. " +
      "Read fewer with an index (.withIndex()), .take(n) or .paginate(), or raise ONEBASE_MAX_READS.",
  );
  // .take() under the limit is fine with more documents in the table, and each call starts afresh.
  expect((await runtime.runQuery("notes:take", { n: 10 })).value).toBe(10);
  expect((await runtime.runQuery("notes:take", { n: 10 })).value).toBe(10);
  expect((await failure(runtime.runQuery("notes:take", { n: 50 }))).message).toContain("read more than 10 documents");
});

test("db.get() counts as a read", async () => {
  await seed(5);
  const ids = (await runtime.withReader((tx) => tx.all("SELECT id FROM documents"))).map((r: any) => r.id as string);
  expect((await runtime.runQuery("notes:getEach", { ids: [...ids, ...ids] })).value).toBe(10);
  expect((await failure(runtime.runQuery("notes:getEach", { ids: [...ids, ...ids, ids[0]!] }))).message).toContain(
    "notes:getEach read more than 10 documents",
  );
});

test("catching the read limit doesn't let a query return", async () => {
  await seed(11);
  expect((await failure(runtime.runQuery("notes:countCaught", {}))).message).toContain("notes:countCaught read more than 10 documents");
});

test("a mutation over the write limit is rolled back", async () => {
  await runtime.runMutation("notes:addMany", { n: 5 });
  expect(await stored()).toBe(5);
  const err = await failure(runtime.runMutation("notes:addMany", { n: 6 }));
  expect(err.message).toBe(
    "notes:addMany wrote more than 5 documents, the limit for one mutation. " +
      "Split the work into several mutations, e.g. a batch at a time with ctx.scheduler.runAfter(0, ...), or raise ONEBASE_MAX_WRITES.",
  );
  expect(await stored()).toBe(5);
  // Deletes count as writes too.
  await runtime.runMutation("notes:removeAll", {});
  expect(await stored()).toBe(0);
});

test("catching the write limit doesn't let a mutation commit", async () => {
  const err = await failure(runtime.runMutation("notes:addManyCaught", { n: 6 }));
  expect(err.message).toContain("notes:addManyCaught wrote more than 5 documents");
  expect(caught).toEqual([err.message, err.message]);
  expect(await stored()).toBe(0);
});

test("a nested mutation shares its caller's limit", async () => {
  await runtime.runMutation("notes:nested", { outer: 2, inner: 3 });
  expect(await stored()).toBe(5);
  expect((await failure(runtime.runMutation("notes:nested", { outer: 3, inner: 3 }))).message).toContain("wrote more than 5 documents");
  expect(await stored()).toBe(5);
});

test("a document over the size limit is refused, and the function can carry on", async () => {
  await runtime.runMutation("notes:bigThenSmall", {});
  expect(caught).toEqual([
    'notes:bigThenSmall: this "notes" document is 2 KB, over the 1000 bytes limit for one document. ' +
      "Keep large data in file storage (ctx.storage) and store its id, or raise ONEBASE_MAX_DOCUMENT_MB.",
  ]);
  expect(await stored()).toBe(1);
});

test("the bytes a mutation writes add up", async () => {
  // Each document is about 900 bytes of JSON: four fit in 4000 bytes, five don't.
  await runtime.runMutation("notes:addMany", { n: 4, size: 880 });
  const err = await failure(runtime.runMutation("notes:addMany", { n: 5, size: 880 }));
  expect(err.message).toBe(
    "notes:addMany wrote more than 3.9 KB of documents, the limit for one mutation. Split the work into several mutations, or raise ONEBASE_MAX_WRITE_MB.",
  );
  expect(await stored()).toBe(4);
});

test("the dashboard's edits aren't limited", async () => {
  await runtime.adminWrite(async (db) => {
    for (let i = 0; i < 20; i++) await db.insert("notes", { text: "x" });
  });
  expect(await stored()).toBe(20);
});

test("a limit of 0 turns it off, and unset limits keep their defaults", async () => {
  const open = await openRuntime(() => new SqliteDriver(":memory:"), { schema, modules, callLimits: { documentsWritten: 0 } });
  try {
    await open.runtime.runMutation("notes:addMany", { n: 50 });
    expect((await open.runtime.runQuery("notes:count", {})).value).toBe(50);
    expect(open.runtime.callLimits).toEqual({ ...DEFAULT_CALL_LIMITS, documentsWritten: 0 });
  } finally {
    await open.driver.close();
  }
});
