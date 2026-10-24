import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { SubscriptionManager } from "../src/engine/sync";
import { defineSchema, defineTable, mutation, paginationOptsValidator, query } from "../src/server";
import { v } from "../src/values";
import { countRuns, DRIVERS, openRuntime } from "./helpers";

const fields = { board: v.string(), title: v.optional(v.string()), done: v.optional(v.boolean()) };
const plain = defineSchema({ cards: defineTable(fields) });
const schema = defineSchema({
  cards: defineTable(fields).searchIndex("search_title", { searchField: "title", filterFields: ["board"] }),
});

const search = (ctx: any, text: string, board?: string) =>
  ctx.db.query("cards").withSearchIndex("search_title", (q: any) => (board ? q.search("title", text).eq("board", board) : q.search("title", text)));

const modules = {
  cards: {
    add: mutation({ args: fields, handler: (ctx, args) => ctx.db.insert("cards", args as any) }),
    retitle: mutation({ args: { id: v.string(), title: v.optional(v.string()) }, handler: (ctx, { id, title }) => ctx.db.patch(id as any, { title }) }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
    search: query({
      args: { text: v.string(), board: v.optional(v.string()) },
      handler: async (ctx, { text, board }) => (await search(ctx, text, board).take(10)).map((c: any) => c.title),
    }),
    openOnly: query({
      args: { text: v.string() },
      handler: async (ctx, { text }) => (await search(ctx, text).filter({ done: false }).collect()).map((c: any) => c.title),
    }),
    page: query({
      args: { text: v.string(), paginationOpts: paginationOptsValidator },
      handler: (ctx, { text, paginationOpts }) => search(ctx, text).paginate(paginationOpts),
    }),
    misuse: query({
      args: { kind: v.string() },
      handler: async (ctx, { kind }) => {
        const q = ctx.db.query("cards") as any;
        if (kind === "index") return q.withSearchIndex("nope", (s: any) => s.search("title", "x")).collect();
        if (kind === "field") return q.withSearchIndex("search_title", (s: any) => s.search("board", "x")).collect();
        if (kind === "filter") return q.withSearchIndex("search_title", (s: any) => s.search("title", "x").eq("done", true)).collect();
        if (kind === "order") return q.withSearchIndex("search_title", (s: any) => s.search("title", "x")).order("desc").collect();
        return q.withSearchIndex("search_title", () => null).collect();
      },
    }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: search indexes`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-search-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules }));
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const q = async (name: string, args: unknown) => (await runtime.runQuery(name, args)).value as any;
  const add = (args: Record<string, unknown>) => runtime.runMutation("cards:add", { board: "a", ...args }) as Promise<string>;

  test("matches any word, best match first, last word as a prefix", async () => {
    await add({ title: "Buy apples" });
    await add({ title: "apples and bananas for the bake sale" });
    await add({ title: "Fix the bike" });
    await add({}); // no title: not indexed

    expect((await q("cards:search", { text: "apples bananas" }))[0]).toBe("apples and bananas for the bake sale");
    expect(await q("cards:search", { text: "APPLES" })).toHaveLength(2);
    expect(await q("cards:search", { text: "bik" })).toEqual(["Fix the bike"]);
    expect(await q("cards:search", { text: "bi apples" })).toHaveLength(2); // only the last word is a prefix
    expect(await q("cards:search", { text: "  ?! " })).toEqual([]);
    expect(await q("cards:search", { text: "zebra" })).toEqual([]);
  });

  test("filter fields and .filter() narrow the results", async () => {
    await add({ board: "home", title: "paint the fence", done: false });
    await add({ board: "work", title: "paint the office", done: false });
    await add({ board: "home", title: "paint the door", done: true });
    expect((await q("cards:search", { text: "paint", board: "work" }))).toEqual(["paint the office"]);
    expect((await q("cards:search", { text: "paint", board: "home" })).sort()).toEqual(["paint the door", "paint the fence"]);
    expect((await q("cards:openOnly", { text: "paint" })).sort()).toEqual(["paint the fence", "paint the office"]);
  });

  test("follows inserts, edits and deletes", async () => {
    const id = await add({ title: "draft the report" });
    expect(await q("cards:search", { text: "report" })).toEqual(["draft the report"]);
    await runtime.runMutation("cards:retitle", { id, title: "send the invoice" });
    expect(await q("cards:search", { text: "report" })).toEqual([]);
    expect(await q("cards:search", { text: "invoice" })).toEqual(["send the invoice"]);
    await runtime.runMutation("cards:retitle", { id, title: undefined });
    expect(await q("cards:search", { text: "invoice" })).toEqual([]);
    await runtime.runMutation("cards:retitle", { id, title: "invoice again" });
    await runtime.runMutation("cards:remove", { id });
    expect(await q("cards:search", { text: "invoice" })).toEqual([]);
  });

  test("paginates in relevance order", async () => {
    for (let i = 0; i < 5; i++) await add({ title: `task number ${i}` });
    const pageOf = (cursor: string | null) => q("cards:page", { text: "task", paginationOpts: { numItems: 2, cursor } });
    const p1 = await pageOf(null);
    const p2 = await pageOf(p1.continueCursor);
    const p3 = await pageOf(p2.continueCursor);
    const titles = [...p1.page, ...p2.page, ...p3.page].map((c: any) => c.title);
    expect(new Set(titles).size).toBe(5);
    expect([p1.isDone, p2.isDone, p3.isDone]).toEqual([false, false, true]);
  });

  test("live search results update, and other boards don't re-run them", async () => {
    const subs = new SubscriptionManager(runtime);
    const runs = countRuns(runtime);
    const seen: string[][] = [];
    subs.subscribe("cards:search", { text: "milk", board: "a" }, null, (u) => u.ok && seen.push(u.value as string[]));
    await Bun.sleep(20);
    await add({ board: "a", title: "buy milk" });
    await add({ board: "b", title: "milk the cow" });
    expect(seen).toEqual([[], ["buy milk"]]);
    expect(runs['cards:search{"text":"milk","board":"a"}']).toBe(2);
  });

  test("explains mistakes", async () => {
    const err = async (kind: string) => ((await q("cards:misuse", { kind }).catch((e) => e)) as Error).message;
    expect(await err("index")).toContain('Search index "nope" doesn\'t exist on "cards". Available: search_title');
    expect(await err("field")).toContain('searches "title", not "board"');
    expect(await err("filter")).toContain('"done" isn\'t a filter field');
    expect(await err("order")).toContain("ordered by relevance");
    expect(await err("return")).toContain("must return q.search(...)");
  });

  test("an index added later covers existing documents; removing it drops it", async () => {
    runtime.stop();
    await driver.close();
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema: plain, modules }));
    await add({ title: "written before the index existed" });
    runtime.stop();
    await driver.close();

    driver = D.make(dir);
    const { Runtime } = await import("../src/engine/runtime");
    runtime = new Runtime({ driver, schema, modules, log: runtime.log });
    expect((await runtime.init()).created).toEqual(["sx_cards__search_title"]);
    expect(await q("cards:search", { text: "existed" })).toEqual(["written before the index existed"]);
    runtime.stop();

    runtime = new Runtime({ driver, schema: plain, modules, log: runtime.log });
    expect((await runtime.init()).dropped).toEqual(["sx_cards__search_title"]);
  });

  test.if(D.name !== "postgres")("ignores accents (SQLite and libSQL)", async () => {
    await add({ title: "Crème brûlée at the café" });
    expect(await q("cards:search", { text: "creme cafe" })).toEqual(["Crème brûlée at the café"]);
  });
});
