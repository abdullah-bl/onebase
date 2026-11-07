// Environment variables set from the dashboard or `onebase env set`, kept in the database so
// every instance and restart sees them, and applied to process.env without a redeploy.
//
// A variable the server was started with (its environment or .env files) wins over a stored one
// of the same name: the stored one is kept but reported as overridden.

import { OnebaseError } from "./database";
import type { Exec } from "./driver";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME = 128;
const MAX_VALUE = 64 * 1024;

export type StoredEnvVar = { name: string; value: string; updated: number };

/** Throws a message saying how to fix a name or value that can't be stored. */
export function checkEnvVar(name: unknown, value?: unknown): asserts name is string {
  if (typeof name !== "string" || !NAME.test(name)) {
    throw new OnebaseError(`"${String(name)}" isn't a valid variable name: use letters, digits and _, not starting with a digit.`);
  }
  if (name.length > MAX_NAME) throw new OnebaseError(`${name.slice(0, 20)}…: variable names can be at most ${MAX_NAME} characters.`);
  if (/^ONEBASE_/i.test(name)) {
    throw new OnebaseError(`${name}: ONEBASE_* settings are read when the server starts. Set them in the server's environment instead.`);
  }
  if (value === undefined) return;
  if (typeof value !== "string") throw new OnebaseError(`${name}: the value must be a string.`);
  if (Buffer.byteLength(value) > MAX_VALUE) throw new OnebaseError(`${name}: values can be at most ${MAX_VALUE / 1024} KB.`);
}

export async function readEnvVars(tx: Exec): Promise<StoredEnvVar[]> {
  const rows = await tx.all(`SELECT name, value, updated FROM _env ORDER BY name`);
  return rows.map((r) => ({ name: r.name as string, value: r.value as string, updated: Number(r.updated) }));
}

/** Upserts `set` and deletes `remove`, in one transaction. Returns the names that changed. */
export async function writeEnvVars(tx: Exec, set: Record<string, string>, remove: string[], now: number): Promise<string[]> {
  const changed: string[] = [];
  for (const [name, value] of Object.entries(set)) {
    const row = await tx.get(`SELECT value FROM _env WHERE name = ?`, [name]);
    if (row && row.value === value) continue;
    if (row) await tx.run(`UPDATE _env SET value = ?, updated = ? WHERE name = ?`, [value, now, name]);
    else await tx.run(`INSERT INTO _env (name, value, updated) VALUES (?, ?, ?)`, [name, value, now]);
    changed.push(name);
  }
  for (const name of remove) {
    if ((await tx.run(`DELETE FROM _env WHERE name = ?`, [name])).changes) changed.push(name);
  }
  return changed;
}

/**
 * Keeps process.env in step with the stored variables. The names the process started with are
 * remembered once, before anything stored is applied, so they keep winning.
 */
export class EnvVars {
  private readonly startup: ReadonlySet<string>;
  /** The stored variables currently copied into the environment. */
  private applied = new Map<string, string>();

  /**
   * `env` is looked up on every use: Bun replaces the process.env object when a worker that
   * shares it starts, so a reference kept from before would stop reaching the real environment.
   */
  constructor(private readonly env: () => Record<string, string | undefined> = () => process.env) {
    const now = env();
    this.startup = new Set(Object.keys(now).filter((k) => now[k] !== undefined));
  }

  /** True when the server's own environment sets `name`, so a stored value is ignored. */
  overridden(name: string): boolean {
    return this.startup.has(name);
  }

  /** Copies `stored` into the environment (removing ones no longer stored). Returns the names whose value changed. */
  apply(stored: StoredEnvVar[]): string[] {
    const env = this.env();
    const next = new Map<string, string>();
    for (const v of stored) if (!this.startup.has(v.name)) next.set(v.name, v.value);
    const changed: string[] = [];
    for (const name of this.applied.keys()) {
      if (next.has(name)) continue;
      delete env[name];
      changed.push(name);
    }
    for (const [name, value] of next) {
      if (this.applied.get(name) === value && env[name] === value) continue;
      env[name] = value;
      changed.push(name);
    }
    this.applied = next;
    return changed;
  }
}

/** The process's one EnvVars: created at the first use, which must come before any stored value is applied. */
let shared: EnvVars | null = null;
export function processEnvVars(): EnvVars {
  return (shared ??= new EnvVars());
}
