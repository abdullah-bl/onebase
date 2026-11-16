// SQLite backups to S3: periodic consistent snapshots (VACUUM INTO), checked, gzipped, encrypted
// when $ONEBASE_SECRET_KEY is set, and uploaded, with old snapshots pruned. Local files
// (<data>/files) are synced incrementally next to them.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { newId } from "./engine/dialect";
import { SqliteDriver, type Driver } from "./engine/driver";
import { LocalBlobs, parseS3Url, type BlobBackend, type S3Location } from "./engine/files";
import type { Logger } from "./engine/runtime";
import { decryptStream, encryptStream, SECRET_KEY_ENV, secretKey } from "./engine/secrets";

export type BackupOptions = { url: string; everyMs: number; keep: number; keepDaily?: number };
export const DEFAULT_KEEP_DAILY = 7;
export type BackupResult = { key: string; bytes: number; filesUploaded: number };

const SNAPSHOT_PREFIX = "db/onebase-";
/** Storage ids are lowercase letters and digits. */
const STORAGE_ID = /^[0-9a-z]+$/;

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * The snapshots to delete: everything but the newest `keep`, and the newest of each of the last
 * `keepDaily` days that have one. The hourly ones give a fine-grained recent past; the daily ones
 * are for the mistake noticed days later.
 */
export function snapshotsToDelete(keys: string[], keep: number, keepDaily: number): string[] {
  const newestFirst = [...keys].sort().reverse();
  const kept = new Set(newestFirst.slice(0, keep));
  const days = new Set<string>();
  for (const key of newestFirst) {
    const day = /onebase-(\d{8})T/.exec(key)?.[1];
    if (!day || days.has(day) || days.size >= keepDaily) continue;
    days.add(day);
    kept.add(key);
  }
  return newestFirst.filter((key) => !kept.has(key));
}

/** Throws unless the SQLite file at `path` is sound. quick_check skips the slow index comparison, which a copy can't get wrong. */
function checkDatabase(path: string, what: string) {
  let result: string;
  try {
    const db = new Database(path, { readonly: true });
    try {
      result = String((db.query("PRAGMA quick_check").get() as Record<string, unknown> | null)?.quick_check ?? "no answer");
    } finally {
      db.close();
    }
  } catch (err) {
    result = err instanceof Error ? err.message : String(err);
  }
  if (result !== "ok") throw new Error(`${what} failed its integrity check (${result}).`);
}

async function listKeys(loc: S3Location, prefix: string): Promise<{ key: string; size: number }[]> {
  const out: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const page: any = await loc.client.list({ prefix: loc.prefix + prefix, continuationToken: token, maxKeys: 1000 });
    for (const item of page.contents ?? []) out.push({ key: item.key, size: item.size ?? 0 });
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Takes one snapshot now. Only for the SQLite driver: Postgres and Turso have their own backups. */
export async function backupNow(driver: Driver, url: string, keep: number, blobs?: BlobBackend, keepDaily = DEFAULT_KEEP_DAILY): Promise<BackupResult> {
  if (!(driver instanceof SqliteDriver) || driver.path === ":memory:") {
    throw new Error("S3 backups work with the SQLite driver. For Postgres or Turso, use your provider's backups.");
  }
  const loc = parseS3Url(url);
  const secret = secretKey();
  // Next to the database, not in /tmp: that is often memory, and a snapshot is as big as the database.
  const tmp = join(dirname(driver.path), `.onebase-snapshot-${newId()}.sqlite`);
  try {
    await driver.snapshot(tmp);
    // A snapshot that can't be restored is worse than none: it would push a good one out.
    checkDatabase(tmp, "The snapshot");
    const key = `${loc.prefix}${SNAPSHOT_PREFIX}${stamp()}.sqlite.gz${secret ? ".enc" : ""}`;
    const gz = Bun.file(tmp).stream().pipeThrough(new CompressionStream("gzip"));
    await loc.client.write(key, new Response(secret ? gz.pipeThrough(encryptStream(secret)) : gz), { type: secret ? "application/octet-stream" : "application/gzip" });
    const bytes = (await loc.client.file(key).stat()).size;

    const snapshots = (await listKeys(loc, SNAPSHOT_PREFIX)).map((o) => o.key);
    for (const old of snapshotsToDelete(snapshots, keep, keepDaily)) await loc.client.delete(old);

    // Files never change once written, so only new ones are uploaded. With a secret key they are
    // encrypted like the snapshot (as <id>.enc), and a copy uploaded in the clear before the key was
    // set is replaced: otherwise "my backups are encrypted" would be true of new files only.
    let filesUploaded = 0;
    if (blobs instanceof LocalBlobs && existsSync(blobs.dir)) {
      const remote = new Set((await listKeys(loc, "files/")).map((o) => o.key));
      for (const name of readdirSync(blobs.dir)) {
        const plain = `${loc.prefix}files/${name}`;
        const key = secret ? `${plain}.enc` : plain;
        if (!remote.has(key)) {
          const file = Bun.file(join(blobs.dir, name));
          await loc.client.write(key, secret ? new Response(file.stream().pipeThrough(encryptStream(secret))) : file);
          filesUploaded++;
        }
        if (secret && remote.has(plain)) await loc.client.delete(plain);
      }
    }
    return { key, bytes, filesUploaded };
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function startBackups(driver: Driver, opts: BackupOptions, log: Logger, blobs?: BlobBackend) {
  if (!(driver instanceof SqliteDriver)) {
    throw new Error("--backup works with the SQLite driver. For Postgres or Turso, use your provider's backups.");
  }
  parseS3Url(opts.url); // validate early
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await backupNow(driver, opts.url, opts.keep, blobs, opts.keepDaily);
      log.info(`backup: ${r.key} (${(r.bytes / 1024).toFixed(1)} KB${r.filesUploaded ? `, +${r.filesUploaded} files` : ""})`);
    } catch (err) {
      log.error(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(run, 5_000);
  const timer = setInterval(run, opts.everyMs);
  return {
    run,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}

export async function listBackups(url: string): Promise<{ key: string; size: number }[]> {
  const loc = parseS3Url(url);
  return (await listKeys(loc, SNAPSHOT_PREFIX)).sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Downloads a snapshot (the newest, or the one whose key contains `at`) into `dbPath`,
 * plus any files missing from `filesDir`. Refuses to overwrite an existing database unless `force`.
 */
export async function restore(url: string, dbPath: string, filesDir: string, opts: { at?: string; force?: boolean } = {}) {
  const loc = parseS3Url(url);
  if (existsSync(dbPath) && statSync(dbPath).size > 0 && !opts.force) {
    throw new Error(`${dbPath} already exists. Stop the server and pass --force to overwrite it.`);
  }
  const snapshots = await listBackups(url);
  const chosen = opts.at ? snapshots.find((s) => s.key.includes(opts.at!)) : snapshots[0];
  if (!chosen) throw new Error(opts.at ? `No backup matching "${opts.at}" in ${loc.description}.` : `No backups found in ${loc.description}.`);

  mkdirSync(dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.restore-${newId()}`;
  let stored: ReadableStream<any> = loc.client.file(chosen.key).stream();
  if (chosen.key.endsWith(".enc")) {
    const secret = secretKey();
    if (!secret) throw new Error(`${chosen.key} is encrypted. Set $${SECRET_KEY_ENV} to the key the server had when it was made.`);
    stored = stored.pipeThrough(decryptStream(secret));
  }
  try {
    await Bun.write(tmp, new Response(stored.pipeThrough(new DecompressionStream("gzip"))));
    // Checked before it replaces anything: a damaged download leaves the database that was there.
    checkDatabase(tmp, `The backup ${chosen.key}`);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  renameSync(tmp, dbPath);

  let files = 0;
  mkdirSync(filesDir, { recursive: true });
  for (const { key } of await listKeys(loc, "files/")) {
    const stored = key.slice(`${loc.prefix}files/`.length);
    const sealed = stored.endsWith(".enc");
    const name = sealed ? stored.slice(0, -".enc".length) : stored;
    // Any key that isn't a storage id isn't one of ours, and a name like "../../x" would be
    // written outside the files folder.
    if (!STORAGE_ID.test(name) || existsSync(join(filesDir, name))) continue;
    if (!sealed) {
      await Bun.write(join(filesDir, name), loc.client.file(key));
    } else {
      const secret = secretKey();
      if (!secret) throw new Error(`The file ${key} is encrypted. Set $${SECRET_KEY_ENV} to the key the server had when it was backed up.`);
      // Under another name until it's whole: a file that fails to decrypt half way isn't left looking restored.
      const tmp = join(filesDir, `.restore-${newId()}`);
      try {
        await Bun.write(tmp, new Response(loc.client.file(key).stream().pipeThrough(decryptStream(secret))));
        renameSync(tmp, join(filesDir, name));
      } finally {
        rmSync(tmp, { force: true });
      }
    }
    files++;
  }
  return { key: chosen.key, files };
}
