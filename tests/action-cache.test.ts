import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { actionCache, cached } from "../src/components/action-cache";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { anyApi, action, defineSchema, defineTable, internalAction, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const internal = anyApi;

let slowMs = 0;
let failNext = false;

const compute = internalAction({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    if (slowMs > 0) await Bun.sleep(slowMs);
    if (failNext) {
      failNext = false;
      throw new Error("compute blew up");
    }
    await ctx.runMutation(internal.data.log, { q });
    return `result:${q}`;
  },
});

const log = internalMutation({
  args: { q: v.string() },
  handler: async (ctx, { q }) => {
    await ctx.db.insert("runs", { q });
  },
});

const components = defineComponents({ cache: actionCache({ ttl: 60_000 }) });

const schema = defineSchema({ runs: defineTable({ q: v.string() }) });

const modules = {
  data: { compute, log },
  admin: {
    run: action({
      args: { q: v.string(), ttl: v.optional(v.number()) },
      handler: (ctx: any, { q, ttl }) => {
        const report = cached("cache", internal.data.compute, (args: { q: string }) => args.q, { ttl });
        return report(ctx, { q });
      },
    }),
    parallel: action({
      args: { q: v.string() },
      handler: async (ctx: any, { q }) => {
        const report = cached("cache", internal.data.compute, (args: { q: string }) => args.q);
        const [a, b] = await Promise.all([report(ctx, { q }), report(ctx, { q })]);
        return [a, b];
      },
    }),
    invalidate: mutation({ args: { key: v.optional(v.string()), prefix: v.optional(v.string()) }, handler: (ctx: any, args) => ctx.components.cache.invalidate(args) }),
    peek: query({ args: { key: v.string() }, handler: (ctx: any, { key }) => ctx.components.cache.peek({ key }) }),
    runs: query({ args: {}, handler: async (ctx) => (await ctx.db.query("runs").collect()).length }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: action cache`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-cache-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.startScheduler();
    slowMs = 0;
    failNext = false;
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const q = async (name: string, args: Record<string, unknown> = {}) => (await runtime.runQuery(name, args)).value as any;
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("a cached action runs once; the second call is a hit", async () => {
    expect(await runtime.runAction("admin:run", { q: "sales" })).toBe("result:sales");
    expect(await q("admin:runs")).toBe(1);
    expect(await runtime.runAction("admin:run", { q: "sales" })).toBe("result:sales");
    expect(await q("admin:runs")).toBe(1);
    expect(await q("admin:peek", { key: "data:compute:sales" })).toMatchObject({ result: "result:sales" });
  });

  test("different arguments are different keys", async () => {
    await runtime.runAction("admin:run", { q: "a" });
    await runtime.runAction("admin:run", { q: "b" });
    expect(await q("admin:runs")).toBe(2);
  });

  test("a short TTL expires", async () => {
    await runtime.runAction("admin:run", { q: "x", ttl: 150 });
    await Bun.sleep(300);
    await runtime.runAction("admin:run", { q: "x", ttl: 150 });
    expect(await q("admin:runs")).toBe(2);
  });

  test("invalidate forgets one key or a prefix", async () => {
    await runtime.runAction("admin:run", { q: "a" });
    await runtime.runAction("admin:run", { q: "b" });
    expect(await runtime.runMutation("admin:invalidate", { key: "data:compute:a" })).toBe(1);
    await runtime.runAction("admin:run", { q: "a" });
    expect(await q("admin:runs")).toBe(3);
    expect(await runtime.runMutation("admin:invalidate", { prefix: "data:compute:" })).toBe(2);
    await runtime.runAction("admin:run", { q: "b" });
    expect(await q("admin:runs")).toBe(4);
  });

  test("concurrent callers share one run", async () => {
    slowMs = 150;
    const [a, b] = (await runtime.runAction("admin:parallel", { q: "hot" })) as string[];
    expect(a).toBe("result:hot");
    expect(b).toBe("result:hot");
    await until(async () => (await q("admin:runs")) === 1, 100);
    expect(await q("admin:runs")).toBe(1);
  });

  test("a failing computation isn't cached and is rethrown", async () => {
    failNext = true;
    await expect(runtime.runAction("admin:run", { q: "boom" })).rejects.toThrow("compute blew up");
    await expect(q("admin:peek", { key: "data:compute:boom" })).resolves.toBeNull();
    await runtime.runAction("admin:run", { q: "boom" });
    expect(await q("admin:runs")).toBe(1);
  });
});
