// What an operator points tools at: metrics for a scraper, logs for a collector, and a dashboard
// that can live on a host name of its own.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { jsonLogger } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({ notes: defineTable({ text: v.string() }) });
const modules = {
  notes: {
    add: mutation({ args: { text: v.string() }, handler: (ctx, a) => ctx.db.insert("notes", a) }),
    list: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) }),
  },
};

describe("operating a server", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;
  let key: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-ops-"));
    app = await startApp({ schema, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, adminHost: "admin.example.test" });
    base = `http://127.0.0.1:${app.server.port}`;
    key = (await Bun.file(join(dataDir, "admin.key")).text()).trim();
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A request as a proxy would pass it on for `host`. */
  const on = (host: string, path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...init.headers, Host: host } });

  test("with --admin-host, the dashboard and admin API exist only on that host", async () => {
    expect((await on("admin.example.test", "/_admin")).status).toBe(200);
    expect((await on("admin.example.test:8443", "/_admin")).status).toBe(200);
    const api = { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: "{}" };
    expect((await on("admin.example.test", "/_admin/api/overview", api)).status).toBe(200);

    // Anywhere else there is nothing there, even with the key.
    expect((await on("app.example.test", "/_admin")).status).toBe(404);
    expect((await on("app.example.test", "/_admin/api/overview", api)).status).toBe(404);
    expect((await fetch(`${base}/_admin`)).status).toBe(404);
    // The app itself is on every host.
    expect((await on("app.example.test", "/api/health")).status).toBe(200);
  });

  test("metrics need the admin key and count what happened", async () => {
    const scrape = (k: string) => on("admin.example.test", "/_admin/api/metrics", { headers: { Authorization: `Bearer ${k}` } });
    expect((await scrape("wrong")).status).toBe(401);

    await app.runtime.runMutation("notes:add", { text: "one" });
    await app.runtime.runQuery("notes:list", {});
    const res = await scrape(key);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/plain; version=0.0.4");
    const text = await res.text();
    const value = (name: string) => Number(new RegExp(`^onebase_${name} (\\S+)$`, "m").exec(text)?.[1]);
    expect(value("calls_total")).toBeGreaterThanOrEqual(2);
    expect(value("writes_total")).toBeGreaterThanOrEqual(1);
    expect(value("write_wait_seconds_total")).toBeGreaterThanOrEqual(0);
    expect(value("memory_rss_bytes")).toBeGreaterThan(1_000_000);
    expect(value("event_loop_lag_seconds")).toBeGreaterThanOrEqual(0);
    expect(text).toContain('onebase_scheduled_jobs{state="pending"} 0');
    // Every sample has its HELP and TYPE, once.
    for (const name of new Set([...text.matchAll(/^(onebase_\w+)/gm)].map((m) => m[1]!))) {
      expect(text.split(`# TYPE ${name} `).length).toBe(2);
    }
  });
});

test("JSON logs are one object per line", () => {
  const lines: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    jsonLogger.warn('disk is "nearly" full\nreally');
  } finally {
    process.stdout.write = write;
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]!.endsWith("\n")).toBe(true);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed).toMatchObject({ level: "warn", msg: 'disk is "nearly" full\nreally' });
  expect(new Date(parsed.time).getTime()).toBeGreaterThan(0);
});
