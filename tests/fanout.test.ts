// What a write costs as the audience grows: one run of a live query for everyone it is the same
// for, and no waiting for other people's queries before the writer gets its answer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { SubscriptionManager, type QueryUpdate } from "../src/engine/sync";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { countRuns, DRIVERS, openRuntime } from "./helpers";

const schema = defineSchema({ notes: defineTable({ text: v.string(), owner: v.optional(v.string()) }) });

const modules = {
  notes: {
    add: mutation({ args: { text: v.string(), owner: v.optional(v.string()) }, handler: (ctx, a) => ctx.db.insert("notes", a) }),
    all: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) }),
    mine: query({
      args: {},
      handler: async (ctx) => {
        const me = (await ctx.auth.getUserIdentity())?.subject ?? "nobody";
        return (await ctx.db.query("notes").collect()).filter((n) => n.owner === me).map((n) => n.text);
      },
    }),
    // Looks at who is asking only once there is a private note: the same for everyone until then.
    sometimes: query({
      args: {},
      handler: async (ctx) => {
        const notes = await ctx.db.query("notes").collect();
        if (!notes.some((n) => n.owner)) return notes.map((n) => n.text);
        const me = (await ctx.auth.getUserIdentity())?.subject ?? "nobody";
        return notes.filter((n) => !n.owner || n.owner === me).map((n) => n.text);
      },
    }),
    nested: query({ args: {}, handler: (ctx) => ctx.runQuery("notes:mine", {}) }),
  },
};

const ann = { subject: "ann", issuer: "test", tokenIdentifier: "test|ann" };
const bob = { subject: "bob", issuer: "test", tokenIdentifier: "test|bob" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const D of DRIVERS) {
  describe(`${D.name} > fan-out`, () => {
    let dir: string;
    let driver: Driver;
    let runtime: Runtime;
    let subs: SubscriptionManager;
    let runs: Record<string, number>;

    beforeEach(async () => {
      dir = mkdtempSync(join(tmpdir(), "onebase-fanout-"));
      ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
      subs = new SubscriptionManager(runtime);
      runs = countRuns(runtime);
    });
    afterEach(async () => {
      runtime.stop();
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    });

    /** Subscribes and collects the values received. */
    const watch = (name: string, identity: typeof ann | null, owner?: object) => {
      const got: unknown[] = [];
      subs.subscribe(name, {}, identity, (u: QueryUpdate) => got.push(u.ok ? u.value : { error: u.error }), owner);
      return got;
    };

    test("a query that never asks who is calling runs once for everyone", async () => {
      const first = watch("notes:all", ann);
      await sleep(30); // the first run is how it's learned
      const others = [watch("notes:all", bob), watch("notes:all", null)];
      await sleep(30);
      expect(runs["notes:all"]).toBe(1);
      expect(subs.size).toBe(1);

      await runtime.runMutation("notes:add", { text: "hello" });
      expect(runs["notes:all"]).toBe(2);
      for (const got of [first, ...others]) expect(got.at(-1)).toEqual(["hello"]);
    });

    test("users who subscribed before that was known are brought together by the next commit", async () => {
      const a = watch("notes:all", ann);
      const b = watch("notes:all", bob);
      await sleep(30);
      expect(runs["notes:all"]).toBe(2);

      await runtime.runMutation("notes:add", { text: "one" });
      expect(subs.size).toBe(1);
      await runtime.runMutation("notes:add", { text: "two" });
      expect(runs["notes:all"]).toBe(4); // one run per commit from here on
      expect(a.at(-1)).toEqual(["one", "two"]);
      expect(b.at(-1)).toEqual(["one", "two"]);
    });

    test("a query that asks who is calling stays one per user, nested calls included", async () => {
      for (const name of ["notes:mine", "notes:nested"]) {
        const a = watch(name, ann);
        await sleep(30);
        const b = watch(name, bob);
        await runtime.runMutation("notes:add", { text: `ann's (${name})`, owner: "ann" });
        await runtime.runMutation("notes:add", { text: `bob's (${name})`, owner: "bob" });
        expect((a.at(-1) as string[]).filter((t) => t.includes(name))).toEqual([`ann's (${name})`]);
        expect((b.at(-1) as string[]).filter((t) => t.includes(name))).toEqual([`bob's (${name})`]);
      }
      expect(subs.size).toBe(4);
    });

    test("a shared query that starts asking who is calling is split, and nobody gets another user's result", async () => {
      const a = watch("notes:sometimes", ann);
      await sleep(30);
      const b = watch("notes:sometimes", bob);
      await runtime.runMutation("notes:add", { text: "public" });
      expect(subs.size).toBe(1);
      expect([a.at(-1), b.at(-1)]).toEqual([["public"], ["public"]]);

      await runtime.runMutation("notes:add", { text: "for ann", owner: "ann" });
      await sleep(50); // the split entries run on their own
      expect(subs.size).toBe(2);
      expect(a.at(-1)).toEqual(["public", "for ann"]);
      expect(b).not.toContainEqual(["public", "for ann"]);
      expect(b.at(-1)).toEqual(["public"]);
      // One-off reads follow the same rule.
      expect(await subs.query("notes:sometimes", {}, bob, "http")).toBe('["public"]');
      expect(await subs.query("notes:sometimes", {}, ann, "http")).toBe('["public","for ann"]');
    });

    test("a write waits for its caller's own queries, and nobody else's", async () => {
      const me = {};
      const mine = watch("notes:mine", ann, me);
      const theirs = watch("notes:mine", bob, {});
      await sleep(30);

      await runtime.runMutation("notes:add", { text: "x", owner: "ann" }, { settle: me });
      expect(mine.at(-1)).toEqual(["x"]); // there before the mutation returned
      await sleep(50);
      expect(runs["notes:mine"]).toBe(4); // bob's re-ran too, with nothing new for him
      expect(theirs).toEqual([[]]);

      await runtime.runMutation("notes:add", { text: "y", owner: "bob" }, { settle: "none" });
      expect(theirs.at(-1)).toEqual([]);
      // A read right after the write never gets the result from before it.
      expect(await subs.query("notes:mine", {}, bob, "http")).toBe('["y"]');
      await sleep(50);
      expect(theirs.at(-1)).toEqual(["y"]);
    });

    test("many subscribers re-run in the background without holding up the writer", async () => {
      const watchers = Array.from({ length: 300 }, (_, i) => watch("notes:mine", { ...ann, subject: `user${i}`, tokenIdentifier: `test|user${i}` }));
      await sleep(300);
      const before = runs["notes:mine"]!;
      await runtime.runMutation("notes:add", { text: "z", owner: "user7" }, { settle: "none" });
      expect(runs["notes:mine"]! - before).toBeLessThan(300);
      for (let i = 0; i < 100 && subs.waiting; i++) await sleep(20);
      await sleep(50);
      expect(runs["notes:mine"]! - before).toBe(300);
      expect(watchers[7]!.at(-1)).toEqual(["z"]);
      expect(watchers[8]!.at(-1)).toEqual([]);
    });
  });
}

// ---------- Scheduled jobs on a shared database ----------

for (const D of DRIVERS.filter((d) => d.name !== "sqlite")) {
  describe(`${D.name} > job leases`, () => {
    test("a job left running by an instance that went away runs again; one still being renewed is left alone", async () => {
      const { Scheduler, leaseMark } = await import("../src/engine/scheduler");
      const jobs = {
        jobs: {
          note: mutation({ args: { text: v.string() }, handler: (ctx, a) => ctx.db.insert("notes", a) }),
          list: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text).sort() }),
        },
      };
      const { driver, runtime } = await openRuntime(() => D.make(""), { schema, modules: jobs });
      const [heartbeat, lease] = [Scheduler.heartbeatMs, Scheduler.jobLeaseMs];
      Scheduler.heartbeatMs = 100;
      Scheduler.jobLeaseMs = 1000;
      try {
        const now = Date.now();
        const row = (id: string, text: string, mark: string | null) =>
          runtime.withWriter((tx) => tx.run("INSERT INTO _scheduled (id, fn, args, run_at, state, error) VALUES (?, 'jobs:note', ?, ?, 'running', ?)", [id, JSON.stringify({ text }), now, mark]));
        await row("gone", "from the instance that went away", leaseMark(now - 60_000));
        await row("alive", "still running elsewhere", leaseMark(now + 60_000));
        await row("older", "claimed by an older onebase", null);

        await runtime.startScheduler();
        await sleep(600);
        expect((await runtime.runQuery("jobs:list", {})).value).toEqual(["from the instance that went away"]);
        const states = await runtime.withReader((tx) => tx.all("SELECT id, state FROM _scheduled ORDER BY id"));
        expect(states).toEqual([
          { id: "alive", state: "running" },
          { id: "gone", state: "done" },
          { id: "older", state: "running" },
        ]);
      } finally {
        Scheduler.heartbeatMs = heartbeat;
        Scheduler.jobLeaseMs = lease;
        runtime.stop();
        await driver.close();
      }
    });
  });
}
