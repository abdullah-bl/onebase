import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/doctor";

let dir: string;

beforeAll(() => {
  dir = join(mkdtempSync(join(tmpdir(), "onebase-doctor-")), "onebase");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "posts.ts"),
    `import { query } from "onebase/server";

export const oneLine = query({ args: {}, handler: (ctx) => ctx.db.query("posts").filter((p) => p.author === "x").collect() });

export const chained = query({
  args: {},
  handler: (ctx) =>
    ctx.db
      .query("posts")
      .withIndex("by_creation_time")
      .filter((p) => p.done === false)
      .collect(),
});

export const arrayAfterCollect = query({
  args: {},
  handler: async (ctx) => (await ctx.db.query("posts").collect()).filter((p) => p.author === "x"),
});

export const arrayVariable = query({
  args: {},
  handler: async (ctx) => {
    const posts = await ctx.db.query("posts").take(10);
    return posts.filter((p) => p.author === "x");
  },
});

export const plainArray = query({ args: {}, handler: () => ["a", "bb"].filter((s) => s.length === 1) });
`,
  );
});

afterAll(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

test("flags document callbacks in query .filter() but not array .filter()", async () => {
  const findings = await doctor(dir);
  const flagged = findings.filter((f) => f.message.startsWith(".filter() on a query")).map((f) => f.where);
  expect(flagged).toEqual(["posts.ts:3", "posts.ts:11"]);
});

test("checks vector index fields", async () => {
  const project = join(mkdtempSync(join(tmpdir(), "onebase-doctor-")), "onebase");
  mkdirSync(project);
  writeFileSync(
    join(project, "schema.ts"),
    `import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  docs: defineTable({ title: v.string(), embedding: v.optional(v.array(v.float64())) })
    .vectorIndex("good", { vectorField: "embedding", dimensions: 3 })
    .vectorIndex("text", { vectorField: "title", dimensions: 3 })
    .vectorIndex("missing", { vectorField: "embedding", dimensions: 3, filterFields: ["kind"] }),
});
`,
  );
  try {
    const findings = (await doctor(project)).filter((f) => f.where.includes("vectorIndex"));
    expect(findings.map((f) => [f.where, f.message])).toEqual([
      ['schema.ts › docs.vectorIndex("text")', 'vectorField "title" is v.string(); vectors are arrays of numbers.'],
      ['schema.ts › docs.vectorIndex("missing")', 'Field "kind" doesn\'t exist on "docs".'],
    ]);
  } finally {
    rmSync(join(project, ".."), { recursive: true, force: true });
  }
});
