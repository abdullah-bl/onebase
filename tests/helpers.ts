// Shared setup for tests that run against every configured database.

import { createDriver, SqliteDriver, type Driver } from "../src/engine/driver";
import { Runtime, type RuntimeOptions } from "../src/engine/runtime";

/** SQLite always runs; set TEST_POSTGRES_URL / TEST_MYSQL_URL / TEST_LIBSQL_URL to also run against Postgres, MySQL and libSQL (Turso). */
export const DRIVERS: { name: string; make: (dir: string) => Driver }[] = [
  { name: "sqlite", make: (dir) => new SqliteDriver(`${dir}/db.sqlite`) },
  ...(process.env.TEST_POSTGRES_URL ? [{ name: "postgres", make: () => createDriver(process.env.TEST_POSTGRES_URL!) }] : []),
  ...(process.env.TEST_LIBSQL_URL ? [{ name: "libsql", make: () => createDriver(process.env.TEST_LIBSQL_URL!) }] : []),
  ...(process.env.TEST_MYSQL_URL ? [{ name: "mysql", make: () => createDriver(process.env.TEST_MYSQL_URL!) }] : []),
];

export const quiet = { info() {}, warn() {}, error() {} };

/** A runtime on a fresh database: shared databases are emptied before the schema is applied. */
export async function openRuntime(make: () => Driver, opts: Omit<RuntimeOptions, "driver">): Promise<{ driver: Driver; runtime: Runtime }> {
  const driver = make();
  if (driver.shared) {
    await driver.init();
    await driver.write(async (tx) => {
      for (const t of ["documents", "_scheduled", "_crons", "_storage", "_upload_tokens", "_meta", "_auth_sessions", "_auth_accounts", "_auth_codes", "_auth_attempts", "_deployments"]) {
        await tx.run(`DELETE FROM ${t}`);
      }
    });
  }
  const runtime = new Runtime({ driver, log: quiet, ...opts });
  try {
    await runtime.init();
  } catch (err) {
    // Close the pool, or one failing test leaves connections open and the rest hit "too many clients".
    await driver.close();
    throw err;
  }
  return { driver, runtime };
}

/** Counts how often each query runs (subscriptions re-run through runtime.runQuery). */
export function countRuns(runtime: Runtime): Record<string, number> {
  const runs: Record<string, number> = {};
  const original = runtime.runQuery.bind(runtime);
  runtime.runQuery = ((name: any, args: any, opts: any) => {
    const key = `${name}${args && Object.keys(args).length ? JSON.stringify(args) : ""}`;
    runs[key] = (runs[key] ?? 0) + 1;
    return original(name, args, opts);
  }) as typeof runtime.runQuery;
  return runs;
}
