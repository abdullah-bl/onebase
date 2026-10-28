// Starts a server from a loaded (or embedded) project.

import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { RateLimiter, serve, type AssetResolver, type RateLimit } from "./engine/http";
import { startBackups, type BackupOptions } from "./backup";
import { createDriver } from "./engine/driver";
import { LocalBlobs, parseS3Url, S3Blobs } from "./engine/files";
import type { AuthConfig } from "./engine/jwt";
import { consoleLogger, Runtime, type Authenticate, type Modules } from "./engine/runtime";
import type { ComponentsDefinition } from "./components";
import type { SchemaDefinition } from "./schema";
import type { Crons, HttpRouter } from "./server";
import { clientBundle } from "./client/bundle.generated";
import { dashboardAssets } from "./dashboard/bundle.generated";
import { createAdmin, loadAdminKey } from "./engine/admin";
import { serveAsset } from "./engine/deployments";
import { importBundle } from "./deploy";

export const VERSION = "0.1.0";

export type AppOptions = {
  /** Serve the dashboard at /_admin (default true). */
  dashboard?: boolean;
  /** Accept `onebase deploy` and run what it pushed, instead of the code given here (default true; never in dev). */
  deploys?: boolean;
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http?: HttpRouter | null;
  /** auth.config.ts: sign-in methods, external providers and/or authenticate(token, ctx). */
  auth?: AuthConfig | null;
  /** A token verifier to use instead of the one built from `auth`. */
  authenticate?: Authenticate | null;
  crons?: Crons | null;
  /** components.ts's default export. */
  components?: ComponentsDefinition | null;
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
  /** Origins allowed to call the API from a browser (default: any). */
  cors?: string[];
  /** Per-IP limit on function calls, subscriptions and uploads. */
  rateLimit?: RateLimit | null;
  trustProxy?: boolean;
  /** How often open connections re-check their auth token, in ms (default 60s; 0 disables). */
  sessionRecheckMs?: number;
  /** Refuse a pushed bundle that takes longer than this to load (default 30s). */
  loadTimeoutMs?: number;
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
    auth: opts.auth,
    authenticate: opts.authenticate,
    crons: opts.crons?.jobs ?? [],
    components: opts.components ?? null,
    dev: opts.dev,
    log: consoleLogger,
    loadCode: opts.deploys === false ? null : importBundle,
    loadTimeoutMs: opts.loadTimeoutMs,
  });
  const { created, dropped } = await runtime.init();
  const adminKey = opts.dashboard === false ? null : loadAdminKey(opts.dataDir);
  const server = serve({
    runtime,
    port: opts.port,
    hostname: opts.hostname,
    // A deployment's own frontend, if it shipped one; otherwise the server's.
    assets: (path) => (runtime.deployment?.assets ? serveAsset(runtime.deployment.assets, path) : (opts.assets?.(path) ?? null)),
    clientBundle,
    cors: opts.cors,
    rateLimit: opts.rateLimit,
    trustProxy: opts.trustProxy,
    sessionRecheckMs: opts.sessionRecheckMs,
    admin: adminKey ? createAdmin({ runtime, key: adminKey.key, assets: dashboardAssets, version: VERSION }) : null,
  });
  const host = opts.hostname === "0.0.0.0" ? "localhost" : opts.hostname;
  runtime.siteUrl = (opts.siteUrl ?? `http://${host}:${server.port}`).replace(/\/$/, "");
  await runtime.startScheduler();
  const backups = opts.backup ? startBackups(driver, opts.backup, runtime.log, blobs) : null;

  if (!opts.quiet) {
    const names = [...runtime.functions.keys()].filter((n) => !n.startsWith("components/"));
    console.log(`\x1b[1monebase\x1b[0m v${VERSION}${opts.dev ? " (dev)" : ""}`);
    console.log(`  functions  ${names.length}${names.length ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", …" : ""})` : ""}`);
    if (created.length || dropped.length) console.log(`  indexes    +${created.length} -${dropped.length}`);
    if (runtime.deployment) {
      const d = runtime.deployment;
      console.log(`  deployment ${d.id}, pushed ${new Date(d.created).toLocaleString()}${d.assets ? ` (${d.assets.size} static files)` : ""}`);
    } else if (!names.length && opts.deploys !== false && !opts.dev) {
      console.log(`  \x1b[2mno functions yet: add some to ./onebase, or push them with onebase deploy\x1b[0m`);
    }
    if (runtime.mounts.size) {
      console.log(`  components ${[...runtime.mounts.values()].map((m) => `${m.name} (${m.definition.name})`).join(", ")}`);
    }
    if (runtime.cronJobs.length) console.log(`  crons      ${runtime.cronJobs.map((j) => j.name).join(", ")}`);
    if (runtime.auth) console.log(`  sign-in    ${runtime.auth.ids.join(", ")}`);
    console.log(`  database   ${driver.description}`);
    console.log(`  files      ${blobs.description}`);
    if (opts.backup) console.log(`  backups    ${opts.backup.url} every ${Math.round(opts.backup.everyMs / 60_000)} min, keep ${opts.backup.keep}`);
    if (opts.cors?.length && !opts.cors.includes("*")) console.log(`  cors       ${opts.cors.join(", ")}`);
    if (opts.rateLimit) console.log(`  rate limit ${new RateLimiter(opts.rateLimit).describe()} per IP${opts.trustProxy ? " (X-Forwarded-For)" : ""}`);
    console.log(`  http       http://${host}:${server.port}`);
    console.log(`  sync       ws://${host}:${server.port}/api/sync`);
    if (adminKey) {
      // In dev the key goes in the link (the #fragment never leaves the browser); otherwise say where it is.
      const link = `http://${host}:${server.port}/_admin`;
      console.log(`  dashboard  ${opts.dev ? `${link}#key=${adminKey.key}` : `${link} (admin key: ${adminKey.source})`}`);
    }
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
