// Components in a real project folder: loading components.ts, generated types, doctor and deploys.

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startApp } from "../src/app";
import { codegen } from "../src/codegen";
import { deploy } from "../src/deploy";
import { doctor } from "../src/doctor";
import { loadProject } from "../src/project";
import { quiet } from "./helpers";

const root = mkdtempSync(join(tmpdir(), "onebase-components-project-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function project(name: string, files: Record<string, string>): string {
  const dir = join(root, name, "onebase");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const COMPONENTS = `
import { defineComponents } from "onebase/components";
import { rateLimiter, MINUTE } from "onebase/components/rate-limiter";
export default defineComponents({ limiter: rateLimiter({ rates: { add: { kind: "fixed window", rate: 2, period: MINUTE } } }) });
`;
const SCHEMA = `
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";
export default defineSchema({ notes: defineTable({ text: v.string() }) });
`;
const NOTES = `
import { mutation, query } from "onebase/server";
import { v } from "onebase/values";
export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const { ok } = await ctx.components.limiter.limit({ name: "add" });
    if (!ok) return null;
    return ctx.db.insert("notes", { text });
  },
});
export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).length });
`;

test("components.ts loads from disk, is typed in _generated and passes doctor", async () => {
  const dir = project("disk", { "components.ts": COMPONENTS, "schema.ts": SCHEMA, "notes.ts": NOTES });
  const loaded = await loadProject(dir);
  expect(Object.keys(loaded.components!.mounts)).toEqual(["limiter"]);
  expect(Object.keys(loaded.modules)).toEqual(["notes"]);
  await codegen(dir);
  const server = readFileSync(join(dir, "_generated", "server.ts"), "utf8");
  expect(server).toContain('import type components from "../components";');
  expect(server).toContain("makeServer<DataModel, typeof components>()");
  expect(readFileSync(join(dir, "_generated", "api.ts"), "utf8")).not.toContain("../components");
  expect((await doctor(dir)).filter((f) => f.level === "error")).toEqual([]);
});

test("doctor explains the mistakes components.ts invites", async () => {
  const dir = project("mistakes", {
    "components.ts": `import { query } from "./_generated/server";\n${COMPONENTS}`,
    "schema.ts": SCHEMA,
    "notes.ts": NOTES,
    "components/extra.ts": `import { query } from "onebase/server";\nexport const f = query({ args: {}, handler: () => 1 });`,
  });
  await codegen(dir);
  const errors = (await doctor(dir)).filter((f) => f.level === "error").map((f) => `${f.where}: ${f.message}`);
  expect(errors).toContain("components.ts:1: components.ts imports _generated/server or _generated/api, which are typed from components.ts: a type cycle.");
  expect(errors).toContain("components/extra.ts: The components/ folder name is reserved for the components mounted in components.ts.");
});

test("components.ts must export defineComponents()", async () => {
  const dir = project("wrong", { "components.ts": "export default {};" });
  await expect(loadProject(dir)).rejects.toThrow("components.ts must `export default defineComponents({ ... })`");
});

test("a deploy ships components; the server provides onebase/components/* itself", async () => {
  const dir = project("deployed", { "components.ts": COMPONENTS, "schema.ts": SCHEMA, "notes.ts": NOTES });
  const dataDir = join(root, "data");
  const app = await startApp({ schema: null, modules: {}, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  Object.assign(app.runtime, { log: quiet });
  try {
    const url = `http://127.0.0.1:${app.server.port}`;
    const key = readFileSync(join(dataDir, "admin.key"), "utf8").trim();
    const dry = await deploy({ dir, url, key, public: null, dryRun: true, log: () => {} });
    expect(dry.functions).toBe(6); // add, count + the rate limiter's limit, check, reset, getValue
    const live = await deploy({ dir, url, key, public: null, log: () => {} });
    expect(live.indexes.created).toContain("cl_limiter$rateLimits__by_name_key_shard");
    for (let i = 0; i < 3; i++) await app.runtime.runMutation("notes:add", { text: `n${i}` });
    expect((await app.runtime.runQuery("notes:count", {})).value).toBe(2);
  } finally {
    await app.close();
  }
});
