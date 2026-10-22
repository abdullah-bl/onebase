import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { SubscriptionManager } from "../src/engine/sync";
import { cronJobs, defineSchema, defineTable, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({
  notes: defineTable({ text: v.string(), done: v.boolean() }),
});

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
