// One-off reads answered from the results of earlier runs, and the live query gaps a cache would inherit.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver, type Driver } from "../src/engine/driver";
import { serve } from "../src/engine/http";
import type { Runtime } from "../src/engine/runtime";
import { SubscriptionManager, type QueryUpdate } from "../src/engine/sync";
import { action, defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { countRuns, openRuntime } from "./helpers";

const schema = defineSchema({
  notes: defineTable({ topic: v.string(), body: v.string(), rank: v.optional(v.number()) })
    .index("by_topic", ["topic"])
    .searchIndex("search_body", { searchField: "body" }),
  pointers: defineTable({ target: v.string() }),
});

/** A query waits here, inside its snapshot, while a test commits around it. */
let gate: Promise<void> | null = null;
const pause = () => {
  let release!: () => void;
  gate = new Promise((resolve) => (release = resolve));
  return () => {
    gate = null;
    release();
  };
};

const topicNotes = (ctx: any, topic: string) => ctx.db.query("notes").withIndex("by_topic", (q: any) => q.eq("topic", topic)).collect();
const clockQuery = (read: () => unknown) => query({ args: {}, handler: () => read() });

const modules = {
  notes: {
    add: mutation({
      args: { topic: v.string(), body: v.string() },
      handler: (ctx, a) => ctx.db.insert("notes", a),
    }),
    edit: mutation({ args: { id: v.string(), body: v.string() }, handler: (ctx, a) => ctx.db.patch(a.id as any, { body: a.body }) }),
    bodies: query({
      args: { topic: v.string() },
      handler: async (ctx, a) => {
        const notes = await topicNotes(ctx, a.topic);
        if (gate) await gate;
        return notes.map((n: any) => n.body);
      },
    }),
    missing: query({ args: {}, handler: () => undefined }),
    broken: query({ args: {}, handler: () => { throw new Error("broken on purpose"); } }),
    whoami: query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.role ?? null }),
    big: query({ args: { size: v.number(), tag: v.optional(v.string()) }, handler: (_ctx, a) => "x".repeat(a.size) }),
    // Everything a query can do without leaving what it reads.
    filtered: query({
      args: {},
      handler: (ctx) => ctx.db.query("notes").filter((q) => q.eq(q.field("topic"), "nothing")).collect(),
    }),
    paged: query({ args: {}, handler: (ctx) => ctx.db.query("notes").order("desc").paginate({ numItems: 2, cursor: null }) }),
    searched: query({
      args: {},
      handler: (ctx) => ctx.db.query("notes").withSearchIndex("search_body", (q) => q.search("body", "hello")).collect(),
    }),
    nested: query({ args: {}, handler: (ctx) => ctx.runQuery("notes:filtered", {}) }),
    fixedDate: query({ args: {}, handler: () => new Date(0).toISOString() }),
    // ... and everything that does.
    now: clockQuery(() => Date.now()),
    newDate: clockQuery(() => new Date().getTime()),
    dateCall: clockQuery(() => Date()),
    random: clockQuery(() => Math.random()),
    perf: clockQuery(() => performance.now()),
    uuid: clockQuery(() => crypto.randomUUID()),
    bytes: clockQuery(() => [...crypto.getRandomValues(new Uint8Array(4))]),
    nestedNow: query({ args: {}, handler: (ctx) => ctx.runQuery("notes:now", {}) }),
  },
  pointers: {
    add: mutation({ args: { target: v.string() }, handler: (ctx, a) => ctx.db.insert("pointers", a) }),
    move: mutation({ args: { id: v.string(), target: v.string() }, handler: (ctx, a) => ctx.db.patch(a.id as any, { target: a.target }) }),
    follow: query({
      args: { id: v.string() },
      handler: async (ctx, a) => {
        const pointer: any = await ctx.db.get(a.id as any);
        const note: any = await ctx.db.get(pointer.target);
        if (gate) await gate;
        return note.body;
      },
    }),
  },
  files: {
    store: action({ args: {}, handler: (ctx) => ctx.storage.store(new Blob(["hi"], { type: "text/plain" })) }),
    dropInMutation: mutation({ args: { id: v.string() }, handler: (ctx, a) => ctx.storage.delete(a.id as any) }),
    dropInAction: action({ args: { id: v.string() }, handler: (ctx, a) => ctx.storage.delete(a.id as any) }),
    url: query({ args: { id: v.string() }, handler: (ctx, a) => ctx.storage.getUrl(a.id as any) }),
    size: query({ args: { id: v.string() }, handler: async (ctx, a) => (await ctx.storage.getMetadata(a.id as any))?.size ?? null }),
  },
};

let dir: string;
let driver: Driver;
let runtime: Runtime;
let subs: SubscriptionManager;
let runs: Record<string, number>;

beforeEach(async () => {
  gate = null;
  dir = mkdtempSync(join(tmpdir(), "onebase-cache-"));
  ({ driver, runtime } = await openRuntime(() => new SqliteDriver(`${dir}/db.sqlite`), { schema, modules, dataDir: dir } as any));
  subs = new SubscriptionManager(runtime);
  runs = countRuns(runtime);
});

afterEach(async () => {
  runtime.stop();
  await driver.close();
  rmSync(dir, { recursive: true, force: true });
});

const add = (topic: string, body: string) => runtime.runMutation("notes:add", { topic, body }) as Promise<string>;
const read = async (name: string, args: Record<string, unknown> = {}, identity: any = null) => JSON.parse(await subs.query(name, args, identity, "http"));
const runsOf = (key: string) => runs[key] ?? 0;
const settle = () => Bun.sleep(10);

const watch = async (name: string, args: Record<string, unknown>) => {
  let last: QueryUpdate | null = null;
  const stop = subs.subscribe(name, args, null, (u) => (last = u));
  await Bun.sleep(20);
  return { value: () => (last as any)?.value, stop };
};

describe("live queries", () => {
  test("a commit during a re-run counts against what that run read, not the run before", async () => {
    const first = await add("t", "first");
    const second = await add("t", "second, old");
    const pointer = (await runtime.runMutation("pointers:add", { target: first })) as string;
    const live = await watch("pointers:follow", { id: pointer });
    expect(live.value()).toBe("first");

    const release = pause();
    // The re-run reads "second, old" and waits. The next commit touches only what it newly read.
    const moved = runtime.runMutation("pointers:move", { id: pointer, target: second });
    await Bun.sleep(20);
    await runtime.runMutation("notes:edit", { id: second, body: "second, new" });
    release();
    await moved;
    await Bun.sleep(30);
    expect(live.value()).toBe("second, new");
  });

  for (const [how, drop] of [
    ["a mutation", (id: string) => runtime.runMutation("files:dropInMutation", { id })],
    ["an action", (id: string) => runtime.runAction("files:dropInAction", { id })],
  ] as const) {
    test(`a file deleted in ${how} reaches queries that read it`, async () => {
      const id = (await runtime.runAction("files:store", {})) as string;
      const url = await watch("files:url", { id });
      const size = await watch("files:size", { id });
      expect(url.value()).toContain(id);
      expect(size.value()).toBe(2);
      await drop(id);
      await settle();
      expect(url.value()).toBeNull();
      expect(size.value()).toBeNull();
    });
  }

  test("two tokens for one user with different claims don't share a result", async () => {
    const base = { subject: "u", tokenIdentifier: "i|u" };
    const seen: Record<string, unknown> = {};
    subs.subscribe("notes:whoami", {}, { ...base, role: "admin" }, (u) => (seen.admin = (u as any).value));
    subs.subscribe("notes:whoami", {}, { ...base, role: "guest" }, (u) => (seen.guest = (u as any).value));
    await settle();
    expect(seen).toEqual({ admin: "admin", guest: "guest" });
  });
});

describe("one-off reads", () => {
  test("repeat reads run once, and a commit they depend on runs them again", async () => {
    const id = await add("t", "one");
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["one"]);
    await settle();
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["one"]);
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["one"]);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);

    // Read your own writes: the mutation's answer means the old result is gone.
    await runtime.runMutation("notes:edit", { id, body: "two" });
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["two"]);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(2);
  });

  test("a commit elsewhere leaves a result alone", async () => {
    await add("t", "one");
    await read("notes:bodies", { topic: "t" });
    await settle();
    await add("other", "x");
    await read("notes:bodies", { topic: "t" });
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);
  });

  test("args in any key order share a result; different args don't", async () => {
    await read("notes:big", { size: 1, tag: "a" });
    await settle();
    await read("notes:big", { tag: "a", size: 1 });
    expect(Object.values(runs).reduce((a, b) => a + b, 0)).toBe(1);
    await read("notes:big", { size: 2, tag: "a" });
    expect(Object.values(runs).reduce((a, b) => a + b, 0)).toBe(2);
  });

  test("identical reads at once share one run", async () => {
    await add("t", "one");
    const results = await Promise.all(Array.from({ length: 50 }, () => read("notes:bodies", { topic: "t" })));
    expect(results.every((r) => r[0] === "one")).toBe(true);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);
  });

  test("a read that starts after a commit never gets a run from before it", async () => {
    const id = await add("t", "old");
    const release = pause();
    const before = read("notes:bodies", { topic: "t" });
    await settle();
    await runtime.runMutation("notes:edit", { id, body: "new" });

    // The run in progress may have the old snapshot, so this one can't share it.
    const after = read("notes:bodies", { topic: "t" });
    release();
    expect(await before).toEqual(["old"]);
    expect(await after).toEqual(["new"]);
    await settle();

    // Nor is the old run kept for later.
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["new"]);
  });

  test("a run that a commit overtakes isn't kept, even if the commit landed before the next read", async () => {
    const id = await add("t", "old");
    const release = pause();
    const before = read("notes:bodies", { topic: "t" });
    await settle();
    await runtime.runMutation("notes:edit", { id, body: "new" });
    release();
    await before;
    await settle();
    expect(subs.cached.entries).toBe(0);
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["new"]);
  });

  test("users see only their own results", async () => {
    const base = { subject: "u", tokenIdentifier: "i|u" };
    expect(await read("notes:whoami", {}, { ...base, role: "admin" })).toBe("admin");
    await settle();
    expect(await read("notes:whoami", {}, { ...base, role: "guest" })).toBe("guest");
    expect(await read("notes:whoami")).toBeNull();
    expect(await read("notes:whoami", {}, { ...base, role: "admin" })).toBe("admin");
    expect(runsOf("notes:whoami")).toBe(3);
  });

  test("errors aren't kept, and reach the caller as they were thrown", async () => {
    await expect(read("notes:broken")).rejects.toThrow("broken on purpose");
    await settle();
    await expect(read("notes:broken")).rejects.toThrow("broken on purpose");
    expect(runsOf("notes:broken")).toBe(2);
    expect(subs.cached.entries).toBe(0);
  });

  test("functions that can't be called stay that way", async () => {
    await expect(read("notes:nope")).rejects.toThrow();
  });

  test("an undefined value arrives as null, from a run and from the cache", async () => {
    expect(await read("notes:missing")).toBeNull();
    await settle();
    expect(await read("notes:missing")).toBeNull();
    expect(runsOf("notes:missing")).toBe(1);
  });

  test("hits appear in the call log", async () => {
    await add("t", "one");
    await read("notes:bodies", { topic: "t" });
    await settle();
    await read("notes:bodies", { topic: "t" });
    const calls = runtime.calls.recent().filter((c) => c.name === "notes:bodies");
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.ok && c.source === "http")).toBe(true);
  });

  for (const name of ["filtered", "paged", "searched", "nested", "fixedDate"]) {
    test(`notes:${name} is reused: reading through ctx doesn't count as reading the clock`, async () => {
      await add("t", "hello");
      await read(`notes:${name}`);
      await settle();
      await read(`notes:${name}`);
      expect(runsOf(`notes:${name}`)).toBe(1);
      expect(subs.cached.entries).toBe(1);
    });
  }

  for (const name of ["now", "newDate", "dateCall", "random", "perf", "uuid", "bytes", "nestedNow"]) {
    test(`notes:${name} runs every time`, async () => {
      await read(`notes:${name}`);
      await settle();
      await read(`notes:${name}`);
      await read(`notes:${name}`);
      expect(runsOf(`notes:${name}`)).toBe(3);
      expect(subs.cached.entries).toBe(0);
    });
  }

  test("a read that joined a run using the clock runs for itself", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => read("notes:now")));
    expect(results).toHaveLength(5);
    expect(runsOf("notes:now")).toBe(5);
  });

  test("a live query that uses the clock is left alone, and reads of it still run", async () => {
    const live = await watch("notes:now", {});
    expect(typeof live.value()).toBe("number");
    const before = runsOf("notes:now");
    await read("notes:now");
    expect(runsOf("notes:now")).toBe(before + 1);
  });
});

describe("with live queries", () => {
  test("a read shares a live query's result", async () => {
    const id = await add("t", "one");
    const live = await watch("notes:bodies", { topic: "t" });
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["one"]);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);

    await runtime.runMutation("notes:edit", { id, body: "two" });
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["two"]);
    expect(live.value()).toEqual(["two"]);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(2);
  });

  test("a result outlives its last subscriber, and isn't re-run while nobody watches", async () => {
    const id = await add("t", "one");
    const live = await watch("notes:bodies", { topic: "t" });
    live.stop();
    expect(subs.size).toBe(0);
    expect(subs.cached.entries).toBe(1);
    expect(await read("notes:bodies", { topic: "t" })).toEqual(["one"]);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);

    await runtime.runMutation("notes:edit", { id, body: "two" });
    await settle();
    expect(subs.cached.entries).toBe(0);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);
  });

  test("subscribing gets a cached result at once, and stays live", async () => {
    const id = await add("t", "one");
    await read("notes:bodies", { topic: "t" });
    await settle();

    let value: unknown;
    subs.subscribe("notes:bodies", { topic: "t" }, null, (u) => (value = (u as any).value));
    expect(value).toEqual(["one"]);
    expect(subs.size).toBe(1);
    expect(subs.cached.entries).toBe(0);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);

    await runtime.runMutation("notes:edit", { id, body: "two" });
    expect(value).toEqual(["two"]);
  });

  test("subscribing while a one-off read runs gets its result", async () => {
    await add("t", "one");
    const release = pause();
    const pending = read("notes:bodies", { topic: "t" });
    let value: unknown;
    subs.subscribe("notes:bodies", { topic: "t" }, null, (u) => (value = (u as any).value));
    release();
    await pending;
    await settle();
    expect(value).toEqual(["one"]);
    expect(subs.cached.entries).toBe(0);
  });

  test("unsubscribing twice counts once", async () => {
    const live = await watch("notes:bodies", { topic: "t" });
    const other = await watch("notes:bodies", { topic: "u" });
    live.stop();
    live.stop();
    expect(subs.size).toBe(1);
    other.stop();
    expect(subs.size).toBe(0);
  });
});

describe("limits", () => {
  const cachedSizes = (s: SubscriptionManager) => s.cached;

  test("the least recently used results go first", async () => {
    subs = new SubscriptionManager(runtime, { cacheBytes: 44_000 });
    const size = 3000;
    await subs.query("notes:big", { size, tag: "a" }, null, "http");
    await subs.query("notes:big", { size, tag: "b" }, null, "http");
    await subs.query("notes:big", { size, tag: "c" }, null, "http");
    await settle();
    // "a" is now the most recent, so "b" is the one that goes when "d" and "e" arrive.
    await subs.query("notes:big", { size, tag: "a" }, null, "http");
    const before = Object.values(runs).reduce((x, y) => x + y, 0);
    await subs.query("notes:big", { size, tag: "d" }, null, "http");
    await subs.query("notes:big", { size, tag: "e" }, null, "http");
    await settle();
    expect(cachedSizes(subs).bytes).toBeLessThanOrEqual(44_000);
    await subs.query("notes:big", { size, tag: "a" }, null, "http");
    expect(Object.values(runs).reduce((x, y) => x + y, 0)).toBe(before + 2);
    await subs.query("notes:big", { size, tag: "b" }, null, "http");
    expect(Object.values(runs).reduce((x, y) => x + y, 0)).toBe(before + 3);
  });

  test("a result too big for the cache isn't kept", async () => {
    subs = new SubscriptionManager(runtime, { cacheBytes: 16_000 });
    await subs.query("notes:big", { size: 8000 }, null, "http");
    await settle();
    expect(cachedSizes(subs).entries).toBe(0);
    expect(cachedSizes(subs).bytes).toBe(0);
  });

  test("dropped results give their room back", async () => {
    const id = await add("t", "one");
    await read("notes:bodies", { topic: "t" });
    await settle();
    expect(subs.cached.bytes).toBeGreaterThan(0);
    await runtime.runMutation("notes:edit", { id, body: "two" });
    expect(subs.cached).toEqual({ entries: 0, bytes: 0 });
    expect((subs as any).entries.size).toBe(0);
    expect((subs as any).index.byKey.size).toBe(0);
  });

  test("0 turns it off", async () => {
    subs = new SubscriptionManager(runtime, { cacheBytes: 0 });
    await add("t", "one");
    await subs.query("notes:bodies", { topic: "t" }, null, "http");
    await settle();
    await subs.query("notes:bodies", { topic: "t" }, null, "http");
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(2);
    expect(subs.cached.entries).toBe(0);
  });

  test("it stays off on a database other instances can write to", async () => {
    Object.defineProperty(driver, "shared", { value: true, configurable: true });
    subs = new SubscriptionManager(runtime, { cacheBytes: 2 ** 20 });
    Object.defineProperty(driver, "shared", { value: false, configurable: true });
    await add("t", "one");
    await subs.query("notes:bodies", { topic: "t" }, null, "http");
    await settle();
    await subs.query("notes:bodies", { topic: "t" }, null, "http");
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(2);
  });

  test("new code drops every result, and forgets which queries used the clock", async () => {
    await add("t", "one");
    await read("notes:bodies", { topic: "t" });
    await read("notes:now");
    await settle();
    expect(subs.cached.entries).toBe(1);
    await subs.rerunAll();
    expect(subs.cached.entries).toBe(0);
    expect((subs as any).impure.size).toBe(0);
    await read("notes:bodies", { topic: "t" });
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(2);
  });
});

describe("over the network", () => {
  let server: ReturnType<typeof serve>;
  let url: string;

  beforeEach(() => {
    server = serve({ runtime, port: 0, hostname: "127.0.0.1" });
    url = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => void server.stop(true));

  const post = (path: string, args: unknown = {}) =>
    fetch(`${url}/api/query`, { method: "POST", body: JSON.stringify({ path, args }) }).then((r) => r.json().then((body) => ({ status: r.status, body })));

  test("HTTP answers are the same from a run and from the cache", async () => {
    await add("t", "one");
    const fresh = await post("notes:bodies", { topic: "t" });
    await settle();
    const hit = await post("notes:bodies", { topic: "t" });
    expect(fresh).toEqual({ status: 200, body: { status: "success", value: ["one"] } });
    expect(hit).toEqual(fresh);
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);

    expect((await post("notes:missing")).body).toEqual({ status: "success", value: null });
  });

  test("HTTP errors are reported as before", async () => {
    const { status, body } = await post("notes:broken");
    expect(status).toBe(400);
    expect(body.status).toBe("error");
  });

  test("WebSocket one-off queries use the cache too", async () => {
    await add("t", "one");
    const ws = new WebSocket(`${url.replace("http", "ws")}/api/sync`);
    const messages: any[] = [];
    ws.onmessage = (e) => messages.push(JSON.parse(e.data as string));
    await new Promise((resolve) => (ws.onopen = resolve));
    const call = async (requestId: number, path: string, args: unknown) => {
      ws.send(JSON.stringify({ type: "call", requestId, kind: "query", path, args }));
      while (!messages.some((m) => m.requestId === requestId)) await Bun.sleep(2);
      return messages.find((m) => m.requestId === requestId);
    };
    expect(await call(1, "notes:bodies", { topic: "t" })).toEqual({ type: "result", requestId: 1, ok: true, value: ["one"] });
    await settle();
    expect(await call(2, "notes:bodies", { topic: "t" })).toEqual({ type: "result", requestId: 2, ok: true, value: ["one"] });
    expect(runsOf('notes:bodies{"topic":"t"}')).toBe(1);
    expect(await call(3, "notes:missing", {})).toEqual({ type: "result", requestId: 3, ok: true, value: null });
    expect((await call(4, "notes:broken", {})).ok).toBe(false);
    ws.close();
  });
});
