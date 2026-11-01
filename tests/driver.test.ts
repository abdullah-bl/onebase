// LibsqlDriver against a fake client, so the transaction limit and 429 retries are checked
// without a libsql-server (CI only runs SQLite).

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDatabase, type Finding } from "../src/doctor";
import { applySchema } from "../src/engine/database";
import { LibsqlDriver, MysqlDriver, SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";

/** Shaped like @libsql/client's error when the server answers HTTP 429. */
function tooManyRequests() {
  const cause = Object.assign(new Error("Server returned HTTP status 429"), { name: "HttpServerError", status: 429 });
  return Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 429", { cause }), { name: "LibsqlError", code: "SERVER_ERROR" });
}

/** The first statements fail with `failures`, one per transaction, as the real client reports a rejected BEGIN. */
function fakeDriver(failures: Error[] = []) {
  const stats = { open: 0, peak: 0, started: 0 };
  const driver = new LibsqlDriver("http://fake");
  (driver as any).client = {
    async transaction() {
      stats.started++;
      stats.peak = Math.max(stats.peak, ++stats.open);
      const failure = failures.shift();
      return {
        async execute() {
          await Bun.sleep(2);
          if (failure) throw failure;
          return { columns: ["x"], rows: [[1]], rowsAffected: 0 };
        },
        commit: async () => {},
        rollback: async () => {},
        close: () => void stats.open--,
      };
    },
  };
  return { driver, stats };
}

describe("libsql driver", () => {
  test("queues transactions instead of opening them all at once", async () => {
    const { driver, stats } = fakeDriver();
    const results = await Promise.all(Array.from({ length: 200 }, () => driver.read((tx) => tx.get("SELECT 1 AS x"))));
    expect(results.every((r) => r?.x === 1)).toBe(true);
    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(32);
    expect(stats.open).toBe(0);
  });

  test("retries HTTP 429, but not errors thrown by the function", async () => {
    const { driver, stats } = fakeDriver([tooManyRequests(), tooManyRequests()]);
    expect(await driver.read((tx) => tx.get("SELECT 1 AS x"))).toEqual({ x: 1 });
    expect(stats.started).toBe(3);

    const writes = fakeDriver([tooManyRequests()]);
    expect(await writes.driver.write((tx) => tx.run("UPDATE t SET x = 1"))).toEqual({ changes: 0 });
    expect(writes.stats.started).toBe(2);

    let calls = 0;
    const err = await driver
      .write(async () => {
        calls++;
        throw new Error("Too many requests (429)");
      })
      .catch((e) => e);
    expect(err.message).toBe("Too many requests (429)");
    expect(calls).toBe(1);
  });
});

describe("sqlite planner statistics", () => {
  const schema = defineSchema({ posts: defineTable({ score: v.number() }).index("by_score", ["score"]) });
  const rangeQuery = `SELECT id FROM documents WHERE tbl = 'posts' AND json_extract(doc, '$.score') > ? ORDER BY json_extract(doc, '$.score'), ct, id LIMIT 10`;

  /** 99% of documents share a hot band, like real data: the index is only worth using for the cold rest. */
  async function seed(driver: SqliteDriver, n: number) {
    await driver.write(async (tx) => {
      for (let i = 0; i < n; i++) {
        const score = i % 100 === 0 ? 5000 + (i % 1000) : i % 100;
        await tx.run("INSERT INTO documents (id, tbl, ct, doc) VALUES (?, 'posts', ?, ?)", [`id${i}`, i, JSON.stringify({ score, body: "x".repeat(500) })]);
      }
    });
  }

  const usesIndex = async (driver: SqliteDriver) =>
    (await driver.read((tx) => driver.explain(tx, rangeQuery, [5999]))).some((line) => line.includes("cl_posts__by_score"));

  test("a range query on an index uses it after a restart, not a scan and sort", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-planner-"));
    try {
      const first = new SqliteDriver(join(dir, "db.sqlite"));
      await first.write((tx) => applySchema(tx, first.dialect, schema));
      await seed(first, 5000);
      await first.close();

      const reopened = new SqliteDriver(join(dir, "db.sqlite"));
      expect(await usesIndex(reopened)).toBe(true);
      await reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a reader that was already open plans with the new statistics", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-planner-"));
    try {
      const driver = new SqliteDriver(join(dir, "db.sqlite"));
      await driver.write((tx) => applySchema(tx, driver.dialect, schema)); // the table is still empty
      expect(await usesIndex(driver)).toBe(false); // the reader has now loaded the schema, with no statistics
      await seed(driver, 5000);
      await driver.optimize();
      expect(await usesIndex(driver)).toBe(true);
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an index created over existing data is used once the driver is told to optimize", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-planner-"));
    try {
      const driver = new SqliteDriver(join(dir, "db.sqlite"));
      await seed(driver, 5000);
      await driver.write((tx) => applySchema(tx, driver.dialect, schema)); // as a deploy would
      await driver.optimize();
      expect(await usesIndex(driver)).toBe(true);
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an eq + range index query reads the index in order, without sorting the rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-planner-"));
    try {
      const authors = defineSchema({ posts: defineTable({ author: v.string() }).index("by_author", ["author"]) });
      const modules = {
        posts: {
          add: mutation({ args: { n: v.number() }, handler: async (ctx, { n }) => void (await Promise.all(Array.from({ length: n }, (_, i) => ctx.db.insert("posts", { author: `a${i % 20}` })))) }),
          newest: query({
            args: { author: v.string() },
            handler: async (ctx, { author }) => (await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author).gt("_creationTime", 0)).take(10)).length,
          }),
        },
      };
      const driver = new SqliteDriver(join(dir, "db.sqlite"));
      const quiet = { info() {}, warn() {}, error() {} };
      const runtime = new Runtime({ driver, log: quiet, schema: authors, modules });
      await runtime.init();
      await runtime.runMutation("posts:add", { n: 2000 });
      await driver.optimize();

      const seen: string[] = [];
      const open = driver.reader.query.bind(driver.reader);
      (driver.reader as any).query = (sql: string) => (sql.includes("FROM documents WHERE") && seen.push(sql), open(sql));
      expect(((await runtime.runQuery("posts:newest", { author: "a3" })) as any).value).toBe(10);
      expect(seen).toHaveLength(1);
      const plan = (await driver.read((tx) => driver.explain(tx, seen[0]!, ["a3", 0]))).join(" | ");
      expect(plan).toContain("cl_posts__by_author");
      expect(plan).not.toContain("TEMP B-TREE"); // the equality-pinned author is not part of the ORDER BY
      runtime.stop();
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mysql driver", () => {
  test("turns the engine's upserts into ON DUPLICATE KEY UPDATE", async () => {
    const sent: string[] = [];
    const driver = new MysqlDriver("mysql://u:p@localhost/db");
    const exec = (driver as any).exec({ unsafe: async (sql: string) => (sent.push(sql), Object.assign([], { affectedRows: 1 })) });
    await exec.run("INSERT INTO _crons (name, spec, next_run) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET spec = excluded.spec, next_run = excluded.next_run");
    expect(sent).toEqual(["INSERT INTO _crons (name, spec, next_run) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE spec = VALUES(spec), next_run = VALUES(next_run)"]);
    await driver.close();
  });

  // Set TEST_MARIADB_URL to check that MariaDB is turned away with an explanation.
  test.if(!!process.env.TEST_MARIADB_URL)("refuses MariaDB", async () => {
    const driver = new MysqlDriver(process.env.TEST_MARIADB_URL!);
    await expect(driver.init()).rejects.toThrow("onebase doesn't support MariaDB");
    await driver.close();
  });
});

describe("sqlite group commit", () => {
  test("queued writes share a commit, and a failing one is undone alone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-group-"));
    try {
      const driver = new SqliteDriver(join(dir, "db.sqlite"));
      await driver.write((tx) => tx.run("CREATE TABLE t (x INTEGER)"));
      let commits = 0;
      const run = driver.writer.run.bind(driver.writer);
      (driver.writer as any).run = (sql: string) => (sql === "COMMIT" && commits++, run(sql));
      const visible = async () => (await driver.read((tx) => tx.all("SELECT x FROM t ORDER BY x"))).map((r) => r.x);

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, (_, i) =>
          driver.write(async (tx) => {
            await tx.run("INSERT INTO t (x) VALUES (?)", [i]);
            if (i === 25) throw new Error("no");
            return i;
          }).then(async (value) => {
            // Answered only once committed: the reader sees this write.
            expect(await visible()).toContain(value);
            return value;
          }),
        ),
      );
      expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.message)).toEqual(["no"]);
      expect(await visible()).toEqual(Array.from({ length: 50 }, (_, i) => i).filter((i) => i !== 25));
      expect(commits).toBeGreaterThan(0);
      expect(commits).toBeLessThan(10);
      expect(driver.writer.inTransaction).toBe(false);
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("requests arriving together over HTTP share a commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-group-"));
    const driver = new SqliteDriver(join(dir, "db.sqlite"));
    // Each request reaches write() from its own socket callback, unlike calls made in one loop.
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const { x } = await req.json();
        await driver.write((tx) => tx.run("INSERT INTO t (x) VALUES (?)", [x]));
        return new Response("ok");
      },
    });
    try {
      await driver.write((tx) => tx.run("CREATE TABLE t (x INTEGER)"));
      let commits = 0;
      const run = driver.writer.run.bind(driver.writer);
      (driver.writer as any).run = (sql: string) => (sql === "COMMIT" && commits++, run(sql));

      // Written from this thread with no await between them, so all have arrived when the event
      // loop next looks. fetch() sends from its own thread, and its requests can land further
      // apart than a commit takes, leaving nothing for a group to wait for however well it works.
      const n = 200;
      const answers: Promise<string>[] = [];
      const sockets = [];
      for (let x = 0; x < n; x++) { // one at a time: the listen backlog can be smaller than n
        const { promise, resolve } = Promise.withResolvers<string>();
        answers.push(promise);
        sockets.push(await Bun.connect({ hostname: "127.0.0.1", port: server.port!, socket: { data: (_, data) => resolve(data.toString()) } }));
      }
      sockets.forEach((socket, x) => {
        const body = JSON.stringify({ x });
        socket.write(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
      });
      for (const answer of await Promise.all(answers)) expect(answer).toStartWith("HTTP/1.1 200");
      for (const socket of sockets) socket.end();
      expect(await driver.read((tx) => tx.get("SELECT COUNT(*) AS n FROM t"))).toEqual({ n });
      expect(commits).toBeLessThan(n / 2);
    } finally {
      server.stop(true);
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed write alone doesn't leave a transaction open, even if closed right after", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-group-"));
    try {
      const driver = new SqliteDriver(join(dir, "db.sqlite"));
      const fail = () => driver.write(async () => { throw new Error("no"); });
      await expect(fail()).rejects.toThrow("no");
      await Bun.sleep(0);
      await new Promise((resolve) => setImmediate(resolve));
      expect(driver.writer.inTransaction).toBe(false);
      await expect(fail()).rejects.toThrow("no");
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an in-memory read between writes runs outside the group", async () => {
    const driver = new SqliteDriver(":memory:");
    await driver.write((tx) => tx.run("CREATE TABLE t (x INTEGER)"));
    const [, inTransaction] = await Promise.all([
      driver.write((tx) => tx.run("INSERT INTO t (x) VALUES (1)")),
      driver.read(async () => driver.writer.inTransaction),
      driver.write((tx) => tx.run("INSERT INTO t (x) VALUES (2)")),
    ]);
    expect(inTransaction).toBe(false);
    expect(await driver.read((tx) => tx.get("SELECT COUNT(*) AS n FROM t"))).toEqual({ n: 2 });
    await driver.close();
  });
});

describe("sqlite free space", () => {
  /** Writes `mb` megabytes of rows into table pad, then deletes all but `keep` of them. */
  async function churn(driver: SqliteDriver, mb: number, keep = 0) {
    const row = "z".repeat(8000);
    for (let i = 0; i < mb * 125; i += 1000) {
      await driver.write(async (tx) => {
        for (let j = i; j < Math.min(i + 1000, mb * 125); j++) await tx.run("INSERT INTO pad (n, x) VALUES (?, ?)", [j, row]);
      });
    }
    await driver.write((tx) => tx.run("DELETE FROM pad WHERE n >= ?", [keep]));
  }
  const freeSpaceWarnings = (path: string) => {
    const findings: Finding[] = [];
    checkDatabase(path, findings);
    return findings.map((f) => f.message);
  };

  test("a new database gives the space of deleted rows back in the background", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-space-"));
    try {
      const path = join(dir, "db.sqlite");
      const driver = new SqliteDriver(path);
      await driver.write((tx) => tx.run("CREATE TABLE pad (n INTEGER, x TEXT)"));
      await churn(driver, 70, 10);
      expect(driver.space()).toMatchObject({ autoVacuum: "incremental" });
      expect(statSync(path).size).toBeGreaterThan(70e6);
      expect(freeSpaceWarnings(path)).toHaveLength(1);

      await driver.maintain();
      expect(driver.space().free).toBe(0);
      expect(statSync(path).size).toBeLessThan(1e6);
      expect(statSync(`${path}-wal`).size).toBe(0);
      expect(await driver.read((tx) => tx.get("SELECT COUNT(*) AS n FROM pad"))).toEqual({ n: 10 });
      expect(freeSpaceWarnings(path)).toEqual([]);
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("onebase vacuum shrinks a database made before incremental vacuum, and turns it on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "onebase-space-"));
    try {
      const path = join(dir, "db.sqlite");
      const old = new Database(path, { create: true });
      old.run("CREATE TABLE pad (n INTEGER, x TEXT)");
      old.close();
      const driver = new SqliteDriver(path);
      await churn(driver, 70, 10);
      expect(driver.space()).toMatchObject({ autoVacuum: "none" });
      await driver.maintain(); // can't do anything without auto_vacuum
      expect(statSync(path).size).toBeGreaterThan(70e6);
      expect(freeSpaceWarnings(path)[0]).toMatch(/^\d+ MB \(\d+%\) of this \d+ MB database is free space/);

      await driver.vacuum();
      expect(driver.space()).toMatchObject({ autoVacuum: "incremental", free: 0 });
      expect(statSync(path).size).toBeLessThan(1e6);
      expect(await driver.read((tx) => tx.get("SELECT COUNT(*) AS n, SUM(n) AS s FROM pad"))).toEqual({ n: 10, s: 45 });
      expect(freeSpaceWarnings(path)).toEqual([]);
      await driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
