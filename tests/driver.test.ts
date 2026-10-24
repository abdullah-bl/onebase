// LibsqlDriver against a fake client, so the transaction limit and 429 retries are checked
// without a libsql-server (CI only runs SQLite).

import { describe, expect, test } from "bun:test";
import { LibsqlDriver } from "../src/engine/driver";

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
