import { afterEach, expect, setSystemTime, test } from "bun:test";
import { checkRateLimitConfig, currentValue, shardConfig, take, type RateLimitConfig } from "../src/components/rate-limiter/algorithm";
import { defineComponents } from "../src/components";
import { MINUTE, rateLimiter, SECOND } from "../src/components/rate-limiter";
import { mutation, query } from "../src/server";
import { v } from "../src/values";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { quiet } from "./helpers";

afterEach(() => void setSystemTime());

const bucket: RateLimitConfig = { kind: "token bucket", rate: 10, period: MINUTE }; // one token per 6s
const window: RateLimitConfig = { kind: "fixed window", rate: 3, period: MINUTE };

/** Runs take() repeatedly, keeping the state as the component does. */
function limiter(config: RateLimitConfig) {
  let state: { value: number; ts: number } | null = null;
  return (now: number, count = 1, reserve = false) => {
    const r = take(config, state, { count, reserve, now });
    if (r.state) state = r.state;
    return r.result;
  };
}

test("token bucket: a full burst, then one token per rate/period", () => {
  const limit = limiter(bucket);
  for (let i = 0; i < 10; i++) expect(limit(0).ok).toBe(true);
  expect(limit(0)).toEqual({ ok: false, retryAfter: 6000 });
  expect(limit(3000)).toEqual({ ok: false, retryAfter: 3000 });
  expect(limit(6000).ok).toBe(true);
  expect(limit(6000).ok).toBe(false);
  // Refills up to capacity, not beyond.
  expect(currentValue(bucket, { value: 0, ts: 0 }, 10 * MINUTE).value).toBe(10);
});

test("token bucket: capacity allows bursts above the rate", () => {
  const limit = limiter({ ...bucket, capacity: 20 });
  for (let i = 0; i < 20; i++) expect(limit(0).ok).toBe(true);
  expect(limit(0).ok).toBe(false);
});

test("fixed window: rate tokens per window, refused until the next one", () => {
  const limit = limiter(window);
  expect(limit(1000, 3).ok).toBe(true);
  expect(limit(30_000)).toEqual({ ok: false, retryAfter: 30_000 });
  expect(limit(MINUTE).ok).toBe(true);
  // Windows start at `start`.
  const shifted = limiter({ ...window, start: 10 * SECOND });
  expect(shifted(15 * SECOND, 3).ok).toBe(true);
  expect(shifted(65 * SECOND)).toEqual({ ok: false, retryAfter: 5000 });
});

test("reserve goes into debt and says when the reservation is due; maxReserved caps it", () => {
  const limit = limiter({ ...bucket, maxReserved: 2 });
  expect(limit(0, 10).ok).toBe(true);
  expect(limit(0, 1, true)).toEqual({ ok: true, retryAfter: 6000 });
  expect(limit(0, 1, true)).toEqual({ ok: true, retryAfter: 12_000 });
  expect(limit(0, 1, true)).toEqual({ ok: false, retryAfter: 18_000 });
});

test("shards split the rate and capacity evenly", () => {
  expect(shardConfig({ ...bucket, shards: 4 })).toMatchObject({ rate: 2.5, capacity: 2.5 });
  expect(shardConfig(bucket)).toBe(bucket);
});

test("configurations are checked with a reason", () => {
  expect(() => checkRateLimitConfig("x", { kind: "leaky", rate: 1, period: 1 })).toThrow('kind must be "token bucket" or "fixed window"');
  expect(() => checkRateLimitConfig("x", { kind: "fixed window", rate: 1, period: 0 })).toThrow("period must be a positive number");
  expect(() => checkRateLimitConfig("x", { ...bucket, shards: 1.5 })).toThrow("shards must be a whole number");
});

test("the component: check() takes nothing, limits are per key, reset() refills, getValue() reports", async () => {
  const components = defineComponents({
    limiter: rateLimiter({ rates: { login: { kind: "fixed window", rate: 2, period: MINUTE }, sharded: { ...bucket, shards: 2 } } }),
  });
  const call = (fn: string) => mutation({ args: { args: v.any() }, handler: (ctx: any, { args }) => ctx.components.limiter[fn](args) });
  const runtime = new Runtime({
    driver: new SqliteDriver(":memory:"),
    schema: null,
    modules: { t: { limit: call("limit"), reset: call("reset"), check: query({ args: { args: v.any() }, handler: (ctx: any, { args }) => ctx.components.limiter.check(args) }), value: query({ args: { args: v.any() }, handler: (ctx: any, { args }) => ctx.components.limiter.getValue(args) }) } },
    components: components as any,
    log: quiet,
  });
  await runtime.init();
  const run = (fn: string, args: object) => (fn === "check" || fn === "value" ? runtime.runQuery(`t:${fn}`, { args }).then((r) => r.value) : runtime.runMutation(`t:${fn}`, { args })) as Promise<any>;
  setSystemTime(new Date(MINUTE * 1000));

  expect(await run("check", { name: "login", key: "ali" })).toEqual({ ok: true });
  expect(await run("value", { name: "login", key: "ali" })).toMatchObject({ value: 2 });
  await run("limit", { name: "login", key: "ali" });
  await run("limit", { name: "login", key: "ali" });
  expect((await run("limit", { name: "login", key: "ali" })).ok).toBe(false);
  expect((await run("check", { name: "login", key: "ali" })).ok).toBe(false);
  expect((await run("limit", { name: "login", key: "sara" })).ok).toBe(true);
  expect(await run("value", { name: "login", key: "ali" })).toMatchObject({ value: 0 });
  await run("reset", { name: "login", key: "ali" });
  expect((await run("limit", { name: "login", key: "ali" })).ok).toBe(true);

  // Shards: 10 tokens split over 2 documents; each call draws from one at random.
  let allowed = 0;
  for (let i = 0; i < 20; i++) if ((await run("limit", { name: "sharded" })).ok) allowed++;
  expect(allowed).toBeGreaterThanOrEqual(5);
  expect(allowed).toBeLessThanOrEqual(10);

  await expect(run("limit", { name: "nope" })).rejects.toThrow('Unknown rate limit "nope". Defined: login, sharded.');
  await expect(run("limit", { name: "login", count: 3 })).rejects.toThrow("count 3 is more than its capacity (2)");
  expect((await run("limit", { name: "adhoc", config: { kind: "token bucket", rate: 1, period: MINUTE } })).ok).toBe(true);
  runtime.stop();
  await runtime.driver.close();
});

