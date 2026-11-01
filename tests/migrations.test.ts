import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { defineMigration, migrations, type MigrationStatus } from "../src/components/migrations";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { anyApi, defineSchema, defineTable, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const internal = anyApi;

const components = defineComponents({ migrations: migrations() });

const schema = defineSchema({
  messages: defineTable({ body: v.optional(v.string()) }),
  log: defineTable({ text: v.string() }),
});

const modules = {
  backfill: {
    upper: defineMigration({
      table: "messages",
      mutateOne: async (ctx, doc) => {
        if (doc.body) await ctx.db.patch(doc._id, { body: doc.body.toUpperCase() });
      },
    }),
    counting: defineMigration({
      table: "messages",
      mutateOne: async (ctx, doc) => {
        await ctx.db.insert("log", { text: `${doc._id}:${doc.body}` });
      },
    }),
    boom: defineMigration({
      table: "messages",
      mutateOne: async (ctx, doc) => {
        if (doc.body === "boom") throw new Error("boom");
        if (doc.body) await ctx.db.patch(doc._id, { body: doc.body.toUpperCase() });
      },
    }),
  },
  admin: {
    seed: internalMutation({
      args: { n: v.number(), prefix: v.optional(v.string()) },
      handler: async (ctx, { n, prefix = "m" }) => {
        for (let i = 0; i < n; i++) await ctx.db.insert("messages", { body: `${prefix}${i}` });
      },
    }),
    fixBoom: internalMutation({
      args: {},
      handler: async (ctx) => {
        for (const doc of await ctx.db.query("messages").collect()) {
          if (doc.body === "boom") await ctx.db.patch(doc._id, { body: "fixed" });
        }
      },
    }),
    migrate: mutation({
      args: { which: v.string(), as: v.optional(v.string()), batchSize: v.optional(v.number()), maxMs: v.optional(v.number()), force: v.optional(v.boolean()) },
      handler: (ctx: any, { which, as, ...rest }) => ctx.components.migrations.migrate({ name: as ?? which, runner: (internal as any).backfill[which], ...rest }),
    }),
    status: query({ args: { name: v.string() }, handler: (ctx: any, { name }) => ctx.components.migrations.status({ name }) }),
    list: query({ args: {}, handler: (ctx: any) => ctx.components.migrations.list() }),
    cancel: mutation({ args: { name: v.string() }, handler: (ctx: any, { name }) => ctx.components.migrations.cancel({ name }) }),
    bodies: query({ args: {}, handler: async (ctx) => (await ctx.db.query("messages").collect()).map((d: any) => d.body) }),
    logs: query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).length }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: migrations`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-migrations-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dash = { allowInternal: true, source: "dashboard" } as const;
  const seed = (n: number, prefix = "m") => runtime.runMutation("admin:seed", { n, prefix }, dash);
  const fixBoom = () => runtime.runMutation("admin:fixBoom", {}, dash);
  const logs = async () => (await runtime.runQuery("admin:logs", {})).value as number;
  const migrate = (which: string, args: Record<string, unknown> = {}) => runtime.runMutation("admin:migrate", { which, ...args }) as Promise<MigrationStatus>;
  const status = async (name: string) => (await runtime.runQuery("admin:status", { name })).value as MigrationStatus | null;
  const bodies = async () => (await runtime.runQuery("admin:bodies", {})).value as (string | undefined)[];
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("a fast migration completes in the calling transaction", async () => {
    await seed(5);
    const st = await migrate("upper");
    expect(st).toMatchObject({ name: "upper", state: "completed", processed: 5 });
    expect(await bodies()).toEqual(["M0", "M1", "M2", "M3", "M4"]);
  });

  test("continues in the background after maxMs, batch by batch", async () => {
    await seed(25);
    const st = await migrate("upper", { batchSize: 10, maxMs: 0 });
    expect(st.state).toBe("inProgress");
    expect(st.processed).toBe(10);
    await runtime.startScheduler();
    await until(async () => (await status("upper"))?.state === "completed");
    expect(await status("upper")).toMatchObject({ state: "completed", processed: 25 });
    expect(await bodies()).toEqual(Array.from({ length: 25 }, (_, i) => `M${i}`));
  });

  test("a failing mutateOne fails the migration, rolls its batch back, and can resume", async () => {
    // Insert order is creation order, so "boom" lands in the middle.
    await runtime.adminWrite(async (db) => {
      for (const body of ["x0", "x1", "boom", "x3", "x4", "x5"]) await db.insert("messages", { body });
    });
    const st = await migrate("boom", { batchSize: 2 });
    expect(st).toMatchObject({ state: "failed", error: "boom", processed: 2 });
    // The failing batch (boom, x3) rolled back; the first batch's writes stand.
    expect(await bodies()).toEqual(["X0", "X1", "boom", "x3", "x4", "x5"]);
    await fixBoom();
    const resumed = await migrate("boom", { batchSize: 2 });
    expect(resumed).toMatchObject({ state: "completed", processed: 6 });
    expect(await bodies()).toEqual(["X0", "X1", "FIXED", "X3", "X4", "X5"]);
  });

  test("force starts over; a different runner needs force", async () => {
    await seed(4);
    await migrate("counting", { batchSize: 3 });
    expect(await logs()).toBe(4);
    // Same name ("counting"), a different runner ("upper"): refused unless forced.
    await expect(runtime.runMutation("admin:migrate", { which: "upper", as: "counting" })).rejects.toThrow("different function");
    await expect(runtime.runMutation("admin:migrate", { which: "upper", as: "counting", force: false })).rejects.toThrow("different function");
    const again = await migrate("counting", { force: true });
    expect(again).toMatchObject({ state: "completed", processed: 4 });
    expect(await logs()).toBe(8);
  });

  test("cancel stops a background migration and migrate resumes it", async () => {
    await seed(25);
    await migrate("upper", { batchSize: 10, maxMs: 0 });
    expect(await runtime.runMutation("admin:cancel", { name: "upper" })).toBe(true);
    expect(await status("upper")).toMatchObject({ state: "canceled", processed: 10 });
    await runtime.startScheduler();
    await Bun.sleep(100); // a canceled continuation must not run
    expect((await status("upper"))?.state).toBe("canceled");
    const resumed = await migrate("upper", { batchSize: 10, maxMs: 0 });
    expect(resumed.state).toBe("inProgress");
    await until(async () => (await status("upper"))?.state === "completed");
    expect((await status("upper"))?.processed).toBe(25);
    expect(await runtime.runMutation("admin:cancel", { name: "upper" })).toBe(false);
  });

  test("status and list report every migration; unknown names are null", async () => {
    expect(await status("nope")).toBeNull();
    await seed(2);
    await migrate("upper");
    await migrate("counting");
    const list = (await runtime.runQuery("admin:list", {})).value as MigrationStatus[];
    expect(list.map((m) => m.name)).toEqual(["counting", "upper"]);
    expect(list[0]).toMatchObject({ state: "completed", processed: 2 });
  });

  test("migrate twice on a completed migration is a no-op", async () => {
    await seed(3);
    await migrate("upper");
    expect(await migrate("upper")).toMatchObject({ state: "completed", processed: 3 });
    expect(await logs()).toBe(0);
  });

  test("runner must be a function handle", async () => {
    await expect(
      runtime.runMutation("components/migrations:migrate", { name: "x", runner: "backfill:upper" }, { allowInternal: true, source: "dashboard" }),
    ).rejects.toThrow("must be a function reference");
  });

  test("batchSize is checked", async () => {
    await expect(migrate("upper", { batchSize: 0 })).rejects.toThrow("batchSize");
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").MutationCtx<any, typeof components>) {
  type Ref<T extends "mutation" | "query", A = any> = import("../src/api").FunctionReference<T, "internal", A, unknown>;
  const good = {} as Ref<"mutation", { cursor?: string | null; numItems: number }>;
  const wrongArgs = {} as Ref<"mutation", { other: string }>;
  const aQuery = {} as Ref<"query">;
  const st: MigrationStatus = await ctx.components.migrations.migrate({ name: "n", runner: good });
  // @ts-expect-error: the runner must take { cursor, numItems }
  await ctx.components.migrations.migrate({ name: "n", runner: wrongArgs });
  // @ts-expect-error: a query isn't a mutation
  await ctx.components.migrations.migrate({ name: "n", runner: aQuery });
  await ctx.components.migrations.migrate({ name: "n", runner: good, batchSize: 10, maxMs: 0, force: true });
  const one: MigrationStatus | null = await ctx.components.migrations.status({ name: "n" });
  const all: MigrationStatus[] = await ctx.components.migrations.list();
  const stopped: boolean = await ctx.components.migrations.cancel({ name: "n" });
  void st; void one; void all; void stopped;
}
void _types;
