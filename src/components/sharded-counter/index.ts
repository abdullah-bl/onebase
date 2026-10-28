// Counters that many writers can bump at once: each counter is split over several documents
// (shards), each write touches one at random, and reading sums them.
//
//   // onebase/components.ts
//   export default defineComponents({ counter: shardedCounter({ shards: 16 }) });
//   // in a mutation
//   await ctx.components.counter.inc({ name: "pageViews" });
//   // in a query (live)
//   const views = await ctx.components.counter.count({ name: "pageViews" });

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v } from "../../values";

const schema = defineSchema({
  counters: defineTable({ name: v.string(), shard: v.number(), value: v.number() }).index("by_name_shard", ["name", "shard"]),
});

type Config = {
  /** Documents per counter (default 16). More shards: fewer conflicting writes, slightly slower reads. */
  shards?: number;
  /** Different shard counts for some counters, by name. */
  perName?: Record<string, number>;
};

const { query, mutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();
type Ctx = { db: any; config: Config };

const DEFAULT_SHARDS = 16;
const shardsFor = (config: Config, name: string) => config.perName?.[name] ?? config.shards ?? DEFAULT_SHARDS;

async function add(ctx: Ctx, name: string, count: number, shard?: number) {
  if (!Number.isFinite(count)) throw new Error(`Counter "${name}": count must be a finite number.`);
  const shards = shardsFor(ctx.config, name);
  const s = shard ?? Math.floor(Math.random() * shards);
  if (!Number.isInteger(s) || s < 0 || s >= shards) throw new Error(`Counter "${name}" has shards 0 to ${shards - 1}, not ${shard}.`);
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name_shard", (q: any) => q.eq("name", name).eq("shard", s))
    .unique();
  if (row) await ctx.db.patch(row._id, { value: row.value + count });
  else await ctx.db.insert("counters", { name, shard: s, value: count });
  return null;
}

const nameArg = { name: v.string() };

/** Adds `count` (default 1; negative to subtract) to one shard. `shard` picks it, say to keep one user on one shard. */
const addFn = mutation({
  args: { ...nameArg, count: v.optional(v.number()), shard: v.optional(v.number()) },
  handler: (ctx, { name, count, shard }) => add(ctx, name, count ?? 1, shard),
});
const inc = mutation({ args: nameArg, handler: (ctx, { name }) => add(ctx, name, 1) });
const dec = mutation({ args: nameArg, handler: (ctx, { name }) => add(ctx, name, -1) });

/** The exact value: reads every shard of the counter. */
const count = query({
  args: nameArg,
  handler: async (ctx, { name }) => {
    const rows = await ctx.db
      .query("counters")
      .withIndex("by_name_shard", (q) => q.eq("name", name))
      .collect();
    return rows.reduce((n, r) => n + r.value, 0);
  },
});

/**
 * An estimate from `readShards` random shards (default 1), scaled up: reads fewer documents, so a
 * live query over it re-runs only when one of those shards changes.
 */
const estimateCount = query({
  args: { ...nameArg, readShards: v.optional(v.number()) },
  handler: async (ctx, { name, readShards }) => {
    const shards = shardsFor(ctx.config, name);
    const n = Math.min(shards, Math.max(1, Math.floor(readShards ?? 1)));
    const picked = new Set<number>();
    while (picked.size < n) picked.add(Math.floor(Math.random() * shards));
    let sum = 0;
    for (const shard of picked) {
      const row = await ctx.db
        .query("counters")
        .withIndex("by_name_shard", (q) => q.eq("name", name).eq("shard", shard))
        .unique();
      sum += row?.value ?? 0;
    }
    return (sum * shards) / n;
  },
});

/** Sets the counter back to 0. */
const reset = mutation({
  args: nameArg,
  handler: async (ctx, { name }) => {
    const rows = await ctx.db
      .query("counters")
      .withIndex("by_name_shard", (q) => q.eq("name", name))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

export const definition = defineComponent({
  name: "shardedCounter",
  schema,
  functions: { add: addFn, inc, dec, count, estimateCount, reset },
  checkConfig: (config: Config) => {
    const ok = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1024;
    if (config.shards !== undefined && !ok(config.shards)) throw new Error("shardedCounter(): shards must be a whole number from 1 to 1024.");
    for (const [name, n] of Object.entries(config.perName ?? {})) {
      if (!ok(n)) throw new Error(`shardedCounter(): perName.${name} must be a whole number from 1 to 1024.`);
    }
  },
});

export type ShardedCounterApi<Name extends string> = {
  add: ComponentFn<"mutation", (args: { name: Name; count?: number; shard?: number }) => Promise<null>>;
  inc: ComponentFn<"mutation", (args: { name: Name }) => Promise<null>>;
  dec: ComponentFn<"mutation", (args: { name: Name }) => Promise<null>>;
  count: ComponentFn<"query", (args: { name: Name }) => Promise<number>>;
  estimateCount: ComponentFn<"query", (args: { name: Name; readShards?: number }) => Promise<number>>;
  reset: ComponentFn<"mutation", (args: { name: Name }) => Promise<null>>;
};

/** Mounts sharded counters. Any counter name works; there's nothing to declare first. */
export function shardedCounter<const E extends keyof ShardedCounterApi<string> = never>(opts: Config & MountOptions<E> = {}): Mount<ShardedCounterApi<string>, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as Mount<ShardedCounterApi<string>, E>;
}
