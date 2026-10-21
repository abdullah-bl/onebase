// SQL differences between SQLite/libSQL and Postgres. Every query is written with `?`
// placeholders; the Postgres driver renumbers them to $1, $2...

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
  boolLiteral(b: boolean): string;
  parseDoc(raw: unknown): Record<string, unknown>;
  docPlaceholder: string;
  /** Schema for system tables. */
  ddl: string[];
  createIndex(name: string, table: string, columns: string[]): string;
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

export const sqliteDialect: Dialect = {
  name: "sqlite",
  field: (path) => SYSTEM[path] ?? `json_extract(doc, '$.${checkPath(path)}')`,
  numField: (path) => SYSTEM[path] ?? `json_extract(doc, '$.${checkPath(path)}')`,
  placeholder: () => "?",
  encode: (value) => sqliteEncode(value),
  decode: (value) => value,
  isNull: (expr) => `${expr} IS NULL`,
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
  ],
  createIndex: (name, table, columns) =>
    `CREATE INDEX "${name}" ON documents(${columns.join(", ")}) WHERE tbl = ${tableLiteral(table)}`,
};

const pgPath = (path: string) =>
  "doc" +
  checkPath(path)
    .split(".")
    .map((p) => ` -> '${p}'`)
    .join("");

export const postgresDialect: Dialect = {
  name: "postgres",
  field: (path) => SYSTEM[path] ?? `(${pgPath(path)})`,
  numField: (path) => SYSTEM[path] ?? `((${pgPath(path).replace(/ -> ('[^']+')$/, " ->> $1")})::double precision)`,
  placeholder: (kind) => (kind === "json" ? "?::text::jsonb" : kind === "id" ? "?::text" : "?::double precision"),
  encode: (value, kind) => (kind === "json" ? JSON.stringify(value) : value),
  decode: (value) => value,
  // A JSON null is a jsonb value, not SQL NULL; treat both (and a missing field) as null.
  isNull: (expr, kind) => (kind === "json" ? `(${expr} IS NULL OR ${expr} = 'null'::jsonb)` : `${expr} IS NULL`),
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
  ],
  createIndex: (name, table, columns) =>
    `CREATE INDEX "${name}" ON documents(${columns.join(", ")}) WHERE tbl = ${tableLiteral(table)}`,
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
