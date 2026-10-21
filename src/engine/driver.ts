// Database drivers. The engine only talks to this interface, so the same functions run on
// a local SQLite file, Postgres, or Turso/libSQL.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { newId, postgresDialect, sqliteDialect, type Dialect } from "./dialect";

export type Row = Record<string, any>;

/** A connection inside a transaction. All SQL uses `?` placeholders. */
export interface Exec {
  all(sql: string, params?: unknown[]): Promise<Row[]>;
  get(sql: string, params?: unknown[]): Promise<Row | null>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
}

export interface Driver {
  readonly dialect: Dialect;
  readonly kind: "sqlite" | "postgres" | "libsql";
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
export class SqliteDriver implements Driver {
  readonly dialect = sqliteDialect;
  readonly kind = "sqlite";
  readonly shared = false;
  readonly writer: Database;
  readonly reader: Database;
  private readonly reads = new SerialQueue();
  private readonly writes = new SerialQueue();

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.writer = new Database(path, { create: true, strict: true });
    this.writer.run("PRAGMA journal_mode = WAL");
    this.writer.run("PRAGMA synchronous = NORMAL");
    this.writer.run("PRAGMA busy_timeout = 5000");
    for (const sql of this.dialect.ddl) this.writer.run(sql);
    if (path === ":memory:") {
      this.reader = this.writer;
    } else {
      this.reader = new Database(path, { readonly: true, strict: true });
      this.reader.run("PRAGMA busy_timeout = 5000");
    }
  }

  get description() {
    return this.path;
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
    return (await tx.all(`EXPLAIN QUERY PLAN ${sql}`, params)).map((r) => String(r.detail));
  }

  async close() {
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

// ---------- Turso / libSQL ----------

const COMMIT_POLL_MS = 200;
const COMMIT_RETENTION_MS = 60_000;

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
    this.client = createClient({ url: this.url, authToken: this.authToken });
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

  read<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.transaction("read", fn);
  }

  write<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return retrying(
      () => this.transaction("write", fn),
      (err: any) => /SQLITE_BUSY|database is locked/i.test(String(err?.code ?? err?.message)),
    );
  }

  async publish(tx: Exec, message: string) {
    await tx.run("INSERT INTO _commits (id, at, payload) VALUES (?, ?, ?)", [newId(), Date.now(), message]);
  }

  async subscribe(onMessage: (message: string) => void) {
    const seen = new Map<string, number>();
    let since = Date.now() - 1000;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const now = Date.now();
        // Look back a few seconds: a slow transaction can commit after newer ones.
        const rows = this.exec(this.client);
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
    this.polling = setInterval(poll, COMMIT_POLL_MS);
  }

  async close() {
    if (this.polling) clearInterval(this.polling);
    this.client?.close();
  }
}

/**
 * Picks a driver from a URL:
 *   ./data/db.sqlite or file:./db.sqlite → SQLite
 *   postgres://user:pass@host/db         → Postgres
 *   libsql://my-db.turso.io, https://…   → Turso / libSQL (token from ?authToken= or $LIBSQL_AUTH_TOKEN)
 */
export function createDriver(url: string): Driver {
  if (/^postgres(ql)?:\/\//.test(url)) return new PostgresDriver(url);
  if (/^(libsql|https?|wss?):\/\//.test(url)) {
    const u = new URL(url);
    const token = u.searchParams.get("authToken") ?? process.env.LIBSQL_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN ?? undefined;
    u.searchParams.delete("authToken");
    return new LibsqlDriver(u.toString(), token);
  }
  return new SqliteDriver(url.replace(/^file:/, ""));
}
