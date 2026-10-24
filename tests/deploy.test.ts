// `onebase deploy` against a real server: bundle, push, hot swap, persistence and rollback.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startApp } from "../src/app";
import { OnebaseClient } from "../src/client/index";
import { bundleProject, deploy } from "../src/deploy";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-deploy-"));
const dataDir = join(root, "data");
let app: Awaited<ReturnType<typeof startApp>>;
let url: string;
let key: string;

const SCHEMA = (textType: string, extra = "") => `
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";
export default defineSchema({ notes: defineTable({ text: ${textType} })${extra} });
`;

const NOTES_V1 = `
import { mutation, query } from "onebase/server";
import { v } from "onebase/values";
export const list = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text) });
export const add = mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) });
`;

// v2 changes what list returns, and adds count.
const NOTES_V2 = NOTES_V1.replace("map((n) => n.text)", "map((n) => n.text.toUpperCase())") + `
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).length });
`;

/** Writes a project folder: functions under onebase/, anything else as given. */
function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [path, text] of Object.entries(files)) {
    const file = path.includes("/") ? join(dir, path) : join(dir, "onebase", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const v1 = project("v1", { "schema.ts": SCHEMA("v.string()"), "notes.ts": NOTES_V1, "public/index.html": "<h1>v1</h1>" });
const CRONS = `import { cronJobs } from "onebase/server";\nconst c = cronJobs();\nc.interval("tally", { hours: 1 }, "notes:count" as any);\nexport default c;`;
const v2 = project("v2", { "schema.ts": SCHEMA("v.string()", '.index("by_text", ["text"])'), "notes.ts": NOTES_V2, "crons.ts": CRONS });

const push = (dir: string, extra: Partial<Parameters<typeof deploy>[0]> = {}) =>
  deploy({ dir: join(dir, "onebase"), url, key, public: null, log: () => {}, ...extra });

async function start(opts: { deploys?: boolean } = {}) {
  app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, ...opts });
  Object.assign(app.runtime, { log: quiet }); // keep test output quiet
  url = `http://127.0.0.1:${app.server.port}`;
  key = readFileSync(join(dataDir, "admin.key"), "utf8").trim();
}

function nextValue<T>(client: OnebaseClient, ref: any, predicate: (v: T) => boolean, onError?: (e: Error) => void): Promise<T> {
  return new Promise((resolve) => {
    const unsub = client.onUpdate(ref, {}, (value: any) => {
      if (predicate(value)) {
        unsub();
        resolve(value);
      }
    }, onError);
  });
}

beforeAll(() => start());
afterAll(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

test("deploys functions and the frontend to an empty server", async () => {
  const r = await push(v1, { public: join(v1, "public") });
  expect(r).toMatchObject({ functions: 2, files: 1, dryRun: false });

  const client = new OnebaseClient(url);
  await client.mutation("notes:add" as any, { text: "first" });
  expect(await client.query("notes:list" as any, {})).toEqual(["first"]);
  client.close();

  expect(await (await fetch(`${url}/`)).text()).toBe("<h1>v1</h1>");
  expect(await (await fetch(`${url}/some/route`)).text()).toBe("<h1>v1</h1>");
  expect((await (await fetch(`${url}/api/health`)).json()).deployment).toBe(r.id);
});

test("live queries move to the new code without reconnecting", async () => {
  const client = new OnebaseClient(url);
  await nextValue<string[]>(client, "notes:list", (v) => v.length === 1);
  // A query that doesn't exist yet fails, then starts working once it's deployed.
  const errors: string[] = [];
  const counted = nextValue<number>(client, "notes:count", () => true, (e) => errors.push(e.message));
  const upper = nextValue<string[]>(client, "notes:list", (v) => v[0] === "FIRST");

  const r = await push(v2);
  expect(r.indexes.created).toHaveLength(1);
  expect(app.runtime.cronJobs.map((j) => j.name)).toEqual(["tally"]);
  expect(await upper).toEqual(["FIRST"]);
  expect(await counted).toBe(1);
  expect(errors[0]).toContain('"notes:count" not found');
  // Without a frontend in this deployment, the server falls back to its own (none here).
  expect((await fetch(`${url}/`)).status).toBe(404);
  client.close();
});

test("a schema that doesn't fit the data is refused, and the old code keeps running", async () => {
  const bad = project("bad", { "schema.ts": SCHEMA("v.number()"), "notes.ts": NOTES_V2 });
  await expect(push(bad)).rejects.toThrow("schema.ts doesn't match 1 existing document");
  const brokenCron = project("cron", {
    "schema.ts": SCHEMA("v.string()"),
    "notes.ts": NOTES_V2,
    "crons.ts": `import { cronJobs } from "onebase/server";\nconst c = cronJobs();\nc.interval("x", { minutes: 1 }, "notes:missing" as any);\nexport default c;`,
  });
  // doctor catches it before anything is sent; the server checks again for bundles pushed some other way.
  await expect(push(brokenCron)).rejects.toThrow("Fix the errors above before deploying");
  const { code } = await bundleProject(join(brokenCron, "onebase"));
  await expect(app.runtime.deploy({ code })).rejects.toThrow("runs notes:missing, which doesn't exist");

  const client = new OnebaseClient(url);
  expect(await client.query("notes:count" as any, {})).toBe(1);
  client.close();
});

test("a dry run checks without changing anything", async () => {
  const before = (await (await fetch(`${url}/api/health`)).json()).deployment;
  const r = await push(v1, { dryRun: true });
  expect(r).toMatchObject({ dryRun: true, functions: 2 });
  expect((await (await fetch(`${url}/api/health`)).json()).deployment).toBe(before);
});

test("the deploy key must match the server's admin key", async () => {
  await expect(deploy({ dir: join(v1, "onebase"), url, key: "wrong", public: null, log: () => {} })).rejects.toThrow("rejected the deploy key");
});

test("a restart keeps running the deployment; --no-deploy runs the local code instead", async () => {
  await app.close();
  await start();
  expect([...app.runtime.functions.keys()].sort()).toEqual(["notes:add", "notes:count", "notes:list"]);
  expect(app.runtime.deployment).not.toBeNull();

  await app.close();
  await start({ deploys: false });
  expect(app.runtime.functions.size).toBe(0);
  await expect(push(v1)).rejects.toThrow("Deploys are turned off");

  await app.close();
  await start();
});

test("--rollback goes back to the previous deployment", async () => {
  const r = await deploy({ dir: join(v2, "onebase"), url, key, public: null, rollback: true, log: () => {} });
  expect(r.functions).toBe(2);
  expect(app.runtime.functions.has("notes:count")).toBe(false);
  expect(app.runtime.cronJobs).toHaveLength(0);
  expect(await (await fetch(`${url}/`)).text()).toBe("<h1>v1</h1>");
});

test("deploys at the same time run one after the other", async () => {
  await Promise.all([push(v1), push(v2), push(v1)]);
  const recorded = await app.runtime.adminRead((_db, tx) => tx.get("SELECT value FROM _meta WHERE key = 'deployment'"));
  expect(app.runtime.deployment?.id).toBe(recorded?.value as string);
});

test("dev servers refuse deploys", async () => {
  const runtime = new Runtime({ driver: new SqliteDriver(":memory:"), schema: null, modules: {}, dev: true, log: quiet, loadCode: async () => ({}) as any });
  await runtime.init();
  await expect(runtime.deploy({ code: "export default {}" })).rejects.toThrow("dev mode");
});
