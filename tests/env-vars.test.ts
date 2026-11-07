// Environment variables set at runtime (dashboard, `onebase env`): stored in the database, applied
// to process.env without a redeploy (on action threads too), reloaded into a deployment, and
// overridden by the server's own environment.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { deploy } from "../src/deploy";
import { SqliteDriver } from "../src/engine/driver";
import { EnvVars } from "../src/engine/env-vars";
import type { Runtime } from "../src/engine/runtime";
import { envCommand } from "../src/env-command";
import { loadProjectCode } from "../src/project";
import { openRuntime, quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-env-vars-"));
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
  for (const k of Object.keys(process.env)) if (k.startsWith("OBTEST_")) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

/** Reads OBTEST_GREETING when called and when the module loaded, from a query and an action. */
const GREET = `
import { action, query } from "onebase/server";
const atLoad = process.env.OBTEST_GREETING ?? null;
export const get = query({ args: {}, handler: async () => ({ now: process.env.OBTEST_GREETING ?? null, atLoad }) });
export const inAction = action({ args: {}, handler: async () => ({ now: process.env.OBTEST_GREETING ?? null, atLoad }) });
`;

function writeProject(name: string): string {
  const dir = join(root, name, "onebase");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "greet.ts"), GREET);
  return dir;
}

describe("EnvVars", () => {
  test("applies stored values, removes dropped ones, and lets startup values win", () => {
    const env: Record<string, string | undefined> = { FROM_SHELL: "shell" };
    const vars = new EnvVars(() => env);
    const at = Date.now();
    expect(vars.apply([{ name: "A", value: "1", updated: at }, { name: "FROM_SHELL", value: "stored", updated: at }])).toEqual(["A"]);
    expect(env).toEqual({ FROM_SHELL: "shell", A: "1" });
    expect(vars.overridden("FROM_SHELL")).toBe(true);
    expect(vars.overridden("A")).toBe(false);
    // Unchanged: nothing to do.
    expect(vars.apply([{ name: "A", value: "1", updated: at }])).toEqual([]);
    expect(vars.apply([{ name: "B", value: "2", updated: at }])).toEqual(["A", "B"]);
    expect(env).toEqual({ FROM_SHELL: "shell", B: "2" });
  });

  test("follows a replaced environment object", () => {
    // Bun swaps process.env's object when a worker that shares it starts.
    let env: Record<string, string | undefined> = {};
    const vars = new EnvVars(() => env);
    vars.apply([{ name: "A", value: "1", updated: 0 }]);
    env = { ...env };
    vars.apply([{ name: "A", value: "2", updated: 0 }]);
    expect(env.A).toBe("2");
  });
});

describe("runtime with local code", () => {
  let runtime: Runtime;

  test("starts and applies changes to queries and action threads without a restart", async () => {
    const code = await loadProjectCode(writeProject("local"));
    const opened = await openRuntime(() => new SqliteDriver(join(root, "local", "db.sqlite")), { ...code, actionWorkers: 1, envVars: new EnvVars() });
    runtime = opened.runtime;
    cleanup.push(() => opened.runtime.stop(), () => opened.driver.close());

    expect((await runtime.runQuery("greet:get", {})).value).toEqual({ now: null, atLoad: null });
    const r = await runtime.setEnvVars({ OBTEST_GREETING: "hello" });
    expect(r).toEqual({ changed: ["OBTEST_GREETING"], overridden: [], reload: "local" });
    expect((await runtime.runQuery("greet:get", {})).value).toEqual({ now: "hello", atLoad: null });
    // Action threads restart, so even a value read when the module loads is current there.
    expect(await runtime.runAction("greet:inAction", {})).toEqual({ now: "hello", atLoad: "hello" });

    await runtime.setEnvVars({ OBTEST_GREETING: "again" });
    expect((await runtime.runQuery("greet:get", {})).value).toMatchObject({ now: "again" });
    expect(await runtime.runAction("greet:inAction", {})).toMatchObject({ now: "again" });

    expect(await runtime.setEnvVars({ OBTEST_GREETING: "again" })).toMatchObject({ changed: [], reload: "none" });
    expect(await runtime.setEnvVars({}, ["OBTEST_GREETING"])).toMatchObject({ changed: ["OBTEST_GREETING"] });
    expect(process.env.OBTEST_GREETING).toBeUndefined();
    expect(await runtime.runAction("greet:inAction", {})).toMatchObject({ now: null });
  });

  test("refuses names it can't store and ONEBASE_ settings", async () => {
    await expect(runtime.setEnvVars({ "1BAD": "x" })).rejects.toThrow("isn't a valid variable name");
    await expect(runtime.setEnvVars({ "A-B": "x" })).rejects.toThrow("isn't a valid variable name");
    await expect(runtime.setEnvVars({ ONEBASE_ADMIN_KEY: "x" })).rejects.toThrow("server's environment");
    await expect(runtime.setEnvVars({ OBTEST_X: 1 as any })).rejects.toThrow("must be a string");
    await expect(runtime.setEnvVars({ OBTEST_X: "x".repeat(70_000) })).rejects.toThrow("at most 64 KB");
    await expect(runtime.setEnvVars({ OBTEST_X: "1" }, ["OBTEST_X"])).rejects.toThrow("set and removed at once");
    expect(await runtime.listEnvVars()).toEqual([]);
  });

  test("a variable the process started with wins and is reported", async () => {
    process.env.OBTEST_FROM_SHELL = "shell";
    const code = await loadProjectCode(writeProject("shell"));
    const opened = await openRuntime(() => new SqliteDriver(join(root, "shell", "db.sqlite")), { ...code, actionWorkers: 0, envVars: new EnvVars() });
    cleanup.push(() => opened.runtime.stop(), () => opened.driver.close());
    const r = await opened.runtime.setEnvVars({ OBTEST_FROM_SHELL: "stored" });
    expect(r.overridden).toEqual(["OBTEST_FROM_SHELL"]);
    expect(process.env.OBTEST_FROM_SHELL).toBe("shell");
    expect(await opened.runtime.listEnvVars()).toMatchObject([{ name: "OBTEST_FROM_SHELL", value: "stored", overridden: true }]);
  });
});

describe("a server running a deployment, through onebase env", () => {
  test("reloads the deployment, so values read when it loads change too", async () => {
    const dataDir = join(root, "server");
    const app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, actionWorkers: 1 });
    Object.assign(app.runtime, { log: quiet });
    cleanup.push(() => app.close());
    const url = `http://127.0.0.1:${app.server.port}`;
    const key = readFileSync(join(dataDir, "admin.key"), "utf8").trim();
    await deploy({ dir: writeProject("deployed"), url, key, public: null, log: () => {} });

    const lines: string[] = [];
    const run = (args: string[], extra: Partial<Parameters<typeof envCommand>[0]> = {}) =>
      envCommand({ args, url, key, out: (l) => lines.push(l), err: (l) => lines.push(l), ...extra });
    const call = async (kind: "query" | "action", path: string) =>
      (await (await fetch(`${url}/api/${kind}`, { method: "POST", body: JSON.stringify({ path, args: {} }) })).json()).value;

    await run(["set", "OBTEST_GREETING", "deployed"]);
    expect(await call("query", "greet:get")).toEqual({ now: "deployed", atLoad: "deployed" });
    expect(await call("action", "greet:inAction")).toEqual({ now: "deployed", atLoad: "deployed" });

    await run(["set", "OBTEST_GREETING=rotated"]);
    expect(await call("query", "greet:get")).toEqual({ now: "rotated", atLoad: "rotated" });

    await run(["set", "OBTEST_PIPED"], { readStdin: async () => "from stdin\n" });
    const file = join(root, "vars.env");
    writeFileSync(file, `# a comment\nOBTEST_A=1\nexport OBTEST_B="two words"\n`);
    await run(["set"], { fromFile: file });

    lines.length = 0;
    await run(["list"]);
    expect(lines).toEqual(["OBTEST_A=1", "OBTEST_B=two words", "OBTEST_GREETING=rotated", "OBTEST_PIPED=from stdin"]);
    lines.length = 0;
    await run(["get", "OBTEST_B"]);
    expect(lines).toEqual(["two words"]);
    await expect(run(["get", "OBTEST_NOPE"])).rejects.toThrow("isn't set");

    await run(["remove", "OBTEST_GREETING", "OBTEST_A"]);
    expect(await call("query", "greet:get")).toEqual({ now: null, atLoad: null });

    // Stored values are applied at startup, before the deployment loads.
    await run(["set", "OBTEST_GREETING", "after restart"]);
    await app.close();
    cleanup.pop();
    delete process.env.OBTEST_GREETING;
    const again = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, actionWorkers: 0 });
    Object.assign(again.runtime, { log: quiet });
    cleanup.push(() => again.close());
    const res = await fetch(`http://127.0.0.1:${again.server.port}/api/query`, { method: "POST", body: JSON.stringify({ path: "greet:get", args: {} }) });
    expect((await res.json()).value).toEqual({ now: "after restart", atLoad: "after restart" });
  });

  test("rejects a wrong key", async () => {
    const dataDir = join(root, "server2");
    const app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
    cleanup.push(() => app.close());
    await expect(envCommand({ args: ["list"], url: `http://127.0.0.1:${app.server.port}`, key: "wrong", out: () => {}, err: () => {} })).rejects.toThrow("rejected");
  });
});
