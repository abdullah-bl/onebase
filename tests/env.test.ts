import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, parseEnv, withoutBunEnv } from "../src/env";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "onebase-env-"));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

test("parses .env files the way bun does", () => {
  const env = parseEnv(
    [
      "# a comment",
      "PLAIN=hello world  # trailing comment",
      "export EXPORTED=yes",
      "EMPTY=",
      'DOUBLE="line1\\nline2 # not a comment \\t \\"kept\\""',
      "SINGLE='literal \\n # but $HOST expands'",
      'MULTI="first',
      'second"',
      "HASH=abc#comment",
      'QUOTED_HASH="abc#def"',
      'AFTER="value" trailing junk',
      "URL=https://${HOST}:$PORT/api",
      "DEFAULT=${MISSING:-fallback}",
      "ESCAPED=\\$HOST",
      "  SPACED  =  padded  ",
      "not a variable line",
    ].join("\n"),
    (k) => ({ HOST: "example.com", PORT: "443" })[k],
  );
  expect(env).toEqual({
    PLAIN: "hello world",
    EXPORTED: "yes",
    EMPTY: "",
    DOUBLE: 'line1\nline2 # not a comment \\t \\"kept\\"',
    SINGLE: "literal \\n # but example.com expands",
    MULTI: "first\nsecond",
    HASH: "abc",
    QUOTED_HASH: "abc#def",
    AFTER: "value",
    URL: "https://example.com:443/api",
    DEFAULT: "fallback",
    ESCAPED: "$HOST",
    SPACED: "padded",
  });
});

test("a variable means its final value, wherever it's defined", () => {
  expect(parseEnv("URL=https://$HOST\nHOST=api.example.com\nLOOP=$LOOP\nCRLF=ok\r\n")).toEqual({
    URL: "https://api.example.com",
    HOST: "api.example.com",
    LOOP: "",
    CRLF: "ok",
  });
  // Real variables win over the file's own definitions.
  expect(parseEnv("HOST=file\nURL=$HOST", (k) => (k === "HOST" ? "real" : undefined)).URL).toBe("real");
});

test("matches bun's own .env parsing", async () => {
  const text = [
    "PLAIN=hello world  # c",
    'DOUBLE="a\\nb \\"q\\" \\$HOST"',
    "SINGLE='x $HOST \\n'",
    "BACKTICK=`y ${HOST}`",
    "HASH=http://x/#frag",
    "HOST=example.com",
    "LATER=$HOST/path",
    "DEFAULT=${NOPE:-d}",
  ].join("\n");
  const cwd = project({ ".env": text, "print.ts": "console.log(JSON.stringify(process.env))" });
  const proc = Bun.spawn([process.execPath, "print.ts"], { cwd, env: { PATH: process.env.PATH }, stdout: "pipe" });
  const bun = JSON.parse(await new Response(proc.stdout).text());
  const mine = parseEnv(text);
  for (const key of Object.keys(mine)) expect([key, mine[key]]).toEqual([key, bun[key]]);
});

test("later files win, and real environment variables win over all of them", () => {
  const cwd = project({
    ".env": "A=env\nB=env\nC=env\nD=env\nREAL=env",
    ".env.local": "B=local\nC=local\nD=local",
    ".env.production": "C=production\nD=production",
    ".env.production.local": "D=production.local",
    ".env.development": "A=development",
  });
  const env: Record<string, string | undefined> = { REAL: "real" };
  const loaded = loadEnv({ mode: "production", cwd, env });
  expect(env).toEqual({ A: "env", B: "local", C: "production", D: "production.local", REAL: "real" });
  expect(loaded.map((p) => p.slice(cwd.length + 1))).toEqual([".env", ".env.local", ".env.production", ".env.production.local"]);

  const dev: Record<string, string | undefined> = {};
  loadEnv({ mode: "development", cwd, env: dev });
  expect(dev.A).toBe("development");
});

test("--env-file reads only the files given, and they must exist", () => {
  const cwd = project({ ".env": "A=default", "prod.env": "A=prod\nB=prod", "extra.env": "B=extra" });
  const env: Record<string, string | undefined> = {};
  loadEnv({ mode: "production", cwd, env, files: ["prod.env", "extra.env"] });
  expect(env).toEqual({ A: "prod", B: "extra" });
  expect(() => loadEnv({ mode: "production", cwd, env: {}, files: ["missing.env"] })).toThrow("--env-file missing.env: file not found");
});

test("values bun loaded on its own get onebase's order, not a real variable's", () => {
  // `bun run` with NODE_ENV unset reads .env.development, even for `onebase serve`.
  const cwd = project({ ".env": "A=env", ".env.development": "A=development\nDEV_ONLY=1", ".env.production": "A=production" });
  const env: Record<string, string | undefined> = { A: "development", DEV_ONLY: "1", REAL: "real" };
  expect(withoutBunEnv(env, cwd)).toEqual({ REAL: "real" });
  loadEnv({ mode: "production", cwd, env, bunAutoloaded: true });
  expect(env).toEqual({ A: "production", REAL: "real" });

  // A real variable that differs from the files is kept.
  const overridden: Record<string, string | undefined> = { A: "from the shell" };
  loadEnv({ mode: "production", cwd, env: overridden, bunAutoloaded: true });
  expect(overridden.A).toBe("from the shell");
});

/** The environment bun itself gives a script started in `cwd`, after loading .env files there. */
async function bunEnv(cwd: string, extra: Record<string, string> = {}): Promise<Record<string, string | undefined>> {
  writeFileSync(join(cwd, "print.ts"), "console.log(JSON.stringify(process.env))");
  const proc = Bun.spawn([process.execPath, "print.ts"], { cwd, env: { PATH: process.env.PATH, ...extra }, stdout: "pipe" });
  return JSON.parse(await new Response(proc.stdout).text());
}

test("values bun read from .env.development.local don't outrank the production files", async () => {
  const cwd = project({ ".env.development.local": "ONEBASE_ADMIN_KEY=dev-local-key\nONEBASE_CORS=*", ".env.production": "ONEBASE_ADMIN_KEY=prod-key\nONEBASE_CORS=https://app.example" });
  const env = await bunEnv(cwd);
  expect(env.ONEBASE_ADMIN_KEY).toBe("dev-local-key"); // what bun loaded on its own
  loadEnv({ mode: "production", cwd, env, bunAutoloaded: true });
  expect([env.ONEBASE_ADMIN_KEY, env.ONEBASE_CORS]).toEqual(["prod-key", "https://app.example"]);
});

test("a NODE_ENV set in .env doesn't hide that bun read the development files", async () => {
  for (const where of [".env", ".env.local"]) {
    const cwd = project({
      [where]: "NODE_ENV=production",
      ".env.development": "ONEBASE_ADMIN_KEY=dev-key\nONEBASE_CORS=*",
      ".env.production": "ONEBASE_ADMIN_KEY=prod-key\nONEBASE_CORS=https://app.example",
    });
    const env = await bunEnv(cwd);
    expect(env.ONEBASE_ADMIN_KEY).toBe("dev-key"); // bun went by the real (unset) NODE_ENV
    loadEnv({ mode: "production", cwd, env, bunAutoloaded: true });
    expect([where, env.ONEBASE_ADMIN_KEY, env.ONEBASE_CORS]).toEqual([where, "prod-key", "https://app.example"]);
  }
  // A real NODE_ENV=production still lets the production files win over .env.local.
  const cwd = project({ ".env.local": "A=local", ".env.production": "A=production" });
  const env = await bunEnv(cwd, { NODE_ENV: "production" });
  loadEnv({ mode: "production", cwd, env, bunAutoloaded: true });
  expect(env.A).toBe("production");
});

test("names like toString and __proto__ are ordinary variables", () => {
  const env = parseEnv("A=x$toString\n__proto__=p\nB=${constructor:-fallback}\nC=$hasOwnProperty");
  expect(Object.entries(env)).toEqual([["A", "x"], ["__proto__", "p"], ["B", "fallback"], ["C", ""]]);
});
