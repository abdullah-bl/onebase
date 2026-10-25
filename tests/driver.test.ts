// LibsqlDriver against a fake client, so the transaction limit and 429 retries are checked
// without a libsql-server (CI only runs SQLite).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../src/engine/database";
import { LibsqlDriver, SqliteDriver } from "../src/engine/driver";
import { defineSchema, defineTable } from "../src/server";
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
});
