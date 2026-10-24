import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../src/engine/runtime";
import { createDriver, SqliteDriver, type Driver } from "../src/engine/driver";
import { SubscriptionManager, type QueryUpdate } from "../src/engine/sync";
import { defineSchema, defineTable, internalMutation, mutation, paginationOptsValidator, query } from "../src/server";
import { ConvexError, v } from "../src/values";

const schema = defineSchema({
  channels: defineTable({ name: v.string() }).index("by_name", ["name"]),
  messages: defineTable({
    channel: v.id("channels"),
    author: v.string(),
    body: v.string(),
    likes: v.optional(v.number()),
  })
    .index("by_channel", ["channel"])
    .index("by_channel_author", ["channel", "author"]),
});

const modules = {
  channels: {
    create: mutation({ args: { name: v.string() }, handler: (ctx, args) => ctx.db.insert("channels", args) }),
  },
  messages: {
    list: query({
      args: { channel: v.string() },
      handler: (ctx, { channel }) =>
        ctx.db
          .query("messages")
          .withIndex("by_channel", (q) => q.eq("channel", channel))
          .collect(),
    }),
    all: query({ args: {}, handler: (ctx) => ctx.db.query("messages").collect() }),
    byAuthor: query({
      args: { author: v.string() },
      handler: (ctx, { author }) => ctx.db.query("messages").filter({ author }).collect(),
    }),
    count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).length }),
    page: query({
      args: { paginationOpts: paginationOptsValidator },
      handler: (ctx, { paginationOpts }) => ctx.db.query("messages").order("desc").paginate(paginationOpts),
    }),
    send: mutation({
      args: { channel: v.string(), author: v.string(), body: v.string() },
      handler: async (ctx, args) => ctx.db.insert("messages", args as any),
    }),
    sendTwiceThenFail: mutation({
      args: { channel: v.string() },
      handler: async (ctx, { channel }) => {
        await ctx.db.insert("messages", { channel, author: "a", body: "1" } as any);
        await ctx.db.insert("messages", { channel, author: "a", body: "2" } as any);
        throw new ConvexError("nope");
      },
    }),
    move: mutation({
      args: { id: v.string(), channel: v.string() },
      handler: (ctx, { id, channel }) => ctx.db.patch(id as any, { channel } as any),
    }),
    like: mutation({
      args: { id: v.string() },
      handler: async (ctx, { id }) => {
        const m = await ctx.db.get(id as any);
        await ctx.db.patch(id as any, { likes: ((m as any).likes ?? 0) + 1 });
      },
    }),
    later: mutation({
      args: { channel: v.string() },
      handler: async (ctx, { channel }) => {
        await ctx.scheduler.runAfter(10, "messages:insertInternal", { channel });
      },
    }),
    insertInternal: internalMutation({
      args: { channel: v.string() },
      handler: (ctx, { channel }) => ctx.db.insert("messages", { channel, author: "bot", body: "scheduled" } as any),
    }),
    badFilter: query({
      args: {},
      handler: (ctx) => ctx.db.query("messages").filter(((m: any) => m.author === "x") as any).collect(),
    }),
    writeInQuery: query({
      args: {},
      handler: (ctx) => (ctx.db as any).insert("messages", {}),
    }),
  },
};

/** SQLite always runs; set TEST_POSTGRES_URL / TEST_LIBSQL_URL to also run against Postgres and libSQL (Turso). */
const DRIVERS: { name: string; make: (dir: string) => Driver }[] = [
  { name: "sqlite", make: (dir) => new SqliteDriver(join(dir, "db.sqlite")) },
  ...(process.env.TEST_POSTGRES_URL ? [{ name: "postgres", make: () => createDriver(process.env.TEST_POSTGRES_URL!) }] : []),
  ...(process.env.TEST_LIBSQL_URL ? [{ name: "libsql", make: () => createDriver(process.env.TEST_LIBSQL_URL!) }] : []),
];

for (const D of DRIVERS) describe(D.name, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;
  const warnings: string[] = [];
  const quiet = { info() {}, warn: (m: string) => warnings.push(m), error() {} };

  async function freshRuntime(reset: boolean) {
    driver = D.make(dir);
    runtime = new Runtime({ driver, schema, modules, dev: true, log: quiet });
    await runtime.init();
    if (reset && driver.shared) {
      await driver.write(async (tx) => {
        for (const t of ["documents", "_scheduled", "_crons", "_storage", "_upload_tokens"]) await tx.run(`DELETE FROM ${t}`);
      });
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-test-"));
    warnings.length = 0;
    await freshRuntime(true);
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const q = async (name: string, args: unknown = {}) => (await runtime.runQuery(name, args)).value as any;
  const m = (name: string, args: unknown = {}) => runtime.runMutation(name, args) as Promise<any>;

  describe("documents", () => {
    test("insert, get, query by index, patch, delete", async () => {
      const general = await m("channels:create", { name: "general" });
      const random = await m("channels:create", { name: "random" });
      const id = await m("messages:send", { channel: general, author: "ali", body: "hi" });
      await m("messages:send", { channel: random, author: "sara", body: "yo" });

      const list = await q("messages:list", { channel: general });
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ _id: id, author: "ali", body: "hi" });
      expect(typeof list[0]._creationTime).toBe("number");

      await m("messages:like", { id });
      await m("messages:like", { id });
      expect((await q("messages:list", { channel: general }))[0].likes).toBe(2);
      expect(await q("messages:byAuthor", { author: "sara" })).toHaveLength(1);
    });

    test("schema validation explains what is wrong", async () => {
      const ch = await m("channels:create", { name: "c" });
      const bad = mutation({ args: {}, handler: (ctx) => ctx.db.insert("messages", { channel: ch, author: 1, extra: true } as any) });
      const rt = new Runtime({ driver, schema, modules: { t: { bad } }, log: runtime.log });
      const err: any = await rt.runMutation("t:bad", {}).catch((e) => e);
      expect(err.message).toContain('Invalid "messages" document');
      expect(err.message).toContain("document.author must be v.string(), got number (1)");
      expect(err.message).toContain("document.body is required");
      expect(err.message).toContain("document.extra is not allowed");
    });

    test("argument validation", async () => {
      const err = await m("messages:send", { channel: "x", author: 5 }).catch((e) => e);
      expect(err.message).toContain('Invalid arguments for "messages:send"');
      expect(err.message).toContain("args.author must be v.string()");
      expect(err.message).toContain("args.body is required");
    });

    test("mutations are atomic", async () => {
      const err = await m("messages:sendTwiceThenFail", { channel: "c" }).catch((e) => e);
      expect(err).toBeInstanceOf(ConvexError);
      expect(await q("messages:count")).toBe(0);
    });

    test("helpful errors for common mistakes", async () => {
      expect((await q("messages:badFilter").catch((e) => e)).message).toContain("must return a q expression");
      expect((await q("messages:writeInQuery").catch((e) => e)).message).toContain("Queries are read-only");
      expect((await q("messages:nope").catch((e) => e)).message).toContain('Functions in "messages"');
      expect((await m("messages:insertInternal", { channel: "c" }).catch((e) => e)).message).toContain("is internal");
      expect((await m("messages:list", { channel: "c" }).catch((e) => e)).message).toContain("is a query, not a mutation");
    });

    test("warns when a filter scans the whole table", async () => {
      await q("messages:byAuthor", { author: "x" });
      expect(warnings.join("\n")).toContain('.index("by_author", ["author"])');
      warnings.length = 0;
      await q("messages:list", { channel: "x" });
      expect(warnings).toHaveLength(0);
    });

    test("pagination with cursors", async () => {
      for (let i = 0; i < 7; i++) await m("messages:send", { channel: "c", author: "a", body: String(i) });
      const p1 = await q("messages:page", { paginationOpts: { numItems: 3, cursor: null } });
      expect(p1.page.map((d: any) => d.body)).toEqual(["6", "5", "4"]);
      expect(p1.isDone).toBe(false);
      const p2 = await q("messages:page", { paginationOpts: { numItems: 3, cursor: p1.continueCursor } });
      expect(p2.page.map((d: any) => d.body)).toEqual(["3", "2", "1"]);
      const p3 = await q("messages:page", { paginationOpts: { numItems: 3, cursor: p2.continueCursor } });
      expect(p3.page.map((d: any) => d.body)).toEqual(["0"]);
      expect(p3.isDone).toBe(true);
      // A pinned page (endCursor) keeps its boundaries when new documents arrive.
      await m("messages:send", { channel: "c", author: "a", body: "7" });
      const pinned = await q("messages:page", { paginationOpts: { numItems: 3, cursor: p1.continueCursor, endCursor: p2.continueCursor } });
      expect(pinned.page.map((d: any) => d.body)).toEqual(["3", "2", "1"]);
    });

    test("scheduler runs internal mutations", async () => {
      await m("messages:later", { channel: "c" });
      expect(await q("messages:count")).toBe(0);
      await Bun.sleep(150);
      expect((await q("messages:all"))[0]).toMatchObject({ author: "bot", body: "scheduled" });
    });

    test("data survives a restart", async () => {
      await m("messages:send", { channel: "c", author: "a", body: "persisted" });
      runtime.stop();
      await driver.close();
      await freshRuntime(false);
      expect((await q("messages:all"))[0].body).toBe("persisted");
    });
  });

  describe("reactivity", () => {
    test("subscriptions update after writes and skip unrelated ones", async () => {
      const subs = new SubscriptionManager(runtime);
      const updates: Record<string, unknown[]> = { a: [], b: [] };
      let runsB = 0;
      const origRun = runtime.runQuery.bind(runtime);
      runtime.runQuery = (async (name: any, args: any, opts: any) => {
        if ((args as any)?.channel === "b") runsB++;
        return origRun(name, args, opts);
      }) as any;

      subs.subscribe("messages:list", { channel: "a" }, null, (u) => updates.a!.push(u.ok ? (u.value as any[]).length : u));
      subs.subscribe("messages:list", { channel: "b" }, null, (u) => updates.b!.push(u.ok ? (u.value as any[]).length : u));
      await Bun.sleep(20);
      expect(updates).toEqual({ a: [0], b: [0] });

      await m("messages:send", { channel: "a", author: "x", body: "1" });
      await m("messages:send", { channel: "a", author: "x", body: "2" });
      expect(updates.a).toEqual([0, 1, 2]);
      // Writes to channel "a" never re-run the channel "b" query.
      expect(runsB).toBe(1);
      expect(updates.b).toEqual([0]);
    });

    test("reads see new commits after a dev-mode query plan check", async () => {
      // Dev mode EXPLAINs filtered queries. A cached EXPLAIN statement used to pin the SQLite
      // reader's snapshot, so every later read missed new commits until restart.
      await m("messages:send", { channel: "a", author: "x", body: "1" });
      expect(await q("messages:byAuthor", { author: "x" })).toHaveLength(1);
      await m("messages:send", { channel: "a", author: "x", body: "2" });
      expect(await q("messages:all")).toHaveLength(2);
      expect(await q("messages:byAuthor", { author: "x" })).toHaveLength(2);
    });

    test("a write that moves a document between ranges updates both sides", async () => {
      const subs = new SubscriptionManager(runtime);
      const seen: Record<string, number[]> = { a: [], b: [], x: [], all: [] };
      const push = (k: string) => (u: any) => seen[k]!.push(u.ok ? (u.value as any[]).length : -1);
      subs.subscribe("messages:list", { channel: "a" }, null, push("a"));
      subs.subscribe("messages:list", { channel: "b" }, null, push("b"));
      subs.subscribe("messages:byAuthor", { author: "x" }, null, push("x")); // range from .filter()
      subs.subscribe("messages:all", {}, null, push("all")); // range without equality conditions
      await Bun.sleep(20);
      const id = await m("messages:send", { channel: "a", author: "x", body: "1" });
      await m("messages:move", { id, channel: "b" }); // matches "a" before the write, "b" after
      // "x" and "all" still hold one message, but its channel changed, so they get a new result too.
      expect(seen).toEqual({ a: [0, 1, 0], b: [0, 1], x: [0, 1, 1], all: [0, 1, 1] });
    });

    test("a commit only checks subscriptions that could match it", async () => {
      const subs = new SubscriptionManager(runtime);
      let checks = 0;
      const affected = (subs as any).affected.bind(subs);
      (subs as any).affected = (...a: unknown[]) => (checks++, affected(...a));
      const seen: number[] = [];
      const stops = Array.from({ length: 500 }, (_, i) => subs.subscribe("messages:list", { channel: `c${i}` }, null, () => {}));
      subs.subscribe("messages:list", { channel: "c7" }, null, (u) => seen.push(u.ok ? (u.value as any[]).length : -1));
      await Bun.sleep(50);
      checks = 0;
      await m("messages:send", { channel: "c7", author: "x", body: "1" });
      expect(seen.at(-1)).toBe(1);
      expect(checks).toBe(1); // not 500
      // Unsubscribing removes entries from the index.
      stops.forEach((stop) => stop());
      expect((subs as any).index.always.size + [...(subs as any).index.byKey.values()].reduce((n: number, s: Set<unknown>) => n + s.size, 0)).toBe(1);
    });

    test("identical subscriptions share one execution", async () => {
      const subs = new SubscriptionManager(runtime);
      let runs = 0;
      const origRun = runtime.runQuery.bind(runtime);
      runtime.runQuery = (async (...a: any[]) => {
        runs++;
        return (origRun as any)(...a);
      }) as any;
      const seen: number[] = [];
      for (let i = 0; i < 5; i++) subs.subscribe("messages:count", {}, null, (u) => seen.push(u.ok ? (u.value as number) : -1));
      await Bun.sleep(20);
      await m("messages:send", { channel: "a", author: "x", body: "1" });
      expect(runs).toBe(2);
      expect(seen.filter((n) => n === 1)).toHaveLength(5);
    });

    test("a burst of new subscriptions all get results", async () => {
      // More first runs at once than libsql-server takes concurrent requests (128 by default).
      const subs = new SubscriptionManager(runtime);
      const first = await Promise.all(
        Array.from({ length: 300 }, (_, i) => new Promise<QueryUpdate>((resolve) => subs.subscribe("messages:list", { channel: `c${i}` }, null, resolve))),
      );
      expect(first.filter((u) => !u.ok)).toEqual([]);
    });
  });
});
