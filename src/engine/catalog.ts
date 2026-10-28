// Every table the engine knows: the app's (schema.ts) and each mounted component's. Component
// tables are stored as "<mount>.<table>", a name app tables can't have, so the two never collide.

import type { SchemaDefinition, TableDefinition } from "../schema";
import { OnebaseError } from "./database";

/** A mount name: what `defineComponents({ <name>: ... })` calls a component. */
export const MOUNT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** The name a table is stored under: "messages" for the app, "limiter.rateLimits" for a component. */
export const storedTable = (mount: string | null, table: string) => (mount ? `${mount}.${table}` : table);

/** The component that owns a stored table, or null for an app table. */
export const tableMount = (stored: string) => {
  const dot = stored.indexOf(".");
  return dot === -1 ? null : stored.slice(0, dot);
};

/** Postgres truncates identifiers to 63 bytes (MySQL allows 64), so longer names get a hash. */
const MAX_IDENT = 63;

/**
 * The name of an index or index side table. Short names read as `cl_<table>__<index>` (a
 * component table's dot becomes `$`); longer ones are cut and end in a hash, so two can't clash.
 * Changing this renames, and so rebuilds, every index: keep it stable.
 */
export function indexIdent(prefix: "cl" | "sx" | "vx", table: string, index: string): string {
  const name = `${prefix}_${table.replace(/\./g, "$")}__${index}`;
  if (Buffer.byteLength(name) <= MAX_IDENT) return name;
  const hash = new Bun.CryptoHasher("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.slice(0, MAX_IDENT - 9)}_${hash}`;
}

/** The app schema plus every mounted component's tables, under their stored names. */
export type Catalog = SchemaDefinition<Record<string, TableDefinition<any, any, any, any>>> & {
  /** No schema.ts: the app may use any table, unvalidated. */
  readonly open: boolean;
};

export type MountedSchema = { mount: string; schema: SchemaDefinition<any> };

/** Null when there is nothing to check: no schema.ts and no components. */
export function buildCatalog(app: SchemaDefinition<any> | null, mounts: MountedSchema[]): Catalog | null {
  if (!app && !mounts.length) return null;
  const tables: Record<string, TableDefinition<any, any, any, any>> = { ...(app?.tables ?? {}) };
  for (const { mount, schema } of mounts) {
    for (const [name, def] of Object.entries(schema.tables)) tables[storedTable(mount, name)] = def as TableDefinition;
  }
  return { tables, schemaValidation: app?.schemaValidation ?? true, open: !app, __isOnebaseSchema: true };
}

/** Component tables are always validated; app tables when schema.ts says so. */
export const validatesTable = (catalog: Catalog, stored: string) => catalog.schemaValidation || tableMount(stored) !== null;

/** Which tables a database handle may use: the app's, one component's, or (the dashboard) all. */
export class TableScope {
  private constructor(readonly mount: string | null | "*") {}

  static readonly app = new TableScope(null);
  static readonly admin = new TableScope("*");
  static component(mount: string) {
    return new TableScope(mount);
  }

  /** The stored name for a table this scope names, or an error listing the tables it can use. */
  table(name: string, catalog: Catalog | null): string {
    if (this.mount === "*") return name;
    if (this.mount === null) {
      if (name.includes(".")) {
        throw new OnebaseError(`Table "${name}" belongs to component "${tableMount(name)}"; call its functions with ctx.components.${tableMount(name)} instead.`);
      }
      if (catalog && !catalog.open && !(name in catalog.tables)) {
        const known = Object.keys(catalog.tables).filter((t) => tableMount(t) === null);
        throw new OnebaseError(`Table "${name}" is not in schema.ts. Known tables: ${known.join(", ") || "(none)"}. Add it with defineTable() first.`);
      }
      return name;
    }
    const stored = storedTable(this.mount, name);
    if (!catalog || !(stored in catalog.tables)) {
      const own = Object.keys(catalog?.tables ?? {}).filter((t) => tableMount(t) === this.mount).map((t) => t.slice(this.mount!.length + 1));
      throw new OnebaseError(`Table "${name}" isn't in component "${this.mount}"'s schema. Its tables: ${own.join(", ") || "(none)"}.`);
    }
    return stored;
  }

  /** May this scope read and write documents stored in `stored`? */
  owns(stored: string): boolean {
    if (this.mount === "*") return true;
    return tableMount(stored) === this.mount;
  }
}
