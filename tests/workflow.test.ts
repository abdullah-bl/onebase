import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { defineWorkflow, workflow } from "../src/components/workflow";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { anyApi, defineSchema, defineTable, internalAction, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const internal = anyApi;

const components = defineComponents({ jobs: workflow({ retry: { initialBackoffMs: 5, base: 1 } }) });

const schema = defineSchema({
  log: defineTable({ text: v.string() }),
  attempts: defineTable({ key: v.string(), n: v.number() }).index("by_key", ["key"]),
});

const modules = {
  flows: {
    onboard: defineWorkflow({
      run: async (step, args: { name: string }) => {
        const greeted = await step.runMutation(internal.flows.greet, { name: args.name });
        const count = await step.runQuery(internal.flows.count, {});
        return { greeted, count };
      },
    }),
    delayed: defineWorkflow({
      run: async (step, args: { ms: number }) => {
        await step.sleep(args.ms);
        await step.runMutation(internal.flows.greet, { name: "after" });
        return "done";
      },
    }),
    withAction: defineWorkflow({
      run: async (step, args: { fail: boolean }) => {
        const r = await step.runAction(internal.flows.fetch, { fail: args.fail });
        await step.runMutation(internal.flows.greet, { name: `got ${r}` });
        return r;
      },
    }),
    flaky: defineWorkflow({
      run: async (step, args: { key: string }) => step.runAction(internal.flows.flakyAction, { key: args.key }, { retry: { maxAttempts: 3 } }),
    }),
    broken: defineWorkflow({
      run: async () => {
        throw new Error("user code broke");
      },
    }),
    greet: internalMutation({
      args: { name: v.string() },
      handler: async (ctx, { name }) => {
        await ctx.db.insert("log", { text: name });
        return `hi ${name}`;
      },
    }),
    count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).length }),
    fetch: internalAction({
      args: { fail: v.boolean() },
      handler: async (_ctx, { fail }) => {
        if (fail) throw new Error("fetch failed");
        return "payload";
      },
    }),
    flakyAction: internalAction({
      args: { key: v.string() },
      handler: async (ctx, { key }) => {
        const n = (await ctx.runMutation(internal.flows.bump, { key })) as number;
        if (n < 3) throw new Error(`attempt ${n} failed`);
        return n;
      },
    }),
    bump: internalMutation({
      args: { key: v.string() },
      handler: async (ctx, { key }) => {
        const row = await ctx.db.query("attempts").withIndex("by_key", (q) => q.eq("key", key)).unique();
        const n = (row?.n ?? 0) + 1;
        if (row) await ctx.db.patch(row._id, { n });
        else await ctx.db.insert("attempts", { key, n });
        return n;
      },
    }),
  },
  admin: {
    start: mutation({
      args: { which: v.string(), args: v.optional(v.any()) },
      handler: (ctx: any, { which, args }) => ctx.components.jobs.start({ fn: (internal as any).flows[which], args }),
    }),
    status: query({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.jobs.status({ id }) }),
    list: query({ args: { state: v.optional(v.string()) }, handler: (ctx: any, { state }) => ctx.components.jobs.list({ status: state, paginationOpts: { numItems: 50, cursor: null } }) }),
    cancel: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.jobs.cancel({ id }) }),
    log: query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).map((d: any) => d.text) }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: workflow`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-workflow-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const start = (which: string, args?: object) => runtime.runMutation("admin:start", { which, args }) as Promise<string>;
  const status = async (id: string) => (await runtime.runQuery("admin:status", { id })).value as any;
  const log = async () => (await runtime.runQuery("admin:log", {})).value as string[];
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("runs query and mutation steps and records the return value", async () => {
    await runtime.startScheduler();
    const id = await start("onboard", { name: "Ada" });
    await until(async () => (await status(id))?.status === "completed");
    expect(await status(id)).toMatchObject({ status: "completed", result: { greeted: "hi Ada", count: 1 } });
    expect(await status(id)).toHaveProperty("steps.length", 2);
    expect(await log()).toEqual(["Ada"]);
  });

  test("sleeps and continues in the background", async () => {
    await runtime.startScheduler();
    const id = await start("delayed", { ms: 80 });
    await until(async () => (await status(id))?.steps?.length === 1);
    expect(await status(id)).toMatchObject({ status: "running" });
    expect((await status(id)).steps).toEqual([expect.objectContaining({ kind: "sleep", state: "pending" })]);
    await until(async () => (await status(id))?.status === "completed");
    expect(await status(id)).toMatchObject({ status: "completed", result: "done" });
    expect(await log()).toEqual(["after"]);
  });

  test("runs action steps out of band and journals their results", async () => {
    await runtime.startScheduler();
    const id = await start("withAction", { fail: false });
    await until(async () => (await status(id))?.status === "completed");
    expect(await status(id)).toMatchObject({ status: "completed", result: "payload" });
    expect(await log()).toEqual(["got payload"]);
    expect(await status(id)).toHaveProperty("steps.0.kind", "action");
  });

  test("retries a failing action with backoff, then succeeds", async () => {
    await runtime.startScheduler();
    const id = await start("flaky", { key: "a" });
    await until(async () => (await status(id))?.status === "completed");
    expect(await status(id)).toMatchObject({ status: "completed", result: 3 });
    expect(await status(id)).toHaveProperty("steps.0.attempts", 3);
  });

  test("a failing action fails the workflow", async () => {
    await runtime.startScheduler();
    const id = await start("withAction", { fail: true });
    await until(async () => (await status(id))?.status === "failed");
    expect(await status(id)).toMatchObject({ status: "failed", error: "fetch failed" });
    expect(await log()).toEqual([]);
  });

  test("an error in the workflow's own code fails it", async () => {
    await runtime.startScheduler();
    const id = await start("broken");
    await until(async () => (await status(id))?.status === "failed");
    expect(await status(id)).toMatchObject({ status: "failed", error: "user code broke" });
  });

  test("re-running mid-sleep doesn't duplicate steps or run them twice", async () => {
    const id = await start("delayed", { ms: 60_000 });
    await runtime.runMutation("components/jobs:run", { workflowId: id }, { allowInternal: true, source: "dashboard" });
    await runtime.runMutation("components/jobs:run", { workflowId: id }, { allowInternal: true, source: "dashboard" });
    expect(await status(id)).toHaveProperty("steps.length", 1);
    expect(await log()).toEqual([]);
    expect(await runtime.runMutation("admin:cancel", { id })).toBe(true);
    expect(await status(id)).toMatchObject({ status: "canceled" });
  });

  test("cancel is honored: a late action outcome is ignored", async () => {
    // No scheduler yet: the run and its action stay queued until after the cancel.
    const id = await start("withAction", { fail: false });
    expect(await status(id)).toMatchObject({ status: "running" });
    expect(await runtime.runMutation("admin:cancel", { id })).toBe(true);
    await runtime.startScheduler();
    await Bun.sleep(200);
    expect(await status(id)).toMatchObject({ status: "canceled", result: null });
    expect(await log()).toEqual([]);
  });

  test("two workflows run independently", async () => {
    await runtime.startScheduler();
    const [a, b] = await Promise.all([start("onboard", { name: "A" }), start("onboard", { name: "B" })]);
    await until(async () => (await status(a))?.status === "completed" && (await status(b))?.status === "completed");
    expect(await status(a)).toMatchObject({ result: { greeted: "hi A" } });
    expect(await status(b)).toMatchObject({ result: { greeted: "hi B" } });
    expect(await log()).toEqual(["A", "B"]);
  });

  test("status and list report workflows", async () => {
    await runtime.startScheduler();
    expect(await status("nope")).toBeNull();
    const id = await start("onboard", { name: "x" });
    await until(async () => (await status(id))?.status === "completed");
    const running = (await runtime.runQuery("admin:list", { state: "running" })).value as any;
    expect(running.page).toEqual([]);
    const all = (await runtime.runQuery("admin:list", {})).value as any;
    expect(all.page.map((w: any) => w.id)).toEqual([id]);
  });

  test("start checks its function handle", async () => {
    await expect(runtime.runMutation("components/jobs:start", { fn: "flows:onboard" }, { allowInternal: true, source: "dashboard" })).rejects.toThrow(
      "must be a function reference",
    );
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").MutationCtx<any, typeof components>) {
  type Ref<T extends "query" | "mutation" | "action", A, R = unknown> = import("../src/api").FunctionReference<T, "internal", A, R>;
  const get = {} as Ref<"query", { id: string }, { name: string }>;
  const touch = {} as Ref<"mutation", { id: string }>;
  const call = {} as Ref<"action", { url: string }, string>;
  const flow = defineWorkflow({
    run: async (step, args: { id: string }) => {
      const user: { name: string } = await step.runQuery(get, { id: args.id });
      // @ts-expect-error: wrong args for the function
      await step.runQuery(get, { nope: 1 });
      await step.runMutation(touch, { id: user.name });
      // @ts-expect-error: a mutation isn't an action
      await step.runAction(touch, { id: "1" });
      const text: string = await step.runAction(call, { url: "https://x" }, { retry: { maxAttempts: 3 } });
      await step.sleep(1_000);
      return text;
    },
  });
  void flow;
  const id: string = await ctx.components.jobs.start({ fn: internal.flows.onboard, args: { name: "a" } });
  const st = await ctx.components.jobs.status({ id });
  if (st?.steps?.length) {
    const n: number = st.steps[0]!.number;
    void n;
  }
  await ctx.components.jobs.cancel({ id });
  const page = await ctx.components.jobs.list({ status: "running", paginationOpts: { numItems: 10, cursor: null } });
  void page;
}
void _types;
