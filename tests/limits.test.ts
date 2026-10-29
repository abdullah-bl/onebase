// Time limits: a function that runs too long is answered with an error, and what it tries once
// the limit has passed never reaches the database (by then another call's transaction).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { action, defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { openRuntime } from "./helpers";

const LIMIT = 150;
/** Longer than the limit: the function wakes up after its call was answered. */
const OVERRUN = 400;

/** What abandoned functions got when they tried to carry on. */
const late: string[] = [];
const lateTry = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    late.push("ok");
  } catch (err) {
    late.push((err as Error).message);
  }
};

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const modules = {
  notes: {
    add: mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) }),
    texts: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text).sort() }),
    slowWrite: mutation({
      args: {},
      handler: async (ctx) => {
        await ctx.db.insert("notes", { text: "before" });
        await Bun.sleep(OVERRUN);
        await lateTry(() => ctx.db.insert("notes", { text: "after" }));
      },
    }),
    slowRead: query({
      args: {},
      handler: async (ctx) => {
        await ctx.db.query("notes").collect();
        await Bun.sleep(OVERRUN);
        await lateTry(() => ctx.db.query("notes").collect());
      },
    }),
    slowAction: action({
      args: {},
      handler: async (ctx) => {
        await Bun.sleep(OVERRUN);
        await lateTry(() => ctx.runMutation("notes:add" as any, { text: "from action" }));
        await lateTry(() => ctx.scheduler.runAfter(0, "notes:add" as any, { text: "scheduled" }));
      },
    }),
  },
};

let dir: string;
let runtime: Runtime;
let driver: SqliteDriver;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "onebase-limits-"));
  ({ runtime, driver } = (await openRuntime(() => new SqliteDriver(join(dir, "db.sqlite")), {
    schema,
    modules,
    timeLimits: { queryMs: LIMIT, mutationMs: LIMIT, actionMs: LIMIT },
  })) as { runtime: Runtime; driver: SqliteDriver });
});

afterAll(async () => {
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The error `call` fails with. */
const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: Error) => err,
  );
const texts = async () => (await runtime.runQuery("notes:texts", {})).value;
const clear = async () => {
  late.length = 0;
  await runtime.withWriter((tx) => tx.run("DELETE FROM documents"));
};

test("a mutation over its limit is rolled back, and the writes around it still commit", async () => {
  await clear();
  const first = runtime.runMutation("notes:add", { text: "first" }); // shares a group commit with the slow one
  const slow = failure(runtime.runMutation("notes:slowWrite", {}));
  const next = runtime.runMutation("notes:add", { text: "next" }); // queued behind it
  const started = performance.now();

  expect((await slow).message).toBe("notes:slowWrite didn't finish within the mutation time limit (150ms).");
  await Promise.all([first, next]);
  expect(performance.now() - started).toBeLessThan(OVERRUN);
  expect(await texts()).toEqual(["first", "next"]);

  await Bun.sleep(OVERRUN);
  expect(late).toEqual(["notes:slowWrite didn't finish within the mutation time limit (150ms)."]);
  expect(await texts()).toEqual(["first", "next"]);
});

test("a query over its limit fails without holding up the queries behind it", async () => {
  await clear();
  await runtime.runMutation("notes:add", { text: "a" });
  const slow = failure(runtime.runQuery("notes:slowRead", {}));
  const next = texts();
  expect((await slow).message).toBe("notes:slowRead didn't finish within the query time limit (150ms).");
  expect(await next).toEqual(["a"]);
  await Bun.sleep(OVERRUN);
  expect(late).toEqual(["notes:slowRead didn't finish within the query time limit (150ms)."]);
});

test("an action over its limit can't call functions or schedule them afterwards", async () => {
  await clear();
  const err = await failure(runtime.runAction("notes:slowAction", {}));
  expect(err.message).toBe("notes:slowAction didn't finish within the action time limit (150ms).");
  await Bun.sleep(OVERRUN);
  expect(late).toEqual([err.message, err.message]);
  expect(await texts()).toEqual([]);
  expect(await runtime.withReader((tx) => tx.get("SELECT COUNT(*) AS n FROM _scheduled"))).toEqual({ n: 0 });
});

test("a limit of 0 turns it off", async () => {
  const unlimited = await openRuntime(() => new SqliteDriver(":memory:"), { schema, modules, timeLimits: { queryMs: 0 } });
  try {
    late.length = 0;
    expect((await unlimited.runtime.runQuery("notes:slowRead", {})).value).toBeNull();
    expect(late).toEqual(["ok"]);
    expect(unlimited.runtime.timeLimits).toEqual({ queryMs: 0, mutationMs: 10_000, actionMs: 600_000 });
  } finally {
    await unlimited.driver.close();
  }
});
