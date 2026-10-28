// Rate limiting that lives in the database: limits hold across restarts and instances, and are
// checked in the caller's transaction (a mutation that fails after limit() gives its token back).
//
//   // onebase/components.ts
//   export default defineComponents({
//     limiter: rateLimiter({ rates: { sendMessage: { kind: "token bucket", rate: 10, period: MINUTE } } }),
//   });
//   // in a mutation
//   await ctx.components.limiter.limit({ name: "sendMessage", key: userId, throws: true });

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type MountOptions, type Mount } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { ConvexError, v } from "../../values";
import { checkRateLimitConfig, currentValue, shardConfig, take, type RateLimitConfig, type RateLimitResult, type RateLimitState } from "./algorithm";

export { DAY, HOUR, MINUTE, SECOND } from "./algorithm";
export type { RateLimitConfig, RateLimitResult } from "./algorithm";

const schema = defineSchema({
  rateLimits: defineTable({
    name: v.string(),
    key: v.optional(v.string()),
    shard: v.number(),
    value: v.number(),
    ts: v.number(),
  }).index("by_name_key_shard", ["name", "key", "shard"]),
});

type Config = { rates: Record<string, RateLimitConfig> };
const { query, mutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();

const limitArgs = {
  name: v.string(),
  key: v.optional(v.string()),
  count: v.optional(v.number()),
  reserve: v.optional(v.boolean()),
  throws: v.optional(v.boolean()),
  /** A limit not named in components.ts. */
  config: v.optional(v.any()),
};

type Ctx = { config: Config; db: any };

function configFor(ctx: Ctx, name: string, inline: unknown): RateLimitConfig {
  if (inline !== undefined) return checkRateLimitConfig(name, inline);
  const config = ctx.config.rates[name];
  if (!config) {
    const names = Object.keys(ctx.config.rates);
    throw new Error(`Unknown rate limit "${name}". Defined: ${names.join(", ") || "(none)"}. Add it to rates in components.ts, or pass config.`);
  }
  return config;
}

const shardRow = (ctx: Ctx, name: string, key: string | undefined, shard: number) =>
  ctx.db
    .query("rateLimits")
    .withIndex("by_name_key_shard", (q: any) => q.eq("name", name).eq("key", key).eq("shard", shard))
    .unique();

const asState = (row: { value: number; ts: number } | null): RateLimitState | null => (row ? { value: row.value, ts: row.ts } : null);

function checkCount(name: string, count: number, config: RateLimitConfig, reserve: boolean) {
  if (!(typeof count === "number" && count > 0 && Number.isFinite(count))) throw new Error(`Rate limit "${name}": count must be a positive number.`);
  const capacity = config.capacity ?? config.rate;
  if (count > capacity && !reserve) {
    throw new Error(`Rate limit "${name}": count ${count} is more than its capacity (${capacity}), so it could never be allowed.`);
  }
}

/** Takes `count` tokens for `name` (and `key`). Fails, or with `throws` throws, when there aren't enough. */
const limit = mutation({
  args: limitArgs,
  handler: async (ctx, args): Promise<RateLimitResult> => {
    const config = configFor(ctx, args.name, args.config);
    const count = args.count ?? 1;
    const reserve = args.reserve ?? false;
    checkCount(args.name, count, config, reserve);
    const shard = Math.floor(Math.random() * (config.shards ?? 1));
    const row = await shardRow(ctx, args.name, args.key, shard);
    const { result, state } = take(shardConfig(config), asState(row), { count, reserve, now: Date.now() });
    if (state) {
      if (row) await ctx.db.patch(row._id, state);
      else await ctx.db.insert("rateLimits", { name: args.name, key: args.key, shard, ...state });
    }
    if (!result.ok && args.throws) throw new ConvexError({ kind: "RateLimited", name: args.name, retryAfter: result.retryAfter });
    return result;
  },
});

/** Like limit(), but only reports whether it would be allowed; nothing is taken. */
const check = query({
  args: limitArgs,
  handler: async (ctx, args): Promise<RateLimitResult> => {
    const config = configFor(ctx, args.name, args.config);
    const count = args.count ?? 1;
    const reserve = args.reserve ?? false;
    checkCount(args.name, count, config, reserve);
    const shard = Math.floor(Math.random() * (config.shards ?? 1));
    const row = await shardRow(ctx, args.name, args.key, shard);
    const { result } = take(shardConfig(config), asState(row), { count, reserve, now: Date.now() });
    if (!result.ok && args.throws) throw new ConvexError({ kind: "RateLimited", name: args.name, retryAfter: result.retryAfter });
    return result;
  },
});

/** Forgets what `name` (and `key`) used: its full capacity is available again. */
const reset = mutation({
  args: { name: v.string(), key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("rateLimits")
      .withIndex("by_name_key_shard", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** Tokens available now for `name` (and `key`), over all shards. */
const getValue = query({
  args: { name: v.string(), key: v.optional(v.string()), config: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const config = configFor(ctx, args.name, args.config);
    const rows = await ctx.db
      .query("rateLimits")
      .withIndex("by_name_key_shard", (q) => q.eq("name", args.name).eq("key", args.key))
      .collect();
    const now = Date.now();
    const per = shardConfig(config);
    const shards = config.shards ?? 1;
    let value = 0;
    for (let shard = 0; shard < shards; shard++) {
      value += currentValue(per, asState(rows.find((r) => r.shard === shard) ?? null), now).value;
    }
    return { value, ts: now };
  },
});

export const definition = defineComponent({
  name: "rateLimiter",
  schema,
  functions: { limit, check, reset, getValue },
  checkConfig: (config: Config) => {
    if (typeof config?.rates !== "object" || config.rates === null) throw new Error("rateLimiter({ rates: { name: { kind, rate, period } } }) needs rates.");
    for (const [name, rate] of Object.entries(config.rates)) checkRateLimitConfig(name, rate);
  },
});

type Common = { key?: string; count?: number; reserve?: boolean; throws?: boolean };
/** A named limit from components.ts, or any name with its config given inline. */
type LimitArgs<Name extends string> = ({ name: Name; config?: undefined } | { name: string; config: RateLimitConfig }) & Common;

export type RateLimiterApi<Name extends string> = {
  limit: ComponentFn<"mutation", (args: LimitArgs<Name>) => Promise<RateLimitResult>>;
  check: ComponentFn<"query", (args: LimitArgs<Name>) => Promise<RateLimitResult>>;
  reset: ComponentFn<"mutation", (args: { name: Name | (string & {}); key?: string }) => Promise<null>>;
  getValue: ComponentFn<"query", (args: { name: Name; key?: string } | { name: string; key?: string; config: RateLimitConfig }) => Promise<{ value: number; ts: number }>>;
};

/** Mounts a rate limiter with named limits: `rateLimiter({ rates: { send: { kind: "token bucket", rate: 10, period: MINUTE } } })`. */
export function rateLimiter<const R extends Record<string, RateLimitConfig>>(opts: { rates: R } & MountOptions): Mount<RateLimiterApi<keyof R & string>> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config as Config, options) as Mount<RateLimiterApi<keyof R & string>>;
}

export type RateLimitErrorData = { kind: "RateLimited"; name: string; retryAfter: number };

/** True for the error limit({ throws: true }) throws; its `data` says which limit and when to retry. */
export function isRateLimitError(err: unknown): err is ConvexError<RateLimitErrorData> {
  return err instanceof ConvexError && (err.data as RateLimitErrorData | undefined)?.kind === "RateLimited";
}
