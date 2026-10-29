// Convex's current db API names the table first: db.get("messages", id), db.patch("messages", id, ...).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const schema = defineSchema({ notes: defineTable({ text: v.string() }), tags: defineTable({ name: v.string() }) });

const modules = {
  t: {
    add: mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) }),
    tag: mutation({ args: {}, handler: (ctx) => ctx.db.insert("tags", { name: "x" }) }),
    get: query({ args: { table: v.string(), id: v.string() }, handler: (ctx: any, { table, id }) => ctx.db.get(table, id) }),
    patch: mutation({ args: { table: v.string(), id: v.string(), text: v.string() }, handler: (ctx: any, { table, id, text }) => ctx.db.patch(table, id, { text }) }),
    replace: mutation({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.db.replace("notes", id, { text: "replaced" }) }),
    remove: mutation({ args: { table: v.string(), id: v.string() }, handler: (ctx: any, { table, id }) => ctx.db.delete(table, id) }),
    // The documented Convex pattern: a v.id() argument, then the one-argument db calls.
    typedGet: query({ args: { id: v.id("notes") }, handler: (ctx, { id }) => ctx.db.get(id) }),
    typedRemove: mutation({ args: { id: v.id("notes") }, handler: (ctx, { id }) => ctx.db.delete(id) }),
    oldForm: mutation({
      args: { id: v.string() },
      handler: async (ctx: any, { id }) => {
        await ctx.db.patch(id, { text: "old form" });
        return (await ctx.db.get(id)).text;
      },
    }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: table-first db calls`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-table-first-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = async (table: string, id: string) => (await runtime.runQuery("t:get", { table, id })).value as any;

  test("a v.id() argument only takes ids of its own table", async () => {
    const note = (await runtime.runMutation("t:add", { text: "a" })) as string;
    const tag = (await runtime.runMutation("t:tag", {})) as string;
    expect((await runtime.runQuery("t:typedGet", { id: note })).value).toMatchObject({ text: "a" });
    for (const id of [tag, "x", note.slice(0, -1)]) {
      await expect(runtime.runQuery("t:typedGet", { id })).rejects.toThrow('args.id must be an id for table "notes"');
    }
    await expect(runtime.runMutation("t:typedRemove", { id: tag })).rejects.toThrow('must be an id for table "notes"');
    expect(await get("tags", tag)).toMatchObject({ name: "x" });
  });

  test("get, patch, replace and delete take the table first", async () => {
    const id = (await runtime.runMutation("t:add", { text: "a" })) as string;
    expect(await get("notes", id)).toMatchObject({ text: "a" });
    await runtime.runMutation("t:patch", { table: "notes", id, text: "b" });
    expect(await get("notes", id)).toMatchObject({ text: "b" });
    await runtime.runMutation("t:replace", { id });
    expect(await get("notes", id)).toMatchObject({ text: "replaced" });
    expect(await runtime.runMutation("t:oldForm", { id })).toBe("old form");
    await runtime.runMutation("t:remove", { table: "notes", id });
    expect(await get("notes", id)).toBeNull();
  });

  test("an id from another table is an error, not a silent miss", async () => {
    const note = (await runtime.runMutation("t:add", { text: "a" })) as string;
    await runtime.runMutation("t:tag", {});
    await expect(get("tags", note)).rejects.toThrow(`db.get("tags", id): "${note}" isn't an id for "tags".`);
    await expect(runtime.runMutation("t:patch", { table: "tags", id: note, text: "x" })).rejects.toThrow(`isn't an id for "tags"`);
    await expect(runtime.runMutation("t:remove", { table: "nope", id: note })).rejects.toThrow('Table "nope" is not in schema.ts');
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(db: import("../src/server").DatabaseWriter<import("../src/server").DataModelFromSchema<typeof schema>>) {
  const id = await db.insert("notes", { text: "x" });
  const note = await db.get("notes", id);
  const text: string | undefined = note?.text;
  await db.patch("notes", id, { text: "y" });
  await db.replace("notes", id, { text: "z" });
  await db.delete("notes", id);
  // @ts-expect-error: a notes id isn't a tags id
  await db.get("tags", id);
  return text;
}
void _types;
