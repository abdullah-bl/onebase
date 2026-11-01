// A TTL cache for expensive results (LLM calls, API fetches, reports): the wrapped function runs
// once, everyone else within the TTL gets the stored result, and concurrent callers share one run.
//
//   // onebase/components.ts
//   export default defineComponents({ cache: actionCache({ ttl: 5 * 60_000 }) });
//
//   // onebase/reports.ts
//   import { cached } from "onebase/components/action-cache";
//   const salesReport = cached("cache", internal.reports.computeSales, (args) => `${args.org}:${args.month}`);
//   // in an action
//   const report = await salesReport(ctx, { org, month });

import type { FunctionHandle, FunctionReference } from "../../api";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v } from "../../values";

type Config = {
  /** How long a stored result is served (default 60_000 ms). */
  ttl?: number;
  /** How long a claim on a running computation lasts before someone else may take over (default 30_000 ms). */
  claimMs?: number;
};

const schema = defineSchema({
  entries: defineTable({
    key: v.string(),
    state: v.union(v.literal("inProgress"), v.literal("completed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_expiresAt", ["expiresAt"]),
});

const { query, mutation, internalMutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();

const ttlFor = (config: Config, override?: number) => Math.max(1, override ?? config.ttl ?? 60_000);
const claimFor = (config: Config) => Math.max(1, config.claimMs ?? 30_000);

/**
 * Reads a cached result and claims the key on a miss: `"hit"` carries the stored value, `"miss"`
 * means the caller won the claim and should run the computation, `"inProgress"` means someone
 * else is running it right now.
 */
const read = mutation({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const now = Date.now();
    const row = await ctx.db.query("entries").withIndex("by_key", (q: any) => q.eq("key", key)).first();
    if (!row || (row.state === "completed" && row.expiresAt <= now)) {
      if (row) await ctx.db.delete(row._id);
      await ctx.db.insert("entries", { key, state: "inProgress", expiresAt: now + claimFor(ctx.config), createdAt: now });
      return { state: "miss" as const };
    }
    if (row.state === "inProgress" && row.expiresAt <= now) {
      // The runner went away: take the claim over.
      await ctx.db.patch(row._id, { expiresAt: now + claimFor(ctx.config), createdAt: now });
      return { state: "miss" as const };
    }
    if (row.state === "inProgress") return { state: "inProgress" as const };
    return { state: "hit" as const, value: row.result ?? null };
  },
});

/** Stores a computed result for the TTL (default: the mount's). */
const write = mutation({
  args: { key: v.string(), value: v.any(), ttl: v.optional(v.number()) },
  handler: async (ctx, { key, value, ttl }) => {
    const now = Date.now();
    const row = await ctx.db.query("entries").withIndex("by_key", (q: any) => q.eq("key", key)).first();
    const entry = { state: "completed" as const, result: value === undefined ? null : value, error: undefined, expiresAt: now + ttlFor(ctx.config, ttl), createdAt: now };
    if (row) await ctx.db.patch(row._id, entry);
    else await ctx.db.insert("entries", { key, ...entry });
    return null;
  },
});

/** Forgets one key (or every key with a prefix, when `prefix` is passed). */
const invalidate = mutation({
  args: { key: v.optional(v.string()), prefix: v.optional(v.string()) },
  handler: async (ctx, { key, prefix }) => {
    if (key === undefined && prefix === undefined) throw new Error("invalidate: pass key or prefix.");
    const rows = key !== undefined
      ? [await ctx.db.query("entries").withIndex("by_key", (q: any) => q.eq("key", key)).first()]
      : await ctx.db.query("entries").collect();
    let n = 0;
    for (const row of rows) {
      if (row && (prefix === undefined || row.key.startsWith(prefix))) {
        await ctx.db.delete(row._id);
        n++;
      }
    }
    return n;
  },
});

/** What's cached under one key right now (null when nothing is). */
const peek = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("entries").withIndex("by_key", (q: any) => q.eq("key", key)).first();
    if (!row || row.state !== "completed" || row.expiresAt <= Date.now()) return null;
    return { key: row.key as string, result: row.result ?? null, expiresAt: row.expiresAt as number };
  },
});

/** Every minute: forgets expired entries. */
const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const old = await ctx.db.query("entries").withIndex("by_expiresAt", (q: any) => q.lt("expiresAt", now)).take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});

export const definition = defineComponent({
  name: "actionCache",
  schema,
  functions: { read, write, invalidate, peek, cleanup },
  crons: () => [{ name: "cleanup", schedule: { minutes: 1 }, fn: cleanup }],
});

// ---- Types and the app-side helper ----

export type CacheRead = { state: "hit"; value: unknown } | { state: "miss" } | { state: "inProgress" };

export type ActionCacheApi = {
  read: ComponentFn<"mutation", (args: { key: string }) => Promise<CacheRead>>;
  write: ComponentFn<"mutation", (args: { key: string; value: unknown; ttl?: number }) => Promise<null>>;
  invalidate: ComponentFn<"mutation", (args: { key?: string; prefix?: string }) => Promise<number>>;
  peek: ComponentFn<"query", (args: { key: string }) => Promise<{ key: string; result: unknown; expiresAt: number } | null>>;
};

/** Mounts the cache: `actionCache({ ttl: 5 * 60_000 })`. */
export function actionCache<const E extends keyof ActionCacheApi = never>(opts: Config & MountOptions<E> = {}): Mount<ActionCacheApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<ActionCacheApi, E>;
}

/**
 * Wraps one of your actions in the cache: `cached("cache", internal.reports.computeSales, (args) => ...)`.
 * The key is prefixed with the action's name, so one mount caches many functions. On a miss the
 * claim is ours and the action runs; while another caller holds the claim we poll briefly for its
 * result, then run the action ourselves rather than wait forever. The action's args and its
 * return value must be storable JSON.
 */
type CallableCache = {
  read: (args: { key: string }) => Promise<CacheRead>;
  write: (args: { key: string; value: unknown; ttl?: number }) => Promise<null>;
  invalidate: (args: { key?: string; prefix?: string }) => Promise<number>;
};

export function cached<A extends Record<string, unknown>, R>(
  mount: string,
  fn: FunctionReference<"action", any, A, R> | FunctionHandle<"action", A, R>,
  keyFor: (args: A) => string,
  opts: { ttl?: number; pollMs?: number; timeoutMs?: number } = {},
): (ctx: { components: Record<string, CallableCache>; runAction: (fn: never, args?: never) => Promise<unknown> }, args: A) => Promise<R> {
  const pollMs = opts.pollMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return async (ctx, args) => {
    const cache = (ctx.components as any)[mount] as CallableCache | undefined;
    if (!cache) throw new Error(`cached: no component mounted as "${mount}". Mount actionCache under that name.`);
    const key = `${String((fn as any)?.[Symbol.for("onebase.functionPath")] ?? fn)}:${keyFor(args)}`;
    const claim = await cache.read({ key });
    if (claim.state === "hit") return claim.value as R;
    if (claim.state === "inProgress") {
      for (const end = Date.now() + timeoutMs; Date.now() < end; await new Promise((r) => setTimeout(r, pollMs))) {
        const again = await cache.read({ key });
        if (again.state === "hit") return again.value as R;
        if (again.state === "miss") break; // the claim expired: take it over below
      }
      const last = await cache.read({ key });
      if (last.state === "hit") return last.value as R;
    }
    let value: R;
    try {
      value = await (ctx as any).runAction(fn, args);
    } catch (err) {
      await cache.invalidate({ key });
      throw err;
    }
    await cache.write({ key, value, ttl: opts.ttl });
    return value;
  };
}
