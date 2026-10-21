// Loads a functions directory (default ./convex) from disk.

import { plugin } from "bun";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createAuthenticate, type AuthConfig } from "./engine/jwt";
import type { Authenticate, Modules } from "./engine/runtime";
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
  authenticate: Authenticate | null;
  /** Module path → source file. */
  sources: Record<string, string>;
};

const SPECIAL = new Set(["schema", "auth.config"]);

let registered = false;

/**
 * Makes `onebase/server` and `onebase/values` importable from function files on disk,
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
    files.push(join(dir, rel));
  }
  return files.sort();
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
    throw new Error(`Functions directory not found: ${dir}\nCreate it (e.g. mkdir convex) or pass --dir <path>.`);
  }
  const project: Project = { dir, schema: null, modules: {}, http: null, crons: null, authenticate: null, sources: {} };
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
      project.authenticate = createAuthenticate(exports.default as AuthConfig);
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
