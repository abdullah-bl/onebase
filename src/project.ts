// Loads a functions directory (default ./onebase) from disk.

import { plugin } from "bun";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as auth from "./auth";
import * as components from "./components";
import * as mcp from "./mcp";
import type { ComponentsDefinition } from "./components";
import * as aggregate from "./components/aggregate";
import * as rateLimiter from "./components/rate-limiter";
import * as shardedCounter from "./components/sharded-counter";
import * as workQueue from "./components/work-queue";
import type { AuthConfig } from "./engine/jwt";
import { OnebaseError } from "./engine/database";
import { rememberModule } from "./engine/deployments";
import type { Modules, ProjectCode } from "./engine/runtime";
import type { SchemaDefinition } from "./schema";
import * as server from "./server";
import type { Crons, HttpRouter } from "./server";
import * as values from "./values";

export type Project = {
  dir: string;
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http: HttpRouter | null;
  crons: Crons | null;
  /** auth.config.ts's default export. */
  authConfig: AuthConfig | null;
  /** components.ts's default export. */
  components: ComponentsDefinition | null;
  /** Module path → source file. */
  sources: Record<string, string>;
};

const SPECIAL = new Set(["schema", "auth.config", "components"]);

/** The components that ship with onebase, importable as onebase/components/<name>. */
export const BUILT_IN_COMPONENTS: Record<string, Record<string, unknown>> = { aggregate, "rate-limiter": rateLimiter, "sharded-counter": shardedCounter, "work-queue": workQueue };

let registered = false;

/**
 * Makes `onebase/server`, `onebase/values` and `onebase/auth` importable from function files on disk,
 * even inside a compiled single-file binary where no node_modules exist.
 */
export function registerVirtualModules() {
  if (registered) return;
  registered = true;
  plugin({
    name: "onebase-modules",
    setup(build) {
      build.module("onebase/server", () => ({ exports: server, loader: "object" }));
      build.module("onebase/values", () => ({ exports: values, loader: "object" }));
      build.module("onebase/auth", () => ({ exports: auth, loader: "object" }));
      build.module("onebase/components", () => ({ exports: components, loader: "object" }));
      build.module("onebase/mcp", () => ({ exports: mcp, loader: "object" }));
      for (const [name, exports] of Object.entries(BUILT_IN_COMPONENTS)) {
        build.module(`onebase/components/${name}`, () => ({ exports, loader: "object" }));
      }
      build.module("onebase", () => ({ exports: server, loader: "object" }));
    },
  });
}

/** Module path for a file, e.g. "messages" or "admin/users". */
export function modulePathFor(dir: string, file: string): string {
  return relative(dir, file).replace(/\\/g, "/").replace(/\.(ts|js|mts|mjs|tsx|jsx)$/, "");
}

export async function listSourceFiles(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.{ts,js,mts,mjs,tsx,jsx}");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    const p = rel.replace(/\\/g, "/");
    if (p.startsWith("_generated/") || p.includes("node_modules/") || p.endsWith(".d.ts") || /\.test\.|\.spec\./.test(p)) continue;
    // A Convex project's component config: onebase doesn't run it (doctor explains what to do).
    if (/^convex\.config\.[mc]?[jt]s$/.test(p)) continue;
    files.push(join(dir, rel));
  }
  return files.sort();
}

/**
 * Source that statically imports every file in `dir`, for bundling: `imports` lines, and `fields`
 * of an object literal shaped like { schema, modules, http, authConfig, crons }.
 */
export async function projectEntry(dir: string): Promise<{ imports: string[]; fields: string; files: number }> {
  const files = await listSourceFiles(dir);
  const imports: string[] = [];
  const modules: string[] = [];
  let schema = "null";
  let http = "null";
  let auth = "null";
  let crons = "null";
  let components = "null";
  files.forEach((file, i) => {
    const modulePath = modulePathFor(dir, file);
    imports.push(`import * as m${i} from ${JSON.stringify(file)};`);
    if (modulePath === "schema") schema = `m${i}.default`;
    else if (modulePath === "auth.config") auth = `m${i}.default`;
    else if (modulePath === "components") components = `(m${i}.default?.__onebase === "components" ? m${i}.default : null)`;
    else {
      modules.push(`${JSON.stringify(modulePath)}: m${i}`);
      if (modulePath === "http") http = `(m${i}.default?.__onebase === "httpRouter" ? m${i}.default : null)`;
      if (modulePath === "crons") crons = `(m${i}.default?.__onebase === "crons" ? m${i}.default : null)`;
    }
  });
  const fields = `schema: ${schema}, modules: { ${modules.join(", ")} }, http: ${http}, authConfig: ${auth}, crons: ${crons}, components: ${components}`;
  return { imports, fields, files: files.length };
}

export class ProjectLoadError extends Error {
  constructor(
    readonly file: string,
    error: unknown,
  ) {
    super(`Failed to load ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function importFile(file: string): Promise<Record<string, unknown>> {
  try {
    return await import(file);
  } catch (err) {
    throw new ProjectLoadError(file, err);
  }
}

/** With `onError`, files that fail to load are reported and skipped instead of aborting. */
export async function loadProject(dirInput: string, onError?: (err: ProjectLoadError) => void): Promise<Project> {
  registerVirtualModules();
  const dir = resolve(dirInput);
  if (!existsSync(dir)) {
    throw new Error(`Functions directory not found: ${dir}\nCreate it (e.g. mkdir onebase) or pass --dir <path>.`);
  }
  const project: Project = { dir, schema: null, modules: {}, http: null, crons: null, authConfig: null, components: null, sources: {} };
  for (const file of await listSourceFiles(dir)) {
    const modulePath = modulePathFor(dir, file);
    let exports: Record<string, unknown>;
    try {
      exports = await importFile(file);
    } catch (err) {
      if (!onError || !(err instanceof ProjectLoadError)) throw err;
      onError(err);
      continue;
    }
    if (modulePath === "schema") {
      const schema = exports.default as any;
      if (!schema?.__isOnebaseSchema) {
        throw new Error(`schema.ts must \`export default defineSchema({ ... })\` (import defineSchema from "onebase/server").`);
      }
      project.schema = schema;
      continue;
    }
    if (modulePath === "auth.config") {
      project.authConfig = (exports.default as AuthConfig) ?? null;
      continue;
    }
    if (modulePath === "components") {
      if ((exports.default as any)?.__onebase !== "components") {
        throw new Error(`components.ts must \`export default defineComponents({ ... })\` (import defineComponents from "onebase/components").`);
      }
      project.components = exports.default as ComponentsDefinition;
      continue;
    }
    if (modulePath === "http" && (exports.default as any)?.__onebase === "httpRouter") {
      project.http = exports.default as HttpRouter;
    }
    if (modulePath === "crons" && (exports.default as any)?.__onebase === "crons") {
      project.crons = exports.default as Crons;
    }
    if (SPECIAL.has(modulePath)) continue;
    project.modules[modulePath] = exports;
    project.sources[modulePath] = file;
  }
  return project;
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
    source: { bundle: source, id },
    schema: project.schema ?? null,
    modules: project.modules,
    http: project.http ?? null,
    auth: project.authConfig ?? null,
    crons: project.crons?.jobs ?? [],
    components: project.components ?? null,
  };
}

/** A functions directory, loaded as the runtime runs it. */
export async function loadProjectCode(dir: string): Promise<ProjectCode> {
  const project = await loadProject(dir);
  return {
    source: { dir: project.dir },
    schema: project.schema,
    modules: project.modules,
    http: project.http,
    auth: project.authConfig,
    crons: project.crons?.jobs ?? [],
    components: project.components,
  };
}
