// SQL differences between SQLite/libSQL and Postgres. Every query is written with `?`
// placeholders; the Postgres driver renumbers them to $1, $2...

import type { Exec } from "./driver";

export const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** What a compiled SQL expression holds, so parameters can be bound with the right type. */
export type ValueKind = "json" | "ct" | "id" | "num";

export interface Dialect {
  readonly name: "sqlite" | "postgres";
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
}

export function checkPath(path: string): string {
  if (!FIELD_PATH.test(path)) throw new Error(`Invalid field path "${path}": use names like "author" or "profile.name".`);
  return path;
}

export function tableLiteral(table: string): string {
  if (!IDENT.test(table)) throw new Error(`Invalid table name "${table}".`);
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
  `CREATE TABLE IF NOT EXISTS _auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start ${time} NOT NULL)`,
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
    "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS _deployments (id TEXT PRIMARY KEY, created REAL NOT NULL, code TEXT NOT NULL, assets TEXT)",
    // Integer row ids for FTS5 tables (documents has text ids).
    "CREATE TABLE IF NOT EXISTS _search_ids (rid INTEGER PRIMARY KEY, doc_id TEXT NOT NULL UNIQUE)",
    ...authDdl("REAL"),
  ],
  createIndex: (name, table, columns) =>
    `CREATE INDEX "${name}" ON documents(${columns.join(", ")}) WHERE tbl = ${tableLiteral(table)}`,
  dropIndex: (name) => (name.startsWith("sx_") ? `DROP TABLE IF EXISTS "${name}"` : `DROP INDEX IF EXISTS "${name}"`),
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
};

const pgPath = (path: string) =>
  "doc" +
  checkPath(path)
    .split(".")
    .map((p) => ` -> '${p}'`)
    .join("");

/** Must match between the index and queries, character for character, for the index to be used. */
const pgSearchVector = (field: string) =>
  `to_tsvector('simple'::regconfig, coalesce(doc #>> '{${checkPath(field).split(".").join(",")}}', ''))`;

export const postgresDialect: Dialect = {
  name: "postgres",
  field: (path) => SYSTEM[path] ?? `(${pgPath(path)})`,
  numField: (path) => SYSTEM[path] ?? `((${pgPath(path).replace(/ -> ('[^']+')$/, " ->> $1")})::double precision)`,
  placeholder: (kind) => (kind === "json" ? "?::text::jsonb" : kind === "id" ? "?::text" : "?::double precision"),
  encode: (value, kind) => (kind === "json" ? JSON.stringify(value) : value),
  decode: (value) => value,
  // A JSON null is a jsonb value, not SQL NULL; treat both (and a missing field) as null.
  isNull: (expr, kind) => (kind === "json" ? `(${expr} IS NULL OR ${expr} = 'null'::jsonb)` : `${expr} IS NULL`),
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
    "CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
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
};

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{20}$/;

/** 4 characters derived from the table name, so an id says which table it belongs to. */
function tableTag(table: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < table.length; i++) h = Math.imul(h ^ table.charCodeAt(i), 0x01000193) >>> 0;
  let tag = "";
  for (let i = 0; i < 4; i++, h >>>= 5) tag += ID_ALPHABET[h & 31];
  return tag;
}

/** A new random id: 16 random characters (80 bits), plus the table tag when a table is given. */
export function newId(table?: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(table ? 16 : 20));
  let id = "";
  for (const b of bytes) id += ID_ALPHABET[b & 31];
  return table ? id + tableTag(table) : id;
}

/** True if `id` is a well-formed id for `table` (no database lookup needed). */
export function isIdForTable(id: unknown, table: string): id is string {
  return typeof id === "string" && ID_PATTERN.test(id) && id.endsWith(tableTag(table));
}
