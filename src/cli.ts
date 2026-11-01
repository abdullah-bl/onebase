#!/usr/bin/env bun
// onebase command line. Also the entry point of the single-file binary.

import { existsSync, mkdirSync, readdirSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { directoryAssets, embeddedAssets, startApp, VERSION } from "./app";
import { backupNow, listBackups, restore } from "./backup";
import { codegen } from "./codegen";
import { deploy } from "./deploy";
import { doctor, printFindings } from "./doctor";
import { SqliteDriver } from "./engine/driver";
import { LocalBlobs } from "./engine/files";
import { parseRateLimit } from "./engine/http";
import type { AuthConfig } from "./engine/jwt";
import type { Modules } from "./engine/runtime";
import { loadEnv, withoutBunEnv } from "./env";
import { loadProject, projectEntry, type Project } from "./project";
import type { ComponentsDefinition } from "./components";
import type { SchemaDefinition } from "./schema";
import type { Crons, HttpRouter } from "./server";

/** A project compiled into the binary by `onebase build`. */
export type EmbeddedProject = {
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http: HttpRouter | null;
  authConfig: AuthConfig | null;
  crons: Crons | null;
  components: ComponentsDefinition | null;
  publicFiles: Record<string, string>;
};

const HELP = `onebase v${VERSION}: a lightweight, Convex-style reactive backend

Usage:
  onebase serve    Run the server
  onebase dev      Run the server, regenerate types and restart on changes
  onebase deploy   Push functions (and ./public) to a running server, with no restart
  onebase codegen  Write <dir>/_generated (typed api, server, dataModel)
  onebase doctor   Check schema and functions for common mistakes
  onebase build    Compile functions + frontend into one executable (from source)
  onebase backup   Take one SQLite snapshot to --backup now
  onebase backups  List snapshots in --backup
  onebase restore  Restore the newest snapshot (or --at <time>) into --data
  onebase vacuum   Shrink the SQLite file to the data it holds (stop the server first)

Options (each $NAME can also come from a .env file):
  --dir <path>      Functions directory (default: ./onebase, or $ONEBASE_DIR; a ported ./convex folder also works)
  --data <path>     Data directory (default: ./onebase_data, or $ONEBASE_DATA)
  --public <path>   Static frontend directory (default: ./public if it exists, or $ONEBASE_PUBLIC)
  --port <n>        Port (default: 8090, or $PORT)
  --host <addr>     Bind address (default: 0.0.0.0, or $ONEBASE_HOST)
  --url <url>       Public URL, used for file URLs (default: http://localhost:<port>, or $ONEBASE_URL)
                    deploy: the server to push to ($ONEBASE_DEPLOY_URL)
  --db <url>        Database: SQLite path (default <data>/db.sqlite), postgres://… or
                    libsql://… / https://… for Turso ($ONEBASE_DB, $DATABASE_URL)
  --files <s3url>   Keep uploaded files in S3/R2/MinIO: s3://bucket/prefix ($ONEBASE_FILES)
  --backup <s3url>  Back up SQLite to s3://bucket/prefix ($ONEBASE_BACKUP)
  --backup-every <d>  Backup interval, e.g. 15m, 1h, 1d (default: 1h, or $ONEBASE_BACKUP_EVERY)
  --backup-keep <n>   Snapshots to keep (default: 24, or $ONEBASE_BACKUP_KEEP)
  --cors <origins>  Browser origins allowed to call the API, comma-separated (default: any; $ONEBASE_CORS)
  --rate-limit <r>  Per-IP limit on function calls, e.g. 100/10s or 600/m (default: off; $ONEBASE_RATE_LIMIT)
  --trust-proxy     Take the client IP from X-Forwarded-For (when behind a reverse proxy; $ONEBASE_TRUST_PROXY=1)
  --at <time>       restore: snapshot to use, e.g. 20261022T0300 (default: newest)
  --force           restore: overwrite an existing database
  --no-dashboard    Don't serve the dashboard or admin API at /_admin, which also turns off deploys ($ONEBASE_DASHBOARD=off)
  --no-deploy       Refuse onebase deploy and run the local code, not what was pushed ($ONEBASE_DEPLOY=off)
  --dry-run         deploy: check the code against the server's data without changing anything
  --rollback        deploy: go back to the previous deployment
  --env-file <path> Read this .env file instead of the defaults (repeatable)
  --out <file>      Output file for build (default: ./app)
  --target <t>      Build target, e.g. bun-linux-x64, bun-linux-arm64, bun-darwin-arm64, bun-windows-x64

.env files: onebase dev reads .env, .env.local, .env.development and .env.development.local;
other commands read .env, .env.local, .env.production and .env.production.local. Later files win,
and real environment variables win over all of them.

deploy authenticates with $ONEBASE_DEPLOY_KEY: the server's admin key ($ONEBASE_ADMIN_KEY there,
or the contents of its onebase_data/admin.key).

S3 credentials come from S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION
(or the AWS_* equivalents), or as ?endpoint=…&region=… on the s3:// URL.
Turso tokens come from ?authToken=… or $TURSO_AUTH_TOKEN.
`;

/** Compiled binaries are built without bun's own .env loading; from source, bun has already done it. */
const COMPILED = Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");

const enabled = (value: string | undefined) => value !== undefined && ["1", "true", "yes", "on"].includes(value.toLowerCase());

/** For switches that default to on, like ONEBASE_DEPLOY: an unknown value is an error, so a typo can't leave it on. */
function off(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return true;
  if (enabled(value)) return false;
  throw new Error(`${name}=${value} isn't understood: use on or off.`);
}

/** Flags, then .env files, then environment variables, then defaults. */
function options(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      data: { type: "string" },
      public: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      url: { type: "string" },
      db: { type: "string" },
      files: { type: "string" },
      backup: { type: "string" },
      "backup-every": { type: "string" },
      "backup-keep": { type: "string" },
      cors: { type: "string" },
      "rate-limit": { type: "string" },
      "trust-proxy": { type: "boolean" },
      at: { type: "string" },
      force: { type: "boolean", default: false },
      "no-dashboard": { type: "boolean" },
      "no-deploy": { type: "boolean" },
      "dry-run": { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      "env-file": { type: "string", multiple: true },
      out: { type: "string", default: "./app" },
      target: { type: "string" },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const command = positionals[0];
  // `onebase dev` passes its flags to a `serve --dev` child, which reads the files (again on each restart).
  if (command !== "dev" && !values.help) {
    loadEnv({ mode: values.dev ? "development" : "production", files: values["env-file"], bunAutoloaded: !COMPILED });
  }
  const env = process.env;
  const port = Number(values.port ?? env.PORT ?? "8090");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number, got "${values.port ?? env.PORT}"`);
  const givenDir = values.dir ?? env.ONEBASE_DIR;
  return {
    ...values,
    command,
    // Default to ./onebase, but pick up ./convex in a project ported from Convex.
    dir: givenDir ?? (!existsSync("./onebase") && existsSync("./convex") ? "./convex" : "./onebase"),
    givenDir: givenDir !== undefined,
    data: values.data ?? env.ONEBASE_DATA ?? "./onebase_data",
    public: values.public ?? env.ONEBASE_PUBLIC,
    port,
    host: values.host ?? env.ONEBASE_HOST ?? "0.0.0.0",
    // For deploy, --url is the server to push to; its own public URL is a server setting.
    url: values.url ?? (command === "deploy" ? env.ONEBASE_DEPLOY_URL : env.ONEBASE_URL),
    db: values.db ?? env.ONEBASE_DB ?? env.DATABASE_URL,
    files: values.files ?? env.ONEBASE_FILES,
    backup: values.backup ?? env.ONEBASE_BACKUP,
    "backup-every": values["backup-every"] ?? env.ONEBASE_BACKUP_EVERY ?? "1h",
    "backup-keep": values["backup-keep"] ?? env.ONEBASE_BACKUP_KEEP ?? "24",
    cors: values.cors ?? env.ONEBASE_CORS,
    "rate-limit": values["rate-limit"] ?? env.ONEBASE_RATE_LIMIT,
    "trust-proxy": values["trust-proxy"] ?? enabled(env.ONEBASE_TRUST_PROXY),
    "no-dashboard": values["no-dashboard"] ?? off("ONEBASE_DASHBOARD", env.ONEBASE_DASHBOARD),
    "no-deploy": values["no-deploy"] ?? off("ONEBASE_DEPLOY", env.ONEBASE_DEPLOY),
  };
}

function duration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}": use e.g. 30m, 1h or 1d.`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

/** A time limit from $name: a duration, or off (0). Unset: the default. */
function timeLimit(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (["0", "off", "none"].includes(value.toLowerCase())) return 0;
  try {
    return duration(value);
  } catch {
    throw new Error(`${name}=${value} isn't understood: use e.g. 10s, 2m or off.`);
  }
}

/** Database, storage, backup and HTTP settings shared by `serve` and embedded binaries. */
function serverOptions(opts: ReturnType<typeof options>) {
  const keep = Number(opts["backup-keep"]);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--backup-keep must be a positive integer.`);
  return {
    db: opts.db,
    files: opts.files,
    backup: opts.backup ? { url: opts.backup, everyMs: duration(opts["backup-every"]), keep } : undefined,
    cors: opts.cors ? opts.cors.split(",").map((o) => o.trim()).filter(Boolean) : undefined,
    rateLimit: opts["rate-limit"] ? parseRateLimit(opts["rate-limit"]) : null,
    trustProxy: opts["trust-proxy"],
    dashboard: !opts["no-dashboard"],
    deploys: !opts["no-deploy"],
    timeLimits: {
      queryMs: timeLimit("ONEBASE_QUERY_TIMEOUT"),
      mutationMs: timeLimit("ONEBASE_MUTATION_TIMEOUT"),
      actionMs: timeLimit("ONEBASE_ACTION_TIMEOUT"),
    },
  };
}

function requireBackupUrl(opts: ReturnType<typeof options>): string {
  if (!opts.backup) throw new Error("Pass --backup s3://bucket/prefix (or set $ONEBASE_BACKUP).");
  return opts.backup;
}

/** The SQLite file --db (or --data) points at, or null when --db is a database URL. */
function sqliteFile(opts: ReturnType<typeof options>): string | null {
  const db = opts.db ?? join(opts.data, "db.sqlite");
  return /^[a-z]+:\/\//.test(db) ? null : db.replace(/^file:/, "");
}

/** The existing SQLite file a command works on. */
function requireSqliteFile(opts: ReturnType<typeof options>, command: string): string {
  const dbPath = sqliteFile(opts);
  if (!dbPath) throw new Error(`${command} works with a SQLite database file, not a database URL.`);
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  return dbPath;
}

async function backupCommand(opts: ReturnType<typeof options>) {
  const url = requireBackupUrl(opts);
  const dbPath = requireSqliteFile(opts, "backup");
  const driver = new SqliteDriver(dbPath);
  try {
    const blobs = opts.files ? undefined : new LocalBlobs(join(opts.data, "files"));
    const r = await backupNow(driver, url, Number(opts["backup-keep"]), blobs);
    console.log(`Uploaded ${r.key} (${(r.bytes / 1024).toFixed(1)} KB)${r.filesUploaded ? ` and ${r.filesUploaded} file(s)` : ""}.`);
  } finally {
    await driver.close();
  }
}

async function vacuumCommand(opts: ReturnType<typeof options>) {
  const dbPath = requireSqliteFile(opts, "vacuum");
  const driver = new SqliteDriver(dbPath);
  try {
    const bytes = () => {
      const space = driver.space();
      return { total: space.pages * space.pageSize, free: space.free * space.pageSize };
    };
    const before = bytes();
    const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
    console.log(`Vacuuming ${dbPath}: ${mb(before.total)}, ${mb(before.free)} of it free…`);
    await driver.vacuum();
    console.log(`Done: ${mb(bytes().total)}. The server now gives space from deleted documents back by itself.`);
  } finally {
    await driver.close();
  }
}

async function backupsCommand(opts: ReturnType<typeof options>) {
  const list = await listBackups(requireBackupUrl(opts));
  if (!list.length) return console.log("No backups yet.");
  for (const b of list) console.log(`${b.key}  ${(b.size / 1024).toFixed(1)} KB`);
}

async function restoreCommand(opts: ReturnType<typeof options>) {
  const dbPath = opts.db ?? join(opts.data, "db.sqlite");
  const r = await restore(requireBackupUrl(opts), dbPath, join(opts.data, "files"), { at: opts.at, force: opts.force });
  console.log(`Restored ${r.key} into ${dbPath}${r.files ? ` and ${r.files} file(s)` : ""}.`);
}

function publicDir(explicit: string | undefined): string | null {
  if (explicit) return explicit;
  return existsSync("./public") ? "./public" : null;
}

async function serveCommand(opts: ReturnType<typeof options>) {
  // A server that only runs what `onebase deploy` pushes needs no functions folder.
  const empty: Project = { dir: resolve(opts.dir), schema: null, modules: {}, http: null, crons: null, authConfig: null, components: null, sources: {} };
  const project = !opts.givenDir && !existsSync(opts.dir) && !opts.dev ? empty : await loadProject(opts.dir);
  const pub = publicDir(opts.public);
  await startApp({
    schema: project.schema,
    modules: project.modules,
    http: project.http,
    auth: project.authConfig,
    crons: project.crons,
    components: project.components,
    dataDir: opts.data,
    ...serverOptions(opts),
    port: opts.port,
    hostname: opts.host,
    siteUrl: opts.url,
    dev: opts.dev,
    assets: pub ? directoryAssets(pub) : null,
  });
}

/** The binary re-runs itself as the child; from source we re-run the script. */
function selfCommand(): string[] {
  return COMPILED ? [process.execPath] : [process.execPath, Bun.main];
}

async function devCommand(opts: ReturnType<typeof options>, argv: string[]) {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const childArgs = ["serve", "--dev", ...argv.filter((a) => a !== "dev")];
  // The child reads the .env files itself; give it the environment without bun's copy of them, so edits apply on restart.
  const childEnv = COMPILED ? { ...process.env } : withoutBunEnv(process.env);
  let child: ReturnType<typeof Bun.spawn> | null = null;

  const restart = async (reason?: string) => {
    try {
      const changed = await codegen(dir);
      if (changed.length) console.log(`\x1b[2mcodegen: updated ${changed.map((f) => relative(process.cwd(), f)).join(", ")}\x1b[0m`);
    } catch (err) {
      console.error(`codegen failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (child) {
      child.kill();
      await child.exited;
    }
    if (reason) console.log(`\x1b[2m${reason} changed, restarting…\x1b[0m`);
    child = Bun.spawn([...selfCommand(), ...childArgs], { stdio: ["inherit", "inherit", "inherit"], env: childEnv });
  };

  await restart();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const changed = (name: string) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart(name), 150);
  };
  watch(dir, { recursive: true }, (_event, file) => {
    const name = String(file ?? "").replace(/\\/g, "/");
    if (!name || name.startsWith("_generated") || name.includes("node_modules")) return;
    changed(name);
  });
  // The .env files are polled, not watched: a watch on the project root makes bun report writes in a
  // sibling folder like onebase_data/ as changes under `dir`, which restarts the server in a loop.
  const envFiles = () => {
    const found = new Map<string, string>();
    for (const name of readdirSync(process.cwd())) {
      if (!/^\.env(\..+)?$/.test(name)) continue;
      try {
        const stat = statSync(join(process.cwd(), name));
        found.set(name, `${stat.mtimeMs}:${stat.size}`);
      } catch {} // removed between the listing and the stat; the next poll sees it gone
    }
    return found;
  };
  let seen = envFiles();
  const poll = setInterval(() => {
    const now = envFiles();
    for (const name of new Set([...seen.keys(), ...now.keys()])) {
      if (seen.get(name) !== now.get(name)) changed(name);
    }
    seen = now;
  }, 500);
  poll.unref();
  const stop = () => {
    child?.kill();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Generates an entry file that statically imports the project, then compiles it. */
async function buildCommand(opts: ReturnType<typeof options>) {
  if (COMPILED) {
    throw new Error("`build` needs onebase's source (run it with bun from an installed package), not the prebuilt binary.");
  }
  const dir = resolve(opts.dir);
  await codegen(dir);
  const { imports, fields, files } = await projectEntry(dir);
  const pub = publicDir(opts.public);
  const lines: string[] = [`import { runEmbedded } from ${JSON.stringify(import.meta.path)};`, ...imports];
  const publicEntries: string[] = [];
  if (pub) {
    const root = resolve(pub);
    let i = 0;
    for await (const rel of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
      lines.push(`import f${i} from ${JSON.stringify(join(root, rel))} with { type: "file" };`);
      publicEntries.push(`${JSON.stringify("/" + rel.replace(/\\/g, "/"))}: f${i}`);
      i++;
    }
  }
  lines.push(`await runEmbedded({ ${fields}, publicFiles: { ${publicEntries.join(", ")} } });`);
  const entry = join(dirname(dir), ".onebase", "entry.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, lines.join("\n") + "\n");

  const out = resolve(opts.out);
  // onebase reads .env files itself (see env.ts), in its own order.
  const args = [process.execPath, "build", "--compile", "--minify", "--no-compile-autoload-dotenv", entry, "--outfile", out];
  if (opts.target) args.push("--target", opts.target);
  const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
  if ((await proc.exited) !== 0) throw new Error("bun build failed");
  console.log(`\nBuilt ${relative(process.cwd(), out) || out}: ${files} module(s), ${publicEntries.length} static file(s).`);
  console.log(`Run it with: ${relative(process.cwd(), out).startsWith(".") ? "" : "./"}${relative(process.cwd(), out)} --port 8090 --data ./onebase_data`);
}

/** Entry point for binaries built with `onebase build`. */
export async function runEmbedded(project: EmbeddedProject, argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help) return console.log(HELP);
  await startApp({
    schema: project.schema,
    modules: project.modules,
    http: project.http,
    auth: project.authConfig,
    crons: project.crons,
    components: project.components,
    dataDir: opts.data,
    ...serverOptions(opts),
    port: opts.port,
    hostname: opts.host,
    siteUrl: opts.url,
    dev: opts.dev,
    assets: Object.keys(project.publicFiles).length ? embeddedAssets(project.publicFiles) : null,
  });
}

export async function main(argv = process.argv.slice(2)) {
  const opts = options(argv);
  if (opts.help || !opts.command || opts.command === "help") return console.log(HELP);
  switch (opts.command) {
    case "serve":
      return serveCommand(opts);
    case "dev":
      return devCommand(opts, argv);
    case "codegen": {
      const changed = await codegen(opts.dir);
      return console.log(changed.length ? `Updated ${changed.length} file(s) in ${join(opts.dir, "_generated")}` : "Generated files are up to date.");
    }
    case "doctor": {
      const findings = await doctor(opts.dir, { db: sqliteFile(opts) });
      printFindings(findings);
      if (findings.some((f) => f.level === "error")) process.exit(1);
      return;
    }
    case "deploy":
      await deploy({
        dir: opts.dir,
        url: opts.url,
        key: process.env.ONEBASE_DEPLOY_KEY?.trim(),
        public: publicDir(opts.public),
        dryRun: opts["dry-run"],
        rollback: opts.rollback,
      });
      return;
    case "build":
      return buildCommand(opts);
    case "backup":
      return backupCommand(opts);
    case "backups":
      return backupsCommand(opts);
    case "restore":
      return restoreCommand(opts);
    case "vacuum":
      return vacuumCommand(opts);
    case "version":
      return console.log(VERSION);
    default:
      console.error(`Unknown command "${opts.command}".\n`);
      console.log(HELP);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\x1b[31merror\x1b[0m ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
