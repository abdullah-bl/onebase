// Batched data migrations with progress tracking: each migration reads its table a batch at a
// time in creation order, remembers its cursor, and continues in the background after restarts.
//
//   // onebase/components.ts
//   export default defineComponents({ migrations: migrations() });
//
//   // onebase/backfill.ts
//   export const renameBodies = defineMigration({
//     table: "messages",
//     mutateOne: async (ctx, doc) => {
//       if (doc.body) await ctx.db.patch(doc._id, { body: doc.body.toUpperCase() });
//     },
//   });
//
//   // wherever you start it (a mutation, the dashboard, a cron)
//   export const runRename = mutation({
//     args: {},
//     handler: (ctx) => ctx.components.migrations.migrate({ name: "rename-bodies", runner: internal.backfill.renameBodies }),
//   });
//   // progress: ctx.components.migrations.status({ name: "rename-bodies" })

import type { FunctionReference } from "../../api";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { internalMutation as appInternalMutation } from "../../server";
import { v } from "../../values";

const state = v.union(v.literal("inProgress"), v.literal("completed"), v.literal("failed"), v.literal("canceled"));

const schema = defineSchema({
  migrations: defineTable({
    name: v.string(),
    /** A handle to the app's runner, from defineMigration(). */
    runner: v.string(),
    batchSize: v.number(),
    /** How long one migrate() call keeps running batches before continuing in the background. */
    maxMs: v.number(),
    state,
    /** Where the last finished batch stopped (null: not started or finished). */
    cursor: v.optional(v.union(v.string(), v.null())),
    processed: v.number(),
    error: v.optional(v.string()),
    startedAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    /** The one scheduled continuation, so callers don't pile them up. */
    job: v.optional(v.union(v.string(), v.null())),
  }).index("by_name", ["name"]),
});

type Config = {};
const { query, mutation, internalMutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();
type Ctx = { db: any; scheduler: any; runMutation: any };

/** What a migration looks like from the app. */
export type MigrationStatus = {
  name: string;
  state: "inProgress" | "completed" | "failed" | "canceled";
  processed: number;
  batchSize: number;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const view = (row: any): MigrationStatus => ({
  name: row.name,
  state: row.state,
  processed: row.processed,
  batchSize: row.batchSize,
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt ?? null,
  error: row.error ?? null,
});

const find = (ctx: { db: any }, name: string) =>
  ctx.db.query("migrations").withIndex("by_name", (q: any) => q.eq("name", name)).unique();

function checkHandle(fn: string) {
  if (typeof fn !== "string" || !fn.startsWith("function://")) {
    throw new Error(`migrate: runner must be a function reference (internal.x.y) or a handle from createFunctionHandle().`);
  }
}

function checkSize(what: string, value: number, max: number) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`migrate: ${what} must be a whole number from 1 to ${max}.`);
}

/** Cancels the row's pending continuation, if one is scheduled. */
async function cancelJob(ctx: Ctx, row: any) {
  if (!row.job) return;
  try {
    await ctx.scheduler.cancel(row.job);
  } catch {
    // It already ran, or the job is gone: nothing to cancel.
  }
}

/** Schedules one continuation of runBatch, replacing any pending one. */
async function wake(ctx: Ctx, row: any) {
  await cancelJob(ctx, row);
  const job = await ctx.scheduler.runAfter(0, runBatch, { name: row.name });
  await ctx.db.patch(row._id, { job });
}

type BatchOutcome = { kind: "done" } | { kind: "failed" } | { kind: "more" };

/** Processes one batch through the app's runner and records where it got to. */
async function runOneBatch(ctx: Ctx, row: any): Promise<BatchOutcome> {
  const before = row.cursor ?? null;
  let outcome: { newCursor: string | null; processed: number; isDone: boolean };
  try {
    outcome = await ctx.runMutation(row.runner, { cursor: before, numItems: row.batchSize });
  } catch (err) {
    await ctx.db.patch(row._id, { state: "failed", error: message(err), updatedAt: Date.now() });
    return { kind: "failed" };
  }
  // Re-read: a cancel or another instance may have moved the row while the batch ran.
  const fresh = await ctx.db.get(row._id);
  if (fresh && fresh.state === "inProgress") {
    await ctx.db.patch(fresh._id, {
      cursor: outcome.isDone ? null : outcome.newCursor,
      processed: fresh.processed + outcome.processed,
      updatedAt: Date.now(),
      ...(outcome.isDone ? { state: "completed", completedAt: Date.now(), error: undefined } : {}),
    });
  }
  return outcome.isDone ? { kind: "done" } : { kind: "more" };
}

/** Registers (or resumes) a migration and runs batches until done or maxMs has passed, then continues in the background. */
const migrate = mutation({
  args: {
    name: v.string(),
    runner: v.string(),
    batchSize: v.optional(v.number()),
    maxMs: v.optional(v.number()),
    /** Start over from the first document, even if it already completed. */
    force: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<MigrationStatus> => {
    checkHandle(args.runner);
    const batchSize = args.batchSize ?? 100;
    checkSize("batchSize", batchSize, 10_000);
    const maxMs = args.maxMs ?? 1000;
    if (!Number.isInteger(maxMs) || maxMs < 0 || maxMs > 60_000) throw new Error("migrate: maxMs must be a whole number from 0 to 60000.");
    const restart = args.force === true;

    let row = await find(ctx, args.name);
    if (!row) {
      await ctx.db.insert("migrations", {
        name: args.name,
        runner: args.runner,
        batchSize,
        maxMs,
        state: "inProgress",
        cursor: null,
        processed: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
    } else if (row.state === "completed" && !restart && row.runner === args.runner) {
      return view(row);
    } else {
      if (row.runner !== args.runner && !restart && row.processed > 0) {
        throw new Error(`Migration "${args.name}" has already processed ${row.processed} documents with a different function. Pass force: true to start it over.`);
      }
      const startOver = restart || row.runner !== args.runner;
      await cancelJob(ctx, row);
      await ctx.db.patch(row._id, {
        runner: args.runner,
        batchSize,
        maxMs,
        state: "inProgress",
        error: undefined,
        ...(startOver ? { cursor: null, processed: 0, startedAt: Date.now(), completedAt: undefined } : {}),
      });
    }

    const deadline = Date.now() + maxMs;
    for (;;) {
      const current = await find(ctx, args.name);
      if (!current || current.state !== "inProgress") break;
      const outcome = await runOneBatch(ctx, current);
      if (outcome.kind !== "more") break;
      if (Date.now() >= deadline) {
        await wake(ctx, current);
        break;
      }
    }
    const final = await find(ctx, args.name);
    return view(final);
  },
});

/** The background continuation: processes one batch, then schedules the next. */
const runBatch = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = await find(ctx, name);
    if (!row || row.state !== "inProgress") return null;
    const outcome = await runOneBatch(ctx, row);
    if (outcome.kind === "more") await wake(ctx, row);
    return null;
  },
});

/** Where a migration stands (null for an unknown name). */
const status = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = await find(ctx, name);
    return row ? view(row) : null;
  },
});

/** Every migration this mount knows about, by name. */
const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("migrations").withIndex("by_name").collect();
    return rows.map(view);
  },
});

/** Stops a running migration mid-flight. Calling migrate() again resumes where it stopped. */
const cancel = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = await find(ctx, name);
    if (!row || row.state !== "inProgress") return false;
    await cancelJob(ctx, row);
    await ctx.db.patch(row._id, { state: "canceled", job: null, updatedAt: Date.now() });
    return true;
  },
});

export const definition = defineComponent({
  name: "migrations",
  schema,
  functions: { migrate, status, list, cancel, runBatch },
});

// ---- Types and helpers for the app ----

type Runner = FunctionReference<"mutation", any, { cursor?: string | null; numItems: number }, any>;

export type MigrationsApi = {
  migrate: ComponentFn<"mutation", <F extends Runner>(args: { name: string; runner: F; batchSize?: number; maxMs?: number; force?: boolean }) => Promise<MigrationStatus>>;
  status: ComponentFn<"query", (args: { name: string }) => Promise<MigrationStatus | null>>;
  list: ComponentFn<"query", (args?: {}) => Promise<MigrationStatus[]>>;
  cancel: ComponentFn<"mutation", (args: { name: string }) => Promise<boolean>>;
};

/** Mounts the migrations component: `migrations()`. */
export function migrations<const E extends keyof MigrationsApi = never>(opts: Config & MountOptions<E> = {}): Mount<MigrationsApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as Mount<MigrationsApi, E>;
}

/**
 * The app half of a migration: a batch runner you export from your functions folder and pass to
 * `migrate()` as its runner. It reads `table` in creation order, `batchSize` documents at a time,
 * and calls `mutateOne(ctx, doc)` on each. Because one batch runs in one transaction, a
 * `mutateOne` that throws rolls its batch back and fails the migration; make it idempotent, since
 * a retry re-runs the batch from its beginning.
 *
 * Don't insert into `table` from `mutateOne`: documents written ahead of the cursor would keep the
 * migration going, and documents written behind it would never be seen.
 */
export function defineMigration(def: {
  table: string;
  mutateOne: (ctx: import("../../server").MutationCtx<any>, doc: { _id: import("../../values").GenericId<string>; _creationTime: number } & Record<string, any>) => Promise<unknown>;
}) {
  if (typeof def?.table !== "string" || !def.table) throw new Error("defineMigration({ table }) needs a table name.");
  if (typeof def?.mutateOne !== "function") throw new Error("defineMigration({ mutateOne }) needs a function.");
  return appInternalMutation({
    args: { cursor: v.optional(v.union(v.string(), v.null())), numItems: v.number() },
    handler: async (ctx: any, { cursor, numItems }: { cursor?: string | null; numItems: number }) => {
      const page = await ctx.db.query(def.table).withIndex("by_creation_time").paginate({ numItems, cursor: cursor ?? null });
      for (const doc of page.page) await def.mutateOne(ctx, doc);
      return { newCursor: page.continueCursor, processed: page.page.length, isDone: page.isDone };
    },
  });
}
