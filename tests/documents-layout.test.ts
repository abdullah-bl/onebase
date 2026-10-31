// The documents table: new databases get a rowid table, and `onebase vacuum` moves older ones to it.

import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDatabase, type Finding } from "../src/doctor";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-layout-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const schema = defineSchema({
  posts: defineTable({ author: v.string(), body: v.string() }).index("by_author", ["author"]).searchIndex("search_body", { searchField: "body" }),
  other: defineTable({ n: v.number() }),
});
const modules = {
  posts: {
    add: mutation({ args: { author: v.string(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("posts", a) }),
    addOther: mutation({ args: { n: v.number() }, handler: (ctx, a) => ctx.db.insert("other", a) }),
    all: query({ args: {}, handler: (ctx) => ctx.db.query("posts").collect() }),
    byAuthor: query({
      args: { author: v.string() },
      handler: async (ctx, { author }) => (await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author)).collect()).map((p) => p.body),
    }),
    newest: query({ args: {}, handler: async (ctx) => (await ctx.db.query("posts").order("desc").first())?.body ?? null }),
    find: query({
      args: { text: v.string() },
      handler: async (ctx, { text }) => (await ctx.db.query("posts").withSearchIndex("search_body", (q) => q.search("body", text)).collect()).map((p) => p.body),
    }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
  },
};

/** A database file with documents laid out as older versions made them. */
function oldFile(name: string) {
  const path = join(root, name);
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("CREATE TABLE documents (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, ct REAL NOT NULL, doc TEXT NOT NULL) WITHOUT ROWID");
  db.close();
  return path;
}

async function open(path: string) {
  const driver = new SqliteDriver(path);
  const runtime = new Runtime({ driver, log: quiet, schema, modules });
  await runtime.init();
  return { driver, runtime };
}

const value = async (runtime: Runtime, name: string, args = {}) => (await runtime.runQuery(name, args)).value as any;
const documentsSql = (driver: SqliteDriver) => (driver.writer.query("SELECT sql FROM sqlite_master WHERE name = 'documents'").get() as { sql: string }).sql;

test("a new database gets a rowid table", async () => {
  const { driver, runtime } = await open(join(root, "new.sqlite"));
  expect(documentsSql(driver)).not.toMatch(/WITHOUT ROWID/i);
  expect(driver.oldDocumentsLayout).toBe(false);
  const id = await runtime.runMutation("posts:add", { author: "a", body: "hello" });
  expect(await value(runtime, "posts:byAuthor", { author: "a" })).toEqual(["hello"]);
  await runtime.runMutation("posts:remove", { id });
  expect(await value(runtime, "posts:all")).toEqual([]);
  runtime.stop();
  await driver.close();
});

test("an older database keeps working as it is until it's vacuumed", async () => {
  const { driver, runtime } = await open(oldFile("old-unvacuumed.sqlite"));
  expect(driver.oldDocumentsLayout).toBe(true);
  await runtime.runMutation("posts:add", { author: "a", body: "hello" });
  expect(await value(runtime, "posts:byAuthor", { author: "a" })).toEqual(["hello"]);
  runtime.stop();
  await driver.close();
});

test("vacuum moves an older database to a rowid table with everything intact", async () => {
  const path = oldFile("old.sqlite");
  const first = await open(path);
  for (let i = 0; i < 500; i++) {
    await first.runtime.runMutation("posts:add", { author: `author-${i % 5}`, body: `word${i} ${"x".repeat(i % 2 ? 1200 : 50)}` });
    await first.runtime.runMutation("posts:addOther", { n: i });
  }
  const before = {
    all: await value(first.runtime, "posts:all"),
    byAuthor: await value(first.runtime, "posts:byAuthor", { author: "author-3" }),
    newest: await value(first.runtime, "posts:newest"),
    found: await value(first.runtime, "posts:find", { text: "word7" }),
  };
  const indexes = () => (first.driver.writer.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const indexesBefore = indexes();
  expect(indexesBefore.length).toBeGreaterThanOrEqual(2);
  expect(before.all.length).toBe(500);

  await first.driver.vacuum();

  expect(first.driver.oldDocumentsLayout).toBe(false);
  expect(indexes()).toEqual(indexesBefore);
  expect((first.driver.writer.query("PRAGMA integrity_check").get() as any).integrity_check).toBe("ok");
  first.runtime.stop();
  await first.driver.close();

  // Reopened, as a server would after `onebase vacuum`.
  const second = await open(path);
  expect(second.driver.oldDocumentsLayout).toBe(false);
  expect(await value(second.runtime, "posts:all")).toEqual(before.all);
  expect(await value(second.runtime, "posts:byAuthor", { author: "author-3" })).toEqual(before.byAuthor);
  expect(await value(second.runtime, "posts:newest")).toEqual(before.newest);
  expect(await value(second.runtime, "posts:find", { text: "word7" })).toEqual(before.found);

  // Writes, indexes and search all keep going on the new table.
  const id = (await second.runtime.runMutation("posts:add", { author: "author-3", body: "afterwards" })) as string;
  expect((await value(second.runtime, "posts:byAuthor", { author: "author-3" })).at(-1)).toBe("afterwards");
  expect(await value(second.runtime, "posts:find", { text: "afterwards" })).toEqual(["afterwards"]);
  await second.runtime.runMutation("posts:remove", { id });
  expect(await value(second.runtime, "posts:find", { text: "afterwards" })).toEqual([]);
  second.runtime.stop();
  await second.driver.close();
});

test("vacuuming a second time changes nothing", async () => {
  const path = oldFile("twice.sqlite");
  const { driver, runtime } = await open(path);
  await runtime.runMutation("posts:add", { author: "a", body: "kept" });
  await driver.vacuum();
  const sql = documentsSql(driver);
  await driver.vacuum();
  expect(documentsSql(driver)).toBe(sql);
  expect(await value(runtime, "posts:byAuthor", { author: "a" })).toEqual(["kept"]);
  runtime.stop();
  await driver.close();
});

test("a failed move leaves the old table in place", async () => {
  const { driver, runtime } = await open(oldFile("fails.sqlite"));
  await runtime.runMutation("posts:add", { author: "a", body: "safe" });
  // A leftover table with the rebuild's name makes the move fail partway.
  driver.writer.run("CREATE TABLE _documents_rebuild (x)");
  await expect(driver.vacuum()).rejects.toThrow();
  expect(driver.oldDocumentsLayout).toBe(true);
  expect(await value(runtime, "posts:byAuthor", { author: "a" })).toEqual(["safe"]);
  runtime.stop();
  await driver.close();
});

test("doctor suggests vacuum for the older layout, and stops once it's done", async () => {
  const path = oldFile("doctor.sqlite");
  const { driver, runtime } = await open(path);
  const findings = () => {
    const found: Finding[] = [];
    checkDatabase(path, found);
    return found.filter((f) => f.message.includes("layout"));
  };
  expect(findings().length).toBe(1);
  expect(findings()[0]!.fix).toContain("onebase vacuum");
  await driver.vacuum();
  expect(findings()).toEqual([]);
  runtime.stop();
  await driver.close();
});

test("a query plan still uses the indexes on a rowid table", async () => {
  const { driver, runtime } = await open(join(root, "plan.sqlite"));
  await runtime.runMutation("posts:add", { author: "a", body: "x" });
  const plan = (sql: string) => (driver.writer.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]).map((r) => r.detail).join("; ");
  expect(plan("SELECT doc FROM documents WHERE tbl = 'posts' ORDER BY ct, id")).toContain("documents_by_creation_time");
  expect(plan("SELECT doc FROM documents WHERE id = 'x'")).toMatch(/USING (INDEX|PRIMARY KEY)/);
  runtime.stop();
  await driver.close();
});
