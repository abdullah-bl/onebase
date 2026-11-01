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
    const [entry] = await list("lobby");
    expect(entry).toMatchObject({ user: "ada", online: true });
    expect(entry.id).toEqual(expect.any(String));
    expect(entry).not.toHaveProperty("sessionId");
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
    let at = 0;
    await runtime.adminWrite(async (db) => {
      const row = await db.query("here.presence").withIndex("by_session", (q: any) => q.eq("sessionId", "s1")).unique();
      at = row!.checkAt as number;
      await db.patch(row!._id, { lastActive: Date.now() - 20_000 });
    });
    // A check that isn't the live one leaves the session alone.
    await runtime.runMutation("components/here:checkSession", { sessionId: "s1", at: at - 1 }, { allowInternal: true, source: "dashboard" });
    expect((await list("lobby"))[0]!.online).toBe(true);
    await runtime.runMutation("components/here:checkSession", { sessionId: "s1", at }, { allowInternal: true, source: "dashboard" });
    expect((await list("lobby"))[0]!.online).toBe(false);
  });

  test("a session keeps one check however many heartbeats it sends", async () => {
    const pendingJobs = async () => (await runtime.adminRead((_db, tx) => tx.all("SELECT id FROM _scheduled WHERE state = 'pending'"))).length;
    // Past the 1.5s window, so checks fire and re-arm while the heartbeats keep coming.
    for (const end = Date.now() + 4_000; Date.now() < end; await Bun.sleep(100)) {
      await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1", interval: 1000 });
    }
    expect((await list("lobby"))[0]!.online).toBe(true);
    expect(await pendingJobs()).toBe(1);
    // It still goes offline once they stop.
    await until(async () => (await list("lobby"))[0]!.online === false);
    expect(await pendingJobs()).toBe(0);
  }, 15_000);

  test("a fresh session survives its check and goes offline once heartbeats stop", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1", interval: 1000 });
    // The check is scheduled at ~1.5s; 500ms in, the session is still fresh.
    await Bun.sleep(500);
    expect((await list("lobby"))[0]!.online).toBe(true);
    // No further heartbeats: the chained checks take it offline (10s window + grace + scheduling slack).
    await until(async () => (await list("lobby"))[0]!.online === false, 15_000);
  });

  test("a client can't ask for an interval past the limit", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1", interval: 1e12 });
    let interval = 0;
    await runtime.adminWrite(async (db) => {
      const row = await db.query("here.presence").withIndex("by_session", (q: any) => q.eq("sessionId", "s1")).unique();
      interval = row!.interval as number;
    });
    expect(interval).toBe(5 * 60_000);
  });

  test("sessions offline past the retention window are forgotten", async () => {
    for (const sessionId of ["old", "recent", "live"]) await runtime.runMutation("admin:heartbeat", { room: "lobby", user: sessionId, sessionId });
    await runtime.runMutation("admin:disconnect", { sessionId: "old" });
    await runtime.runMutation("admin:disconnect", { sessionId: "recent" });
    await runtime.adminWrite(async (db) => {
      const row = await db.query("here.presence").withIndex("by_session", (q: any) => q.eq("sessionId", "old")).unique();
      await db.patch(row!._id, { disconnectedAt: Date.now() - 2 * 3_600_000 });
    });
    await runtime.runMutation("components/here:prune", {}, { allowInternal: true, source: "dashboard" });
    expect((await list("lobby")).map((e) => e.user).sort()).toEqual(["live", "recent"]);
  });

  test("reconnecting flips a session back online", async () => {
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    await runtime.runMutation("admin:disconnect", { sessionId: "s1" });
    await runtime.runMutation("admin:heartbeat", { room: "lobby", user: "ada", sessionId: "s1" });
    expect((await list("lobby"))[0]!.online).toBe(true);
  });
});
