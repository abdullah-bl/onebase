import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { presence } from "../src/components/presence";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const components = defineComponents({ here: presence({ heartbeatInterval: 10_000, heartbeatTimer: 500 }) });

const schema = defineSchema({ unused: defineTable({ n: v.number() }) });

const modules = {
  admin: {
    heartbeat: mutation({
      args: { room: v.string(), user: v.string(), sessionId: v.string(), interval: v.optional(v.number()) },
      handler: (ctx: any, args) => ctx.components.here.heartbeat(args),
    }),
    disconnect: mutation({ args: { sessionId: v.string() }, handler: (ctx: any, { sessionId }) => ctx.components.here.disconnect({ sessionId }) }),
    list: query({ args: { room: v.string() }, handler: (ctx: any, { room }) => ctx.components.here.list({ room }) }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: presence`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-presence-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.startScheduler();
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const list = async (room: string) => (await runtime.runQuery("admin:list", { room })).value as any[];
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("a heartbeat shows the session online, and disconnect marks it offline", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    expect(await list("lobby")).toEqual([expect.objectContaining({ user: "ada", sessionId: "s1", online: true })]);
    expect(await runtime.runMutation("admin:disconnect", { sessionId: "s1" })).toBe(true);
    expect((await list("lobby"))[0]!.online).toBe(false);
    expect(await runtime.runMutation("admin:disconnect", { sessionId: "s1" })).toBe(false);
  });

  test("rooms are independent", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "a", user: "ada", sessionId: "s1" });
    await runtime.runMutation("admin:heartbeat", { room: "b", user: "bob", sessionId: "s2" });
    expect((await list("a")).map((e) => e.user)).toEqual(["ada"]);
    expect((await list("b")).map((e) => e.user)).toEqual(["bob"]);
  });

  test("the scheduled check marks a quiet session offline", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    // 20s of silence: past the 10s window (plus 500ms grace).
    await runtime.adminWrite(async (db) => {
      const row = await db.query("here.presence").withIndex("by_session", (q: any) => q.eq("sessionId", "s1")).unique();
      await db.patch(row!._id, { lastActive: Date.now() - 20_000 });
    });
    await runtime.runMutation("components/here:checkSession", { sessionId: "s1", interval: 10_000 }, { allowInternal: true, source: "dashboard" });
    expect((await list("lobby"))[0]!.online).toBe(false);
  });

  test("a fresh session survives its check and goes offline once heartbeats stop", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1", interval: 1000 });
    // The check is scheduled at ~1.5s; 500ms in, the session is still fresh.
    await Bun.sleep(500);
    expect((await list("lobby"))[0]!.online).toBe(true);
    // No further heartbeats: the chained checks take it offline (10s window + grace + scheduling slack).
    await until(async () => (await list("lobby"))[0]!.online === false, 15_000);
  });

  test("reconnecting flips a session back online", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    await runtime.runMutation("admin:disconnect", { sessionId: "s1" });
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    expect((await list("lobby"))[0]!.online).toBe(true);
  });
});
