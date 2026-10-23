// Live queries re-run only for writes inside what they read: their index range and,
// for take/first/paginate, the rows they actually scanned.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postgresDialect, sqliteDialect } from "../src/engine/dialect";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { SubscriptionManager, type QueryUpdate } from "../src/engine/sync";
import { defineSchema, defineTable, mutation, paginationOptsValidator, query } from "../src/server";
import { v } from "../src/values";
import { countRuns, DRIVERS, openRuntime } from "./helpers";

const schema = defineSchema({
  posts: defineTable({ author: v.string(), score: v.number(), title: v.string() })
    .index("by_score", ["score"])
    .index("by_author", ["author"]),
});

const titles = (docs: { title: string }[]) => docs.map((d) => d.title);

const modules = {
  posts: {
    add: mutation({
      args: { author: v.optional(v.string()), score: v.optional(v.number()), title: v.string() },
      handler: (ctx, a) => ctx.db.insert("posts", { author: a.author ?? "ann", score: a.score ?? 0, title: a.title }),
    }),
    edit: mutation({
      args: { id: v.string(), score: v.optional(v.number()), title: v.optional(v.string()) },
      handler: (ctx, { id, ...rest }) => ctx.db.patch(id as any, rest),
    }),
    latest: query({ args: {}, handler: async (ctx) => titles(await ctx.db.query("posts").order("desc").take(2)) }),
    top: query({
      args: {},
      handler: async (ctx) => titles(await ctx.db.query("posts").withIndex("by_score", (q) => q.gt("score", 10)).collect()),
    }),
    late: query({
      args: {},
      handler: async (ctx) => titles(await ctx.db.query("posts").withIndex("by_author", (q) => q.gte("author", "m")).collect()),
    }),
    recentBy: query({
      args: { author: v.string(), since: v.number() },
      handler: async (ctx, { author, since }) =>
        titles(await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author).gt("_creationTime", since)).collect()),
    }),
    page: query({
      args: { paginationOpts: paginationOptsValidator },
      handler: (ctx, { paginationOpts }) => ctx.db.query("posts").order("desc").paginate(paginationOpts),
    }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: precise live query invalidation`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;
  let subs: SubscriptionManager;
  let runs: Record<string, number>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-readsets-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
    subs = new SubscriptionManager(runtime);
    runs = countRuns(runtime);
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (title: string, extra: Record<string, unknown> = {}) => runtime.runMutation("posts:add", { title, ...extra }) as Promise<string>;
  const edit = (id: string, change: Record<string, unknown>) => runtime.runMutation("posts:edit", { id, ...change });
  /** Subscribes and returns a getter for the latest value. */
  const watch = async (name: string, args: Record<string, unknown> = {}) => {
    let last: QueryUpdate | null = null;
    subs.subscribe(name, args, null, (u) => (last = u));
    await Bun.sleep(20);
    return () => (last as QueryUpdate | null)?.ok ? (last as any).value : last;
  };

  test("take(n) ignores writes to rows past the ones it read", async () => {
    const p1 = await add("p1");
    const p2 = await add("p2");
    await add("p3");
    const value = await watch("posts:latest");
    expect(value()).toEqual(["p3", "p2"]);

    await edit(p1, { title: "p1 edited" }); // older than both rows read
    expect(runs["posts:latest"]).toBe(1);

    await edit(p2, { title: "p2 edited" });
    expect(runs["posts:latest"]).toBe(2);
    expect(value()).toEqual(["p3", "p2 edited"]);

    await add("p4"); // lands in front, inside the scanned range
    expect(value()).toEqual(["p4", "p3"]);
  });

  test("index range bounds rule out writes outside them", async () => {
    const value = await watch("posts:top");
    await add("low", { score: 5 });
    expect(runs["posts:top"]).toBe(1);
    const high = await add("high", { score: 20 });
    expect(value()).toEqual(["high"]);
    await edit(high, { score: 3 }); // leaves the range: its old version was inside
    expect(value()).toEqual([]);
    expect(runs["posts:top"]).toBe(3);
  });

  test("a pinned page ignores new documents in front of it", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await add(`p${i}`));
    const first = (await runtime.runQuery("posts:page", { paginationOpts: { numItems: 2, cursor: null } })).value as any;
    const second = (await runtime.runQuery("posts:page", { paginationOpts: { numItems: 2, cursor: first.continueCursor } })).value as any;
    const pinned = { paginationOpts: { numItems: 2, cursor: first.continueCursor, endCursor: second.continueCursor } };
    const key = `posts:page${JSON.stringify(pinned)}`;
    const value = await watch("posts:page", pinned);
    expect(titles(value().page)).toEqual(["p3", "p2"]);
    const before = runs[key];

    await add("p6"); // newest: belongs to the first page
    expect(runs[key]).toBe(before);
    await edit(ids[2]!, { title: "p2 edited" });
    expect(titles(value().page)).toEqual(["p3", "p2 edited"]);
  });

  test("_creationTime can follow an index's equality fields, like in Convex", async () => {
    const old = await add("old", { author: "zoe" });
    const since = Date.now();
    await Bun.sleep(2);
    await add("new", { author: "zoe" });
    await add("other author", { author: "ann" });
    const args = { author: "zoe", since };
    const value = await watch("posts:recentBy", args);
    expect(value()).toEqual(["new"]);
    const key = `posts:recentBy${JSON.stringify(args)}`;
    await edit(old, { title: "old edited" }); // created before `since`: outside the range
    expect(runs[key]).toBe(1);
    await add("newer", { author: "zoe" });
    expect(value()).toEqual(["new", "newer"]);
  });

  test("string ranges stay correct whether or not the database's ordering can be decided in JS", async () => {
    const value = await watch("posts:late");
    await add("by zoe", { author: "zoe" });
    await add("by adam", { author: "adam" });
    await add("by mia", { author: "mia" });
    expect(value()).toEqual(["by mia", "by zoe"]);
  });
});

describe("index ordering in JS", () => {
  test("SQLite: NULL < numbers (booleans are 0/1) < text; objects undecided", () => {
    const c = (a: unknown, b: unknown) => sqliteDialect.compare(a, b, "json");
    expect(c(true, 1)).toBe(0);
    expect(c(undefined, null)).toBe(0);
    expect(c(null, -5)).toBe(-1);
    expect(c(5, "a")).toBe(-1);
    expect(c("b", "a")).toBe(1);
    expect(c("é", "z")).toBe(1); // binary order, not locale order
    expect(c({ a: 1 }, 1)).toBeNull();
  });

  test("Postgres: string < number < boolean; unequal strings and nulls undecided", () => {
    const c = (a: unknown, b: unknown) => postgresDialect.compare(a, b, "json");
    expect(c(1, "a")).toBe(1);
    expect(c(true, 5)).toBe(1);
    expect(c(2, 10)).toBe(-1);
    expect(c("a", "a")).toBe(0);
    expect(c("a", "b")).toBeNull();
    expect(c(null, 1)).toBeNull();
    expect(postgresDialect.compare(1.5, 2, "ct")).toBe(-1);
  });
});
