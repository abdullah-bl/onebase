// A deploy that changes the schema checks every document. That check must not hold the server
// up while it runs, and must still catch a document written while it was running.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { deploy } from "../src/deploy";
import { quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-deploy-check-"));
let app: Awaited<ReturnType<typeof startApp>>;
let url: string;
let key: string;

const SCHEMA = (text: string, extra = "") => `
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";
export default defineSchema({ notes: defineTable({ text: ${text}, n: v.number() })${extra} });
`;
const NOTES = `
import { mutation, query } from "onebase/server";
import { v } from "onebase/values";
export const addMany = mutation({
  args: { from: v.number(), count: v.number() },
  handler: async (ctx, { from, count }) => {
    for (let i = from; i < from + count; i++) await ctx.db.insert("notes", { text: "note " + i, n: i });
  },
});
export const first = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").first())?._id ?? null });
export const setText = mutation({ args: { id: v.id("notes"), text: v.any() }, handler: (ctx, { id, text }) => ctx.db.patch(id, { text }) });
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).length });
`;

function project(name: string, schema: string): string {
  const dir = join(root, name, "onebase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "schema.ts"), schema);
  writeFileSync(join(dir, "notes.ts"), NOTES);
  return dir;
}
const loose = project("loose", SCHEMA("v.union(v.string(), v.number())"));
const strict = project("strict", SCHEMA("v.string()"));
const wider = project("wider", SCHEMA("v.union(v.string(), v.number(), v.null())"));
const push = (dir: string, extra: Partial<Parameters<typeof deploy>[0]> = {}) => deploy({ dir, url, key, public: null, log: () => {}, ...extra });

const DOCS = 10_000;

beforeAll(async () => {
  const dataDir = join(root, "data");
  app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  Object.assign(app.runtime, { log: quiet });
  url = `http://127.0.0.1:${app.server.port}`;
  key = readFileSync(join(dataDir, "admin.key"), "utf8").trim();
  await push(loose);
  for (let from = 0; from < DOCS; from += 2000) await app.runtime.runMutation("notes:addMany", { from, count: 2000 }, { settle: "none" });
}, 60_000);

afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

/**
 * Runs `work` and reports how the document check was done: how many separate short reads the
 * database got (the check reads 500 documents at a time), and whether any of those reads happened
 * while a write transaction was open.
 */
async function watching<T>(work: () => Promise<T>) {
  const driver = app.driver as any;
  const { read, write } = driver;
  let reads = 0;
  let scansInsideAWrite = 0;
  driver.read = (fn: any) => (reads++, read.call(driver, fn));
  driver.write = (fn: any) =>
    write.call(driver, (tx: any) => {
      const all = tx.all.bind(tx);
      const counted = { ...tx, all: (sql: string, params: unknown[]) => (sql.includes("FROM documents WHERE tbl = ?") && sql.includes("LIMIT 500") && scansInsideAWrite++, all(sql, params)) };
      return fn(counted);
    });
  try {
    return { result: await work(), reads: () => reads, scansInsideAWrite: () => scansInsideAWrite };
  } finally {
    driver.read = read;
    driver.write = write;
  }
}

test("a deploy checks 10,000 documents in short reads, outside its write transaction", async () => {
  const run = await watching(() => push(wider));
  expect(run.result).toMatchObject({ dryRun: false });
  // 20 batches of 500, each its own read, with the event loop coming round in between. Checked
  // inside the deploy's transaction, as it used to be, every write waits for the whole scan.
  expect(run.reads()).toBeGreaterThanOrEqual(20);
  expect(run.scansInsideAWrite()).toBe(0);
  expect((await app.runtime.runQuery("notes:count", {})).value).toBe(DOCS);
}, 60_000);

test("a dry run checks the same way and changes nothing", async () => {
  const run = await watching(() => push(strict, { dryRun: true }));
  expect(run.result).toMatchObject({ dryRun: true });
  expect(run.reads()).toBeGreaterThanOrEqual(20);
  // Still the wider schema: a number is accepted.
  const id = (await app.runtime.runQuery("notes:first", {})).value;
  await app.runtime.runMutation("notes:setText", { id, text: 7 });
  await expect(push(strict, { dryRun: true })).rejects.toThrow("doesn't match 1 existing document");
  await app.runtime.runMutation("notes:setText", { id, text: "note 0" });
}, 60_000);

test("a document that stops matching while the check runs still stops the deploy", async () => {
  const id = (await app.runtime.runQuery("notes:first", {})).value as string;
  const runtime = app.runtime as any;
  // Once the check is under way (and past the first batch, which holds this document), make it a
  // number: fine by the schema that is live, not by the one being deployed.
  let wrote: Promise<unknown> | null = null;
  const watch = setInterval(() => {
    if (!runtime.precheck || wrote) return;
    wrote = app.runtime.runMutation("notes:setText", { id, text: 42 });
  }, 0);
  try {
    await expect(push(strict)).rejects.toThrow(`notes ${id}: document.text`);
  } finally {
    clearInterval(watch);
  }
  expect(wrote).not.toBeNull();
  await wrote;
  // The old code is still live, the write is there, and nothing is left watching writes.
  expect(runtime.precheck).toBeNull();
  expect((await app.runtime.runQuery("notes:count", {})).value).toBe(DOCS);
  await app.runtime.runMutation("notes:setText", { id, text: "note 0" });
  expect(await push(strict)).toMatchObject({ dryRun: false });
  await expect(app.runtime.runMutation("notes:setText", { id, text: 42 })).rejects.toThrow();
}, 60_000);
