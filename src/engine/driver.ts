// Database drivers. The engine only talks to this interface, so the same functions run on
// a local SQLite file, Postgres, MySQL, or Turso/libSQL.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { mysqlDialect, newId, postgresDialect, sqliteDialect, vector32, vectorDistanceCos, type Dialect } from "./dialect";
import { unguardedFetch } from "./guard";

export type Row = Record<string, any>;

/** A connection inside a transaction. All SQL uses `?` placeholders. */
export interface Exec {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  get(sql: string, params?: unknown[]): Promise<Row | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface Driver {
  readonly dialect: Dialect;
  readonly kind: "sqlite" | "postgres" | "mysql" | "libsql";
  /** Shown at startup (no credentials). */
  readonly description: string;
  /** True when other processes can share this database, so commits must be broadcast. */
  readonly shared: boolean;
  init(): Promise<void>;
  /** Runs `fn` on a consistent read-only snapshot. */
  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T>;
  /** Runs `fn` in a serializable read-write transaction. It may be retried on conflicts. */
  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T>;
  /** Sends a message to other instances once the transaction commits. */
  publish?(tx: Exec, message: string): Promise<void>;
  /** Receives messages published by any instance (including this one). */
  subscribe?(onMessage: (message: string) => void): Promise<void>;
  /** Query plan lines, used for missing-index warnings (SQLite only). */
  explain?(tx: Exec, sql: string, params: unknown[]): Promise<string[]>;
  /** Refreshes the planner's statistics (SQLite only); called after indexes are created. */
  optimize?(): Promise<void>;
  close(): Promise<void>;
}

export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** Runs at most `limit` tasks at once; the rest wait in order. */
class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      // Hand the slot straight to the next waiter, so a new caller can't take it first.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/** Runs `fn` in a savepoint: its writes are undone if it throws. Works on every driver. */
export async function savepoint<T>(tx: Exec, fn: () => Promise<T>): Promise<T> {
  const name = `sp_${newId()}`;
  await tx.run(`SAVEPOINT ${name}`);
  try {
    const result = await fn();
    await tx.run(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (err) {
    await tx.run(`ROLLBACK TO SAVEPOINT ${name}`);
    await tx.run(`RELEASE SAVEPOINT ${name}`);
    throw err;
  }
}

async function retrying<T>(fn: () => Promise<T>, isConflict: (err: unknown) => boolean, attempts = 8): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts - 1 || !isConflict(err)) throw err;
      await Bun.sleep(Math.random() * 10 * 2 ** i);
    }
  }
}

// ---------- SQLite (bun:sqlite) ----------

/**
 * Local SQLite file in WAL mode. A separate reader connection gives queries a committed
 * snapshot while a mutation's transaction is still open.
 */
const OPTIMIZE_INTERVAL_MS = 60 * 60 * 1000;
/** Also optimize after this many write transactions: a database that starts empty grows fast. */
const OPTIMIZE_EVERY_WRITES = 1000;

/** The vector functions libSQL has built in, so vector indexes use the same SQL on both. */
function addVectorFunctions(db: Database) {
  db.function("vector32", { deterministic: true }, vector32);
  db.function("vector_distance_cos", { deterministic: true }, vectorDistanceCos);
}

export class SqliteDriver implements Driver {
  readonly dialect = sqliteDialect;
  readonly kind = "sqlite";
  readonly shared = false;
  readonly writer: Database;
  reader: Database;
  private readonly reads = new SerialQueue();
  private readonly writes = new SerialQueue();
  private optimizeTimer: ReturnType<typeof setInterval> | null = null;
  private writeCount = 0;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.writer = new Database(path, { create: true, strict: true });
    this.writer.run("PRAGMA journal_mode = WAL");
    this.writer.run("PRAGMA synchronous = NORMAL");
    this.writer.run("PRAGMA busy_timeout = 5000");
    addVectorFunctions(this.writer);
    for (const sql of this.dialect.ddl) this.writer.run(sql);
    // Without statistics SQLite can't tell a selective index from a useless one, and a range
    // query on an expression index falls back to scanning the table and sorting it. Analyze what
    // was never analyzed now, and keep the statistics fresh as the data grows.
    this.writer.run("PRAGMA analysis_limit = 1000");
    this.writer.run("PRAGMA optimize = 0x10002");
    if (path !== ":memory:") {
      this.optimizeTimer = setInterval(() => void this.optimize().catch(() => {}), OPTIMIZE_INTERVAL_MS);
      this.optimizeTimer.unref?.();
    }
    if (path === ":memory:") {
      this.reader = this.writer;
    } else {
      this.reader = this.openReader();
    }
  }

  private openReader(): Database {
    const reader = new Database(this.path, { readonly: true, strict: true });
    reader.run("PRAGMA busy_timeout = 5000");
    addVectorFunctions(reader);
    return reader;
  }

  get description() {
    return this.path;
  }

  /**
   * Refreshes the planner's statistics. Queued with the writes, since they only change when
   * nothing is mid-transaction. A connection keeps the statistics it loaded along with the
   * schema, so when they changed the reader is reopened (between reads) to plan with them.
   */
  async optimize(): Promise<void> {
    const changed = await this.writes.run(async () => {
      const before = this.statistics();
      this.writer.run("PRAGMA optimize");
      return this.statistics() !== before;
    });
    if (!changed || this.reader === this.writer) return;
    await this.reads.run(async () => {
      this.reader.close();
      this.reader = this.openReader();
    });
  }

  private statistics(): string {
    try {
      const row = this.writer.query("SELECT group_concat(idx || ':' || stat) AS s FROM (SELECT idx, stat FROM sqlite_stat1 ORDER BY idx)").get() as { s: string | null } | null;
      return row?.s ?? "";
    } catch {
      return ""; // never analyzed: no statistics table yet
    }
  }

  private exec(db: Database): Exec {
    return {
      all: async (sql, params = []) => db.query(sql).all(...(params as any[])) as Row[],
      get: async (sql, params = []) => (db.query(sql).get(...(params as any[])) as Row | null) ?? null,
      run: async (sql, params = []) => ({ changes: db.query(sql).run(...(params as any[])).changes }),
    };
  }

  async init() {}

  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    // In-memory databases have a single connection, so reads queue behind writes.
    if (this.reader === this.writer) return this.writes.run(() => fn(this.exec(this.writer)));
    return this.reads.run(async () => {
      this.reader.run("BEGIN");
      try {
        return await fn(this.exec(this.reader));
      } finally {
        this.reader.run("COMMIT");
      }
    });
  }

  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.writes.run(async () => {
      this.writer.run("BEGIN IMMEDIATE");
      try {
        const result = await fn(this.exec(this.writer));
        this.writer.run("COMMIT");
        if (++this.writeCount % OPTIMIZE_EVERY_WRITES === 0) void this.optimize().catch(() => {}); // queued behind this write
        return result;
      } catch (err) {
        this.writer.run("ROLLBACK");
        throw err;
      }
    });
  }

  /** Writes a consistent copy of the database to `path` without blocking writers. */
  snapshot(path: string): Promise<void> {
    const quoted = path.replace(/'/g, "''");
    return this.reads.run(async () => void this.reader.run(`VACUUM INTO '${quoted}'`));
  }

  async explain(tx: Exec, sql: string, params: unknown[]) {
    // Not through tx.all(): a cached (never finalized) EXPLAIN statement pins the
    // reader connection's WAL snapshot in bun:sqlite, so later reads never see new commits.
    // Either connection yields the same plan.
    const db = this.reader.inTransaction ? this.reader : this.writer;
    const stmt = db.prepare(`EXPLAIN QUERY PLAN ${sql}`);
    try {
      return (stmt.all(...(params as any[])) as Row[]).map((r) => String(r.detail));
    } finally {
      stmt.finalize();
    }
  }

  async close() {
    if (this.optimizeTimer) clearInterval(this.optimizeTimer);
    try {
      await this.optimize();
    } catch {}
    if (this.reader !== this.writer) this.reader.close();
    this.writer.close();
  }
}

// ---------- Postgres (Bun.SQL) ----------

const CHANNEL = "onebase_commits";

/** Converts `?` placeholders to $1, $2... (our SQL never has `?` inside literals). */
function numbered(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class PostgresDriver implements Driver {
  readonly dialect = postgresDialect;
  readonly kind = "postgres";
  readonly shared = true;
  private readonly sql: InstanceType<typeof Bun.SQL>;

  constructor(private readonly url: string) {
    this.sql = new Bun.SQL(url, { max: 10 });
  }

  get description() {
    const u = new URL(this.url);
    return `postgres://${u.host}${u.pathname}`;
  }

  private exec(tx: any): Exec {
    return {
      all: async (sql, params = []) => [...(await tx.unsafe(numbered(sql), params))],
      get: async (sql, params = []) => (await tx.unsafe(numbered(sql), params))[0] ?? null,
      run: async (sql, params = []) => ({ changes: (await tx.unsafe(numbered(sql), params)).count ?? 0 }),
    };
  }

  async init() {
    await this.sql.begin(async (tx: any) => {
      // Serialize schema setup when several instances start at once.
      await tx.unsafe("SELECT pg_advisory_xact_lock(7302461)");
      for (const ddl of this.dialect.ddl) await tx.unsafe(ddl);
    });
  }

  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.sql.begin(async (tx: any) => {
      await tx.unsafe("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return fn(this.exec(tx));
    }) as Promise<T>;
  }

  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    // Serialization failures (another instance touched the same rows) are retried.
    return retrying(
      () =>
        this.sql.begin(async (tx: any) => {
          await tx.unsafe("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
          return fn(this.exec(tx));
        }) as Promise<T>,
      (err: any) => err?.errno === "40001" || err?.errno === "40P01",
    );
  }

  async publish(tx: Exec, message: string) {
    // NOTIFY is transactional: it's delivered only if the transaction commits.
    await tx.get("SELECT pg_notify(?, ?)", [CHANNEL, message]);
  }

  async subscribe(onMessage: (message: string) => void) {
    await this.sql.listen(CHANNEL, onMessage);
  }

  async close() {
    await this.sql.close();
  }
}

// ---------- Commit log (libSQL, MySQL) ----------

const COMMIT_POLL_MS = 200;
const COMMIT_RETENTION_MS = 60_000;

/**
 * For databases without LISTEN/NOTIFY: each mutation writes its message to a _commits table in
 * its transaction, and every instance polls the table for messages it hasn't seen.
 */
async function pollCommits(rows: Exec, onMessage: (message: string) => void): Promise<ReturnType<typeof setInterval>> {
  const seen = new Map<string, number>();
  let since = Date.now();
  // Commits already in the log are older than anything this instance will read, so don't replay them.
  const existing = await rows.all("SELECT id, at FROM _commits WHERE at > ?", [since - 5000]).catch(() => []);
  for (const r of existing) seen.set(r.id, r.at);
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      const now = Date.now();
      // Look back a few seconds: a slow transaction can commit after newer ones.
      const fresh = await rows.all("SELECT id, at, payload FROM _commits WHERE at > ? ORDER BY at", [since - 5000]);
      for (const r of fresh) {
        if (seen.has(r.id)) continue;
        seen.set(r.id, r.at);
        onMessage(r.payload);
      }
      since = now;
      for (const [id, at] of seen) if (at < now - 10_000) seen.delete(id);
      if (Math.random() < 0.02) await rows.run("DELETE FROM _commits WHERE at < ?", [now - COMMIT_RETENTION_MS]);
    } catch {
      // Transient network errors: try again next tick.
    } finally {
      busy = false;
    }
  };
  return setInterval(poll, COMMIT_POLL_MS);
}

// ---------- Turso / libSQL ----------
// sqld answers HTTP 429 once more than --max-concurrent-requests (128 by default) are in
// flight, and Turso rate-limits too. An open transaction sends one request at a time, so
// bursts (say, hundreds of subscriptions running for the first time) queue here instead.
const MAX_TRANSACTIONS = 32;

/** The server didn't run the transaction (another writer holds the lock, or it's shedding load), so it can be retried. */
function libsqlRetryable(err: any): boolean {
  if (/SQLITE_BUSY|database is locked/i.test(String(err?.code ?? err?.message))) return true;
  // Only the client's own errors: a mutation may throw anything.
  if (err?.name !== "LibsqlError" && err?.name !== "LibsqlBatchError") return false;
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    if (e.status === 429 || /too many requests/i.test(e.message)) return true;
  }
  return false;
}

/**
 * Remote libSQL (Turso, sqld). Other instances learn about commits by polling a small
 * _commits log written inside each mutation's transaction.
 */
export class LibsqlDriver implements Driver {
  readonly dialect = sqliteDialect;
  readonly kind = "libsql";
  readonly shared = true;
  private client: any;
  private polling: ReturnType<typeof setInterval> | null = null;
  private readonly open = new Semaphore(MAX_TRANSACTIONS);

  constructor(
    private readonly url: string,
    private readonly authToken?: string,
  ) {}

  get description() {
    const u = new URL(this.url);
    return `${u.protocol}//${u.host}`;
  }

  private exec(tx: any): Exec {
    const toRows = (rs: any): Row[] =>
      rs.rows.map((row: any) => Object.fromEntries(rs.columns.map((c: string, i: number) => [c, row[i]])));
    return {
      all: async (sql, args = []) => toRows(await tx.execute({ sql, args })),
      get: async (sql, args = []) => toRows(await tx.execute({ sql, args }))[0] ?? null,
      run: async (sql, args = []) => ({ changes: (await tx.execute({ sql, args })).rowsAffected }),
    };
  }

  async init() {
    const { createClient } = await import("@libsql/client/web");
    // Queries run inside mutations, where user code may not call fetch().
    this.client = createClient({ url: this.url, authToken: this.authToken, fetch: unguardedFetch });
    await this.client.batch(
      [...this.dialect.ddl, "CREATE TABLE IF NOT EXISTS _commits (id TEXT PRIMARY KEY, at REAL NOT NULL, payload TEXT NOT NULL)"],
      "write",
    );
  }

  private async transaction<T>(mode: "read" | "write", fn: (tx: Exec) => Promise<T>): Promise<T> {
    const tx = await this.client.transaction(mode);
    try {
      const result = await fn(this.exec(tx));
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback().catch(() => {});
      throw err;
    } finally {
      tx.close();
    }
  }

  // A retry gives up its slot while it backs off.
  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return retrying(() => this.open.run(() => this.transaction("read", fn)), libsqlRetryable);
  }

  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return retrying(() => this.open.run(() => this.transaction("write", fn)), libsqlRetryable);
  }

  async publish(tx: Exec, message: string) {
    await tx.run("INSERT INTO _commits (id, at, payload) VALUES (?, ?, ?)", [newId(), Date.now(), message]);
  }

  async subscribe(onMessage: (message: string) => void) {
    this.polling = await pollCommits(this.exec(this.client), onMessage);
  }

  async close() {
    if (this.polling) clearInterval(this.polling);
    this.client?.close();
  }
}

// ---------- MySQL (Bun.SQL) ----------

/** MySQL 8's defaults plus ANSI_QUOTES, so "identifiers" are quoted as in the other databases. */
const MYSQL_MODE = "ANSI_QUOTES,ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";
const MYSQL_MIN_VERSION = [8, 0, 21]; // JSON_VALUE(... RETURNING ...)

/** The engine writes upserts as SQLite/Postgres do; MySQL spells them ON DUPLICATE KEY UPDATE. */
function onDuplicateKey(sql: string): string {
  return sql.replace(/ON CONFLICT\s*\([^)]*\)\s*DO UPDATE SET (.*)$/s, (_, sets: string) =>
    `ON DUPLICATE KEY UPDATE ${sets.replace(/excluded\.(\w+)/g, "VALUES($1)")}`,
  );
}

/** Deadlocks and lock wait timeouts: MySQL rolled the transaction back (or can be retried). */
function mysqlRetryable(err: any): boolean {
  return err?.errno === 1213 || err?.errno === 1205;
}

/**
 * MySQL 8.0.21+. Each transaction runs on a connection of its own (session settings stick to a
 * connection), mutations at SERIALIZABLE, which in InnoDB makes every read lock what it read.
 * Other instances learn about commits by polling the _commits log, as with libSQL.
 */
export class MysqlDriver implements Driver {
  readonly dialect = mysqlDialect;
  readonly kind = "mysql";
  readonly shared = true;
  private readonly sql: InstanceType<typeof Bun.SQL>;
  private polling: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly url: string) {
    const u = new URL(url);
    // Bun reads most options from the URL, but not this one; it's needed for caching_sha2_password without TLS.
    const allowPublicKeyRetrieval = u.searchParams.get("allowPublicKeyRetrieval") === "true";
    u.searchParams.delete("allowPublicKeyRetrieval");
    this.sql = new Bun.SQL(u.toString(), { adapter: "mysql", max: 10, foundRows: true, allowPublicKeyRetrieval } as any);
  }

  get description() {
    const u = new URL(this.url);
    return `mysql://${u.host}${u.pathname}`;
  }

  private exec(conn: any): Exec {
    const run = async (sql: string, params: unknown[] = []) => conn.unsafe(onDuplicateKey(sql), params);
    return {
      all: async (sql, params) => [...(await run(sql, params))],
      get: async (sql, params) => (await run(sql, params))[0] ?? null,
      run: async (sql, params) => ({ changes: (await run(sql, params)).affectedRows ?? 0 }),
    };
  }

  private async transaction<T>(isolation: string, start: string, fn: (tx: Exec) => Promise<T>): Promise<T> {
    const conn = await this.sql.reserve();
    try {
      await conn.unsafe(`SET SESSION sql_mode = '${MYSQL_MODE}', SESSION time_zone = '+00:00', SESSION transaction_isolation = '${isolation}'`);
      await conn.unsafe(start);
      try {
        const result = await fn(this.exec(conn));
        await conn.unsafe("COMMIT");
        return result;
      } catch (err) {
        await conn.unsafe("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      conn.release();
    }
  }

  async init() {
    const [{ v }] = await this.sql.unsafe("SELECT VERSION() AS v");
    if (/mariadb/i.test(v)) {
      throw new Error(
        `onebase doesn't support MariaDB (${v}): its JSON type is plain text, so documents can't be compared or ordered by value. ` +
          `Use MySQL 8.0.21+, Postgres, SQLite or libSQL.`,
      );
    }
    const version = String(v).split(/[.-]/).map(Number);
    const diff = MYSQL_MIN_VERSION.map((n, i) => (version[i] ?? 0) - n).find((d) => d !== 0) ?? 0;
    if (diff < 0) {
      throw new Error(`onebase needs MySQL ${MYSQL_MIN_VERSION.join(".")} or later; this server is ${v}.`);
    }
    await this.transaction("READ-COMMITTED", "START TRANSACTION", async (tx) => {
      // Serialize schema setup when several instances start at once (DDL commits as it goes).
      await tx.get("SELECT GET_LOCK('onebase_init', 60)");
      try {
        for (const ddl of this.dialect.ddl) await tx.run(ddl);
      } finally {
        await tx.get("SELECT RELEASE_LOCK('onebase_init')");
      }
    });
  }

  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.transaction("REPEATABLE-READ", "START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY", fn);
  }

  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return retrying(() => this.transaction("SERIALIZABLE", "START TRANSACTION", fn), mysqlRetryable);
  }

  async publish(tx: Exec, message: string) {
    await tx.run("INSERT INTO _commits (id, at, payload) VALUES (?, ?, ?)", [newId(), Date.now(), message]);
  }

  async subscribe(onMessage: (message: string) => void) {
    this.polling = await pollCommits(this.exec(this.sql), onMessage);
  }

  async close() {
    if (this.polling) clearInterval(this.polling);
    await this.sql.close();
  }
}

/**
 * Picks a driver from a URL:
 *   ./data/db.sqlite or file:./db.sqlite → SQLite
 *   postgres://user:pass@host/db         → Postgres
 *   mysql://user:pass@host/db            → MySQL 8.0.21+
 *   libsql://my-db.turso.io, https://…   → Turso / libSQL (token from ?authToken= or $LIBSQL_AUTH_TOKEN)
 */
export function createDriver(url: string): Driver {
  if (/^postgres(ql)?:\/\//.test(url)) return new PostgresDriver(url);
  if (/^mysql:\/\//.test(url)) return new MysqlDriver(url);
  if (/^(libsql|https?|wss?):\/\//.test(url)) {
    const u = new URL(url);
    const token = u.searchParams.get("authToken") ?? process.env.LIBSQL_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN ?? undefined;
    u.searchParams.delete("authToken");
    return new LibsqlDriver(u.toString(), token);
  }
  return new SqliteDriver(url.replace(/^file:/, ""));
}
