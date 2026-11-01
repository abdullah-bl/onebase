import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { CallLog } from "../src/engine/calllog";
import { SubscriptionManager } from "../src/engine/sync";
import { cronJobs, defineSchema, defineTable, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({
  notes: defineTable({ text: v.string(), done: v.boolean() }),
});

let flakyWorks = false;

const modules = {
  notes: {
    list: query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect() }),
    add: mutation({
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        console.log("adding", text);
        return ctx.db.insert("notes", { text, done: false });
      },
    }),
    whoami: query({ args: {}, handler: async (ctx) => (await ctx.auth.getUserIdentity())?.subject ?? null }),
    secret: internalMutation({ args: {}, handler: async () => "internal ok" }),
    later: mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(60_000, "notes:secret", {}) }),
    flaky: internalMutation({
      args: {},
      handler: async () => {
        if (!flakyWorks) throw new Error("flaky failed");
        return "fine";
      },
    }),
    flakyLater: mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(0, "notes:flaky", {}) }),
  },
};

describe("dashboard admin API", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  const KEY = "test-admin-key";

  const admin = async (name: string, body: unknown = {}, key = KEY) => {
    const res = await fetch(`${base}/_admin/api/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const ok = async (name: string, body: unknown = {}) => {
    const { body: r } = await admin(name, body);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  beforeAll(async () => {
    process.env.ONEBASE_ADMIN_KEY = KEY;
    dataDir = mkdtempSync(join(tmpdir(), "onebase-admin-"));
    const crons = cronJobs();
    crons.daily("nightly", { hourUTC: 2, minuteUTC: 0 }, "notes:secret");
    app = await startApp({ schema, modules, crons, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
    base = `http://127.0.0.1:${app.server.port}`;
  });

  afterAll(async () => {
    delete process.env.ONEBASE_ADMIN_KEY;
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("serves the app and rejects requests without the key", async () => {
    const page = await fetch(`${base}/_admin`);
    expect(await page.text()).toContain("/_admin/app.js");
    expect((await fetch(`${base}/_admin/app.js`)).headers.get("content-type")).toContain("javascript");
    expect((await admin("overview", {}, "wrong")).status).toBe(401);
    expect((await admin("overview", {}, "")).status).toBe(401);
  });

  test("browses and edits documents, with schema validation", async () => {
    const id = await app.runtime.runMutation("notes:add", { text: "first" });
    const overview = await ok("overview");
    expect(overview.tables).toEqual([{ name: "notes", count: 1, inSchema: true }]);

    const page = await ok("documents", { table: "notes", numItems: 10 });
    expect(page.page[0]).toMatchObject({ _id: id, text: "first", done: false });

    const newId = await ok("insert", { table: "notes", doc: { text: "from the dashboard", done: true } });
    expect((await ok("documents", { table: "notes", filter: { done: true } })).page.map((d: any) => d._id)).toEqual([newId]);

    const bad = await admin("replace", { id: newId, doc: { text: 42, done: true } });
    expect(bad.body.error).toContain("document.text must be v.string()");

    await ok("patch", { id: newId, fields: { text: "edited" } });
    expect((await ok("documents", { table: "notes", id: newId })).page[0].text).toBe("edited");

    await ok("delete", { ids: [newId] });
    expect((await ok("documents", { table: "notes", id: newId })).page).toEqual([]);
  });

  test("dashboard edits update live queries", async () => {
    const subs = new SubscriptionManager(app.runtime);
    const seen: number[] = [];
    subs.subscribe("notes:list", {}, null, (u) => u.ok && seen.push((u.value as unknown[]).length));
    await Bun.sleep(50);
    const before = seen.at(-1)!;
    await ok("insert", { table: "notes", doc: { text: "live", done: false } });
    await Bun.sleep(50);
    expect(seen.at(-1)).toBe(before + 1);
  });

  test("runs any function, including internal ones and as a user", async () => {
    const fns = await ok("functions");
    expect(fns.find((f: any) => f.name === "notes:add")).toMatchObject({ type: "mutation", visibility: "public", args: { kind: "object" } });
    expect(await ok("run", { name: "notes:secret", args: {} })).toMatchObject({ ok: true, value: "internal ok" });
    expect(await ok("run", { name: "notes:whoami", args: {}, identity: { subject: "user_7" } })).toMatchObject({ value: "user_7" });
    const failed = await ok("run", { name: "notes:add", args: { text: 5 } });
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("args.text must be v.string()");
  });

  test("logs calls with their source and console output", async () => {
    await app.runtime.runMutation("notes:add", { text: "logged" }, { source: "client" });
    const calls = await ok("calls", { limit: 50 });
    const call = calls.filter((c: any) => c.name === "notes:add" && c.source === "client").at(-1);
    expect(call).toMatchObject({ type: "mutation", ok: true });
    expect(call.lines).toEqual([{ level: "log", text: "adding logged" }]);
  });

  test("streams calls and commits as server-sent events", async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/_admin/api/events`, { headers: { Authorization: `Bearer ${KEY}` }, signal: controller.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    const read = (async () => {
      while (!text.includes("event: commit")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += value;
      }
    })();
    await Bun.sleep(50);
    await app.runtime.runMutation("notes:add", { text: "streamed" });
    await Promise.race([read, Bun.sleep(2000)]);
    controller.abort();
    expect(text).toContain("event: stats");
    expect(text).toContain("event: call");
    expect(text).toContain('event: commit\ndata: {"tables":["notes"]}');
  });

  test("scheduler jobs and crons", async () => {
    await app.runtime.runMutation("notes:later", {});
    const [job] = await ok("jobs", { state: "pending" });
    expect(job).toMatchObject({ fn: "notes:secret", state: "pending" });
    await ok("cancelJob", { id: job.id });
    expect(await ok("jobs", { state: "canceled" })).toHaveLength(1);
    const [cron] = await ok("crons");
    expect(cron).toMatchObject({ name: "nightly", fn: "notes:secret", schedule: "0 2 * * *" });
    expect(cron.nextRun).toBeGreaterThan(Date.now());
  });

  test("reports failed jobs and retries them", async () => {
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await check()); i++) await Bun.sleep(10);
    };
    const failedCount = async () => (await ok("scheduler")).jobs.failed ?? 0;

    await app.runtime.runMutation("notes:flakyLater", {});
    await app.runtime.runMutation("notes:flakyLater", {});
    await until(async () => (await failedCount()) === 2);
    const summary = await ok("scheduler");
    expect(summary.jobs.failed).toBe(2);
    expect(summary.lastFailed).toMatchObject({ fn: "notes:flaky", error: "flaky failed" });
    expect(summary.crons[0]).toMatchObject({ name: "nightly" });

    const [first, second] = await ok("jobs", { state: "failed" });
    expect(await ok("retryJob", { id: first.id })).toEqual({ retried: 1 });
    await until(async () => (await failedCount()) === 2 && !(await ok("jobs", { state: "pending" })).some((j: any) => j.id === first.id));
    expect(await ok("retryJob", { id: "not-a-job" })).toEqual({ retried: 0 });

    flakyWorks = true;
    expect(await ok("retryFailedJobs")).toEqual({ retried: 2 });
    await until(async () => (await ok("jobs", { state: "done" })).length >= 2);
    expect((await ok("jobs", { state: "done" })).map((j: any) => j.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(await failedCount()).toBe(0);
  });

  test("reports traffic and per-function latency", async () => {
    await app.runtime.runMutation("notes:add", { text: "measured" }, { source: "client" });
    await ok("run", { name: "notes:add", args: { text: 5 } });
    const metrics = await ok("metrics");
    expect(metrics.seconds).toHaveLength(60);
    expect(metrics.minutes).toHaveLength(60);
    expect(metrics.ranges["1m"].calls).toBeGreaterThanOrEqual(2);
    const add = metrics.functions.find((f: any) => f.name === "notes:add");
    expect(add).toMatchObject({ type: "mutation" });
    expect(add.errors).toBeGreaterThanOrEqual(1);
    expect(add.lastError).toContain("args.text must be v.string()");
    expect(add.p95).toBeGreaterThan(0);
  });

  test("uploads a file with a token from the dashboard", async () => {
    const token = await ok("uploadToken");
    const res = await fetch(`${base}/api/storage/upload?token=${token}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "from the dashboard" });
    const { storageId } = (await res.json()) as { storageId: string };
    expect((await ok("files")).map((f: any) => f.id)).toContain(storageId);
    await ok("deleteFile", { id: storageId });
    expect((await fetch(`${base}/api/storage/upload?token=${token}`, { method: "POST", body: "again" })).ok).toBe(false);
  });

  test("lists and deletes files", async () => {
    const id = await app.runtime.actionCtx(null).storage.store(new Blob(["hello"], { type: "text/plain" }));
    const files = await ok("files");
    expect(files[0]).toMatchObject({ id, size: 5 });
    expect(files[0].contentType).toStartWith("text/plain");
    await ok("deleteFile", { id });
    expect(await ok("files")).toEqual([]);
    expect((await fetch(`${base}/api/storage/${id}`)).status).toBe(404);
  });
});

test("the dashboard can be turned off", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "onebase-admin-off-"));
  const app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, dashboard: false });
  try {
    expect((await fetch(`http://127.0.0.1:${app.server.port}/_admin`)).status).toBe(404);
  } finally {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe("call metrics", () => {
  const run = (log: CallLog, name: string, ms = 0, fail = false) =>
    log
      .track(name, "query", "client", async () => {
        if (ms) await Bun.sleep(ms);
        if (fail) throw new Error("no");
      })
      .catch(() => {});

  test("adds up calls and errors per function", async () => {
    const log = new CallLog();
    await run(log, "a:one");
    await run(log, "a:one", 0, true);
    await run(log, "a:two");
    const m = log.metrics();
    expect(m.ranges["15m"]).toMatchObject({ calls: 3, errors: 1 });
    expect(m.functions.find((f) => f.name === "a:one")).toMatchObject({ calls: 2, errors: 1, lastError: "no" });
    expect(m.seconds.reduce((sum, p) => sum + p.ok + p.err, 0)).toBe(3);
  });

  test("cached answers count as calls but not as latency", () => {
    const log = new CallLog();
    log.record("a:cached", "query", "client");
    const [f] = log.metrics().functions;
    expect(f).toMatchObject({ calls: 1, cached: 1, p50: null, p95: null });
    expect(log.metrics().minutes.at(-1)).toMatchObject({ ok: 1, p95: null });
  });

  test("percentiles land near the real duration", async () => {
    const log = new CallLog();
    await run(log, "a:slow", 40);
    const [f] = log.metrics().functions;
    expect(f!.p95!).toBeGreaterThanOrEqual(30);
    expect(f!.p95!).toBeLessThan(100);
  });

  test("forgets what's older than the window", async () => {
    const log = new CallLog();
    await run(log, "a:one", 0, true);
    const later = log.metrics(Date.now() + 2 * 3_600_000);
    expect(later.functions).toEqual([]);
    expect(later.ranges["1h"].calls).toBe(0);
    expect(later.minutes.every((p) => p.ok + p.err === 0)).toBe(true);
  });

  test("keeps a bounded number of names, however many paths clients invent", async () => {
    const log = new CallLog();
    for (let i = 0; i < 600; i++) log.record(`GET /x/${i}`, "http", "http");
    const names = log.metrics().functions;
    expect(names).toHaveLength(501);
    expect(names.find((f) => f.name === "(other)")).toMatchObject({ calls: 100 });
    expect(log.metrics().ranges["1h"].calls).toBe(600);
  });
});

describe("recent calls", () => {
  const filled = (max: number, calls: number) => {
    const log = new CallLog(max);
    for (let i = 1; i <= calls; i++) log.record(`c${i}`, "query", "client");
    return log;
  };
  const names = (log: CallLog, limit?: number) => log.recent(limit).map((c) => c.name);

  test("returns everything oldest first until the log is full", () => {
    expect(names(filled(5, 0))).toEqual([]);
    expect(names(filled(5, 3))).toEqual(["c1", "c2", "c3"]);
    expect(names(filled(5, 3), 2)).toEqual(["c2", "c3"]);
    expect(names(filled(5, 3), 4)).toEqual(["c1", "c2", "c3"]);
    expect(names(filled(5, 5))).toEqual(["c1", "c2", "c3", "c4", "c5"]);
  });

  test("keeps the newest records in order after wrapping around", () => {
    // After 7 calls in 5 slots the newest two sit at the start of the array.
    const log = filled(5, 7);
    expect(names(log)).toEqual(["c3", "c4", "c5", "c6", "c7"]);
    expect(names(log, 2)).toEqual(["c6", "c7"]); // Stops before the seam.
    expect(names(log, 3)).toEqual(["c5", "c6", "c7"]); // Crosses it.
    expect(names(log, 9)).toEqual(["c3", "c4", "c5", "c6", "c7"]);
  });

  test("agrees with slicing a plain array at every position", () => {
    for (let calls = 0; calls <= 12; calls++) {
      const all = Array.from({ length: calls }, (_, i) => `c${i + 1}`);
      const log = filled(5, calls);
      for (let limit = 1; limit <= 7; limit++) expect(names(log, limit)).toEqual(all.slice(-5).slice(-limit));
    }
  });

  test("handles limits that aren't positive whole numbers", () => {
    const log = filled(5, 7);
    expect(names(log, 0)).toEqual([]);
    expect(names(log, -2)).toEqual([]);
    expect(names(log, 2.5)).toEqual(["c6", "c7"]);
    expect(names(log, Infinity)).toEqual(["c3", "c4", "c5", "c6", "c7"]);
  });

  test("a log that keeps nothing still counts and notifies", () => {
    const log = new CallLog(0);
    const heard: string[] = [];
    log.listen((c) => heard.push(c.name));
    log.record("c1", "query", "client");
    expect(log.recent()).toEqual([]);
    expect(log.totals.calls).toBe(1);
    expect(heard).toEqual(["c1"]);
  });

  test("evicting old records leaves totals, listeners and metrics counting every call", () => {
    const log = new CallLog(2);
    const heard: number[] = [];
    log.listen((c) => heard.push(c.id));
    for (let i = 0; i < 5; i++) log.record("a:one", "query", "client");
    expect(log.recent().map((c) => c.id)).toEqual([4, 5]);
    expect(heard).toEqual([1, 2, 3, 4, 5]);
    expect(log.totals.calls).toBe(5);
    expect(log.metrics().ranges["1h"].calls).toBe(5);
  });
});
