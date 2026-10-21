// Starts a server from a loaded (or embedded) project.

import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { serve, type AssetResolver } from "./engine/http";
import { startBackups, type BackupOptions } from "./backup";
import { createDriver } from "./engine/driver";
import { LocalBlobs, parseS3Url, S3Blobs } from "./engine/files";
import { consoleLogger, Runtime, type Authenticate, type Modules } from "./engine/runtime";
import type { SchemaDefinition } from "./schema";
import type { Crons, HttpRouter } from "./server";
import { clientBundle } from "./client/bundle.generated";

export const VERSION = "0.1.0";

export type AppOptions = {
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http?: HttpRouter | null;
  authenticate?: Authenticate | null;
  crons?: Crons | null;
  dataDir: string;
  /** Database URL: a SQLite path (default <dataDir>/db.sqlite), postgres://… or libsql://… */
  db?: string;
  /** s3://bucket/prefix to keep files in S3 (default: <dataDir>/files). */
  files?: string;
  /** Periodic SQLite backups to S3. */
  backup?: BackupOptions;
  /** Public base URL (for file URLs); defaults to http://localhost:<port>. */
  siteUrl?: string;
  port: number;
  hostname: string;
  dev: boolean;
  assets?: AssetResolver | null;
  quiet?: boolean;
};

/** Serves files from a directory, falling back to index.html for client-side routes. */
export function directoryAssets(dirInput: string): AssetResolver {
  const root = resolve(dirInput);
  return (pathname) => {
    const decoded = decodeURIComponent(pathname);
    let file = resolve(join(root, decoded));
    if (file !== root && !file.startsWith(root + sep)) return null;
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (existsSync(file)) return new Response(Bun.file(file));
    if (!extname(decoded) && existsSync(join(root, "index.html"))) return new Response(Bun.file(join(root, "index.html")));
    return null;
  };
}

/** Serves files embedded in a compiled binary (pathname → embedded file path). */
export function embeddedAssets(files: Record<string, string>): AssetResolver {
  return (pathname) => {
    const path = pathname.endsWith("/") ? pathname + "index.html" : pathname;
    const file = files[path] ?? (!extname(path) ? files["/index.html"] : undefined);
    return file ? new Response(Bun.file(file)) : null;
  };
}

export async function startApp(opts: AppOptions) {
  const driver = createDriver(opts.db ?? join(opts.dataDir, "db.sqlite"));
  const blobs = opts.files ? new S3Blobs(parseS3Url(opts.files)) : new LocalBlobs(join(opts.dataDir, "files"));
  const runtime = new Runtime({
    driver,
    blobs,
    schema: opts.schema,
    modules: opts.modules,
    http: opts.http,
    authenticate: opts.authenticate,
    crons: opts.crons?.jobs ?? [],
    dev: opts.dev,
    log: consoleLogger,
  });
  const { created, dropped } = await runtime.init();
  const server = serve({ runtime, port: opts.port, hostname: opts.hostname, assets: opts.assets, clientBundle });
  const host = opts.hostname === "0.0.0.0" ? "localhost" : opts.hostname;
  runtime.siteUrl = (opts.siteUrl ?? `http://${host}:${server.port}`).replace(/\/$/, "");
  await runtime.startScheduler();
  const backups = opts.backup ? startBackups(driver, opts.backup, runtime.log, blobs) : null;

  if (!opts.quiet) {
    const names = [...runtime.functions.keys()];
    console.log(`\x1b[1monebase\x1b[0m v${VERSION}${opts.dev ? " (dev)" : ""}`);
    console.log(`  functions  ${names.length}${names.length ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""})` : ""}`);
    if (created.length || dropped.length) console.log(`  indexes    +${created.length} -${dropped.length}`);
    if (opts.crons?.jobs.length) console.log(`  crons      ${opts.crons.jobs.map((j) => j.name).join(", ")}`);
    console.log(`  database   ${driver.description}`);
    console.log(`  files      ${blobs.description}`);
    if (opts.backup) console.log(`  backups    ${opts.backup.url} every ${Math.round(opts.backup.everyMs / 60_000)} min, keep ${opts.backup.keep}`);
    console.log(`  http       http://${host}:${server.port}`);
    console.log(`  sync       ws://${host}:${server.port}/api/sync`);
  }

  const close = async () => {
    runtime.stop();
    backups?.stop();
    server.stop(true);
    await driver.close();
  };
  if (!opts.quiet) {
    const shutdown = () => void close().finally(() => process.exit(0));
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
  return { server, runtime, driver, close };
}
