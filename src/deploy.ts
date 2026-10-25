// `onebase deploy`: bundles the functions (and the frontend) on your machine and pushes them to a
// running server, which checks them against its data and swaps them in without a restart.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { codegen } from "./codegen";
import { doctor, printFindings } from "./doctor";
import { OnebaseError } from "./engine/database";
import { rememberModule } from "./engine/deployments";
import type { DeployResult, ProjectCode } from "./engine/runtime";
import { projectEntry, registerVirtualModules } from "./project";
import { isRegisteredFunction } from "./server";

/**
 * Bundles the functions in `dir` and the npm packages they import into one ES module. The
 * onebase modules stay external: the server provides its own.
 */
export async function bundleProject(dirInput: string): Promise<{ code: string; files: number }> {
  const dir = resolve(dirInput);
  const { imports, fields, files } = await projectEntry(dir);
  const entry = join(dirname(dir), ".onebase", "deploy.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, `${imports.join("\n")}\nexport default { ${fields} };\n`);
  let result: Bun.BuildOutput;
  try {
    result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      external: ["onebase", "onebase/*"],
      // Bun would bake in this machine's NODE_ENV; the server's own should apply, as for a functions folder.
      define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
    });
  } catch (err) {
    const logs = (err as AggregateError)?.errors;
    throw new Error(`Bundling failed:\n${Array.isArray(logs) && logs.length ? logs.map(String).join("\n") : String(err)}`);
  }
  if (!result.success) throw new Error(`Bundling failed:\n${result.logs.map(String).join("\n")}`);
  return { code: await result.outputs[0]!.text(), files };
}

let bundleDir: string | null = null;

/**
 * Server side: loads a bundle from bundleProject. Each deployment is a new file, so a new module.
 * Loads through require() where possible: unlike import(), its module cache can be emptied (see
 * releaseModules), so a replaced deployment's code can actually be freed. Bundles that need
 * top-level await can't be required and fall back to import(), which keeps them for the process's
 * lifetime.
 */
export async function importBundle(source: string, id: string): Promise<ProjectCode> {
  registerVirtualModules();
  bundleDir ??= mkdtempSync(join(tmpdir(), "onebase-deploys-"));
  const file = join(bundleDir, `${id}.js`);
  writeFileSync(file, source);
  let loaded: { default?: any };
  try {
    loaded = require(file) as { default?: any };
    rememberModule(id, require.resolve(file));
  } catch {
    loaded = (await import(file)) as { default?: any };
  }
  rmSync(file, { force: true }); // the code lives in the database; a rollback rewrites it
  const project = loaded.default;
  if (!project || typeof project !== "object" || typeof project.modules !== "object") {
    throw new OnebaseError("This isn't a onebase deploy bundle. Push code with onebase deploy.");
  }
  if (project.schema && !project.schema.__isOnebaseSchema) {
    throw new OnebaseError("schema.ts must `export default defineSchema({ ... })`.");
  }
  return {
    schema: project.schema ?? null,
    modules: project.modules,
    http: project.http ?? null,
    auth: project.authConfig ?? null,
    crons: project.crons?.jobs ?? [],
  };
}

/** The frontend as { "/path": base64 }. */
async function readPublic(dir: string): Promise<Record<string, string>> {
  const root = resolve(dir);
  const files: Record<string, string> = {};
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: root, onlyFiles: true })) {
    files["/" + rel.replace(/\\/g, "/")] = Buffer.from(await Bun.file(join(root, rel)).arrayBuffer()).toString("base64");
  }
  return files;
}

/**
 * The schema and function count of the project that was just bundled, read by importing its entry
 * here (the developer's own machine, like onebase dev and doctor). A dry run ships them as data,
 * so the server can check the schema against its data without ever running the pushed code.
 */
async function dryRunFacts(entry: string): Promise<{ schema: string | null; functions: number }> {
  const project = ((await import(entry)) as { default?: any }).default ?? {};
  const schema = project.schema ?? null;
  const json = schema
    ? JSON.stringify({
        schemaValidation: schema.schemaValidation ?? true,
        tables: Object.fromEntries(Object.entries(schema.tables ?? {}).map(([name, table]: [string, any]) => [name, { validator: table.validator }])),
      })
    : null;
  let functions = 0;
  for (const exports of Object.values(project.modules ?? {}) as Record<string, unknown>[]) {
    for (const value of Object.values(exports ?? {})) if (isRegisteredFunction(value)) functions++;
  }
  return { schema: json, functions };
}

export type DeployOptions = {
  dir: string;
  /** The server's URL, e.g. https://api.example.com. */
  url: string | undefined;
  /** The server's admin key. */
  key: string | undefined;
  /** Frontend directory to ship, or null to keep serving the server's own. */
  public: string | null;
  dryRun?: boolean;
  rollback?: boolean;
  log?: (line: string) => void;
};

const KEY_HINT =
  "The key is the server's admin key: the value of $ONEBASE_ADMIN_KEY there, or the contents of onebase_data/admin.key.";

/** Sends one admin API call; errors explain what to fix. */
async function adminCall(url: string, key: string, name: string, body: unknown): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${url}/_admin/api/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Couldn't reach ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let reply: { ok?: boolean; value?: unknown; error?: string } | null = null;
  try {
    reply = JSON.parse(text);
  } catch {}
  if (res.status === 401) throw new Error(`The server rejected the deploy key. ${KEY_HINT}`);
  if (!reply || (res.status === 404 && !reply.error)) {
    throw new Error(`${url} doesn't look like a onebase server with deploys (HTTP ${res.status}). Is the URL right, and is the dashboard on (no --no-dashboard)?`);
  }
  if (!reply.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
  return reply.value;
}

const kb = (bytes: number) => (bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/** The `onebase deploy` command. */
export async function deploy(opts: DeployOptions): Promise<DeployResult> {
  const log = opts.log ?? console.log;
  if (!opts.url) throw new Error("Where to? Pass --url https://your-server or set ONEBASE_DEPLOY_URL (for example in .env.local).");
  if (!opts.key) throw new Error(`Set ONEBASE_DEPLOY_KEY (for example in .env.local, which git ignores). ${KEY_HINT}`);
  const url = opts.url.replace(/\/$/, "");
  const { hostname, protocol } = new URL(url);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname) && !hostname.endsWith(".localhost")) {
    log(`\x1b[33mwarn\x1b[0m ${url} is plain HTTP, so the deploy key travels unencrypted. Use https:// in production.`);
  }
  const start = performance.now();

  if (opts.rollback) {
    const r: DeployResult = await adminCall(url, opts.key, "rollback", {});
    log(`\x1b[32m✓\x1b[0m Rolled back ${url} to ${r.id} (pushed ${new Date(r.created).toLocaleString()}): ${r.functions} function(s).`);
    return r;
  }

  const dir = resolve(opts.dir);
  if (!existsSync(dir)) throw new Error(`Functions directory not found: ${dir}. Run onebase deploy from your project, or pass --dir.`);
  await codegen(dir);
  const findings = await doctor(dir);
  const errors = findings.filter((f) => f.level === "error");
  if (findings.length) printFindings(findings, log);
  if (errors.length) throw new Error("Fix the errors above before deploying (onebase doctor shows them).");

  const bundle = await bundleProject(dir);
  const assets = opts.public ? await readPublic(opts.public) : null;
  const assetBytes = assets ? Object.values(assets).reduce((n, b) => n + (b.length * 3) / 4, 0) : 0;
  const what = `${bundle.files} source file(s) (${kb(bundle.code.length)})`;
  const frontend = assets ? ` and ${Object.keys(assets).length} static file(s) from ${relative(process.cwd(), opts.public!) || "."}/ (${kb(assetBytes)})` : "";
  log(`${opts.dryRun ? "Checking" : "Deploying"} ${what}${frontend} to ${url}…`);

  const r: DeployResult = await adminCall(url, opts.key, "deploy", {
    code: bundle.code,
    assets,
    dryRun: opts.dryRun ?? false,
    ...(opts.dryRun ? await dryRunFacts(join(dirname(dir), ".onebase", "deploy.ts")) : {}),
  });
  for (const w of r.warnings) log(`\x1b[33mwarn\x1b[0m ${w}`);
  const ms = performance.now() - start;
  const took = ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
  if (r.dryRun) {
    log(`\x1b[32m✓\x1b[0m Dry run passed: ${r.functions} function(s) and the schema fit the data on ${url}. Nothing was changed.`);
    return r;
  }
  const indexes = r.indexes.created.length || r.indexes.dropped.length ? `, indexes +${r.indexes.created.length} -${r.indexes.dropped.length}` : "";
  log(`\x1b[32m✓\x1b[0m Deployed ${r.id} to ${url} in ${took}: ${r.functions} function(s)${indexes}${r.files ? `, ${r.files} static file(s)` : ""}.`);
  return r;
}
