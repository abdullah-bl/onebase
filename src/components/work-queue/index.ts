// Background work with a limit on how much runs at once, retries with backoff, and a callback
// when each item finishes. Items are documents, so the queue survives restarts and is shared by
// every instance.
//
//   // onebase/components.ts
//   export default defineComponents({ emails: workQueue({ maxParallelism: 5, retry: { maxAttempts: 3 } }) });
//   // in a mutation
//   await ctx.components.emails.enqueueAction({ fn: internal.emails.send, args: { to }, onComplete: internal.emails.sent });

import type { FunctionHandle, FunctionReference } from "../../api";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { paginationOptsValidator } from "../../server";
import { v, type GenericId } from "../../values";

const state = v.union(v.literal("pending"), v.literal("running"), v.literal("succeeded"), v.literal("failed"), v.literal("canceled"));

const schema = defineSchema({
  items: defineTable({
    /** A handle to the function to run. */
    fn: v.string(),
    kind: v.union(v.literal("action"), v.literal("mutation")),
    args: v.any(),
    state,
    attempts: v.number(),
    maxAttempts: v.number(),
    initialBackoffMs: v.number(),
    base: v.number(),
    runAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    result: v.optional(v.any()),
    onComplete: v.optional(v.string()),
    context: v.optional(v.any()),
  })
    .index("by_state_runAt", ["state", "runAt"])
    .index("by_state_finishedAt", ["state", "finishedAt"]),
  /** The one scheduled run of `pump`, so enqueues don't schedule a pile of them. */
  pump: defineTable({ at: v.union(v.number(), v.null()), job: v.union(v.string(), v.null()) }),
});

export type RetryConfig = {
  /** Runs in all, the first included (default 1: no retries). */
  maxAttempts?: number;
  /** Wait before the first retry, in ms (default 250); each retry waits `base` times longer, ±50%. */
  initialBackoffMs?: number;
  base?: number;
};

type Config = {
  /** Items running at once (default 10). */
  maxParallelism?: number;
  retry?: RetryConfig;
  /** A running item that hasn't finished after this long is counted as failed (default 15 minutes). */
  timeoutMs?: number;
  /** How long finished items are kept for status() and list() (default 7 days). */
  retentionMs?: number;
};

const { query, mutation, internalQuery, internalMutation, internalAction } = componentServer<DataModelFromSchema<typeof schema>, Config>();
type Ctx = { db: any; config: Config; scheduler: any; runMutation: any };

const DAY = 86_400_000;
const parallelism = (c: Config) => c.maxParallelism ?? 10;

/** What onComplete receives. */
export type WorkResult = { kind: "success"; returnValue: unknown } | { kind: "failed"; error: string } | { kind: "canceled" };
/** onComplete's args: `internalMutation({ args: onCompleteValidator, handler: (ctx, { id, context, result }) => ... })`. */
export const onCompleteValidator = { id: v.string(), context: v.any(), result: v.any() };

/** Makes sure `pump` runs by `at`: one scheduled run at a time. */
async function wake(ctx: Ctx, at: number) {
  const now = Date.now();
  const meta = await ctx.db.query("pump").first();
  // A pump is due by then (one far in the past is assumed lost: the sweep cron recovers it too).
  if (meta?.at !== null && meta?.at !== undefined && meta.at <= at && meta.at > now - 60_000) return;
  if (meta?.job) await ctx.scheduler.cancel(meta.job);
  const job = await ctx.scheduler.runAfter(Math.max(0, at - now), pump, {});
  if (meta) await ctx.db.patch(meta._id, { at, job });
  else await ctx.db.insert("pump", { at, job });
}

/** Starts due items while there are free slots, then arranges to run again when the next one is due. */
const pump = internalMutation({
  args: {},
  handler: async (ctx) => {
    const meta = await ctx.db.query("pump").first();
    if (meta) await ctx.db.patch(meta._id, { at: null, job: null });
    const now = Date.now();
    const max = parallelism(ctx.config);
    const running = await ctx.db
      .query("items")
      .withIndex("by_state_runAt", (q) => q.eq("state", "running"))
      .take(max);
    let free = max - running.length;
    if (free > 0) {
      const due = await ctx.db
        .query("items")
        .withIndex("by_state_runAt", (q) => q.eq("state", "pending").lte("runAt", now))
        .take(free);
      for (const item of due) {
        const attempt = item.attempts + 1;
        await ctx.db.patch(item._id, { state: "running", startedAt: now, attempts: attempt });
        await ctx.scheduler.runAfter(0, item.kind === "action" ? runAction : runMutation, { id: item._id, attempt });
        free--;
      }
    }
    // With slots to spare, wake up when the next delayed item is due; otherwise a finishing item wakes it.
    const next = await ctx.db
      .query("items")
      .withIndex("by_state_runAt", (q) => q.eq("state", "pending"))
      .first();
    if (next && free > 0 && next.runAt > now) await wake(ctx, next.runAt);
    return null;
  },
});

/** A value that can be stored as an item's result (anything else is kept as null). */
function storable(value: unknown): unknown {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

async function notify(ctx: Ctx, item: any, result: WorkResult) {
  if (!item.onComplete) return;
  try {
    await ctx.runMutation(item.onComplete, { id: item._id, context: item.context ?? null, result });
  } catch (err) {
    // Its writes were rolled back; the item's own outcome still stands.
    console.error(`onComplete for work item ${item._id} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Records how an attempt went: done, retried later, or failed for good. Frees its slot. */
async function finish(ctx: Ctx, item: any, outcome: Outcome) {
  const now = Date.now();
  if (outcome.ok) {
    const result = storable(outcome.value);
    await ctx.db.patch(item._id, { state: "succeeded", result, error: undefined, finishedAt: now });
    await notify(ctx, item, { kind: "success", returnValue: result });
  } else if (item.attempts < item.maxAttempts) {
    const backoff = item.initialBackoffMs * item.base ** (item.attempts - 1) * (0.5 + Math.random());
    const runAt = now + Math.round(backoff);
    await ctx.db.patch(item._id, { state: "pending", runAt, error: outcome.error });
    await wake(ctx, runAt);
  } else {
    await ctx.db.patch(item._id, { state: "failed", error: outcome.error, finishedAt: now });
    await notify(ctx, item, { kind: "failed", error: outcome.error });
  }
  await wake(ctx, now);
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The item if this attempt is still the current one (a timed-out attempt finishing late is ignored). */
async function current(ctx: { db: any }, id: string, attempt: number) {
  const item = await ctx.db.get(id);
  return item && item.state === "running" && item.attempts === attempt ? item : null;
}

/** Runs a mutation item in this transaction, so it happens exactly once. */
const runMutation = internalMutation({
  args: { id: v.string(), attempt: v.number() },
  handler: async (ctx, { id, attempt }) => {
    const item = await current(ctx, id, attempt);
    if (!item) return null;
    let outcome: Outcome;
    try {
      outcome = { ok: true, value: await ctx.runMutation(item.fn as FunctionHandle<"mutation">, item.args ?? {}) };
    } catch (err) {
      outcome = { ok: false, error: message(err) };
    }
    await finish(ctx, item, outcome);
    return null;
  },
});

const runningItem = internalQuery({ args: { id: v.string(), attempt: v.number() }, handler: (ctx, { id, attempt }) => current(ctx, id, attempt) });

const complete = internalMutation({
  args: { id: v.string(), attempt: v.number(), outcome: v.any() },
  handler: async (ctx, { id, attempt, outcome }) => {
    const item = await current(ctx, id, attempt);
    if (item) await finish(ctx, item, outcome as Outcome);
    return null;
  },
});

/** Runs an action item, then records the outcome in a mutation. */
const runAction = internalAction({
  args: { id: v.string(), attempt: v.number() },
  handler: async (ctx, { id, attempt }) => {
    const item = await ctx.runQuery(runningItem, { id, attempt });
    if (!item) return null;
    let outcome: Outcome;
    try {
      outcome = { ok: true, value: storable(await ctx.runAction(item.fn as FunctionHandle<"action">, item.args ?? {})) };
    } catch (err) {
      outcome = { ok: false, error: message(err) };
    }
    await ctx.runMutation(complete, { id, attempt, outcome });
    return null;
  },
});

/** Every minute: fails attempts that ran too long (say, on an instance that went away) and forgets old items. */
const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const timeout = ctx.config.timeoutMs ?? 15 * 60_000;
    const running = await ctx.db
      .query("items")
      .withIndex("by_state_runAt", (q) => q.eq("state", "running"))
      .collect();
    for (const item of running) {
      if ((item.startedAt ?? 0) < now - timeout) await finish(ctx, item, { ok: false, error: `Timed out after ${Math.round(timeout / 1000)}s.` });
    }
    const before = now - (ctx.config.retentionMs ?? 7 * DAY);
    for (const s of ["succeeded", "failed", "canceled"] as const) {
      const old = await ctx.db
        .query("items")
        .withIndex("by_state_finishedAt", (q) => q.eq("state", s).lt("finishedAt", before))
        .take(500);
      for (const item of old) await ctx.db.delete(item._id);
    }
    await wake(ctx, now);
    return null;
  },
});

const enqueueArgs = {
  fn: v.string(),
  args: v.optional(v.any()),
  /** When to run it (ms since the epoch), or `delayMs` from now. Default: as soon as a slot is free. */
  runAt: v.optional(v.number()),
  delayMs: v.optional(v.number()),
  retry: v.optional(v.object({ maxAttempts: v.optional(v.number()), initialBackoffMs: v.optional(v.number()), base: v.optional(v.number()) })),
  onComplete: v.optional(v.string()),
  context: v.optional(v.any()),
};

async function enqueue(ctx: Ctx, kind: "action" | "mutation", a: any): Promise<string> {
  if (typeof a.fn !== "string" || !a.fn.startsWith("function://")) {
    throw new Error(`enqueue${kind === "action" ? "Action" : "Mutation"}: fn must be a function reference (internal.x.y) or a handle.`);
  }
  const retry = { ...ctx.config.retry, ...a.retry };
  const maxAttempts = retry.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("retry.maxAttempts must be a whole number of at least 1.");
  const runAt = a.runAt ?? Date.now() + Math.max(0, a.delayMs ?? 0);
  const id = await ctx.db.insert("items", {
    fn: a.fn,
    kind,
    args: a.args ?? {},
    state: "pending",
    attempts: 0,
    maxAttempts,
    initialBackoffMs: retry.initialBackoffMs ?? 250,
    base: retry.base ?? 2,
    runAt,
    onComplete: a.onComplete,
    context: a.context,
  });
  await wake(ctx, runAt);
  return id;
}

/** Queues an action. Returns the item's id, for status() and cancel(). */
const enqueueAction = mutation({ args: enqueueArgs, handler: (ctx, a) => enqueue(ctx, "action", a) });
/** Queues a mutation; it runs in its own transaction, exactly once per attempt. */
const enqueueMutation = mutation({ args: enqueueArgs, handler: (ctx, a) => enqueue(ctx, "mutation", a) });

/** Stops an item that hasn't finished. A running action can't be interrupted, but its outcome is ignored. */
const cancel = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const item = await ctx.db.get(id as GenericId<"items">);
    if (!item || (item.state !== "pending" && item.state !== "running")) return false;
    await ctx.db.patch(item._id, { state: "canceled", finishedAt: Date.now() });
    await notify(ctx, item, { kind: "canceled" });
    if (item.state === "running") await wake(ctx, Date.now());
    return true;
  },
});

const view = (item: any) =>
  item && {
    id: item._id as string,
    state: item.state as WorkState,
    attempts: item.attempts as number,
    runAt: item.runAt as number,
    error: (item.error as string | undefined) ?? null,
    result: item.result ?? null,
  };

/** Where an item stands (null once it's been forgotten, retentionMs after it finished). */
const status = query({ args: { id: v.string() }, handler: async (ctx, { id }) => view(await ctx.db.get(id as GenericId<"items">)) });

/** Items in one state, oldest first, a page at a time. */
const list = query({
  args: { state, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { state, paginationOpts }) => {
    const page = await ctx.db
      .query("items")
      .withIndex("by_state_runAt", (q) => q.eq("state", state))
      .paginate(paginationOpts);
    return { ...page, page: page.page.map(view) };
  },
});

export const definition = defineComponent({
  name: "workQueue",
  schema,
  functions: { enqueueAction, enqueueMutation, cancel, status, list, pump, runAction, runMutation, runningItem, complete, sweep },
  checkConfig: (config: Config) => {
    const n = parallelism(config);
    if (!Number.isInteger(n) || n < 1 || n > 1000) throw new Error("workQueue(): maxParallelism must be a whole number from 1 to 1000.");
    if (config.retry?.maxAttempts !== undefined && !(Number.isInteger(config.retry.maxAttempts) && config.retry.maxAttempts >= 1)) {
      throw new Error("workQueue(): retry.maxAttempts must be a whole number of at least 1.");
    }
  },
  crons: () => [{ name: "sweep", schedule: { minutes: 1 }, fn: sweep }],
});

// ---- Types for the app ----

export type WorkState = "pending" | "running" | "succeeded" | "failed" | "canceled";
export type WorkStatus = { id: string; state: WorkState; attempts: number; runAt: number; error: string | null; result: unknown };

type Fn<T extends "action" | "mutation"> = FunctionReference<T, any> | FunctionHandle<T>;
type ArgsOf<F> = F extends FunctionReference<any, any, infer A> ? A : F extends FunctionHandle<any, infer A> ? A : never;
type EnqueueArgs<F> = {
  fn: F;
  args: ArgsOf<F>;
  runAt?: number;
  delayMs?: number;
  retry?: RetryConfig;
  /** A mutation called once the item has succeeded, failed for good or been canceled; its args are onCompleteValidator. */
  onComplete?: Fn<"mutation">;
  /** Passed to onComplete as-is. */
  context?: unknown;
};

export type WorkQueueApi = {
  enqueueAction: ComponentFn<"mutation", <F extends Fn<"action">>(args: EnqueueArgs<F>) => Promise<string>>;
  enqueueMutation: ComponentFn<"mutation", <F extends Fn<"mutation">>(args: EnqueueArgs<F>) => Promise<string>>;
  cancel: ComponentFn<"mutation", (args: { id: string }) => Promise<boolean>>;
  status: ComponentFn<"query", (args: { id: string }) => Promise<WorkStatus | null>>;
  list: ComponentFn<
    "query",
    (args: { state: WorkState; paginationOpts: { numItems: number; cursor: string | null } }) => Promise<{ page: WorkStatus[]; isDone: boolean; continueCursor: string }>
  >;
};

/** Mounts a work queue: `workQueue({ maxParallelism: 5, retry: { maxAttempts: 3 } })`. */
export function workQueue<const E extends keyof WorkQueueApi = never>(opts: Config & MountOptions<E> = {}): Mount<WorkQueueApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as Mount<WorkQueueApi, E>;
}
