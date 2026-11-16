// Live-query re-runs on query worker threads (ONEBASE_QUERY_WORKERS): background re-runs move off
// the main thread, see the commit that caused them, and give the same results and errors the main
// thread would. A query that needs the main thread, or code that was replaced, never gets a
// worker's result delivered.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleProject } from "../src/deploy";
import { SqliteDriver } from "../src/engine/driver";
import type { Runtime, RuntimeOptions } from "../src/engine/runtime";
import { SubscriptionManager, type QueryUpdate } from "../src/engine/sync";
import { importBundle, loadProjectCode } from "../src/project";
import { openRuntime } from "./helpers";

const LIMIT = 400;

const FILES: Record<string, string> = {
  "schema.ts": `
    import { defineSchema, defineTable } from "onebase/server";
    import { v } from "onebase/values";
    export default defineSchema({ notes: defineTable({ text: v.string(), owner: v.optional(v.string()) }).index("by_text", ["text"]) });
  `,
  "notes.ts": `
    import { internalQuery, mutation, query, createFunctionHandle } from "onebase/server";
    import { OneBaseError, v } from "onebase/values";
    import { internal } from "./_generated/api";

    const where = () => (Bun.isMainThread ? "main" : "worker");
    const texts = async (ctx: any) => (await ctx.db.query("notes").collect()).map((n: any) => n.text).sort();
    const has = async (ctx: any, text: string) => (await ctx.db.query("notes").withIndex("by_text", (q: any) => q.eq("text", text)).first()) !== null;
    /** A fixed amount of computation that never yields and doesn't read the clock. */
    const burn = (n: number) => { let x = 1; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; } return x; };

    export const add = mutation({ args: { text: v.string(), owner: v.optional(v.string()) }, handler: (ctx, a) => ctx.db.insert("notes", a) });
    export const remove = mutation({
      args: { text: v.string() },
      handler: async (ctx, { text }) => { for (const n of await ctx.db.query("notes").collect()) if (n.text === text) await ctx.db.delete(n._id); },
    });

    export const all = query({ args: {}, handler: async (ctx) => ({ texts: await texts(ctx), where: where() }) });
    export const mine = query({
      args: {},
      handler: async (ctx) => {
        const me = (await ctx.auth.getUserIdentity())?.subject ?? "nobody";
        return { texts: (await ctx.db.query("notes").collect()).filter((n) => n.owner === me).map((n) => n.text), where: where() };
      },
    });
    // The same for everyone until there is a private note.
    export const sometimes = query({
      args: {},
      handler: async (ctx) => {
        const notes = await ctx.db.query("notes").collect();
        if (!notes.some((n) => n.owner)) return notes.map((n) => n.text).sort();
        const me = (await ctx.auth.getUserIdentity())?.subject ?? "nobody";
        return notes.filter((n) => !n.owner || n.owner === me).map((n) => n.text).sort();
      },
    });
    export const slow = query({ args: { n: v.number() }, handler: async (ctx, { n }) => { const t = await texts(ctx); burn(n); return { texts: t, where: where() }; } });
    export const throws = query({
      args: {},
      handler: async (ctx) => {
        if (await has(ctx, "bad")) throw new OneBaseError({ code: "nope" });
        return { texts: await texts(ctx), where: where() };
      },
    });
    export const dice = query({ args: {}, handler: async (ctx) => ((await has(ctx, "dice")) ? Math.random() : 0) });
    export const forever = query({
      args: {},
      handler: async (ctx) => {
        if (await has(ctx, "spin")) while (true) {}
        return { texts: await texts(ctx), where: where() };
      },
    });
    export const secret = internalQuery({ args: {}, handler: async () => "secret" });
    export const handled = query({
      args: {},
      handler: async (ctx) => {
        if (await has(ctx, "handle")) await createFunctionHandle(internal.notes.secret);
        return { texts: await texts(ctx), where: where() };
      },
    });
    export const nested = query({ args: {}, handler: (ctx) => ctx.runQuery(internal.notes.secret, {}).then((s) => ({ s, where: where() })) });
  `,
};

const root = mkdtempSync(join(tmpdir(), "onebase-query-workers-"));
const opened: { runtime: Runtime; driver: SqliteDriver }[] = [];

function writeProject(name: string, files: Record<string, string>): string {
  const project = join(root, name, "onebase");
  mkdirSync(join(project, "_generated"), { recursive: true });
  for (const [file, source] of Object.entries(files)) writeFileSync(join(project, file), source);
  writeFileSync(join(project, "_generated", "api.ts"), `import { anyApi } from "onebase/server"; export const api: any = anyApi; export const internal: any = anyApi;`);
  return project;
}

/** A runtime running a project from disk, as `onebase serve` does, with live queries on top. */
async function start(name: string, files: Record<string, string>, opts: Partial<RuntimeOptions> = {}) {
  const code = await loadProjectCode(writeProject(name, files));
  const started = (await openRuntime(() => new SqliteDriver(join(root, name, "db.sqlite")), {
    ...code,
    queryWorkers: 2,
    queryWorkersAfterMs: 0, // every background re-run goes to a worker, however small the fan-out
    timeLimits: { queryMs: LIMIT },
    ...opts,
  })) as { runtime: Runtime; driver: SqliteDriver };
  opened.push(started);
  const subs = new SubscriptionManager(started.runtime);
  started.runtime.onDeploy(() => subs.rerunAll());
  return { runtime: started.runtime, subs };
}

const user = (subject: string) => ({ subject, issuer: "t", tokenIdentifier: `t|${subject}` });

/** Waits until `ready()` holds, failing after a few seconds. */
async function until(ready: () => boolean, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(5);
  }
}

let runtime: Runtime;
let subs: SubscriptionManager;

/** Subscribes and collects every update received. */
const watch = (name: string, args: Record<string, unknown> = {}, identity: ReturnType<typeof user> | null = null) => {
  const got: QueryUpdate[] = [];
  subs.subscribe(name, args, identity, (u) => got.push(u.ok ? { ok: true, value: u.value } : { ...u }));
  return got;
};
const last = (got: QueryUpdate[]) => got.at(-1) as any;
const settled = () => until(() => subs.waiting === 0, "the background re-runs");

beforeAll(async () => {
  ({ runtime, subs } = await start("main", FILES));
});

afterAll(async () => {
  for (const { runtime, driver } of opened) {
    runtime.stop();
    await driver.close();
  }
  rmSync(root, { recursive: true, force: true });
});

test("a background re-run runs on a worker and sees the commit that caused it", async () => {
  expect(runtime.queryPool).not.toBeNull();
  const watchers = Array.from({ length: 20 }, (_, i) => watch("notes:mine", {}, user(`u${i}`)));
  await until(() => watchers.every((w) => w.length > 0), "the first results");
  expect(last(watchers[0]!).value.where).toBe("main"); // a subscription's first run stays on the main thread
  const before = runtime.queryWorkerRuns;

  for (let i = 0; i < 5; i++) {
    await runtime.runMutation("notes:add", { text: `n${i}`, owner: "u3" }, { settle: "none" });
    // Every write is seen by the re-run it caused: the latest value always has it.
    await until(() => (last(watchers[3]!).value.texts as string[]).includes(`n${i}`), `u3 to see n${i}`);
  }
  await settled();
  expect(last(watchers[3]!).value).toEqual({ texts: ["n0", "n1", "n2", "n3", "n4"], where: "worker" });
  expect(last(watchers[4]!).value.texts).toEqual([]);
  // Every subscriber's latest result came from a worker (re-runs of one entry may merge, so not one per write).
  for (const w of watchers) expect(last(w).value.where).toBe("worker");
  expect(runtime.queryWorkerRuns - before).toBeGreaterThanOrEqual(20);
  expect(runtime.queryPool!.size).toBeGreaterThan(0);
});

test("a commit that lands while a worker runs the query brings it up to date afterwards", async () => {
  const got = watch("notes:slow", { n: 40_000_000 });
  await until(() => got.length > 0, "the first result");
  await runtime.runMutation("notes:add", { text: "during-1" }, { settle: "none" });
  await Bun.sleep(15); // the worker is busy with the re-run for during-1
  await runtime.runMutation("notes:add", { text: "during-2" }, { settle: "none" });
  await until(() => (last(got).value.texts as string[]).includes("during-2"), "the second write");
  expect(last(got).value.texts).toContain("during-1");
  expect(last(got).value.where).toBe("worker");
});

test("a write still waits only for its caller's own queries, which run on the main thread", async () => {
  const me = {};
  const mine: QueryUpdate[] = [];
  subs.subscribe("notes:all", {}, null, (u) => mine.push(u), me);
  await until(() => mine.length > 0, "the first result");
  await runtime.runMutation("notes:add", { text: "waited" }, { settle: me });
  // Delivered before the write returned, by a run on the main thread (not queued behind workers).
  expect(last(mine).value.texts).toContain("waited");
  expect(last(mine).value.where).toBe("main");
});

test("a query that throws on a worker fails as it would on the main thread, and recovers", async () => {
  const got = watch("notes:throws");
  await until(() => got.length > 0, "the first result");
  await runtime.runMutation("notes:add", { text: "bad" }, { settle: "none" });
  await until(() => last(got).ok === false, "the error");
  const here = await runtime.runQuery("notes:throws", {}).catch((err) => runtime.toClientError(err, "notes:throws"));
  expect(last(got)).toEqual({ ok: false, error: (here as Error).message, data: { code: "nope" } });
  // What it read before throwing is still watched, so fixing the data brings it back.
  await runtime.runMutation("notes:remove", { text: "bad" }, { settle: "none" });
  await until(() => last(got).ok === true, "the recovery");
  expect(last(got).value.where).toBe("worker");
});

test("a query seen reading the clock or randomness on a worker is never answered from the cache", async () => {
  const got = watch("notes:dice");
  await until(() => got.length > 0, "the first result");
  expect(last(got).value).toBe(0);
  await runtime.runMutation("notes:add", { text: "dice" }, { settle: "none" });
  await until(() => last(got).value !== 0, "the random value");
  await settled();
  // Learned on the worker: each one-off read runs the query again.
  const a = await subs.query("notes:dice", {}, null, "http");
  const b = await subs.query("notes:dice", {}, null, "http");
  expect(a).not.toBe(b);
});

test("identity: per-user queries stay per user, and a shared one that starts reading it is split", async () => {
  const ann = watch("notes:sometimes", {}, user("ann"));
  await until(() => ann.length > 0, "ann's first result");
  const bob = watch("notes:sometimes", {}, user("bob"));
  await until(() => bob.length > 0, "bob's first result");
  await runtime.runMutation("notes:add", { text: "for-ann", owner: "ann" }, { settle: "none" });
  await until(() => (last(ann).value as string[]).includes("for-ann"), "ann's private note");
  await settled();
  await Bun.sleep(50);
  expect(last(bob).value).not.toContain("for-ann"); // bob never gets ann's result
  expect(bob.some((u: any) => u.ok && u.value.includes("for-ann"))).toBe(false);
});

test("a query past its time limit fails with the usual error; its worker is replaced and others carry on", async () => {
  const spinning = watch("notes:forever");
  const other = watch("notes:all");
  await until(() => spinning.length > 0 && other.length > 0, "the first results");
  await runtime.runMutation("notes:add", { text: "spin" }, { settle: "none" });
  await until(() => last(spinning).ok === false, "the time-limit error", LIMIT + 3000);
  expect(last(spinning).error).toBe(`notes:forever didn't finish within the query time limit (${LIMIT}ms).`);
  await until(() => (last(other).value.texts as string[]).includes("spin"), "the other query");

  await runtime.runMutation("notes:remove", { text: "spin" }, { settle: "none" });
  await until(() => last(spinning).ok === true, "the recovery");
  expect(last(spinning).value.where).toBe("worker"); // on a new worker
});

test("a query that uses a function handle runs on the main thread from then on", async () => {
  const got = watch("notes:handled");
  await until(() => got.length > 0, "the first result");
  await runtime.runMutation("notes:add", { text: "handle" }, { settle: "none" });
  await until(() => (last(got).value.texts as string[]).includes("handle"), "the handle note");
  expect(last(got).value.where).toBe("main");
  expect(runtime.queryPool!.accepts("notes:handled")).toBe(false);
  await runtime.runMutation("notes:add", { text: "after-handle" }, { settle: "none" });
  await until(() => (last(got).value.texts as string[]).includes("after-handle"), "the next write");
  expect(last(got).value.where).toBe("main");
});

test("nested ctx.runQuery runs on the worker too", async () => {
  const got = watch("notes:nested");
  await until(() => got.length > 0, "the first result");
  await runtime.runMutation("notes:add", { text: "nudge" }, { settle: "none" }); // reads nothing, so every commit re-runs it
  await until(() => last(got).value.where === "worker", "a worker run");
  expect(last(got).value.s).toBe("secret");
});

test("a deploy while a worker runs the query: the old code's result is never delivered", async () => {
  const version = (v: string) => ({
    "notes.ts": `
      import { mutation, query } from "onebase/server";
      import { v } from "onebase/values";
      const burn = (n: number) => { let x = 1; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; } return x; };
      export const add = mutation({ args: { text: v.string() }, handler: (ctx, a) => ctx.db.insert("notes", a) });
      export const version = query({
        args: {},
        handler: async (ctx) => {
          const texts = (await ctx.db.query("notes").collect()).map((n) => n.text);
          if (texts.length) burn(60_000_000);
          return { v: "${v}", texts, where: Bun.isMainThread ? "main" : "worker" };
        },
      });
    `,
  });
  const deployed = await start("deploys", version("local"), { loadCode: importBundle });
  await deployed.runtime.deploy({ code: (await bundleProject(writeProject("v1", version("v1")))).code });
  const got: any[] = [];
  deployed.subs.subscribe("notes:version", {}, null, (u) => got.push(u.ok ? u.value : u));
  await until(() => got.length > 0, "the first result");
  expect(got.at(-1)).toEqual({ v: "v1", texts: [], where: "main" });

  await deployed.runtime.runMutation("notes:add", { text: "x" }, { settle: "none" });
  await Bun.sleep(20); // the worker is in the middle of the v1 re-run that saw "x"
  await deployed.runtime.deploy({ code: (await bundleProject(writeProject("v2", version("v2")))).code });
  await until(() => got.at(-1).v === "v2", "the new code's result");
  await Bun.sleep(300); // long enough for the old run to have finished
  expect(got.at(-1)).toMatchObject({ v: "v2", texts: ["x"] });
  expect(got.some((u) => u.v === "v1" && u.texts.includes("x"))).toBe(false);
  expect(got.every((u) => u.v === "v1" || u.v === "v2")).toBe(true); // no error from the stopped run either
  // And the next background re-run uses the new code's workers.
  await deployed.runtime.runMutation("notes:add", { text: "y" }, { settle: "none" });
  await until(() => got.at(-1).texts?.includes("y"), "the next write", 8000);
  expect(got.at(-1)).toMatchObject({ v: "v2", where: "worker" });
});

test("by default a small fan-out stays on the main thread and starts no worker; a large one moves to the workers", async () => {
  // As `onebase serve` runs it: workers allowed, but only used once a round of re-runs has gone on for a few milliseconds.
  const app = await start("adaptive", FILES, { queryWorkersAfterMs: undefined });
  const pool = app.runtime.queryPool!;
  expect(pool).not.toBeNull();
  const watchAs = (name: string, args: Record<string, unknown>, who: string) => {
    const got: any[] = [];
    app.subs.subscribe(name, args, user(who), (u) => got.push(u.ok ? u.value : u));
    return got;
  };
  const idle = () => until(() => app.subs.waiting === 0, "the background re-runs");

  const few = Array.from({ length: 5 }, (_, i) => watchAs("notes:mine", {}, `u${i}`));
  await until(() => few.every((w) => w.length > 0), "the first results");
  for (let i = 0; i < 5; i++) {
    await app.runtime.runMutation("notes:add", { text: `small${i}`, owner: "u1" }, { settle: "none" });
    await until(() => few[1]!.at(-1).texts.includes(`small${i}`), `small${i}`);
    await idle();
  }
  expect(few.every((w) => w.at(-1).where === "main")).toBe(true);
  expect(app.runtime.queryWorkerRuns).toBe(0);
  expect(pool.size).toBe(0);

  // 80 queries of a few milliseconds each: far more than the main thread does before handing over.
  const many = Array.from({ length: 80 }, (_, i) => watchAs("notes:slow", { n: 2_000_000 + i }, "u0"));
  await until(() => many.every((w) => w.length > 0), "the first results", 20_000);
  for (const text of ["large1", "large2"]) {
    await app.runtime.runMutation("notes:add", { text }, { settle: "none" });
    await until(() => many.every((w) => w.at(-1).texts.includes(text)), text, 20_000);
    await idle();
  }
  // The first write's round starts a worker and carries on meanwhile; by the second, it is ready.
  expect(app.runtime.queryWorkerRuns).toBeGreaterThan(0);
  expect(many.some((w) => w.at(-1).where === "worker")).toBe(true);
  // The start of every round still runs on the main thread.
  expect(many.some((w) => w.at(-1).where === "main")).toBe(true);
}, 60_000);

test("queryWorkers: 0, dev mode and in-memory code keep every query on the main thread", async () => {
  const off = await start("off", FILES, { queryWorkers: 0 });
  expect(off.runtime.queryPool).toBeNull();
  const dev = await start("dev", FILES, { dev: true });
  expect(dev.runtime.queryPool).toBeNull();
  const got: any[] = [];
  off.subs.subscribe("notes:all", {}, null, (u) => got.push(u.ok ? u.value : u));
  await until(() => got.length > 0, "the first result");
  await off.runtime.runMutation("notes:add", { text: "z" }, { settle: "none" });
  await until(() => got.at(-1).texts.includes("z"), "the write");
  expect(got.at(-1).where).toBe("main");
});
