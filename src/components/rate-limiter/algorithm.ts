// The rate limiting arithmetic, free of storage so it can be tested on its own.

export type RateLimitConfig = {
  /**
   * "token bucket": tokens refill continuously at `rate` per `period`, up to `capacity`, so
   * bursts are allowed and the average is capped. "fixed window": `rate` tokens are added at the
   * start of each `period` (windows start at `start`, default the epoch), up to `capacity`.
   */
  kind: "token bucket" | "fixed window";
  /** Tokens added per period. */
  rate: number;
  /** In milliseconds: use SECOND, MINUTE, HOUR or DAY. */
  period: number;
  /** The most tokens that can be saved up (default: rate). */
  capacity?: number;
  /** With `reserve: true`, how far into debt a key may go (default: no limit). */
  maxReserved?: number;
  /**
   * Splits the limit over this many documents, each with an equal share, so writes to one busy
   * limit don't all contend on one document (useful with several instances). Default 1.
   */
  shards?: number;
  /** Fixed window only: when windows start, in ms since the epoch (default 0). */
  start?: number;
};

/** What's stored per name, key and shard: tokens left (negative when reserved ahead) and when that was. */
export type RateLimitState = { value: number; ts: number };

export type RateLimitResult = { ok: true; retryAfter?: number } | { ok: false; retryAfter: number };

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Throws when a configuration can't work, naming what to fix. */
export function checkRateLimitConfig(name: string, config: unknown): RateLimitConfig {
  const c = config as RateLimitConfig;
  const where = `Rate limit "${name}"`;
  if (typeof c !== "object" || c === null) throw new Error(`${where} needs { kind, rate, period }.`);
  if (c.kind !== "token bucket" && c.kind !== "fixed window") throw new Error(`${where}: kind must be "token bucket" or "fixed window".`);
  if (!(typeof c.rate === "number" && c.rate > 0 && Number.isFinite(c.rate))) throw new Error(`${where}: rate must be a positive number.`);
  if (!(typeof c.period === "number" && c.period > 0 && Number.isFinite(c.period))) throw new Error(`${where}: period must be a positive number of ms (e.g. MINUTE).`);
  if (c.capacity !== undefined && !(typeof c.capacity === "number" && c.capacity > 0)) throw new Error(`${where}: capacity must be a positive number.`);
  if (c.maxReserved !== undefined && !(typeof c.maxReserved === "number" && c.maxReserved >= 0)) throw new Error(`${where}: maxReserved can't be negative.`);
  if (c.shards !== undefined && !(Number.isInteger(c.shards) && c.shards >= 1)) throw new Error(`${where}: shards must be a whole number of at least 1.`);
  if (c.start !== undefined && typeof c.start !== "number") throw new Error(`${where}: start must be a timestamp in ms.`);
  return c;
}

/** One shard's share of a limit. */
export function shardConfig(config: RateLimitConfig): RateLimitConfig {
  const n = config.shards ?? 1;
  if (n === 1) return config;
  return {
    ...config,
    rate: config.rate / n,
    capacity: (config.capacity ?? config.rate) / n,
    maxReserved: config.maxReserved === undefined ? undefined : config.maxReserved / n,
  };
}

/** Tokens available at `now`, before taking any. */
export function currentValue(config: RateLimitConfig, state: RateLimitState | null, now: number): RateLimitState {
  const capacity = config.capacity ?? config.rate;
  if (config.kind === "token bucket") {
    if (!state) return { value: capacity, ts: now };
    const refill = Math.max(0, now - state.ts) * (config.rate / config.period);
    return { value: Math.min(capacity, state.value + refill), ts: now };
  }
  const start = config.start ?? 0;
  const windowStart = start + Math.floor((now - start) / config.period) * config.period;
  if (!state) return { value: capacity, ts: windowStart };
  const windows = Math.max(0, Math.floor((windowStart - state.ts) / config.period));
  return { value: Math.min(capacity, state.value + windows * config.rate), ts: Math.max(state.ts, windowStart) };
}

/**
 * Takes `count` tokens. Returns the new state to store (null when nothing changes) and whether it
 * was allowed; `retryAfter` is how long until it would be (or, when reserved, until it's valid).
 */
export function take(
  config: RateLimitConfig,
  state: RateLimitState | null,
  opts: { count: number; reserve: boolean; now: number },
): { result: RateLimitResult; state: RateLimitState | null } {
  const { count, reserve, now } = opts;
  const current = currentValue(config, state, now);
  const value = current.value - count;
  if (value >= 0) return { result: { ok: true }, state: { value, ts: current.ts } };
  const retryAfter = waitFor(config, current, -value, now);
  if (reserve && (config.maxReserved === undefined || -value <= config.maxReserved)) {
    return { result: { ok: true, retryAfter }, state: { value, ts: current.ts } };
  }
  return { result: { ok: false, retryAfter }, state: null };
}

/** How long until `missing` more tokens have been added. */
function waitFor(config: RateLimitConfig, current: RateLimitState, missing: number, now: number): number {
  if (config.kind === "token bucket") return Math.ceil(missing / (config.rate / config.period));
  const windows = Math.ceil(missing / config.rate);
  return Math.max(0, current.ts + windows * config.period - now);
}
