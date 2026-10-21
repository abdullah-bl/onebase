// SQLite backups to S3: periodic consistent snapshots (VACUUM INTO), gzipped and uploaded,
// with old snapshots pruned. Local files (<data>/files) are synced incrementally next to them.

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newId } from "./engine/dialect";
import { SqliteDriver, type Driver } from "./engine/driver";
import { LocalBlobs, parseS3Url, type BlobBackend, type S3Location } from "./engine/files";
import type { Logger } from "./engine/runtime";

export type BackupOptions = { url: string; everyMs: number; keep: number };
export type BackupResult = { key: string; bytes: number; filesUploaded: number };

const SNAPSHOT_PREFIX = "db/onebase-";

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
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
export async function backupNow(driver: Driver, url: string, keep: number, blobs?: BlobBackend): Promise<BackupResult> {
  if (!(driver instanceof SqliteDriver) || driver.path === ":memory:") {
    throw new Error("S3 backups work with the SQLite driver. For Postgres or Turso, use your provider's backups.");
  }
  const loc = parseS3Url(url);
  const tmp = join(tmpdir(), `onebase-snapshot-${newId()}.sqlite`);
  try {
    await driver.snapshot(tmp);
    const key = `${loc.prefix}${SNAPSHOT_PREFIX}${stamp()}.sqlite.gz`;
    const gz = Bun.file(tmp).stream().pipeThrough(new CompressionStream("gzip"));
    await loc.client.write(key, new Response(gz), { type: "application/gzip" });
    const bytes = (await loc.client.file(key).stat()).size;

    // Keep the newest `keep` snapshots.
    const snapshots = (await listKeys(loc, SNAPSHOT_PREFIX)).map((o) => o.key).sort().reverse();
    for (const old of snapshots.slice(keep)) await loc.client.delete(old);

    // Files never change once written, so only new ones are uploaded.
    let filesUploaded = 0;
    if (blobs instanceof LocalBlobs && existsSync(blobs.dir)) {
      const remote = new Set((await listKeys(loc, "files/")).map((o) => o.key));
      for (const name of readdirSync(blobs.dir)) {
        const key = `${loc.prefix}files/${name}`;
        if (remote.has(key)) continue;
        await loc.client.write(key, Bun.file(join(blobs.dir, name)));
        filesUploaded++;
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
      const r = await backupNow(driver, opts.url, opts.keep, blobs);
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
  const plain = loc.client.file(chosen.key).stream().pipeThrough(new DecompressionStream("gzip"));
  await Bun.write(tmp, new Response(plain));
  for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  renameSync(tmp, dbPath);

  let files = 0;
  mkdirSync(filesDir, { recursive: true });
  for (const { key } of await listKeys(loc, "files/")) {
    const name = key.slice(`${loc.prefix}files/`.length);
    if (!name || existsSync(join(filesDir, name))) continue;
    await Bun.write(join(filesDir, name), loc.client.file(key));
    files++;
  }
  return { key: chosen.key, files };
}
