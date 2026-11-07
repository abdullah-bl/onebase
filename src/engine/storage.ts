// Which onebase last opened a database, and in which storage format, so an upgrade can migrate
// the format forward and an older onebase refuses a database it can't read instead of damaging it.
//
// The format is a number in _meta, raised by each entry in MIGRATIONS. A release that changes how
// system tables or documents are stored adds one; the rest leave it alone.

import { compareVersions, VERSION } from "../version";
import { OnebaseError } from "./database";
import type { Dialect } from "./dialect";
import type { Driver, Exec } from "./driver";

export type Migration = {
  /** The format this migration produces (one more than the one before it). */
  version: number;
  description: string;
  run(tx: Exec, dialect: Dialect): Promise<void>;
};

/**
 * Format 1 is every database written before formats were recorded. New entries go at the end,
 * each in its own transaction; they must be safe to run on a database another instance of the
 * previous release is still using, or say in `description` that those must stop first.
 */
export const MIGRATIONS: Migration[] = [];

export const STORAGE_VERSION = 1 + MIGRATIONS.length;

export type StorageStamp = { version: number; onebase: string; updated: number };

const KEY = "storage";
const UPSERT = `INSERT INTO _meta ("key", value) VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET value = excluded.value`;

async function readStamp(tx: Exec): Promise<StorageStamp | null> {
  const row = await tx.get(`SELECT value FROM _meta WHERE "key" = ?`, [KEY]);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value as string);
    if (typeof parsed?.version === "number") return parsed as StorageStamp;
  } catch {}
  throw new OnebaseError(`The database's storage stamp (_meta "${KEY}") is unreadable: ${String(row.value).slice(0, 80)}`);
}

export type StorageCheck = {
  /** The onebase that opened this database before, if it recorded itself. */
  previous: string | null;
  /** Migrations run now, oldest first. */
  migrated: Migration[];
};

/**
 * Checks the database's format against this onebase, migrates it forward if it's older, and
 * records this version. Throws, changing nothing, when a newer onebase has already migrated it.
 */
export async function checkStorage(
  driver: Driver,
  opts: { version?: string; migrations?: Migration[]; log?: (msg: string) => void } = {},
): Promise<StorageCheck> {
  const version = opts.version ?? VERSION;
  const migrations = opts.migrations ?? MIGRATIONS;
  const target = 1 + migrations.length;
  const stamp = await driver.read(readStamp);
  const current = stamp?.version ?? 1;
  if (current > target) {
    throw new OnebaseError(
      `This database is in storage format ${current}, written by onebase ${stamp!.onebase}; this is onebase ${version}, which reads up to format ${target}. ` +
        `Run onebase ${stamp!.onebase} or newer, or restore a backup taken before the upgrade.`,
    );
  }
  const migrated: Migration[] = [];
  for (const m of migrations.slice(current - 1)) {
    opts.log?.(`Migrating the database to storage format ${m.version}: ${m.description}…`);
    await driver.write(async (tx) => {
      // Another instance may have run it in the meantime.
      if (((await readStamp(tx))?.version ?? 1) >= m.version) return;
      await m.run(tx, driver.dialect);
      await tx.run(UPSERT, [KEY, JSON.stringify({ version: m.version, onebase: version, updated: Date.now() } satisfies StorageStamp)]);
    });
    migrated.push(m);
  }
  // Records the newest onebase that opened it; an older one of the same format leaves the stamp alone.
  await driver.write(async (tx) => {
    const now = await readStamp(tx);
    if (now && now.version === target && compareVersions(now.onebase, version) >= 0) return;
    await tx.run(UPSERT, [KEY, JSON.stringify({ version: Math.max(target, now?.version ?? 1), onebase: version, updated: Date.now() } satisfies StorageStamp)]);
  });
  return { previous: stamp?.onebase ?? null, migrated };
}
