// Several onebase instances sharing one Postgres or libSQL database.
// Runs when TEST_POSTGRES_URL / TEST_LIBSQL_URL are set.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleProject, importBundle } from "../src/deploy";
import { createDriver, type Driver } from "../src/engine/driver";
import { Runtime, type RuntimeOptions } from "../src/engine/runtime";
import { SubscriptionManager } from "../src/engine/sync";
import { password } from "../src/auth";
import { authTables, cronJobs, defineSchema, defineTable, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  ticks: defineTable({ instance: v.string() }),
});

const modules = {
  counters: {
    get: query({
      args: { name: v.string() },
      handler: async (ctx, { name }) => (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique())?.value ?? 0,
    }),
    increment: mutation({
      args: { name: v.string() },
      handler: async (ctx, { name }) => {
        const doc = await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
        if (doc) await ctx.db.patch(doc._id, { value: doc.value + 1 });
        else await ctx.db.insert("counters", { name, value: 1 });
      },
    }),
  },
  ticks: {
    count: query({ args: {}, handler: async (ctx) => (await ctx.db.query("ticks").collect()).length }),
    record: internalMutation({ args: { instance: v.string() }, handler: (ctx, args) => ctx.db.insert("ticks", args) }),
  },
};

const URLS = [
  ["postgres", process.env.TEST_POSTGRES_URL],
  ["libsql", process.env.TEST_LIBSQL_URL],
].filter(([, url]) => url) as [string, string][];

for (const [name, url] of URLS) {
  describe(`${name}: multiple instances`, () => {
    const open: { runtime: Runtime; driver: Driver }[] = [];
    const quiet = { info() {}, warn() {}, error() {} };

    async function instance(crons?: ReturnType<typeof cronJobs>, extra: Partial<RuntimeOptions> = {}) {
      const driver = createDriver(url);
      const runtime = new Runtime({ driver, schema, modules, crons: crons?.jobs, log: quiet, ...extra });
      await runtime.init();
      open.push({ runtime, driver });
      return runtime;
    }

    afterEach(async () => {
      for (const { runtime, driver } of open.splice(0)) {
        runtime.stop();
        await driver.close();
      }
    });

    test("a deploy on one instance goes live on the others", async () => {
      const reset = (r: Runtime) =>
        r.driver.write(async (tx) => {
          await tx.run("DELETE FROM _deployments");
          await tx.run("DELETE FROM _meta WHERE key = 'deployment'");
        });
      await reset(await instance());
      const a = await instance(undefined, { loadCode: importBundle });
      const b = await instance(undefined, { loadCode: importBundle });

      const dir = mkdtempSync(join(tmpdir(), "onebase-multi-deploy-"));
      mkdirSync(join(dir, "onebase"));
      writeFileSync(
        join(dir, "onebase", "schema.ts"),
        `import { defineSchema, defineTable } from "onebase/server";\nimport { v } from "onebase/values";\n` +
          `export default defineSchema({ counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]), ticks: defineTable({ instance: v.string() }) });`,
      );
      writeFileSync(join(dir, "onebase", "hello.ts"), `import { query } from "onebase/server";\nexport const where = query({ args: {}, handler: () => "deployed" });`);
      const { code } = await bundleProject(join(dir, "onebase"));
      rmSync(dir, { recursive: true, force: true });

      const r = await a.deploy({ code });
      const deadline = Date.now() + 3000;
      while (b.deployment?.id !== r.id && Date.now() < deadline) await Bun.sleep(25);
      expect(b.deployment?.id).toBe(r.id);
      expect((await b.runQuery("hello:where", {})).value).toBe("deployed");
      expect(b.functions.has("counters:get")).toBe(false);
      await reset(a);
    });

    test("a write on one instance updates live queries on another", async () => {
      const a = await instance();
      const b = await instance();
      await a.driver.write(async (tx) => {
        await tx.run("DELETE FROM documents");
        await tx.run("DELETE FROM _crons");
      });
      const seen: unknown[] = [];
      new SubscriptionManager(b).subscribe("counters:get", { name: "x" }, null, (u) => seen.push(u.ok ? u.value : u));
      await Bun.sleep(100);
      expect(seen).toEqual([0]);

      await a.runMutation("counters:increment", { name: "x" });
      await a.runMutation("counters:increment", { name: "x" });
      const deadline = Date.now() + 3000;
      while (seen.at(-1) !== 2 && Date.now() < deadline) await Bun.sleep(25);
      expect(seen.at(-1)).toBe(2);
    });

    test("concurrent increments from two instances don't lose updates", async () => {
      const a = await instance();
      const b = await instance();
      await a.driver.write((tx) => tx.run("DELETE FROM documents"));
      await Promise.all([
        ...Array.from({ length: 10 }, () => a.runMutation("counters:increment", { name: "race" })),
        ...Array.from({ length: 10 }, () => b.runMutation("counters:increment", { name: "race" })),
      ]);
      expect((await a.runQuery("counters:get", { name: "race" })).value).toBe(20);
    });

    test("a cron runs once per period even with two instances", async () => {
      const cronsA = cronJobs();
      cronsA.interval("tick", { seconds: 1 }, "ticks:record", { instance: "a" });
      const cronsB = cronJobs();
      cronsB.interval("tick", { seconds: 1 }, "ticks:record", { instance: "a" }); // same spec, as when deploying twice
      const setup = await instance();
      await setup.driver.write(async (tx) => {
        await tx.run("DELETE FROM documents");
        await tx.run("DELETE FROM _crons");
      });
      const a = await instance(cronsA);
      const b = await instance(cronsB);
      await Promise.all([a.startScheduler(), b.startScheduler()]);
      await Bun.sleep(2600);
      const ticks = (await a.runQuery("ticks:count", {})).value as number;
      expect(ticks).toBeGreaterThanOrEqual(2);
      expect(ticks).toBeLessThanOrEqual(3);
    });

    test("a sign-out on one instance reaches connections on the others", async () => {
      const authed = async () => {
        const driver = createDriver(url);
        const runtime = new Runtime({ driver, schema: defineSchema({ ...authTables }), modules: {}, log: quiet, auth: { methods: [password()] } });
        await runtime.init();
        open.push({ runtime, driver });
        return runtime;
      };
      const a = await authed();
      const b = await authed();
      const revoked: string[] = [];
      b.onSessionsRevoked((ids) => revoked.push(...ids));
      await a.authWrite(async ({ revoke }) => revoke(["session-1"]));
      for (let i = 0; i < 20 && !revoked.length; i++) await Bun.sleep(50);
      expect(revoked).toEqual(["session-1"]);

      // Hundreds of sessions at once (sign out everywhere, a reset) don't fit in one NOTIFY payload.
      revoked.length = 0;
      const many = Array.from({ length: 350 }, (_, i) => `session-${i}`.padEnd(20, "x"));
      await a.authWrite(async ({ revoke }) => revoke(many));
      for (let i = 0; i < 20 && revoked.length < many.length; i++) await Bun.sleep(50);
      expect(revoked.sort()).toEqual([...many].sort());
    });
  });
}
