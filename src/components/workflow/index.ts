// Durable workflows: a workflow's steps are journaled one document each, so it survives restarts,
// sleeps survive restarts, and every step runs exactly once per attempt. The workflow's code runs
// in the app (defineWorkflow); this component journals its progress and drives it forward.
//
//   // onebase/components.ts
//   export default defineComponents({ jobs: workflow() });
//
//   // onebase/flows.ts
//   export const onboarding = defineWorkflow({
//     run: async (step, args: { userId: string }) => {
//       const user = await step.runQuery(internal.users.get, { id: args.userId });
//       await step.runMutation(internal.emails.welcome, { userId: user._id });
//       await step.sleep(60_000);
//       return await step.runAction(internal.reports.generate, { userId: args.userId });
//     },
//   });
//
//   // in a mutation
//   const id = await ctx.components.jobs.start({ fn: internal.flows.onboarding, args: { userId } });
//   const st = await ctx.components.jobs.status({ id });

import type { FunctionReference } from "../../api";
import type { GenericId } from "../../values";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { paginationOptsValidator } from "../../server";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v } from "../../values";
import { storable, type RetryConfig, type WorkflowSignal } from "./app";

export { defineWorkflow, YIELD_AFTER, type CompletedStep, type RetryConfig, type StepCtx } from "./app";

const workflowState = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"), v.literal("canceled"));
const stepState = v.union(v.literal("completed"), v.literal("inProgress"), v.literal("pending"), v.literal("failed"));

const schema = defineSchema({
  workflows: defineTable({
    /** A handle to the app's runner, from defineWorkflow(). */
    fn: v.string(),
    args: v.any(),
    status: workflowState,
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    /** The latest scheduled continuation, for cancel(). */
    job: v.optional(v.union(v.string(), v.null())),
  }).index("by_status_updatedAt", ["status", "updatedAt"]),
  steps: defineTable({
    workflowId: v.string(),
    /** Position in the workflow's call order; the runner's replay counts on it. */
    number: v.number(),
    kind: v.union(v.literal("query"), v.literal("mutation"), v.literal("action"), v.literal("sleep")),
    state: stepState,
    name: v.optional(v.string()),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    /** For action steps: the handle to run, its args, and its retry policy. */
    fn: v.optional(v.string()),
    args: v.optional(v.any()),
    attempts: v.number(),
    maxAttempts: v.number(),
    initialBackoffMs: v.number(),
    base: v.number(),
    /** For sleep steps: when to wake. */
    wakeAt: v.optional(v.number()),
  })
    .index("by_workflow_number", ["workflowId", "number"])
    .index("by_state", ["state"]),
});

type Config = {
  /** Retry policy action steps get when they don't name one. */
  retry?: RetryConfig;
  /** An action that hasn't finished after this long counts as failed (default 15 minutes). */
  timeoutMs?: number;
  /** How long finished workflows are kept for status() and list() (default 7 days). */
  retentionMs?: number;
};

const { query, mutation, internalQuery, internalMutation, internalAction } = componentServer<DataModelFromSchema<typeof schema>, Config>();
type Ctx = { db: any; config: Config; scheduler: any; runQuery: any; runMutation: any };

const DAY = 86_400_000;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function retryConfig(config: Config, override: RetryConfig | null) {
  const retry = { ...config.retry, ...override };
  return {
    maxAttempts: Math.max(1, Math.floor(retry.maxAttempts ?? 1)),
    initialBackoffMs: Math.max(1, Math.floor(retry.initialBackoffMs ?? 250)),
    base: Math.max(1, Math.floor(retry.base ?? 2)),
  };
}

const storableOutcome = (value: unknown) => ({ ok: true as const, value: storable(value) });

async function rowsFor(ctx: { db: any }, workflowId: string) {
  const rows: any[] = await ctx.db.query("steps").withIndex("by_workflow_number", (q: any) => q.eq("workflowId", workflowId)).collect();
  return rows.sort((a, b) => a.number - b.number);
}

async function rowFor(ctx: { db: any }, workflowId: string, number: number) {
  return ctx.db.query("steps").withIndex("by_workflow_number", (q: any) => q.eq("workflowId", workflowId).eq("number", number)).unique();
}

/** Schedules the next run of `run`, remembering the job so cancel() can stop it. */
async function kick(ctx: Ctx, workflowId: string, delayMs: number) {
  const job = await ctx.scheduler.runAfter(delayMs, run, { workflowId });
  await ctx.db.patch(workflowId as GenericId<"workflows">, { job, updatedAt: Date.now() });
}

async function fail(ctx: Ctx, workflowId: string, error: string) {
  await ctx.db.patch(workflowId as GenericId<"workflows">, { status: "failed", error, completedAt: Date.now(), updatedAt: Date.now(), job: null });
}

/** Records a failed attempt at a step and either schedules its retry or fails the workflow. */
async function stepFailed(ctx: Ctx, wf: any, rows: any[], number: number | null, error: string, retry: RetryConfig | null) {
  if (number === null) {
    for (const s of rows) if (s.state === "inProgress" || s.state === "pending") await ctx.db.patch(s._id, { state: "failed", error });
    await fail(ctx, wf._id, error);
    return;
  }
  const cfg = retryConfig(ctx.config, retry);
  const existing = rows.find((s) => s.number === number);
  const attempts = (existing?.attempts ?? 0) + 1;
  if (existing) await ctx.db.patch(existing._id, { state: "failed", error, attempts, maxAttempts: cfg.maxAttempts, initialBackoffMs: cfg.initialBackoffMs, base: cfg.base });
  else await ctx.db.insert("steps", { workflowId: wf._id, number, kind: "mutation", state: "failed", error, attempts, ...cfg });
  if (attempts < cfg.maxAttempts) {
    const backoff = Math.round(cfg.initialBackoffMs * cfg.base ** (attempts - 1) * (0.5 + Math.random()));
    await kick(ctx, wf._id, backoff);
  } else {
    await fail(ctx, wf._id, error);
  }
}

/** Journals the steps the runner just executed (a retried step updates its row instead). */
async function journal(ctx: Ctx, workflowId: string, executed: WorkflowSignal["steps"]) {
  for (const s of executed) {
    const existing = await rowFor(ctx, workflowId, s.number);
    if (existing) await ctx.db.patch(existing._id, { state: "completed", result: s.result, error: undefined, wakeAt: undefined });
    else await ctx.db.insert("steps", { workflowId, number: s.number, kind: s.kind, state: "completed", result: s.result, attempts: 1, maxAttempts: 1, initialBackoffMs: 250, base: 2 });
  }
}

/** Runs the workflow until it finishes, pauses at an action or a sleep, or fails. */
const run = internalMutation({
  args: { workflowId: v.string() },
  handler: async (ctx, { workflowId }) => {
    const wf = await ctx.db.get(workflowId as GenericId<"workflows">);
    if (!wf || wf.status !== "running") return null;
    const rows = await rowsFor(ctx, workflowId);
    const now = Date.now();
    // An action is in flight, or a sleep is still waiting: its continuation carries on from here.
    if (rows.some((s) => s.state === "inProgress")) return null;
    if (rows.some((s) => s.kind === "sleep" && s.state === "pending" && (s.wakeAt ?? 0) > now)) return null;

    for (const s of rows) {
      if (s.kind === "sleep" && s.state === "pending" && (s.wakeAt ?? 0) <= now) await ctx.db.patch(s._id, { state: "completed" });
    }
    const done = rows
      .filter((s) => s.state === "completed" || (s.kind === "sleep" && s.state === "pending" && (s.wakeAt ?? 0) <= now))
      .map((s) => ({ number: s.number as number, result: s.kind === "sleep" ? null : (s.result ?? null) }));
    let outcome: WorkflowSignal;
    try {
      outcome = await ctx.runMutation(wf.fn as any, { workflowId, args: wf.args, completed: done });
      await journal(ctx, workflowId, outcome.steps);
    } catch (err) {
      // The runner itself couldn't run (renamed, not a workflow) or its steps can't be journaled.
      // Retrying won't help, so report it rather than stay "running" forever.
      await fail(ctx, workflowId, message(err));
      return null;
    }

    const pause = outcome.pause;
    if (!pause) {
      await ctx.db.patch(wf._id, { status: "completed", result: outcome.returnValue, completedAt: now, updatedAt: now, job: null });
      return null;
    }
    if (pause.kind === "yield") {
      await kick(ctx, workflowId, 0);
      return null;
    }
    if (pause.kind === "sleep") {
      const wakeAt = now + Math.max(0, pause.ms);
      const existing = rows.find((s) => s.number === pause.number);
      if (existing) await ctx.db.patch(existing._id, { state: "pending", wakeAt });
      else await ctx.db.insert("steps", { workflowId, number: pause.number, kind: "sleep", state: "pending", attempts: 0, maxAttempts: 1, initialBackoffMs: 250, base: 2, wakeAt });
      await kick(ctx, workflowId, wakeAt - now);
      return null;
    }
    if (pause.kind === "action") {
      const cfg = retryConfig(ctx.config, pause.retry);
      const existing = rows.find((s) => s.number === pause.number);
      if (existing) await ctx.db.patch(existing._id, { state: "inProgress", fn: pause.fn, args: pause.args, error: undefined, maxAttempts: cfg.maxAttempts, initialBackoffMs: cfg.initialBackoffMs, base: cfg.base });
      else await ctx.db.insert("steps", { workflowId, number: pause.number, kind: "action", state: "inProgress", fn: pause.fn, args: pause.args, attempts: 1, ...cfg });
      await ctx.scheduler.runAfter(0, runActionStep, { workflowId, number: pause.number });
      await ctx.db.patch(wf._id, { updatedAt: now });
      return null;
    }
    await stepFailed(ctx, wf, rows, pause.number, pause.error, pause.retry);
    return null;
  },
});

const stepRow = internalQuery({
  args: { workflowId: v.string(), number: v.number() },
  handler: async (ctx, { workflowId, number }) => rowFor(ctx, workflowId, number),
});

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

/** Applies an action attempt's outcome: done, retried later, or failed for good. */
async function applyOutcome(ctx: Ctx, wf: any, step: any, outcome: Outcome) {
  if (outcome.ok) {
    await ctx.db.patch(step._id, { state: "completed", result: outcome.value, error: undefined });
    await kick(ctx, wf._id, 0);
  } else if (step.attempts < step.maxAttempts) {
    const backoff = Math.round(step.initialBackoffMs * step.base ** (step.attempts - 1) * (0.5 + Math.random()));
    await ctx.db.patch(step._id, { state: "inProgress", attempts: step.attempts + 1, error: outcome.error });
    await ctx.scheduler.runAfter(backoff, runActionStep, { workflowId: wf._id, number: step.number });
    await ctx.db.patch(wf._id, { updatedAt: Date.now() });
  } else {
    await ctx.db.patch(step._id, { state: "failed", error: outcome.error });
    await fail(ctx, wf._id, outcome.error);
  }
}

/** Runs an action step out of band, then records its outcome in a mutation. */
const runActionStep = internalAction({
  args: { workflowId: v.string(), number: v.number() },
  handler: async (ctx, { workflowId, number }) => {
    const step = await ctx.runQuery(stepRow, { workflowId, number });
    if (!step || step.state !== "inProgress") return null;
    let outcome: Outcome;
    try {
      outcome = storableOutcome(await ctx.runAction(step.fn as any, step.args ?? {}));
    } catch (err) {
      outcome = { ok: false, error: message(err) };
    }
    await ctx.runMutation(actionDone, { workflowId, number, outcome });
    return null;
  },
});

const actionDone = internalMutation({
  args: { workflowId: v.string(), number: v.number(), outcome: v.any() },
  handler: async (ctx, { workflowId, number, outcome }) => {
    const wf = await ctx.db.get(workflowId as GenericId<"workflows">);
    if (!wf || wf.status !== "running") return null; // canceled: the late outcome is ignored
    const step = await rowFor(ctx, workflowId, number);
    if (!step || step.state !== "inProgress") return null;
    await applyOutcome(ctx, wf, step, outcome as Outcome);
    return null;
  },
});

/** Every minute: fails lost actions, re-kicks workflows whose continuation went missing, and forgets old runs. */
const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const timeout = ctx.config.timeoutMs ?? 15 * 60_000;
    for (const step of await ctx.db.query("steps").withIndex("by_state", (q: any) => q.eq("state", "inProgress")).take(500)) {
      const wf = await ctx.db.get(step.workflowId as GenericId<"workflows">);
      if (!wf || wf.status !== "running" || (wf.updatedAt ?? 0) >= now - timeout) continue;
      await applyOutcome(ctx, wf, step, { ok: false, error: `Timed out after ${Math.round(timeout / 1000)}s.` });
    }
    for (const wf of await ctx.db.query("workflows").withIndex("by_status_updatedAt", (q: any) => q.eq("status", "running").lt("updatedAt", now - timeout)).take(200)) {
      const rows = await rowsFor(ctx, wf._id as string);
      if (rows.some((s) => s.state === "inProgress")) continue;
      await kick(ctx, wf._id as string, 0);
    }
    const before = now - (ctx.config.retentionMs ?? 7 * DAY);
    for (const state of ["completed", "failed", "canceled"] as const) {
      for (const wf of await ctx.db.query("workflows").withIndex("by_status_updatedAt", (q: any) => q.eq("status", state).lt("updatedAt", before)).take(200)) {
        for (const step of await rowsFor(ctx, wf._id as string)) await ctx.db.delete(step._id);
        await ctx.db.delete(wf._id);
      }
    }
    return null;
  },
});

const checkHandle = (fn: string) => {
  if (typeof fn !== "string" || !fn.startsWith("function://")) {
    throw new Error(`start: fn must be a function reference (internal.x.y) or a handle from createFunctionHandle().`);
  }
};

/** Starts a workflow: returns its id, for status(), cancel() and list(). */
const start = mutation({
  args: { fn: v.string(), args: v.optional(v.any()) },
  handler: async (ctx, { fn, args }) => {
    checkHandle(fn);
    const now = Date.now();
    const id = await ctx.db.insert("workflows", { fn, args: args ?? {}, status: "running", startedAt: now, updatedAt: now });
    await kick(ctx, id, 0);
    return id;
  },
});

const view = (wf: any) => ({
  id: wf._id as string,
  status: wf.status as WorkflowStatus["status"],
  result: wf.result ?? null,
  error: wf.error ?? null,
  startedAt: wf.startedAt as number,
  updatedAt: wf.updatedAt as number,
  completedAt: wf.completedAt ?? null,
});

/** Where a workflow stands, step by step (null once it's been forgotten). */
const status = query({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const wf = await ctx.db.get(id as GenericId<"workflows">);
    if (!wf) return null;
    const steps = (await rowsFor(ctx, id)).map((s: any) => ({
      number: s.number as number,
      kind: s.kind as "query" | "mutation" | "action" | "sleep",
      state: s.state as "completed" | "inProgress" | "pending" | "failed",
      result: s.result ?? null,
      error: s.error ?? null,
      wakeAt: s.wakeAt ?? null,
      attempts: s.attempts as number,
    }));
    return { ...view(wf), steps };
  },
});

/** Workflows in one state (or all of them), oldest first, a page at a time. */
const list = query({
  args: { status: v.optional(workflowState), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { status: state, paginationOpts }) => {
    const page = state
      ? await ctx.db.query("workflows").withIndex("by_status_updatedAt", (q: any) => q.eq("status", state)).paginate(paginationOpts)
      : await ctx.db.query("workflows").paginate(paginationOpts);
    return { ...page, page: page.page.map(view) };
  },
});

/** Stops a running workflow. A running action can't be interrupted, but its outcome is ignored. */
const cancel = mutation({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const wf = await ctx.db.get(id as GenericId<"workflows">);
    if (!wf || wf.status !== "running") return false;
    if (wf.job) {
      try {
        await ctx.scheduler.cancel(wf.job);
      } catch {
        // It already ran.
      }
    }
    await ctx.db.patch(wf._id, { status: "canceled", completedAt: Date.now(), updatedAt: Date.now(), job: null });
    return true;
  },
});

export const definition = defineComponent({
  name: "workflow",
  schema,
  functions: { start, status, list, cancel, run, runActionStep, actionDone, stepRow, sweep },
  checkConfig: (config: Config) => {
    if (config.retry?.maxAttempts !== undefined && !(Number.isInteger(config.retry.maxAttempts) && config.retry.maxAttempts >= 1)) {
      throw new Error("workflow(): retry.maxAttempts must be a whole number of at least 1.");
    }
  },
  crons: () => [{ name: "sweep", schedule: { minutes: 1 }, fn: sweep }],
});

// ---- Types for the app ----

export type WorkflowStepStatus = { number: number; kind: "query" | "mutation" | "action" | "sleep"; state: "completed" | "inProgress" | "pending" | "failed"; result: unknown; error: string | null; wakeAt: number | null; attempts: number };
export type WorkflowStatus = { id: string; status: "running" | "completed" | "failed" | "canceled"; result: unknown; error: string | null; startedAt: number; updatedAt: number; completedAt: number | null; steps?: WorkflowStepStatus[] };
export type WorkflowSummary = { id: string; status: "running" | "completed" | "failed" | "canceled"; result: unknown; error: string | null; startedAt: number; updatedAt: number; completedAt: number | null };

export type WorkflowApi = {
  start: ComponentFn<"mutation", (args: { fn: FunctionReference<"mutation", any, any, any> | string; args?: unknown }) => Promise<string>>;
  status: ComponentFn<"query", (args: { id: string }) => Promise<WorkflowStatus | null>>;
  list: ComponentFn<"query", (args: { status?: "running" | "completed" | "failed" | "canceled"; paginationOpts: { numItems: number; cursor: string | null } }) => Promise<{ page: WorkflowSummary[]; isDone: boolean; continueCursor: string }>>;
  cancel: ComponentFn<"mutation", (args: { id: string }) => Promise<boolean>>;
};

/** Mounts the workflow engine: `workflow({ retry: { maxAttempts: 3 } })`. */
export function workflow<const E extends keyof WorkflowApi = never>(opts: Config & MountOptions<E> = {}): Mount<WorkflowApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<WorkflowApi, E>;
}
