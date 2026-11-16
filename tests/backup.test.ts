// Backups: which snapshots are kept, that a snapshot is checked before it counts and before it
// replaces a database, encryption with $ONEBASE_SECRET_KEY, and what restore refuses to write.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { backupNow, listBackups, restore, snapshotsToDelete } from "../src/backup";
import { SqliteDriver } from "../src/engine/driver";
import { action, mutation, query } from "../src/server";
import { v } from "../src/values";
import { fakeS3 } from "./fake-s3";

test("retention keeps the newest snapshots, and the newest of each recent day", () => {
  const key = (day: number, hour: number) => `db/onebase-202611${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}0000Z.sqlite.gz`;
  const keys: string[] = [];
  for (let day = 1; day <= 10; day++) for (let hour = 0; hour < 24; hour++) keys.push(key(day, hour));
  const kept = (keep: number, daily: number) => {
    const gone = new Set(snapshotsToDelete(keys, keep, daily));
    return keys.filter((k) => !gone.has(k));
  };
  // The newest three, and the last of each of the three latest days.
  expect(kept(3, 3)).toEqual([key(8, 23), key(9, 23), key(10, 21), key(10, 22), key(10, 23)]);
  expect(kept(24, 7)).toHaveLength(24 + 6);
  expect(kept(2, 0)).toEqual([key(10, 22), key(10, 23)]);
  expect(snapshotsToDelete([], 24, 7)).toEqual([]);
});

describe("backup and restore", () => {
  const s3 = fakeS3();
  const dirs: string[] = [];
  const dir = (name: string) => (dirs.push(mkdtempSync(join(tmpdir(), `onebase-${name}-`))), dirs.at(-1)!);
  let app: Awaited<ReturnType<typeof startApp>>;
  let fileId: string;

  const modules = {
    notes: {
      add: mutation({ args: { text: v.string() }, handler: (ctx, args) => ctx.db.insert("notes", args) }),
      all: query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect() }),
      attach: action({ args: {}, handler: (ctx) => ctx.storage.store(new Blob(["file body"], { type: "text/plain" })) }),
    },
  };
  const texts = async (dbPath: string) => {
    const copy = new SqliteDriver(dbPath);
    const rows = copy.writer.query("SELECT doc FROM documents ORDER BY ct").all() as { doc: string }[];
    await copy.close();
    return rows.map((r) => JSON.parse(r.doc).text);
  };

  beforeAll(async () => {
    app = await startApp({ schema: null, modules, dataDir: dir("backup"), port: 0, hostname: "127.0.0.1", dev: true, quiet: true });
    await app.runtime.runMutation("notes:add", { text: "first" });
    fileId = (await app.runtime.runAction("notes:attach", {})) as string;
  });
  afterAll(async () => {
    delete process.env.ONEBASE_SECRET_KEY;
    await app.close();
    s3.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  test("a snapshot round-trips with its files, and leaves nothing behind next to the database", async () => {
    const url = s3.url("plain");
    const made = await backupNow(app.driver, url, 2, app.runtime.files.backend);
    expect(made.key).toEndWith(".sqlite.gz");
    expect(made.filesUploaded).toBe(1);
    expect(readdirSync(join((app.driver as SqliteDriver).path, "..")).filter((f) => f.includes("snapshot"))).toEqual([]);

    const to = dir("restore");
    const restored = await restore(url, join(to, "db.sqlite"), join(to, "files"));
    expect(restored).toEqual({ key: made.key, files: 1 });
    expect(await texts(join(to, "db.sqlite"))).toEqual(["first"]);
    expect(readFileSync(join(to, "files", fileId), "utf8")).toBe("file body");
    await expect(restore(url, join(to, "db.sqlite"), join(to, "files"))).rejects.toThrow("already exists");
  });

  test("restore writes only storage ids into the files folder", async () => {
    const url = s3.url("planted");
    await backupNow(app.driver, url, 2, app.runtime.files.backend);
    // What someone with write access to the bucket could add.
    for (const name of ["../../escaped", "sub/dir", "UPPER", "..", "ok123"]) s3.objects.set(`planted/files/${name}`, new TextEncoder().encode("planted"));

    const to = dir("restore");
    const restored = await restore(url, join(to, "data", "db.sqlite"), join(to, "data", "files"));
    expect(restored.files).toBe(2); // the real file and "ok123"
    expect(readdirSync(join(to, "data", "files")).sort()).toEqual([fileId, "ok123"].sort());
    expect(existsSync(join(to, "escaped"))).toBe(false);
    expect(readdirSync(to)).toEqual(["data"]);
  });

  test("a damaged backup is refused and leaves the existing database alone", async () => {
    const url = s3.url("damaged");
    const made = await backupNow(app.driver, url, 2);
    const to = dir("restore");
    await restore(url, join(to, "db.sqlite"), join(to, "files"));

    // A valid gzip of something that isn't a database.
    const junk = await new Response(new Blob(["x".repeat(20_000)]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    s3.objects.set(made.key, new Uint8Array(junk));
    await expect(restore(url, join(to, "db.sqlite"), join(to, "files"), { force: true })).rejects.toThrow("failed its integrity check");
    expect(await texts(join(to, "db.sqlite"))).toEqual(["first"]);
    expect(readdirSync(to).filter((f) => f.includes("restore-"))).toEqual([]);
  });

  test("with a secret key, backups are encrypted and need the same key to restore", async () => {
    const url = s3.url("sealed");
    process.env.ONEBASE_SECRET_KEY = "k".repeat(40);
    const made = await backupNow(app.driver, url, 2);
    expect(made.key).toEndWith(".sqlite.gz.enc");
    const stored = s3.objects.get(made.key)!;
    expect(new TextDecoder().decode(stored.subarray(0, 7))).toBe("OBENC1\n");
    expect(Buffer.from(stored).includes("first")).toBe(false);

    const to = dir("restore");
    const dbPath = join(to, "db.sqlite");
    process.env.ONEBASE_SECRET_KEY = "another-key-".repeat(4);
    await expect(restore(url, dbPath, join(to, "files"))).rejects.toThrow("can't be decrypted");
    delete process.env.ONEBASE_SECRET_KEY;
    await expect(restore(url, dbPath, join(to, "files"))).rejects.toThrow("is encrypted. Set $ONEBASE_SECRET_KEY");
    expect(existsSync(dbPath)).toBe(false);

    process.env.ONEBASE_SECRET_KEY = "k".repeat(40);
    await restore(url, dbPath, join(to, "files"));
    expect(await texts(dbPath)).toEqual(["first"]);
    expect((await listBackups(url)).map((b) => b.key)).toEqual([made.key]);
    delete process.env.ONEBASE_SECRET_KEY;
  });

  test("with a secret key, uploaded files are encrypted too, and ones backed up before the key are replaced", async () => {
    const url = s3.url("sealed-files");
    const fileKey = `sealed-files/files/${fileId}`;
    await backupNow(app.driver, url, 2, app.runtime.files.backend);
    expect(Buffer.from(s3.objects.get(fileKey)!).toString()).toBe("file body");

    process.env.ONEBASE_SECRET_KEY = "k".repeat(40);
    expect((await backupNow(app.driver, url, 2, app.runtime.files.backend)).filesUploaded).toBe(1);
    expect(s3.objects.has(fileKey)).toBe(false);
    const stored = s3.objects.get(`${fileKey}.enc`)!;
    expect(new TextDecoder().decode(stored.subarray(0, 7))).toBe("OBENC1\n");
    expect(Buffer.from(stored).includes("file body")).toBe(false);
    // Already there: nothing to upload the next time.
    expect((await backupNow(app.driver, url, 2, app.runtime.files.backend)).filesUploaded).toBe(0);

    const to = dir("restore");
    expect((await restore(url, join(to, "db.sqlite"), join(to, "files"))).files).toBe(1);
    expect(readFileSync(join(to, "files", fileId), "utf8")).toBe("file body");

    // Leave only a snapshot made without a key, so that what fails below is the file.
    for (const key of [...s3.objects.keys()]) if (key.startsWith("sealed-files/db/")) s3.objects.delete(key);
    delete process.env.ONEBASE_SECRET_KEY;
    await backupNow(app.driver, url, 2);
    const without = dir("restore");
    await expect(restore(url, join(without, "db.sqlite"), join(without, "files"))).rejects.toThrow("is encrypted. Set $ONEBASE_SECRET_KEY");
    process.env.ONEBASE_SECRET_KEY = "another-key-".repeat(4);
    const wrong = dir("restore");
    await expect(restore(url, join(wrong, "db.sqlite"), join(wrong, "files"))).rejects.toThrow("can't be decrypted");
    // Nothing half-written is left looking like a restored file.
    expect(readdirSync(join(wrong, "files"))).toEqual([]);
    delete process.env.ONEBASE_SECRET_KEY;
  });
});
