import type { SchemaDefinition } from "../schema";
import type { PaginationOptions, PaginationResult } from "../server";
import { describeValue, isPlainObject, validate, type AnyValidator } from "../values";
import { FIELD_PATH, isIdForTable, newId, systemKind, tableLiteral, type Dialect, type ValueKind } from "./dialect";
import type { Exec } from "./driver";

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

/** What one query read; used to decide which writes affect it. */
export type ReadRange = {
  table: string;
  /** Equality conditions every matching document satisfies. */
  eq: [path: string, value: unknown][];
  /** Index range conditions (gt/gte/lt/lte). */
  bounds?: { field: string; op: "gt" | "gte" | "lt" | "lte"; value: unknown }[];
  /** The slice of index order that was scanned: keys after `after`, up to and including `until`. */
  window?: { keys: string[]; order: "asc" | "desc"; after?: unknown[]; until?: unknown[] };
};
export type ReadSet = { ids: Set<string>; ranges: ReadRange[] };
export type Write = { table: string; id: string; before: Doc | null; after: Doc | null };

export type DbOptions = {
  tx: Exec;
  dialect: Dialect;
  schema: SchemaDefinition<any> | null;
  nextCreationTime: () => number;
  readSet?: ReadSet;
  writes?: Write[];
  onWarning?: (message: string) => void;
  explain?: (tx: Exec, sql: string, params: unknown[]) => Promise<string[]>;
  /** Query shapes already warned about (shared per runtime). */
  warned?: Set<string>;
};

export class OnebaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OnebaseError";
  }
}

// ---- Value helpers ----

function getPath(doc: Record<string, unknown>, path: string): unknown {
  let cur: any = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === undefined || a === null) && (b === undefined || b === null)) return true;
  if (typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

const BOUND_OK = { gt: (c: number) => c > 0, gte: (c: number) => c >= 0, lt: (c: number) => c < 0, lte: (c: number) => c <= 0 };

/** Lexicographic comparison of index keys; null when the dialect can't decide. */
function compareKeys(a: unknown[], b: unknown[], paths: string[], d: Dialect): number | null {
  for (let i = 0; i < paths.length; i++) {
    const c = d.compare(a[i], b[i], systemKind(paths[i]!) ?? "json");
    if (c !== 0) return c;
  }
  return 0;
}

/** Could `doc` be part of what the query read? Anything undecidable counts as yes. */
function inRange(range: ReadRange, doc: Doc | null, d: Dialect): boolean {
  if (!doc) return false;
  if (!range.eq.every(([p, v]) => sameValue(getPath(doc, p), v))) return false;
  for (const b of range.bounds ?? []) {
    const c = d.compare(getPath(doc, b.field), b.value, systemKind(b.field) ?? "json");
    if (c !== null && !BOUND_OK[b.op](c)) return false;
  }
  const w = range.window;
  if (w && (w.after || w.until)) {
    const key = w.keys.map((k) => getPath(doc, k));
    const dir = w.order === "asc" ? 1 : -1;
    if (w.after) {
      const c = compareKeys(key, w.after, w.keys, d);
      if (c !== null && c * dir <= 0) return false;
    }
    if (w.until) {
      const c = compareKeys(key, w.until, w.keys, d);
      if (c !== null && c * dir > 0) return false;
    }
  }
  return true;
}

/** Does this write possibly change the result of a query that read `range`? */
export function writeAffects(range: ReadRange, write: Write, dialect: Dialect): boolean {
  if (range.table !== write.table) return false;
  return inRange(range, write.before, dialect) || inRange(range, write.after, dialect);
}

/** Rejects values that cannot round-trip through JSON, with a hint on how to store them. */
function checkStorable(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new OnebaseError(`${path} is ${value}; only finite numbers can be stored.`);
    return;
  }
  if (value instanceof Date) {
    throw new OnebaseError(`${path} is a Date. Store a timestamp instead: date.getTime() with v.number().`);
  }
  if (Array.isArray(value)) return value.forEach((item, i) => checkStorable(item, `${path}[${i}]`));
  if (isPlainObject(value)) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new OnebaseError(`${path} is a ${proto?.constructor?.name ?? "class instance"}; only plain objects can be stored.`);
    }
    for (const [k, item] of Object.entries(value)) {
      if (item !== undefined) checkStorable(item, `${path}.${k}`);
    }
    return;
  }
  throw new OnebaseError(`${path} is a ${typeof value}, which can't be stored. Use strings, numbers, booleans, null, arrays or objects.`);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value));
}

// ---- Filter expressions ----

type Expr =
  | { __expr: true; op: "field"; path: string }
  | { __expr: true; op: "lit"; value: unknown }
  | { __expr: true; op: string; args: Expr[] };

const lit = (value: unknown): Expr => ({ __expr: true, op: "lit", value });
const toExpr = (x: unknown): Expr => (typeof x === "object" && x !== null && (x as any).__expr ? (x as Expr) : lit(x));
const node = (op: string, args: unknown[]): Expr => ({ __expr: true, op, args: args.map(toExpr) });

export const filterBuilder = {
  field: (path: string): Expr => {
    if (path !== "_id" && path !== "_creationTime" && !FIELD_PATH.test(path)) {
      throw new OnebaseError(`q.field("${path}"): invalid field path.`);
    }
    return { __expr: true, op: "field", path };
  },
  eq: (a: unknown, b: unknown) => node("eq", [a, b]),
  neq: (a: unknown, b: unknown) => node("neq", [a, b]),
  lt: (a: unknown, b: unknown) => node("lt", [a, b]),
  lte: (a: unknown, b: unknown) => node("lte", [a, b]),
  gt: (a: unknown, b: unknown) => node("gt", [a, b]),
  gte: (a: unknown, b: unknown) => node("gte", [a, b]),
  and: (...xs: unknown[]) => node("and", xs),
  or: (...xs: unknown[]) => node("or", xs),
  not: (x: unknown) => node("not", [x]),
  add: (a: unknown, b: unknown) => node("add", [a, b]),
  sub: (a: unknown, b: unknown) => node("sub", [a, b]),
  mul: (a: unknown, b: unknown) => node("mul", [a, b]),
  div: (a: unknown, b: unknown) => node("div", [a, b]),
  mod: (a: unknown, b: unknown) => node("mod", [a, b]),
  neg: (a: unknown) => node("neg", [a]),
};

const COMPARE: Record<string, string> = { lt: "<", lte: "<=", gt: ">", gte: ">=" };
const ARITH: Record<string, string> = { add: "+", sub: "-", mul: "*", div: "/", mod: "%" };
const isNullLit = (e: Expr) => e.op === "lit" && ((e as any).value === null || (e as any).value === undefined);
const isArith = (e: Expr) => e.op in ARITH || e.op === "neg";

/** Compiles filter expressions to SQL, binding each literal with the type of what it's compared to. */
class ExprCompiler {
  constructor(
    private readonly d: Dialect,
    readonly params: unknown[],
  ) {}

  private kindOf(e: Expr, numeric: boolean): ValueKind | null {
    if (e.op === "field") return systemKind((e as any).path) ?? (numeric ? "num" : "json");
    if (isArith(e)) return "num";
    return null;
  }

  private operand(e: Expr, kind: ValueKind): string {
    if (e.op === "field") {
      const path = (e as any).path;
      return kind === "num" ? this.d.numField(path) : this.d.field(path);
    }
    if (e.op === "lit") {
      this.params.push(this.d.encode((e as any).value, kind));
      return this.d.placeholder(kind);
    }
    if (isArith(e)) return this.arith(e);
    return this.bool(e);
  }

  private arith(e: Expr): string {
    const args = (e as any).args as Expr[];
    if (e.op === "neg") return `(-${this.operand(args[0]!, "num")})`;
    return `(${this.operand(args[0]!, "num")} ${ARITH[e.op]} ${this.operand(args[1]!, "num")})`;
  }

  bool(e: Expr): string {
    const d = this.d;
    if (e.op === "lit") return d.boolLiteral(Boolean((e as any).value));
    if (e.op === "field") return d.name === "postgres" ? `(${d.field((e as any).path)} = 'true'::jsonb)` : `(${d.field((e as any).path)})`;
    const args = (e as any).args as Expr[];
    switch (e.op) {
      case "and":
        return args.length ? `(${args.map((a) => this.bool(a)).join(" AND ")})` : d.boolLiteral(true);
      case "or":
        return args.length ? `(${args.map((a) => this.bool(a)).join(" OR ")})` : d.boolLiteral(false);
      case "not":
        return `(NOT ${this.bool(args[0]!)})`;
      case "eq":
      case "neq":
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        const [a, b] = args as [Expr, Expr];
        const numeric = isArith(a) || isArith(b);
        const kind = this.kindOf(a, numeric) ?? this.kindOf(b, numeric) ?? "json";
        if ((e.op === "eq" || e.op === "neq") && (isNullLit(a) || isNullLit(b))) {
          const other = this.operand(isNullLit(a) ? b : a, kind);
          const test = d.isNull(other, kind);
          return e.op === "eq" ? `(${test})` : `(NOT ${test})`;
        }
        const sa = this.operand(a, kind);
        const sb = this.operand(b, kind);
        if (e.op === "eq") return `(${sa} = ${sb})`;
        if (e.op === "neq") return d.name === "postgres" ? `(${sa} IS DISTINCT FROM ${sb})` : `(${sa} IS NOT ${sb})`;
        return `(${sa} ${COMPARE[e.op]} ${sb})`;
      }
      default:
        if (isArith(e)) throw new OnebaseError(`.filter() needs a comparison, e.g. q.gt(q.add(...), 10), not a bare number.`);
        throw new OnebaseError(`Unknown filter operator "${e.op}".`);
    }
  }
}

/** Top-level `field == value` conditions, which every matching document must satisfy. */
function equalityConditions(e: Expr): [string, unknown][] {
  if (e.op === "and") return ((e as any).args as Expr[]).flatMap(equalityConditions);
  if (e.op === "eq") {
    const [a, b] = (e as any).args as Expr[];
    if (a!.op === "field" && b!.op === "lit") return [[(a as any).path, (b as any).value]];
    if (b!.op === "field" && a!.op === "lit") return [[(b as any).path, (a as any).value]];
  }
  return [];
}

// ---- Cursors ----

function encodeCursor(key: unknown[]): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

function decodeCursor(cursor: string): unknown[] {
  try {
    const key = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(key)) return key;
  } catch {}
  throw new OnebaseError(`Invalid pagination cursor. Pass null for the first page, then the continueCursor you got back.`);
}

// ---- Queries ----

type Cond = { field: string; op: "eq" | "gt" | "gte" | "lt" | "lte"; value: unknown };

class QueryImpl {
  private indexName: string | null = null;
  private indexFields: string[] = [];
  private rangeConds: Cond[] = [];
  private filters: Expr[] = [];
  private direction: "asc" | "desc" = "asc";

  constructor(
    private readonly db: DatabaseImpl,
    private readonly table: string,
  ) {}

  withIndex(indexName: string, range?: (q: any) => unknown) {
    if (this.indexName) throw new OnebaseError(`.withIndex() can only be called once per query.`);
    const fields = this.db.indexFields(this.table, indexName);
    this.indexName = indexName;
    this.indexFields = fields;
    if (range) {
      const conds: Cond[] = [];
      const b: any = {};
      for (const op of ["eq", "gt", "gte", "lt", "lte"] as const) {
        b[op] = (field: string, value: unknown) => {
          conds.push({ field, op, value });
          return b;
        };
      }
      range(b);
      this.checkRange(conds);
      this.rangeConds = conds;
    }
    return this;
  }

  private checkRange(conds: Cond[]) {
    const fields = this.indexFields;
    const where = `index "${this.indexName}" on "${this.table}" (fields: ${fields.join(", ")})`;
    let pos = 0;
    let i = 0;
    for (; i < conds.length && conds[i]!.op === "eq"; i++, pos++) {
      const cond = conds[i]!;
      if (cond.field !== fields[pos]) {
        throw new OnebaseError(
          fields.includes(cond.field)
            ? `.eq("${cond.field}") is out of order for ${where}. Call .eq() on fields in index order: ${fields.join(" → ")}.`
            : `"${cond.field}" is not part of ${where}. Use .filter() for other fields, or add it to the index.`,
        );
      }
    }
    for (; i < conds.length; i++) {
      const cond = conds[i]!;
      if (cond.op === "eq") {
        throw new OnebaseError(`.eq("${cond.field}") must come before range conditions (gt/gte/lt/lte) for ${where}.`);
      }
      if (cond.field !== fields[pos]) {
        throw new OnebaseError(
          `Range condition on "${cond.field}" is not allowed for ${where}. ` +
            `After the .eq() conditions, only "${fields[pos] ?? "(no more fields)"}" can have gt/gte/lt/lte. Use .filter() otherwise.`,
        );
      }
    }
    const lower = conds.filter((c) => c.op === "gt" || c.op === "gte").length;
    const upper = conds.filter((c) => c.op === "lt" || c.op === "lte").length;
    if (lower > 1 || upper > 1) {
      throw new OnebaseError(`Use at most one lower bound (gt/gte) and one upper bound (lt/lte) for ${where}.`);
    }
  }

  fullTableScan() {
    return this;
  }

  order(direction: "asc" | "desc") {
    if (direction !== "asc" && direction !== "desc") {
      throw new OnebaseError(`.order() takes "asc" or "desc", got ${describeValue(direction)}.`);
    }
    this.direction = direction;
    return this;
  }

  filter(predicate: unknown) {
    if (typeof predicate === "function") {
      const result = predicate(filterBuilder);
      if (!result || typeof result !== "object" || !(result as any).__expr) {
        throw new OnebaseError(
          `.filter() callback must return a q expression, e.g. .filter(q => q.eq(q.field("done"), false)).\n` +
            `It receives a filter builder, not a document. For plain JS filtering use (await query.collect()).filter(doc => ...), ` +
            `or the shorthand .filter({ done: false }).`,
        );
      }
      this.filters.push(result as Expr);
    } else if (isPlainObject(predicate)) {
      const parts = Object.entries(predicate)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => filterBuilder.eq(filterBuilder.field(k), v));
      if (parts.length) this.filters.push(filterBuilder.and(...parts));
    } else {
      throw new OnebaseError(`.filter() takes a callback (q => q.eq(...)) or an object ({ field: value }).`);
    }
    return this;
  }

  /** Ordering key: the index fields, then creation time, then id as a tiebreaker. */
  private keys(): { sql: string; kind: ValueKind }[] {
    const d = this.db.dialect;
    const fields = this.indexFields.filter((f) => f !== "_creationTime");
    return [...fields.map((f) => ({ sql: d.field(f), kind: (systemKind(f) ?? "json") as ValueKind })), { sql: "ct", kind: "ct" }, { sql: "id", kind: "id" }];
  }

  private async run(opts: { limit?: number; cursor?: string | null; endCursor?: string | null }) {
    const d = this.db.dialect;
    const params: unknown[] = [];
    const where = [`tbl = ${tableLiteral(this.table)}`];
    for (const cond of this.rangeConds) {
      const kind = systemKind(cond.field) ?? "json";
      const col = d.field(cond.field);
      if (cond.op === "eq" && (cond.value === null || cond.value === undefined)) {
        where.push(d.isNull(col, kind));
      } else {
        where.push(`${col} ${{ eq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" }[cond.op]} ${d.placeholder(kind)}`);
        params.push(d.encode(cond.value, kind));
      }
    }
    const compiler = new ExprCompiler(d, params);
    for (const f of this.filters) where.push(compiler.bool(f));

    const keys = this.keys();
    const dir = this.direction === "asc" ? "ASC" : "DESC";
    const bound = (cursor: string, op: string) => {
      const key = decodeCursor(cursor);
      if (key.length !== keys.length) throw new OnebaseError("This cursor belongs to a different query.");
      where.push(`(${keys.map((k) => k.sql).join(", ")}) ${op} (${keys.map((k) => d.placeholder(k.kind)).join(", ")})`);
      params.push(...key.map((v, i) => d.encode(v, keys[i]!.kind)));
    };
    if (opts.cursor) bound(opts.cursor, this.direction === "asc" ? ">" : "<");
    if (opts.endCursor) bound(opts.endCursor, this.direction === "asc" ? "<=" : ">=");

    const select = keys.map((k, i) => `${k.sql} AS k${i}`).join(", ");
    let sql = `SELECT id, ct, doc, ${select} FROM documents WHERE ${where.join(" AND ")} ORDER BY ${keys.map((k) => `${k.sql} ${dir}`).join(", ")}`;
    if (opts.limit !== undefined) {
      sql += ` LIMIT ${Math.floor(opts.limit)}`;
    }

    await this.db.checkPlan(sql, params, this.table, this.filters);
    const rows = (await this.db.tx.all(sql, params)).map((row) => ({
      doc: { _id: row.id, _creationTime: Number(row.ct), ...d.parseDoc(row.doc) } as Doc,
      key: keys.map((k, i) => (k.kind === "ct" ? Number(row[`k${i}`]) : d.decode(row[`k${i}`], k.kind))),
    }));
    // The scan covered keys after the cursor, up to the end cursor or the last row of a full page.
    const full = opts.limit !== undefined && rows.length > 0 && rows.length === opts.limit;
    this.recordRead({
      after: opts.cursor ? decodeCursor(opts.cursor) : undefined,
      until: opts.endCursor ? decodeCursor(opts.endCursor) : full ? rows[rows.length - 1]!.key : undefined,
    });
    return rows;
  }

  private recordRead(scanned: { after?: unknown[]; until?: unknown[] }) {
    if (!this.db.readSet) return;
    const eq: [string, unknown][] = this.rangeConds.filter((c) => c.op === "eq").map((c) => [c.field, c.value]);
    for (const f of this.filters) eq.push(...equalityConditions(f));
    const bounds = this.rangeConds.filter((c) => c.op !== "eq") as NonNullable<ReadRange["bounds"]>;
    const fields = this.indexFields.filter((f) => f !== "_creationTime");
    this.db.readSet.ranges.push({
      table: this.table,
      eq,
      bounds,
      window: { keys: [...fields, "_creationTime", "_id"], order: this.direction, ...scanned },
    });
  }

  async collect(): Promise<Doc[]> {
    return (await this.run({})).map((r) => r.doc);
  }

  async take(n: number): Promise<Doc[]> {
    if (!Number.isInteger(n) || n < 0) throw new OnebaseError(`.take(n) needs a non-negative integer, got ${describeValue(n)}.`);
    return (await this.run({ limit: n })).map((r) => r.doc);
  }

  async first(): Promise<Doc | null> {
    return (await this.run({ limit: 1 }))[0]?.doc ?? null;
  }

  async unique(): Promise<Doc | null> {
    const rows = await this.run({ limit: 2 });
    if (rows.length > 1) {
      throw new OnebaseError(
        `.unique() found more than one "${this.table}" document (e.g. ${rows[0]!.doc._id} and ${rows[1]!.doc._id}). ` +
          `Use .first() if any match is fine.`,
      );
    }
    return rows[0]?.doc ?? null;
  }

  async paginate(options: PaginationOptions): Promise<PaginationResult<Doc>> {
    if (!options || typeof options.numItems !== "number") {
      throw new OnebaseError(
        `.paginate() needs { numItems, cursor }. Take it from your args: args: { paginationOpts: paginationOptsValidator }.`,
      );
    }
    const cursor = options.cursor || null;
    if (options.endCursor) {
      const rows = await this.run({ cursor, endCursor: options.endCursor });
      return { page: rows.map((r) => r.doc), isDone: false, continueCursor: options.endCursor };
    }
    const rows = await this.run({ cursor, limit: options.numItems + 1 });
    const isDone = rows.length <= options.numItems;
    const page = rows.slice(0, options.numItems);
    const last = page[page.length - 1];
    return {
      page: page.map((r) => r.doc),
      isDone,
      continueCursor: last ? encodeCursor(last.key) : (cursor ?? ""),
    };
  }

  async *[Symbol.asyncIterator]() {
    for (const doc of await this.collect()) yield doc;
  }
}

// ---- Database ----

export class DatabaseImpl {
  readonly tx: Exec;
  readonly dialect: Dialect;
  readonly readSet?: ReadSet;
  private readonly schema: SchemaDefinition<any> | null;
  private readonly writes?: Write[];
  private readonly onWarning?: (message: string) => void;
  private readonly explain?: DbOptions["explain"];
  private readonly nextCreationTime: () => number;

  constructor(opts: DbOptions) {
    this.tx = opts.tx;
    this.dialect = opts.dialect;
    this.schema = opts.schema;
    this.readSet = opts.readSet;
    this.writes = opts.writes;
    this.onWarning = opts.onWarning;
    this.explain = opts.explain;
    this.nextCreationTime = opts.nextCreationTime;
    this.warned = opts.warned ?? new Set();
  }

  private checkTable(table: unknown): string {
    if (typeof table !== "string") {
      throw new OnebaseError(`Expected a table name string, got ${describeValue(table)}.`);
    }
    if (this.schema && !(table in this.schema.tables)) {
      const known = Object.keys(this.schema.tables).join(", ") || "(none)";
      throw new OnebaseError(`Table "${table}" is not in schema.ts. Known tables: ${known}. Add it with defineTable() first.`);
    }
    return table;
  }

  indexFields(table: string, indexName: string): string[] {
    if (indexName === "by_creation_time") return ["_creationTime"];
    const def = this.schema?.tables[table];
    const index = def?.indexes.find((i: { name: string }) => i.name === indexName);
    if (!index) {
      const names = ["by_creation_time", ...(def?.indexes.map((i: { name: string }) => i.name) ?? [])].join(", ");
      throw new OnebaseError(
        `Index "${indexName}" doesn't exist on "${table}". Available: ${names}. ` +
          `Add it in schema.ts: defineTable({...}).index("${indexName}", ["field"]).`,
      );
    }
    return index.fields;
  }

  private readonly warned: Set<string>;

  /** Warns once per query shape when filters can't use an index. */
  async checkPlan(sql: string, params: unknown[], table: string, filters: Expr[]) {
    if (!this.onWarning || filters.length === 0 || this.warned.has(sql)) return;
    this.warned.add(sql);
    const fields = [...new Set(filters.flatMap(equalityConditions).map(([f]) => f))];
    let indexed: boolean;
    if (this.explain) {
      const plan = await this.explain(this.tx, sql, params);
      indexed = plan.some((line) => line.includes(`cl_${table}__`));
    } else {
      // Without a query planner to ask, check whether some index starts with a filtered field.
      const indexes = (this.schema?.tables[table]?.indexes ?? []) as { fields: string[] }[];
      indexed = indexes.some((i) => fields.includes(i.fields[0]!));
    }
    if (indexed) return;
    const hint = fields.length
      ? `Add .index("by_${fields.join("_")}", [${fields.map((f) => `"${f}"`).join(", ")}]) to "${table}" in schema.ts and it will be used automatically.`
      : `Consider an index on the fields you filter by.`;
    this.onWarning(`Query on "${table}" reads every document to apply .filter(). ${hint}`);
  }

  private validateDoc(table: string, value: Record<string, unknown>) {
    const tableDef = this.schema?.tables[table];
    if (!tableDef || !this.schema?.schemaValidation) return;
    const errors = validate(tableDef.validator as AnyValidator, value, "document");
    if (errors.length) {
      throw new OnebaseError(`Invalid "${table}" document:\n  - ${errors.join("\n  - ")}`);
    }
  }

  private prepareValue(table: string, value: unknown, verb: string): Record<string, unknown> {
    if (!isPlainObject(value)) throw new OnebaseError(`db.${verb}() needs an object, got ${describeValue(value)}.`);
    for (const sys of ["_id", "_creationTime"]) {
      if (sys in value && value[sys] !== undefined) {
        throw new OnebaseError(`Don't pass "${sys}" to db.${verb}(); it is set automatically.`);
      }
    }
    checkStorable(value, "document");
    const clean = stripUndefined(value);
    this.validateDoc(table, clean);
    return clean;
  }

  private async loadRaw(id: string): Promise<{ table: string; doc: Doc } | null> {
    const row = await this.tx.get("SELECT id, tbl, ct, doc FROM documents WHERE id = ?", [id]);
    if (!row) return null;
    return { table: row.tbl, doc: { _id: row.id, _creationTime: Number(row.ct), ...this.dialect.parseDoc(row.doc) } };
  }

  private requireId(id: unknown, verb: string): string {
    if (typeof id !== "string" || id.length === 0) {
      throw new OnebaseError(`db.${verb}() needs a document id (string), got ${describeValue(id)}.`);
    }
    return id;
  }

  // -- DatabaseReader --

  async get(id: unknown): Promise<Doc | null> {
    const docId = this.requireId(id, "get");
    this.readSet?.ids.add(docId);
    return (await this.loadRaw(docId))?.doc ?? null;
  }

  query(table: unknown) {
    return new QueryImpl(this, this.checkTable(table));
  }

  /** Synchronous, like Convex: ids carry a tag for their table. */
  normalizeId(table: string, id: string): string | null {
    this.checkTable(table);
    return isIdForTable(id, table) ? id : null;
  }

  // -- DatabaseWriter --

  async insert(table: unknown, value: unknown): Promise<string> {
    const t = this.checkTable(table);
    const doc = this.prepareValue(t, value, "insert");
    const id = newId(t);
    const ct = this.nextCreationTime();
    await this.tx.run(`INSERT INTO documents (id, tbl, ct, doc) VALUES (?, ?, ?, ${this.dialect.docPlaceholder})`, [id, t, ct, JSON.stringify(doc)]);
    this.writes?.push({ table: t, id, before: null, after: { _id: id, _creationTime: ct, ...doc } });
    return id;
  }

  private async existing(id: unknown, verb: string) {
    const docId = this.requireId(id, verb);
    const raw = await this.loadRaw(docId);
    if (!raw) throw new OnebaseError(`db.${verb}(): document "${docId}" doesn't exist (it may have been deleted).`);
    return { id: docId, table: raw.table, doc: raw.doc };
  }

  private async writeDoc(table: string, before: Doc, fields: Record<string, unknown>) {
    await this.tx.run(`UPDATE documents SET doc = ${this.dialect.docPlaceholder} WHERE id = ?`, [JSON.stringify(fields), before._id]);
    this.writes?.push({ table, id: before._id, before, after: { _id: before._id, _creationTime: before._creationTime, ...fields } });
  }

  async patch(id: unknown, value: unknown): Promise<void> {
    const { table, doc } = await this.existing(id, "patch");
    if (!isPlainObject(value)) throw new OnebaseError(`db.patch() needs an object, got ${describeValue(value)}.`);
    const { _id, _creationTime, ...current } = doc;
    for (const sys of ["_id", "_creationTime"] as const) {
      if (value[sys] !== undefined && value[sys] !== doc[sys]) {
        throw new OnebaseError(`db.patch() can't change "${sys}".`);
      }
    }
    const { _id: _a, _creationTime: _b, ...changes } = value;
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    await this.writeDoc(table, doc, this.prepareValue(table, merged, "patch"));
  }

  async replace(id: unknown, value: unknown): Promise<void> {
    const { table, doc } = await this.existing(id, "replace");
    if (isPlainObject(value)) {
      const { _id, _creationTime, ...rest } = value;
      if (_id !== undefined && _id !== doc._id) throw new OnebaseError(`db.replace() can't change "_id".`);
      value = rest;
    }
    await this.writeDoc(table, doc, this.prepareValue(table, value, "replace"));
  }

  async delete(id: unknown): Promise<void> {
    const { id: docId, table, doc } = await this.existing(id, "delete");
    await this.tx.run("DELETE FROM documents WHERE id = ?", [docId]);
    this.writes?.push({ table, id: docId, before: doc, after: null });
  }
}

/** A read-only view: what a query's ctx.db exposes. */
export function readerView(db: DatabaseImpl) {
  return {
    get: db.get.bind(db),
    query: db.query.bind(db),
    normalizeId: db.normalizeId.bind(db),
    ...Object.fromEntries(
      ["insert", "patch", "replace", "delete"].map((m) => [
        m,
        () => {
          throw new OnebaseError(`ctx.db.${m}() isn't available in a query. Queries are read-only; move writes into a mutation.`);
        },
      ]),
    ),
  };
}

export function writerView(db: DatabaseImpl) {
  return {
    ...readerView(db),
    insert: db.insert.bind(db),
    patch: db.patch.bind(db),
    replace: db.replace.bind(db),
    delete: db.delete.bind(db),
  };
}

/** Creates the indexes declared in the schema and drops the ones that were removed. */
export async function applySchema(
  tx: Exec,
  dialect: Dialect,
  schema: SchemaDefinition<any> | null,
): Promise<{ created: string[]; dropped: string[] }> {
  const wanted = new Map<string, string>();
  for (const [table, def] of Object.entries(schema?.tables ?? {})) {
    for (const index of (def as any).indexes as { name: string; fields: string[] }[]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(index.name)) {
        throw new Error(`Invalid index name "${index.name}" on table "${table}".`);
      }
      const name = `cl_${table}__${index.name}`;
      const columns = [...index.fields.map((f) => dialect.field(f)), "ct", "id"];
      wanted.set(name, dialect.createIndex(name, table, columns));
    }
  }
  const existing = new Map((await tx.all("SELECT name, def FROM _indexes")).map((r) => [r.name as string, r.def as string]));
  const created: string[] = [];
  const dropped: string[] = [];
  for (const [name, def] of existing) {
    if (wanted.get(name) !== def) {
      await tx.run(`DROP INDEX IF EXISTS "${name}"`);
      await tx.run("DELETE FROM _indexes WHERE name = ?", [name]);
      dropped.push(name);
    }
  }
  for (const [name, def] of wanted) {
    if (existing.get(name) === def) continue;
    await tx.run(`DROP INDEX IF EXISTS "${name}"`); // left over from an older version
    await tx.run(def);
    await tx.run("INSERT INTO _indexes (name, def) VALUES (?, ?)", [name, def]);
    created.push(name);
  }
  return { created, dropped };
}
