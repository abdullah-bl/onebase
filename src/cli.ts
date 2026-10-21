#!/usr/bin/env bun
// onebase command line. Also the entry point of the single-file binary.

import { existsSync, mkdirSync, watch, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { directoryAssets, embeddedAssets, startApp, VERSION } from "./app";
import { backupNow, listBackups, restore } from "./backup";
import { codegen } from "./codegen";
import { doctor, printFindings } from "./doctor";
import { SqliteDriver } from "./engine/driver";
import { LocalBlobs } from "./engine/files";
import { parseRateLimit } from "./engine/http";
import { createAuthenticate, type AuthConfig } from "./engine/jwt";
import type { Modules } from "./engine/runtime";
import { listSourceFiles, loadProject, modulePathFor } from "./project";
import type { SchemaDefinition } from "./schema";
import type { Crons, HttpRouter } from "./server";

/** A project compiled into the binary by `onebase build`. */
export type EmbeddedProject = {
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http: HttpRouter | null;
  authConfig: AuthConfig | null;
  crons: Crons | null;
  publicFiles: Record<string, string>;
};

const HELP = `onebase v${VERSION}: a lightweight, Convex-style reactive backend

Usage:
  onebase serve    Run the server
  onebase dev      Run the server, regenerate types and restart on changes
  onebase codegen  Write <dir>/_generated (typed api, server, dataModel)
  onebase doctor   Check schema and functions for common mistakes
  onebase build    Compile functions + frontend into one executable (from source)
  onebase backup   Take one SQLite snapshot to --backup now
  onebase backups  List snapshots in --backup
  onebase restore  Restore the newest snapshot (or --at <time>) into --data

Options:
  --dir <path>      Functions directory (default: ./onebase; a ported ./convex folder also works)
  --data <path>     Data directory (default: ./onebase_data)
  --public <path>   Static frontend directory (default: ./public if it exists)
  --port <n>        Port (default: 8090, or $PORT)
  --host <addr>     Bind address (default: 0.0.0.0)
  --url <url>       Public URL, used for file URLs (default: http://localhost:<port>, or $ONEBASE_URL)
  --db <url>        Database: SQLite path (default <data>/db.sqlite), postgres://… or
                    libsql://… / https://… for Turso ($ONEBASE_DB, $DATABASE_URL)
  --files <s3url>   Keep uploaded files in S3/R2/MinIO: s3://bucket/prefix ($ONEBASE_FILES)
  --backup <s3url>  Back up SQLite to s3://bucket/prefix ($ONEBASE_BACKUP)
  --backup-every <d>  Backup interval, e.g. 15m, 1h, 1d (default: 1h)
  --backup-keep <n>   Snapshots to keep (default: 24)
  --cors <origins>  Browser origins allowed to call the API, comma-separated (default: any; $ONEBASE_CORS)
  --rate-limit <r>  Per-IP limit on function calls, e.g. 100/10s or 600/m (default: off; $ONEBASE_RATE_LIMIT)
  --trust-proxy     Take the client IP from X-Forwarded-For (when behind a reverse proxy)
  --at <time>       restore: snapshot to use, e.g. 20261022T0300 (default: newest)
  --force           restore: overwrite an existing database
  --out <file>      Output file for build (default: ./app)
  --target <t>      Build target, e.g. bun-linux-x64, bun-linux-arm64, bun-darwin-arm64, bun-windows-x64

S3 credentials come from S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT, S3_REGION
(or the AWS_* equivalents), or as ?endpoint=…&region=… on the s3:// URL.
Turso tokens come from ?authToken=… or $TURSO_AUTH_TOKEN.
`;

function options(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dir: { type: "string" },
      data: { type: "string", default: "./onebase_data" },
      public: { type: "string" },
      port: { type: "string", default: process.env.PORT ?? "8090" },
      host: { type: "string", default: "0.0.0.0" },
      url: { type: "string", default: process.env.ONEBASE_URL },
      db: { type: "string", default: process.env.ONEBASE_DB ?? process.env.DATABASE_URL },
      files: { type: "string", default: process.env.ONEBASE_FILES },
      backup: { type: "string", default: process.env.ONEBASE_BACKUP },
      "backup-every": { type: "string", default: "1h" },
      "backup-keep": { type: "string", default: "24" },
      cors: { type: "string", default: process.env.ONEBASE_CORS },
      "rate-limit": { type: "string", default: process.env.ONEBASE_RATE_LIMIT },
      "trust-proxy": { type: "boolean", default: false },
      at: { type: "string" },
      force: { type: "boolean", default: false },
      out: { type: "string", default: "./app" },
      target: { type: "string" },
      dev: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number, got "${values.port}"`);
  // Default to ./onebase, but pick up ./convex in a project ported from Convex.
  const dir = values.dir ?? (!existsSync("./onebase") && existsSync("./convex") ? "./convex" : "./onebase");
  return { ...values, dir, port, command: positionals[0] };
}

function duration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(text.trim());
  if (!m) throw new Error(`Invalid duration "${text}": use e.g. 30m, 1h or 1d.`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
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
  };
}

function requireBackupUrl(opts: ReturnType<typeof options>): string {
  if (!opts.backup) throw new Error("Pass --backup s3://bucket/prefix (or set $ONEBASE_BACKUP).");
  return opts.backup;
}

async function backupCommand(opts: ReturnType<typeof options>) {
  const url = requireBackupUrl(opts);
  const dbPath = opts.db ?? join(opts.data, "db.sqlite");
  if (/^[a-z]+:\/\//.test(dbPath)) throw new Error("backup works with a SQLite database file, not a database URL.");
  if (!existsSync(dbPath)) throw new Error(`No database at ${dbPath}.`);
  const driver = new SqliteDriver(dbPath);
  try {
    const blobs = opts.files ? undefined : new LocalBlobs(join(opts.data, "files"));
    const r = await backupNow(driver, url, Number(opts["backup-keep"]), blobs);
    console.log(`Uploaded ${r.key} (${(r.bytes / 1024).toFixed(1)} KB)${r.filesUploaded ? ` and ${r.filesUploaded} file(s)` : ""}.`);
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
  const project = await loadProject(opts.dir);
  const pub = publicDir(opts.public);
  await startApp({
    schema: project.schema,
    modules: project.modules,
    http: project.http,
    authenticate: project.authenticate,
    crons: project.crons,
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
  const compiled = Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, Bun.main];
}

async function devCommand(opts: ReturnType<typeof options>, argv: string[]) {
  const dir = resolve(opts.dir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const childArgs = ["serve", "--dev", ...argv.filter((a) => a !== "dev")];
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
    child = Bun.spawn([...selfCommand(), ...childArgs], { stdio: ["inherit", "inherit", "inherit"] });
  };

  await restart();
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(dir, { recursive: true }, (_event, file) => {
    const name = String(file ?? "").replace(/\\/g, "/");
    if (!name || name.startsWith("_generated") || name.includes("node_modules")) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void restart(name), 150);
  });
  const stop = () => {
    child?.kill();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Generates an entry file that statically imports the project, then compiles it. */
async function buildCommand(opts: ReturnType<typeof options>) {
  const compiled = Bun.main.includes("$bunfs") || Bun.main.includes("~BUN");
  if (compiled) {
    throw new Error("`build` needs onebase's source (run it with bun from an installed package), not the prebuilt binary.");
  }
  const dir = resolve(opts.dir);
  await codegen(dir);
  const files = await listSourceFiles(dir);
  const pub = publicDir(opts.public);
  const lines: string[] = [`import { runEmbedded } from ${JSON.stringify(import.meta.path)};`];
  const modules: string[] = [];
  let schema = "null";
  let http = "null";
  let auth = "null";
  let crons = "null";
  files.forEach((file, i) => {
    const modulePath = modulePathFor(dir, file);
    lines.push(`import * as m${i} from ${JSON.stringify(file)};`);
    if (modulePath === "schema") schema = `m${i}.default`;
    else if (modulePath === "auth.config") auth = `m${i}.default`;
    else {
      modules.push(`${JSON.stringify(modulePath)}: m${i}`);
      if (modulePath === "http") http = `(m${i}.default?.__onebase === "httpRouter" ? m${i}.default : null)`;
      if (modulePath === "crons") crons = `(m${i}.default?.__onebase === "crons" ? m${i}.default : null)`;
    }
  });
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
  lines.push(
    `await runEmbedded({ schema: ${schema}, modules: { ${modules.join(", ")} }, http: ${http}, authConfig: ${auth}, crons: ${crons}, publicFiles: { ${publicEntries.join(", ")} } });`,
  );
  const entry = join(dirname(dir), ".onebase", "entry.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, lines.join("\n") + "\n");

  const out = resolve(opts.out);
  const args = [process.execPath, "build", "--compile", "--minify", entry, "--outfile", out];
  if (opts.target) args.push("--target", opts.target);
  const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
  if ((await proc.exited) !== 0) throw new Error("bun build failed");
  console.log(`\nBuilt ${relative(process.cwd(), out) || out}: ${files.length} module(s), ${publicEntries.length} static file(s).`);
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
    authenticate: project.authConfig ? createAuthenticate(project.authConfig) : null,
    crons: project.crons,
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
      const findings = await doctor(opts.dir);
      printFindings(findings);
      if (findings.some((f) => f.level === "error")) process.exit(1);
      return;
    }
    case "build":
      return buildCommand(opts);
    case "backup":
      return backupCommand(opts);
    case "backups":
      return backupsCommand(opts);
    case "restore":
      return restoreCommand(opts);
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
