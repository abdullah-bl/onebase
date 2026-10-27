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
  const recorded = await app.runtime.adminRead((_db, tx) => tx.get("SELECT value FROM _meta WHERE \"key\" = 'deployment'"));
  expect(app.runtime.deployment?.id).toBe(recorded?.value as string);
});

test("dev servers refuse deploys", async () => {
  const runtime = new Runtime({ driver: new SqliteDriver(":memory:"), schema: null, modules: {}, dev: true, log: quiet, loadCode: async () => ({}) as any });
  await runtime.init();
  await expect(runtime.deploy({ code: "export default {}" })).rejects.toThrow("dev mode");
});

test("--rollback returns to what was live before, even after an earlier rollback", async () => {
  const good = await push(v1);
  await push(v2);
  expect((await push(v1, { rollback: true })).id).toBe(good.id);
  await push(v2);
  expect((await push(v1, { rollback: true })).id).toBe(good.id); // not the v2 rolled away from the first time
  expect(app.runtime.functions.has("notes:count")).toBe(false);
});

test("a deploy broadcast from another instance runs the active deployment, not the one it names", async () => {
  const older = await push(v2);
  const current = await push(v1);
  // Two instances deploying at once: this one hears about the deploy that lost after its own won.
  await (app.runtime as any).onRemoteCommit(JSON.stringify({ o: "another-instance", d: older.id }));
  expect(app.runtime.deployment?.id).toBe(current.id);
});

test("after a deploy without a schema, the next schema checks every document again", async () => {
  const RAW = `
import { mutation } from "onebase/server";
import { v } from "onebase/values";
export const add = mutation({ args: { text: v.any() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) });
export const tidy = mutation({ args: {}, handler: async (ctx) => {
  for (const n of await ctx.db.query("notes").collect()) if (typeof n.text !== "string") await ctx.db.delete(n._id);
} });
`;
  const bare = project("bare", { "notes.ts": RAW });
  await push(v1);
  await push(bare);
  const client = new OnebaseClient(url);
  await client.mutation("notes:add" as any, { text: 123 });
  await expect(push(v1)).rejects.toThrow("schema.ts doesn't match 1 existing document");
  await client.mutation("notes:tidy" as any, {});
  client.close();
  await push(v1);
});

test("bundles read NODE_ENV on the server, not on the machine that built them", async () => {
  const dir = project("mode", { "mode.ts": `import { query } from "onebase/server";\nexport const get = query({ args: {}, handler: () => process.env.NODE_ENV ?? null });` });
  const { code } = await bundleProject(join(dir, "onebase"));
  expect(code).toContain("process.env.NODE_ENV");
});

test("a dry run never runs the pushed code on the server", async () => {
  const probe = `onebase-probe-${crypto.randomUUID()}`;
  const dir = project("probe", {
    "schema.ts": SCHEMA("v.string()"),
    "notes.ts": NOTES_V1 + `\n(globalThis as any)[${JSON.stringify(probe)}] = ((globalThis as any)[${JSON.stringify(probe)}] ?? 0) + 1;\n`,
  });
  const count = () => (globalThis as any)[probe] ?? 0;
  // The CLI loads the project locally to check it (like onebase dev would); the server doesn't.
  await push(dir, { dryRun: true });
  expect(count()).toBe(1);
  await push(dir, { dryRun: true });
  expect(count()).toBe(1); // nothing new ran anywhere
  // A real deploy does run the bundle, once, on the server.
  await push(dir);
  expect(count()).toBe(2);
});

test("a dry run without the schema and function count is refused", async () => {
  await expect(app.runtime.deploy({ code: "export default {}", dryRun: true })).rejects.toThrow("Update the onebase CLI");
});

test("a replaced deployment's module is freed; a rollback reloads it from the database", async () => {
  const a = await push(v1);
  const b = await push(v2);
  const cached = Object.keys(require.cache).filter((k) => k.includes("onebase-deploys-"));
  expect(cached).toHaveLength(1); // a's module left the cache when b went live
  expect(cached[0]!.endsWith(`${b.id}.js`)).toBe(true);

  const back = await deploy({ dir: join(v2, "onebase"), url, key, public: null, rollback: true, log: () => {} });
  expect(back.id).toBe(a.id);
  const client = new OnebaseClient(url);
  expect(await client.query("notes:list" as any, {})).toEqual(["first"]); // v1: no .toUpperCase()
  client.close();
});

test("a bundle whose top level never finishes is refused, and later deploys still work", async () => {
  const hang = project("hang", {
    "notes.ts": `import { query } from "onebase/server";\nawait new Promise(() => {});\nexport const list = query({ args: {}, handler: () => "never" });`,
  });
  const { code } = await bundleProject(join(hang, "onebase"));
  const app2 = await startApp({
    schema: null,
    modules: {},
    dataDir: join(root, "hang-data"),
    port: 0,
    hostname: "127.0.0.1",
    dev: false,
    quiet: true,
    loadTimeoutMs: 300,
  });
  Object.assign(app2.runtime, { log: quiet }); // keep test output quiet
  try {
    await expect(app2.runtime.deploy({ code })).rejects.toThrow("didn't finish loading");
    // The deploy queue isn't stuck: a good deploy after it goes through.
    const good = project("good-after-hang", { "notes.ts": NOTES_V1 });
    const r = await app2.runtime.deploy({ code: (await bundleProject(join(good, "onebase"))).code });
    expect(r.functions).toBe(2);
  } finally {
    await app2.close();
  }
});
