// SQL differences between SQLite/libSQL, Postgres and MySQL. Every query is written with `?`
// placeholders; the Postgres driver renumbers them to $1, $2... Identifiers are double-quoted,
// which MySQL accepts in ANSI_QUOTES mode (the MySQL driver turns it on).

import type { VectorIndexDef } from "../schema";
import type { Exec } from "./driver";

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What a compiled SQL expression holds, so parameters can be bound with the right type. */
export type ValueKind = "json" | "ct" | "id" | "num";

export interface Dialect {
  readonly name: "sqlite" | "postgres" | "mysql";
  /** Comparable expression for a document field (validated path). */
  field(path: string): string;
  /** Numeric expression for a document field, for arithmetic in filters. */
  numField(path: string): string;
  /** Placeholder for a value compared against an expression of `kind`. */
  placeholder(kind: ValueKind): string;
  /** Encodes a JS value for a placeholder of `kind`. */
  encode(value: unknown, kind: ValueKind): unknown;
  /** Decodes a selected document field / key value. */
  decode(value: unknown, kind: ValueKind): unknown;
  isNull(expr: string, kind: ValueKind): string;
  /** True when a document field holds `true` (a bare field used as a filter). */
  isTrue(expr: string): string;
  /** `a` differs from `b`, where null equals null. */
  distinct(a: string, b: string): string;
  /**
   * Orders two values the way the database orders them in an index, or returns null when
   * that can't be decided in JS (callers then assume the worst).
   */
  compare(a: unknown, b: unknown, kind: ValueKind): number | null;
  boolLiteral(b: boolean): string;
  parseDoc(raw: unknown): Record<string, unknown>;
  docPlaceholder: string;
  /** Schema for system tables. */
  ddl: string[];
  createIndex(name: string, table: string, columns: string[]): string;
  /** Drops an index made by createIndex() or searchIndex(). */
  dropIndex(name: string): string;
  /** Statements that create a search index and fill it from existing documents; `def` changes when they do. */
  searchIndex(name: string, table: string, field: string): { def: string; create: string[] };
  /** SQL for a search query: what to select from, the match condition and the relevance order. */
  searchSql(name: string, field: string): { from: string; match: string; rank: string; rankTakesQuery: boolean };
  /** Search terms in the database's query syntax: any term matches, the last one also as a prefix. */
  searchQuery(terms: string[]): string;
  /** Updates search indexes after a document write (SQLite keeps them in separate FTS5 tables). */
  syncSearch?(tx: Exec, docId: string, entries: { name: string; text: string | null }[]): Promise<void>;
  /** Statements that create a vector index and fill it from existing documents; `def` changes when they do. */
  vectorIndex(name: string, table: string, index: VectorIndexDef): { def: string; create: string[] };
  /**
   * SQL for a vector search: what to select from, conditions every indexed document meets, and
   * either its cosine distance (1 - cosine similarity) to the query vector bound to `?`, or
   * (where the database can't compute that) its vector as JSON, for the engine to compare.
   */
  vectorSql(name: string, index: VectorIndexDef): { from: string; where: string[] } & ({ distance: string } | { vector: string });
  /** Encodes a query vector for the `?` in vectorSql().distance. */
  encodeVector(vector: number[]): unknown;
  /** Session settings for a vector search returning up to `limit` documents (pgvector's HNSW scan). */
  vectorSetup?(tx: Exec, limit: number): Promise<void>;
  /** Updates vector indexes after a document write (SQLite keeps them in separate tables). */
  syncVector?(tx: Exec, docId: string, entries: { name: string; vector: number[] | null }[]): Promise<void>;
}

export function checkPath(path: string): string {
  if (!FIELD_PATH.test(path)) throw new Error(`Invalid field path "${path}": use names like "author" or "profile.name".`);
  return path;
}

/** A stored table name: an app table, or a component's as "<mount>.<table>". */
export const STORED_TABLE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

export function tableLiteral(table: string): string {
  if (!STORED_TABLE.test(table)) throw new Error(`Invalid table name "${table}".`);
  return `'${table}'`;
}

const SYSTEM = { _creationTime: "ct", _id: "id" } as Record<string, string>;
export const systemKind = (path: string): ValueKind | null =>
  path === "_creationTime" ? "ct" : path === "_id" ? "id" : null;

function sqliteEncode(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return value;
}

/** System tables for built-in auth (credentials, sessions, one-time codes, failed attempts). */
const authDdl = (time: string) => [
  `CREATE TABLE IF NOT EXISTS _auth_accounts (provider TEXT NOT NULL, account_id TEXT NOT NULL, user_id TEXT NOT NULL, secret TEXT, created ${time} NOT NULL, PRIMARY KEY (provider, account_id))`,
  "CREATE INDEX IF NOT EXISTS _auth_accounts_user ON _auth_accounts(user_id)",
  `CREATE TABLE IF NOT EXISTS _auth_sessions (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, created ${time} NOT NULL, expires ${time} NOT NULL, last_used ${time} NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS _auth_sessions_user ON _auth_sessions(user_id)",
  `CREATE TABLE IF NOT EXISTS _auth_codes (code_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, expires ${time} NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS _auth_attempts ("key" TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start ${time} NOT NULL)`,
];

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Compares by Unicode code point, which matches SQLite's binary collation on UTF-8 text. */
function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(i)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
    if (ca > 0xffff) i++;
  }
  return sign(a.length - b.length);
}

function compareSystem(a: unknown, b: unknown, kind: ValueKind): number | null | undefined {
  if (kind === "ct") return typeof a === "number" && typeof b === "number" ? sign(a - b) : null;
  if (kind === "id") return typeof a === "string" && typeof b === "string" ? compareCodePoints(a, b) : null;
  return undefined;
}

/** SQLite orders NULL < numbers (booleans are 0/1) < text. Objects and arrays are left undecided. */
function sqliteCompare(a: unknown, b: unknown, kind: ValueKind): number | null {
  const sys = compareSystem(a, b, kind);
  if (sys !== undefined) return sys;
  const norm = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? Number(v) : v);
  const rank = (v: unknown) => (v === null ? 0 : typeof v === "number" ? 1 : typeof v === "string" ? 2 : null);
  const x = norm(a);
  const y = norm(b);
  const rx = rank(x);
  const ry = rank(y);
  if (rx === null || ry === null) return null;
  if (rx !== ry) return sign(rx - ry);
  if (rx === 1) return sign((x as number) - (y as number));
  if (rx === 2) return compareCodePoints(x as string, y as string);
  return 0;
}

/**
 * jsonb orders string < number < boolean. Strings follow the database collation, so only
 * equal strings are decided; nulls (JSON null vs a missing field) are left undecided too.
 */
function postgresCompare(a: unknown, b: unknown, kind: ValueKind): number | null {
  const sys = compareSystem(a, b, kind);
  if (sys !== undefined) return sys;
  const rank = (v: unknown) => (typeof v === "string" ? 1 : typeof v === "number" ? 2 : typeof v === "boolean" ? 3 : null);
  const rx = rank(a);
  const ry = rank(b);
  if (rx === null || ry === null) return null;
  if (rx !== ry) return sign(rx - ry);
  if (rx === 1) return a === b ? 0 : null;
  return sign(Number(a) - Number(b));
}

export const sqliteDialect: Dialect = {
  name: "sqlite",
  field: (path) => SYSTEM[path] ?? `json_extract(doc, '$.${checkPath(path)}')`,
  numField: (path) => SYSTEM[path] ?? `json_extract(doc, '$.${checkPath(path)}')`,
  placeholder: () => "?",
  encode: (value) => sqliteEncode(value),
  decode: (value) => value,
  isNull: (expr) => `${expr} IS NULL`,
  isTrue: (expr) => `(${expr})`,
  distinct: (a, b) => `(${a} IS NOT ${b})`,
  compare: sqliteCompare,
  boolLiteral: (b) => (b ? "1" : "0"),
  parseDoc: (raw) => JSON.parse(raw as string),
  docPlaceholder: "?",
  ddl: [
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, ct REAL NOT NULL, doc TEXT NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS documents_by_creation_time ON documents(tbl, ct, id)",
    "CREATE TABLE IF NOT EXISTS _indexes (name TEXT PRIMARY KEY, def TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _scheduled (id TEXT PRIMARY KEY, fn TEXT NOT NULL, args TEXT NOT NULL, run_at REAL NOT NULL, state TEXT NOT NULL, error TEXT)",
    "CREATE INDEX IF NOT EXISTS _scheduled_pending ON _scheduled(state, run_at)",
    "CREATE TABLE IF NOT EXISTS _crons (name TEXT PRIMARY KEY, spec TEXT NOT NULL, next_run REAL NOT NULL, last_run REAL, last_error TEXT)",
    "CREATE TABLE IF NOT EXISTS _storage (id TEXT PRIMARY KEY, ct REAL NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, content_type TEXT)",
    "CREATE TABLE IF NOT EXISTS _upload_tokens (token TEXT PRIMARY KEY, expires REAL NOT NULL)",
    `CREATE TABLE IF NOT EXISTS _meta ("key" TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS _deployments (id TEXT PRIMARY KEY, created REAL NOT NULL, code TEXT NOT NULL, assets TEXT)",
    // Integer row ids for FTS5 tables (documents has text ids).
    "CREATE TABLE IF NOT EXISTS _search_ids (rid INTEGER PRIMARY KEY, doc_id TEXT NOT NULL UNIQUE)",
    ...authDdl("REAL"),
  ],
  createIndex: (name, table, columns) =>
    `CREATE INDEX "${name}" ON documents(${columns.join(", ")}) WHERE tbl = ${tableLiteral(table)}`,
  dropIndex: (name) => (/^[sv]x_/.test(name) ? `DROP TABLE IF EXISTS "${name}"` : `DROP INDEX IF EXISTS "${name}"`),
  searchIndex: (name, table, field) => {
    const path = `'$.${checkPath(field)}'`;
    const tbl = tableLiteral(table);
    const create = [
      `CREATE VIRTUAL TABLE "${name}" USING fts5(text, tokenize = 'unicode61 remove_diacritics 2')`,
      `INSERT OR IGNORE INTO _search_ids (doc_id) SELECT id FROM documents WHERE tbl = ${tbl} AND json_type(doc, ${path}) = 'text'`,
      `INSERT INTO "${name}" (rowid, text) SELECT s.rid, json_extract(d.doc, ${path}) FROM documents d ` +
        `JOIN _search_ids s ON s.doc_id = d.id WHERE d.tbl = ${tbl} AND json_type(d.doc, ${path}) = 'text'`,
    ];
    return { def: create.join(";\n"), create };
  },
  searchSql: (name) => ({
    from: `"${name}" JOIN _search_ids ON _search_ids.rid = "${name}".rowid JOIN documents ON documents.id = _search_ids.doc_id`,
    match: `"${name}" MATCH ?`,
    rank: `"${name}".rank`, // bm25: lower is better
    rankTakesQuery: false,
  }),
  searchQuery: (terms) => terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" OR "),
  async syncSearch(tx, docId, entries) {
    const row = await tx.get("SELECT rid FROM _search_ids WHERE doc_id = ?", [docId]);
    const indexed = entries.some((e) => e.text !== null);
    if (!row && !indexed) return;
    const rid = row?.rid ?? (await tx.get("INSERT INTO _search_ids (doc_id) VALUES (?) RETURNING rid", [docId]))!.rid;
    for (const e of entries) {
      if (row) await tx.run(`DELETE FROM "${e.name}" WHERE rowid = ?`, [rid]);
      if (e.text !== null) await tx.run(`INSERT INTO "${e.name}" (rowid, text) VALUES (?, ?)`, [rid, e.text]);
    }
    if (!indexed) await tx.run("DELETE FROM _search_ids WHERE rid = ?", [rid]);
  },
  // vector32() and vector_distance_cos() are built into libSQL; SqliteDriver adds them to bun:sqlite.
  vectorIndex: (name, table, index) => {
    const path = `'$.${checkPath(index.vectorField)}'`;
    const create = [
      `CREATE TABLE "${name}" (doc_id TEXT PRIMARY KEY, vec BLOB NOT NULL) WITHOUT ROWID`,
      `INSERT INTO "${name}" (doc_id, vec) SELECT id, vector32(json_extract(doc, ${path})) FROM documents ` +
        `WHERE tbl = ${tableLiteral(table)} AND json_type(doc, ${path}) = 'array' AND json_array_length(doc, ${path}) = ${index.dimensions}`,
    ];
    return { def: create.join(";\n"), create };
  },
  vectorSql: (name) => ({
    from: `"${name}" JOIN documents ON documents.id = "${name}".doc_id`,
    where: [],
    distance: `vector_distance_cos("${name}".vec, vector32(?))`,
  }),
  encodeVector: (vector) => JSON.stringify(vector),
  async syncVector(tx, docId, entries) {
    for (const e of entries) {
      if (e.vector) await tx.run(`INSERT OR REPLACE INTO "${e.name}" (doc_id, vec) VALUES (?, vector32(?))`, [docId, JSON.stringify(e.vector)]);
      else await tx.run(`DELETE FROM "${e.name}" WHERE doc_id = ?`, [docId]);
    }
  },
};

/** A float32 vector from JSON text ("[1, 2, 3]"), stored the way libSQL stores F32_BLOB values. */
export function vector32(json: unknown): Uint8Array {
  if (json instanceof Uint8Array) return json;
  const values = typeof json === "string" ? JSON.parse(json) : null;
  if (!Array.isArray(values) || values.some((x) => typeof x !== "number")) throw new Error("vector32() needs a JSON array of numbers.");
  return new Uint8Array(Float32Array.from(values).buffer);
}

const floats = (blob: Uint8Array) =>
  blob.byteOffset % 4 === 0 ? new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength >> 2) : new Float32Array(blob.slice().buffer);

/** Cosine distance (1 - cosine similarity) of two float32 vectors; 1 when either is all zeros, null when the sizes differ. */
export function vectorDistanceCos(a: Uint8Array | null, b: Uint8Array | null): number | null {
  if (!a || !b || a.byteLength !== b.byteLength) return null;
  return cosineDistance(floats(a), floats(b));
}

/** Cosine distance of two vectors of the same size; 1 when either is all zeros. */
export function cosineDistance(x: ArrayLike<number>, y: ArrayLike<number>): number {
  let dot = 0;
  let nx = 0;
  let ny = 0;
  for (let i = 0; i < x.length; i++) {
    dot += x[i]! * y[i]!;
    nx += x[i]! * x[i]!;
    ny += y[i]! * y[i]!;
  }
  return nx === 0 || ny === 0 ? 1 : 1 - dot / Math.sqrt(nx * ny);
}

const pgPath = (path: string) =>
  "doc" +
  checkPath(path)
    .split(".")
    .map((p) => ` -> '${p}'`)
    .join("");

/** Must match between the index and queries, character for character, for the index to be used. */
const pgSearchVector = (field: string) =>
  `to_tsvector('simple'::regconfig, coalesce(doc #>> '{${checkPath(field).split(".").join(",")}}', ''))`;

/** pgvector's HNSW index takes vectors of up to 2000 dimensions; larger ones are searched without an index. */
const PG_HNSW_MAX_DIMENSIONS = 2000;

/**
 * The document's vector as a pgvector value, or NULL when the field isn't an array of the right
 * size (so a stray value can't fail the index). Must match between the index and queries.
 */
const pgVector = (index: VectorIndexDef) => {
  const path = `'{${checkPath(index.vectorField).split(".").join(",")}}'`;
  const n = index.dimensions;
  return (
    `((CASE WHEN jsonb_typeof(doc #> ${path}) <> 'array' THEN NULL WHEN jsonb_array_length(doc #> ${path}) <> ${n} THEN NULL ` +
    `ELSE doc #>> ${path} END)::vector(${n}))`
  );
};

export const postgresDialect: Dialect = {
  name: "postgres",
  field: (path) => SYSTEM[path] ?? `(${pgPath(path)})`,
  numField: (path) => SYSTEM[path] ?? `((${pgPath(path).replace(/ -> ('[^']+')$/, " ->> $1")})::double precision)`,
  placeholder: (kind) => (kind === "json" ? "?::text::jsonb" : kind === "id" ? "?::text" : "?::double precision"),
  encode: (value, kind) => (kind === "json" ? JSON.stringify(value) : value),
  decode: (value) => value,
  // A JSON null is a jsonb value, not SQL NULL; treat both (and a missing field) as null.
  isNull: (expr, kind) => (kind === "json" ? `(${expr} IS NULL OR ${expr} = 'null'::jsonb)` : `${expr} IS NULL`),
  isTrue: (expr) => `(${expr} = 'true'::jsonb)`,
  distinct: (a, b) => `(${a} IS DISTINCT FROM ${b})`,
  compare: postgresCompare,
  boolLiteral: (b) => (b ? "TRUE" : "FALSE"),
  parseDoc: (raw) => (typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)),
  docPlaceholder: "?::text::jsonb",
  ddl: [
    "CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, ct DOUBLE PRECISION NOT NULL, doc JSONB NOT NULL)",
    "CREATE INDEX IF NOT EXISTS documents_by_creation_time ON documents(tbl, ct, id)",
    "CREATE TABLE IF NOT EXISTS _indexes (name TEXT PRIMARY KEY, def TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _scheduled (id TEXT PRIMARY KEY, fn TEXT NOT NULL, args TEXT NOT NULL, run_at DOUBLE PRECISION NOT NULL, state TEXT NOT NULL, error TEXT)",
    "CREATE INDEX IF NOT EXISTS _scheduled_pending ON _scheduled(state, run_at)",
    "CREATE TABLE IF NOT EXISTS _crons (name TEXT PRIMARY KEY, spec TEXT NOT NULL, next_run DOUBLE PRECISION NOT NULL, last_run DOUBLE PRECISION, last_error TEXT)",
    "CREATE TABLE IF NOT EXISTS _storage (id TEXT PRIMARY KEY, ct DOUBLE PRECISION NOT NULL, sha256 TEXT NOT NULL, size BIGINT NOT NULL, content_type TEXT)",
    "CREATE TABLE IF NOT EXISTS _upload_tokens (token TEXT PRIMARY KEY, expires DOUBLE PRECISION NOT NULL)",
    `CREATE TABLE IF NOT EXISTS _meta ("key" TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    "CREATE TABLE IF NOT EXISTS _deployments (id TEXT PRIMARY KEY, created DOUBLE PRECISION NOT NULL, code TEXT NOT NULL, assets TEXT)",
    ...authDdl("DOUBLE PRECISION"),
  ],
  createIndex: (name, table, columns) =>
    `CREATE INDEX "${name}" ON documents(${columns.join(", ")}) WHERE tbl = ${tableLiteral(table)}`,
  dropIndex: (name) => `DROP INDEX IF EXISTS "${name}"`,
  // An expression index over the documents table itself, so writes need no extra work.
  searchIndex: (name, table, field) => {
    const def = `CREATE INDEX "${name}" ON documents USING GIN (${pgSearchVector(field)}) WHERE tbl = ${tableLiteral(table)}`;
    return { def, create: [def] };
  },
  searchSql: (_name, field) => ({
    from: "documents",
    match: `${pgSearchVector(field)} @@ to_tsquery('simple'::regconfig, ?)`,
    rank: `ts_rank(${pgSearchVector(field)}, to_tsquery('simple'::regconfig, ?)) DESC`,
    rankTakesQuery: true,
  }),
  searchQuery: (terms) => terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(" | "),
  // Like search indexes, an expression index over the documents table (needs the pgvector extension).
  vectorIndex: (name, table, index) => {
    const create = ["CREATE EXTENSION IF NOT EXISTS vector"];
    if (index.dimensions <= PG_HNSW_MAX_DIMENSIONS) {
      create.push(`CREATE INDEX "${name}" ON documents USING hnsw (${pgVector(index)} vector_cosine_ops) WHERE tbl = ${tableLiteral(table)}`);
    }
    return { def: create.join(";\n"), create };
  },
  vectorSql: (_name, index) => ({
    from: "documents",
    where: [`${pgVector(index)} IS NOT NULL`],
    distance: `(${pgVector(index)} <=> ?::text::vector(${index.dimensions}))`,
  }),
  encodeVector: (vector) => JSON.stringify(vector),
  // An HNSW scan returns at most ef_search rows, and before pgvector 0.8 filters apply only to
  // those, so a filtered search could come back short. Iterative scans keep going until it's full.
  async vectorSetup(tx, limit) {
    await tx.get("SELECT set_config('hnsw.ef_search', ?, true)", [String(Math.max(40, limit))]);
    const ext = await tx.get("SELECT extversion FROM pg_extension WHERE extname = 'vector'");
    const [major = 0, minor = 0] = String(ext?.extversion ?? "0").split(".").map(Number);
    if (major > 0 || minor >= 8) await tx.get("SELECT set_config('hnsw.iterative_scan', 'strict_order', true)");
  },
};

/**
 * MySQL orders JSON values null < number < string < object < array < boolean, and strings by
 * their UTF-8 bytes (so by code point). Nulls (JSON null vs a missing field) are left undecided.
 */
function mysqlCompare(a: unknown, b: unknown, kind: ValueKind): number | null {
  const sys = compareSystem(a, b, kind);
  if (sys !== undefined) return sys;
  const rank = (v: unknown) => (typeof v === "number" ? 1 : typeof v === "string" ? 2 : typeof v === "boolean" ? 5 : null);
  const rx = rank(a);
  const ry = rank(b);
  if (rx === null || ry === null) return null;
  if (rx !== ry) return sign(rx - ry);
  if (rx === 2) return compareCodePoints(a as string, b as string);
  return sign(Number(a) - Number(b));
}

const myPath = (path: string) => `'$.${checkPath(path)}'`;

/** Text columns that are keys need a length in MySQL; binary collation compares them like the other databases do. */
const MY_TABLE = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin";
const MY_KEY = "VARCHAR(255)";

/**
 * MySQL 8 (not MariaDB, whose JSON is plain text and can't be ordered by value). It can't index
 * a JSON value, so .index() declarations are recorded but queries read the table's documents in
 * creation order and sort them; search uses FULLTEXT side tables, and vector search ranks in JS.
 */
export const mysqlDialect: Dialect = {
  name: "mysql",
  field: (path) => SYSTEM[path] ?? `JSON_EXTRACT(doc, ${myPath(path)})`,
  numField: (path) => SYSTEM[path] ?? `JSON_VALUE(doc, ${myPath(path)} RETURNING DOUBLE)`,
  placeholder: (kind) => (kind === "json" ? "CAST(? AS JSON)" : "?"),
  encode: (value, kind) => (kind === "json" ? JSON.stringify(value) : value),
  decode: (value) => value,
  isNull: (expr, kind) => (kind === "json" ? `(${expr} IS NULL OR ${expr} = CAST('null' AS JSON))` : `${expr} IS NULL`),
  isTrue: (expr) => `(${expr} = CAST('true' AS JSON))`,
  distinct: (a, b) => `(NOT (${a} <=> ${b}))`,
  compare: mysqlCompare,
  boolLiteral: (b) => (b ? "TRUE" : "FALSE"),
  parseDoc: (raw) => (typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)),
  docPlaceholder: "?",
  ddl: [
    `CREATE TABLE IF NOT EXISTS documents (id ${MY_KEY} PRIMARY KEY, tbl ${MY_KEY} NOT NULL, ct DOUBLE NOT NULL, doc JSON NOT NULL, KEY documents_by_creation_time (tbl, ct, id)) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _indexes (name ${MY_KEY} PRIMARY KEY, def TEXT NOT NULL) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _scheduled (id ${MY_KEY} PRIMARY KEY, fn ${MY_KEY} NOT NULL, args LONGTEXT NOT NULL, run_at DOUBLE NOT NULL, state VARCHAR(32) NOT NULL, error TEXT, KEY _scheduled_pending (state, run_at)) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _crons (name ${MY_KEY} PRIMARY KEY, spec TEXT NOT NULL, next_run DOUBLE NOT NULL, last_run DOUBLE, last_error TEXT) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _storage (id ${MY_KEY} PRIMARY KEY, ct DOUBLE NOT NULL, sha256 VARCHAR(64) NOT NULL, size BIGINT NOT NULL, content_type ${MY_KEY}) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _upload_tokens (token ${MY_KEY} PRIMARY KEY, expires DOUBLE NOT NULL) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _meta ("key" ${MY_KEY} PRIMARY KEY, value LONGTEXT NOT NULL) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _deployments (id ${MY_KEY} PRIMARY KEY, created DOUBLE NOT NULL, code LONGTEXT NOT NULL, assets LONGTEXT) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _auth_accounts (provider ${MY_KEY} NOT NULL, account_id ${MY_KEY} NOT NULL, user_id ${MY_KEY} NOT NULL, secret TEXT, created DOUBLE NOT NULL, PRIMARY KEY (provider, account_id), KEY _auth_accounts_user (user_id)) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _auth_sessions (id ${MY_KEY} PRIMARY KEY, token_hash ${MY_KEY} NOT NULL UNIQUE, user_id ${MY_KEY} NOT NULL, created DOUBLE NOT NULL, expires DOUBLE NOT NULL, last_used DOUBLE NOT NULL, KEY _auth_sessions_user (user_id)) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _auth_codes (code_hash ${MY_KEY} PRIMARY KEY, kind ${MY_KEY} NOT NULL, data TEXT NOT NULL, expires DOUBLE NOT NULL) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _auth_attempts ("key" ${MY_KEY} PRIMARY KEY, count INTEGER NOT NULL, window_start DOUBLE NOT NULL) ${MY_TABLE}`,
    `CREATE TABLE IF NOT EXISTS _commits (id ${MY_KEY} PRIMARY KEY, at DOUBLE NOT NULL, payload LONGTEXT NOT NULL, KEY _commits_at (at)) ${MY_TABLE}`,
  ],
  // Nothing to build (see above); DO 0 is MySQL's no-op statement.
  createIndex: () => "DO 0",
  dropIndex: (name) => (/^[sv]x_/.test(name) ? `DROP TABLE IF EXISTS "${name}"` : "DO 0"),
  // FULLTEXT can't index a JSON expression, so text is copied to a side table (case- and accent-insensitive).
  searchIndex: (name, table, field) => {
    const path = myPath(field);
    const create = [
      `CREATE TABLE "${name}" (doc_id ${MY_KEY} PRIMARY KEY, text LONGTEXT COLLATE utf8mb4_0900_ai_ci NOT NULL, FULLTEXT (text)) ${MY_TABLE}`,
      `INSERT INTO "${name}" (doc_id, text) SELECT id, JSON_UNQUOTE(JSON_EXTRACT(doc, ${path})) FROM documents ` +
        `WHERE tbl = ${tableLiteral(table)} AND JSON_TYPE(JSON_EXTRACT(doc, ${path})) = 'STRING'`,
    ];
    return { def: create.join(";\n"), create };
  },
  searchSql: (name) => ({
    from: `"${name}" JOIN documents ON documents.id = "${name}".doc_id`,
    match: `MATCH("${name}".text) AGAINST (? IN BOOLEAN MODE)`,
    rank: `MATCH("${name}".text) AGAINST (? IN BOOLEAN MODE) DESC`,
    rankTakesQuery: true,
  }),
  // Boolean mode matches any of the words; terms are only letters and digits, so need no escaping.
  searchQuery: (terms) => terms.map((t, i) => (i === terms.length - 1 ? `${t}*` : t)).join(" "),
  async syncSearch(tx, docId, entries) {
    for (const e of entries) {
      if (e.text !== null) await tx.run(`INSERT INTO "${e.name}" (doc_id, text) VALUES (?, ?) ON DUPLICATE KEY UPDATE text = VALUES(text)`, [docId, e.text]);
      else await tx.run(`DELETE FROM "${e.name}" WHERE doc_id = ?`, [docId]);
    }
  },
  // MySQL Community has no vector distance function, so the engine compares the vectors.
  vectorIndex: () => ({ def: "documents", create: [] }),
  vectorSql: (_name, index) => {
    const vector = `JSON_EXTRACT(doc, ${myPath(index.vectorField)})`;
    return { from: "documents", where: [`JSON_TYPE(${vector}) = 'ARRAY'`, `JSON_LENGTH(${vector}) = ${index.dimensions}`], vector };
  },
  encodeVector: (vector) => JSON.stringify(vector),
};

export { isIdForTable, newId } from "../ids";
