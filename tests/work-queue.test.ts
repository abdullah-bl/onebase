import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { onCompleteArgs, onCompleteValidator, workQueue } from "../src/components/work-queue";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { action, anyApi, defineSchema, defineTable, internalAction, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const components = defineComponents({
  queue: workQueue({ maxParallelism: 2, retry: { initialBackoffMs: 10, base: 1 } }),
});

const schema = defineSchema({
  log: defineTable({ text: v.string() }),
  attempts: defineTable({ key: v.string(), n: v.number() }).index("by_key", ["key"]),
});

let concurrent = 0;
let peak = 0;

const internal = anyApi;
const modules = {
  work: {
    write: internalMutation({ args: { text: v.string() }, handler: async (ctx, { text }) => (await ctx.db.insert("log", { text }), text.toUpperCase()) }),
    /** Fails until its third attempt. */
    flaky: internalMutation({
      args: { key: v.string() },
      handler: async (ctx, { key }) => {
        const row = await ctx.db.query("attempts").withIndex("by_key", (q) => q.eq("key", key)).unique();
        const n = (row?.n ?? 0) + 1;
        if (row) await ctx.db.patch(row._id, { n });
        else await ctx.db.insert("attempts", { key, n });
        return n;
      },
    }),
    failsTwice: internalAction({
      args: { key: v.string() },
      handler: async (ctx, { key }) => {
        const n = (await ctx.runMutation(internal.work.flaky, { key })) as number;
        if (n < 3) throw new Error(`attempt ${n} failed`);
        return `ok on ${n}`;
      },
    }),
    alwaysFails: internalAction({ args: {}, handler: () => { throw new Error("nope"); } }),
    slow: internalAction({
      args: { ms: v.number() },
      handler: async (_ctx, { ms }) => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await Bun.sleep(ms);
        concurrent--;
        return null;
      },
    }),
    done: internalMutation({
      args: onCompleteValidator,
      handler: async (ctx, { id, context, result }) => {
        await ctx.db.insert("log", { text: `done ${context} ${result.kind}${result.kind === "success" ? ` ${JSON.stringify(result.returnValue)}` : result.kind === "failed" ? ` ${result.error}` : ""}` });
      },
    }),
    typedDone: internalMutation({
      args: onCompleteArgs(v.object({ n: v.number() })),
      handler: async (ctx, { context, result }) => {
        const n: number = context.n;
        await ctx.db.insert("log", { text: `typed ${n + 1} ${result.kind}` });
      },
    }),
    typed: mutation({
      args: { context: v.any() },
      handler: (ctx: any, { context }) => ctx.components.queue.enqueueMutation({ fn: internal.work.write, args: { text: "t" }, onComplete: internal.work.typedDone, context }),
    }),
    enqueue: mutation({ args: { kind: v.string(), args: v.any() }, handler: (ctx: any, { kind, args }) => ctx.components.queue[kind]({ ...args, fn: internal.work[args.fn], onComplete: args.onComplete ? internal.work.done : undefined }) }),
    cancel: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.queue.cancel({ id }) }),
    status: query({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.queue.status({ id }) }),
    list: query({ args: { state: v.string() }, handler: (ctx: any, { state }) => ctx.components.queue.list({ state, paginationOpts: { numItems: 50, cursor: null } }) }),
    log: query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).map((d) => d.text) }),
    fromAction: action({ args: {}, handler: (ctx: any) => ctx.components.queue.enqueueMutation({ fn: internal.work.write, args: { text: "from an action" } }) }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: work queue`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-queue-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.startScheduler();
    concurrent = 0;
    peak = 0;
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const enqueue = (kind: string, args: object) => runtime.runMutation("work:enqueue", { kind, args }) as Promise<string>;
  const status = async (id: string) => (await runtime.runQuery("work:status", { id })).value as any;
  const log = async () => (await runtime.runQuery("work:log", {})).value as string[];
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("runs a mutation once and reports to onComplete", async () => {
    const id = await enqueue("enqueueMutation", { fn: "write", args: { text: "hi" }, onComplete: true, context: "ctx1" });
    await until(async () => (await status(id)).state === "succeeded");
    expect(await status(id)).toMatchObject({ state: "succeeded", attempts: 1, result: "HI", error: null });
    expect(await log()).toEqual(["hi", 'done ctx1 success "HI"']);
  });

  test("retries a failing action with backoff, then succeeds", async () => {
    const id = await enqueue("enqueueAction", { fn: "failsTwice", args: { key: "a" }, retry: { maxAttempts: 3 }, onComplete: true, context: "c" });
    await until(async () => (await status(id)).state === "succeeded");
    expect(await status(id)).toMatchObject({ attempts: 3, result: "ok on 3" });
    expect(await log()).toEqual(['done c success "ok on 3"']);
  });

  test("gives up after maxAttempts", async () => {
    const id = await enqueue("enqueueAction", { fn: "alwaysFails", args: {}, retry: { maxAttempts: 2 }, onComplete: true, context: "x" });
    await until(async () => (await status(id)).state === "failed");
    expect(await status(id)).toMatchObject({ attempts: 2, error: "nope" });
    expect(await log()).toEqual(["done x failed nope"]);
  });

  test("never runs more than maxParallelism at once", async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => enqueue("enqueueAction", { fn: "slow", args: { ms: 80 } })));
    await until(async () => (await Promise.all(ids.map(status))).every((s) => s.state === "succeeded"), 10_000);
    expect(peak).toBe(2);
  });

  test("delays, cancels, and lists", async () => {
    const later = await enqueue("enqueueMutation", { fn: "write", args: { text: "later" }, delayMs: 60_000, onComplete: true, context: "l" });
    expect(await status(later)).toMatchObject({ state: "pending", attempts: 0 });
    const pending = (await runtime.runQuery("work:list", { state: "pending" })).value as any;
    expect(pending.page.map((s: any) => s.id)).toEqual([later]);
    expect(await runtime.runMutation("work:cancel", { id: later })).toBe(true);
    expect(await status(later)).toMatchObject({ state: "canceled" });
    expect(await runtime.runMutation("work:cancel", { id: later })).toBe(false);
    expect(await log()).toEqual(["done l canceled"]);
  });

  test("onCompleteArgs checks the context; a bad one fails only the callback", async () => {
    const good = (await runtime.runMutation("work:typed", { context: { n: 1 } })) as string;
    const bad = (await runtime.runMutation("work:typed", { context: { n: "one" } })) as string;
    await until(async () => (await status(good)).state === "succeeded" && (await status(bad)).state === "succeeded");
    expect((await log()).sort()).toEqual(["t", "t", "typed 2 success"]);
  });

  test("actions can enqueue too", async () => {
    const id = (await runtime.runAction("work:fromAction", {})) as string;
    await until(async () => (await status(id)).state === "succeeded");
    expect(await log()).toEqual(["from an action"]);
  });

  test("the sweep fails attempts that ran too long; a late result is ignored", async () => {
    const id = await enqueue("enqueueMutation", { fn: "write", args: { text: "stuck" }, delayMs: 60_000, retry: { maxAttempts: 1 } });
    // Pretend an instance claimed it 20 minutes ago and went away.
    await runtime.adminWrite((db) => db.patch(id, { state: "running", attempts: 1, startedAt: Date.now() - 20 * 60_000 }));
    await runtime.runMutation("components/queue:sweep", {}, { allowInternal: true, source: "dashboard" });
    expect(await status(id)).toMatchObject({ state: "failed", error: "Timed out after 900s." });
    await runtime.runMutation("components/queue:complete", { id, attempt: 1, outcome: { ok: true, value: 1 } }, { allowInternal: true, source: "dashboard" });
    expect(await status(id)).toMatchObject({ state: "failed" });
  });

  test("fn must be a function reference", async () => {
    await expect(runtime.runMutation("components/queue:enqueueAction", { fn: "work:slow" }, { allowInternal: true, source: "dashboard" })).rejects.toThrow(
      "fn must be a function reference",
    );
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").MutationCtx<any, typeof components>) {
  type Ref<T extends "action" | "mutation", A> = import("../src/api").FunctionReference<T, "internal", A, unknown>;
  const send = {} as Ref<"action", { to: string }>;
  const write = {} as Ref<"mutation", { text: string }>;
  const id: string = await ctx.components.queue.enqueueAction({ fn: send, args: { to: "a@b.c" } });
  // @ts-expect-error: wrong args for the function
  await ctx.components.queue.enqueueAction({ fn: send, args: { text: "x" } });
  // @ts-expect-error: a mutation isn't an action
  await ctx.components.queue.enqueueAction({ fn: write, args: { text: "x" } });
  await ctx.components.queue.enqueueMutation({ fn: write, args: { text: "x" }, retry: { maxAttempts: 3 } });
  return id;
}
void _types;
