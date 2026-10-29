// Reads .env files for the CLI and compiled binaries, so every flag can come from a file.
//
// `onebase dev` reads .env, .env.local, .env.development, .env.development.local; every other
// command reads the .production files instead. Later files win, and real environment
// variables win over all of them. `--env-file <path>` reads only the files given.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type EnvMode = "development" | "production";

/** The files read for `mode`, lowest priority first. */
export function envFilesFor(mode: EnvMode): string[] {
  return [".env", ".env.local", `.env.${mode}`, `.env.${mode}.local`];
}

const KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Reads KEY=value lines (with an optional `export`) the way bun does, so a project behaves the
 * same run from source or as a binary. A # starts a comment unless the value is quoted. Single,
 * double and backtick quotes may span lines; inside double quotes \n and \r are newlines.
 * $ references are left for `expand`.
 */
function parseRaw(text: string): Record<string, string> {
  // No prototype: keys like __proto__ or toString are ordinary names here.
  const out: Record<string, string> = Object.create(null);
  const src = text.replace(/\r\n?/g, "\n");
  let i = 0;
  while (i < src.length) {
    const next = src.indexOf("\n", i);
    const eol = next === -1 ? src.length : next;
    const m = /^\s*(?:export\s+)?([^=\s#]+)\s*=[ \t]*/.exec(src.slice(i, eol));
    const start = i + (m?.[0].length ?? 0);
    i = eol + 1;
    if (!m || !KEY.test(m[1]!)) continue;
    const quote = src[start];
    if (quote === '"' || quote === "'" || quote === "`") {
      let end = start + 1;
      while (end < src.length && src[end] !== quote) end += quote === '"' && src[end] === "\\" ? 2 : 1;
      if (end < src.length) {
        const body = src.slice(start + 1, end);
        out[m[1]!] = quote === '"' ? body.replace(/\\n/g, "\n").replace(/\\r/g, "\r") : body;
        // Anything after the closing quote is ignored, and the value may have spanned lines.
        const after = src.indexOf("\n", end);
        i = after === -1 ? src.length : after + 1;
        continue;
      }
    }
    out[m[1]!] = src.slice(start, eol).replace(/#.*$/, "").trim();
  }
  return out;
}

const REFERENCE = /\\\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expands $VAR, ${VAR} and ${VAR:-default} (\$ is a literal $). A variable means its real value,
 * or else its final value across the files, wherever it's defined.
 */
function expand(raw: Record<string, string>, lookup: (key: string) => string | undefined): Record<string, string> {
  const done = new Map<string, string>();
  const resolving = new Set<string>();
  const value = (key: string): string => {
    if (done.has(key)) return done.get(key)!;
    if (resolving.has(key)) return ""; // a cycle
    resolving.add(key);
    const result = raw[key]!.replace(REFERENCE, (m, braced, fallback, bare) => {
      if (m === "\\$") return "$";
      const name = braced ?? bare;
      const v = lookup(name) ?? (Object.hasOwn(raw, name) ? value(name) : undefined);
      return fallback !== undefined && !v ? fallback : (v ?? "");
    });
    resolving.delete(key);
    done.set(key, result);
    return result;
  };
  return Object.fromEntries(Object.keys(raw).map((k) => [k, value(k)]));
}

/** Parses one .env file. `lookup` gives real variables, which win over the file's own. */
export function parseEnv(text: string, lookup: (key: string) => string | undefined = () => undefined): Record<string, string> {
  return expand(parseRaw(text), lookup);
}

/** Every file's values merged (later files win), then expanded. */
function readFiles(cwd: string, names: string[], lookup: (key: string) => string | undefined, required: boolean) {
  const raw: Record<string, string> = Object.create(null);
  const loaded: string[] = [];
  for (const name of names) {
    const file = readFile(cwd, name);
    if (!file) {
      if (required) throw new Error(`--env-file ${name}: file not found.`);
      continue;
    }
    Object.assign(raw, parseRaw(file.text));
    loaded.push(file.path);
  }
  return { values: expand(raw, lookup), loaded };
}

/**
 * The files bun itself reads before onebase starts, lowest priority first (`bun run` reads the
 * development ones when NODE_ENV is unset).
 */
function bunAutoloadFiles(env: Record<string, string | undefined>): string[] {
  const mode = env.NODE_ENV === "production" || env.NODE_ENV === "test" ? env.NODE_ENV : "development";
  return [".env", `.env.${mode}`, ...(mode === "test" ? [] : [".env.local"]), `.env.${mode}.local`];
}

export type LoadEnvOptions = {
  mode: EnvMode;
  /** From --env-file: read exactly these files (each must exist) instead of the defaults. */
  files?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  /**
   * Whether bun already loaded .env files into `env` (true when running from source; compiled
   * binaries are built without it). Values that came from them are re-read in onebase's order.
   */
  bunAutoloaded?: boolean;
};

function readFile(cwd: string, name: string) {
  const path = resolve(cwd, name);
  return existsSync(path) ? { path, text: readFileSync(path, "utf8") } : null;
}

/**
 * `env` without what bun loaded from .env files: a variable whose value matches what bun read
 * from a file is a file value, not a real environment variable.
 */
export function withoutBunEnv(env: Record<string, string | undefined>, cwd = process.cwd()): Record<string, string | undefined> {
  const real = { ...env };
  const { values } = readFiles(cwd, bunAutoloadFiles(env), (k) => (Object.hasOwn(env, k) ? env[k] : undefined), false);
  for (const [key, value] of Object.entries(values)) if (env[key] === value) delete real[key];
  return real;
}

/** Loads .env files into `env` (default: process.env) and returns the files that were read. */
export function loadEnv(opts: LoadEnvOptions): string[] {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  // Undo bun's own loading, so its files get onebase's precedence like the rest.
  const real = opts.bunAutoloaded ? withoutBunEnv(env, cwd) : { ...env };
  for (const key of Object.keys(env)) if (!Object.hasOwn(real, key)) delete env[key];

  const { values, loaded } = readFiles(cwd, opts.files ?? envFilesFor(opts.mode), (k) => (Object.hasOwn(real, k) ? real[k] : undefined), Boolean(opts.files));
  for (const [key, value] of Object.entries(values)) if (real[key] === undefined) env[key] = value;
  return loaded;
}
