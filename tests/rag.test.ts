import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { chunkText, rag } from "../src/components/rag";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { anyApi, action, defineSchema, defineTable, internalAction, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const internal = anyApi;

// A deterministic fake embedder: [banana count, has apple, length].
const vec = (text: string): number[] => {
  const key = text.toLowerCase();
  return [(key.match(/banana/g) ?? []).length, key.includes("apple") ? 1 : 0, Math.min(key.length / 100, 1)];
};
let embedFails = 0;
let embedBadDims = false;
let embedBatchSizes: number[] = [];

const embed = internalAction({
  args: { texts: v.array(v.string()) },
  handler: async (_ctx, { texts }) => {
    embedBatchSizes.push(texts.length);
    if (embedFails > 0) {
      embedFails--;
      throw new Error("embedder down");
    }
    if (embedBadDims) return texts.map(() => [1, 2]);
    return texts.map(vec);
  },
});

const components = defineComponents({
  docs: rag({ dimensions: 3, chunking: { maxChars: 60, overlap: 10 } }),
  other: rag({ dimensions: 3 }),
});

const schema = defineSchema({ unused: defineTable({ n: v.number() }) });

const modules = {
  rag: { embed },
  admin: {
    init: mutation({ args: {}, handler: (ctx: any) => ctx.components.docs.setEmbedder({ embed: internal.rag.embed }) }),
    add: mutation({
      args: { mount: v.optional(v.string()), namespace: v.string(), key: v.optional(v.string()), title: v.optional(v.string()), metadata: v.optional(v.any()), importance: v.optional(v.number()), text: v.optional(v.string()), chunks: v.optional(v.array(v.string())) },
      handler: (ctx: any, { mount = "docs", ...args }) => ctx.components[mount].add(args),
    }),
    replace: mutation({
      args: { namespace: v.optional(v.string()), key: v.optional(v.string()), entryId: v.optional(v.string()), text: v.optional(v.string()) },
      handler: (ctx: any, args) => ctx.components.docs.replace(args),
    }),
    remove: mutation({
      args: { entryId: v.optional(v.string()), namespace: v.optional(v.string()), key: v.optional(v.string()) },
      handler: (ctx: any, args) => ctx.components.docs.delete(args),
    }),
    search: action({
      args: { namespace: v.string(), query: v.string(), limit: v.optional(v.number()), mode: v.optional(v.string()) },
      handler: (ctx: any, { namespace, query, limit, mode }) => ctx.components.docs.search({ namespace, query, limit, mode }),
    }),
    status: query({ args: { id: v.string() }, handler: (ctx: any, { id }) => ctx.components.docs.status({ entryId: id }) }),
    list: query({ args: { namespace: v.string() }, handler: (ctx: any, { namespace }) => ctx.components.docs.list({ namespace, paginationOpts: { numItems: 50, cursor: null } }) }),
    otherList: query({ args: {}, handler: (ctx: any) => ctx.components.other.list({ namespace: "ns", paginationOpts: { numItems: 50, cursor: null } }) }),
  },
};

// The search wrapper runs through useQuery above, but search is an action: run it via runtime.runAction directly.
for (const D of DRIVERS) describe(`${D.name}: rag`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-rag-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.runMutation("admin:init", {});
    await runtime.startScheduler();
    embedFails = 0;
    embedBadDims = false;
    embedBatchSizes = [];
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const add = (args: Record<string, unknown>) => runtime.runMutation("admin:add", args) as Promise<{ entryId: string }>;
  const status = async (id: string) => (await runtime.runQuery("admin:status", { id })).value as any;
  const search = async (args: Record<string, unknown>) => (await runtime.runAction("admin:search", args)) as any[];
  /** Adds and waits until the background embedder has finished with it. */
  const addReady = async (args: Record<string, unknown>) => {
    const { entryId } = await add(args);
    await until(async () => (await status(entryId))?.state === "ready");
    return entryId;
  };
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("adds a document, embeds it in the background, and searches it by vector", async () => {
    await addReady({ namespace: "help", key: "bananas", title: "Bananas", metadata: { topic: "fruit" }, text: "Bananas are yellow and sweet." });
    await addReady({ namespace: "help", text: "Apples are red and crunchy." });
    await addReady({ namespace: "help", key: "mix", text: "A banana is not an apple, but a banana tree is a plant." });
    const results = await search({ namespace: "help", query: "banana banana", limit: 2 });
    expect(results).toHaveLength(2);
    expect((results[0] as any).text.toLowerCase()).toContain("banana");
    expect(results[0]!.score).toBeGreaterThan((results[1]!.score as number));
    expect(results[0]!.title).toBe("Bananas");
    expect(results[0]!.metadata).toEqual({ topic: "fruit" });
  });

  test("accepts pre-split chunks and chunks long text itself", async () => {
    const chunked = await add({ namespace: "ns", text: "one two three ".repeat(12) });
    await until(async () => (await status(chunked.entryId))?.state === "ready");
    expect((await status(chunked.entryId)).chunkCount).toBeGreaterThan(1);
    const pieces = await search({ namespace: "ns", query: "one two three", limit: 10 });
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.text.length).toBeLessThanOrEqual(60);

    const explicit = await add({ namespace: "ns", chunks: ["first chunk", "second chunk"] });
    await until(async () => (await status(explicit.entryId))?.state === "ready");
    expect((await status(explicit.entryId)).chunkCount).toBe(2);
  });

  test("replace swaps content under the same key once the new entry is ready", async () => {
    const first = await add({ namespace: "ns", key: "doc", text: "Bananas ripen fast." });
    await until(async () => (await status(first.entryId))?.state === "ready");
    const second = await runtime.runMutation("admin:replace", { namespace: "ns", key: "doc", text: "Apples keep for weeks." }) as { entryId: string };
    expect(second.entryId).not.toBe(first.entryId);
    await until(async () => (await status(second.entryId))?.state === "ready");
    expect(await status(first.entryId)).toBeNull(); // the old entry is gone
    const results = await search({ namespace: "ns", query: "apples", limit: 5 });
    expect(results.map((r) => r.entryId)).toEqual([second.entryId]);
  });

  test("replace without content is refused and keeps the entry", async () => {
    const entryId = await addReady({ namespace: "ns", key: "doc", text: "Bananas ripen fast." });
    await expect(runtime.runMutation("admin:replace", { namespace: "ns", key: "doc" })).rejects.toThrow("text or chunks");
    await expect(add({ namespace: "ns", key: "empty" })).rejects.toThrow("text or chunks");
    expect(await status(entryId)).toMatchObject({ state: "ready", chunkCount: 1 });
  });

  test("only embedded entries are searchable, and the old entry serves while its replacement isn't ready", async () => {
    const first = await addReady({ namespace: "ns", key: "doc", text: "Bananas ripen fast." });
    embedFails = 1;
    const second = (await runtime.runMutation("admin:replace", { namespace: "ns", key: "doc", text: "Bananas keep for weeks." })) as { entryId: string };
    await until(async () => (await status(second.entryId))?.state === "errored");
    for (const mode of ["vector", "text", "hybrid"]) {
      const results = await search({ namespace: "ns", query: "bananas", mode });
      expect(results.map((r) => r.entryId)).toEqual([first]);
    }
  });

  test("a newer replace supersedes one still embedding, leaving one entry for the key", async () => {
    await addReady({ namespace: "ns", key: "doc", text: "Bananas one." });
    embedFails = 1;
    const second = (await runtime.runMutation("admin:replace", { namespace: "ns", key: "doc", text: "Bananas two." })) as { entryId: string };
    await until(async () => (await status(second.entryId))?.state === "errored");
    const third = (await runtime.runMutation("admin:replace", { namespace: "ns", key: "doc", text: "Bananas three." })) as { entryId: string };
    await until(async () => (await status(third.entryId))?.state === "ready");
    const entries = (await runtime.runQuery("admin:list", { namespace: "ns" })).value as any;
    expect(entries.page.map((e: any) => e.id)).toEqual([third.entryId]);
  });

  test("deleting during a replacement removes both rows, by key or by either id", async () => {
    for (const target of ["key", "old", "new"]) {
      const key = `doc-${target}`;
      const first = await addReady({ namespace: target, key, text: "Bananas one." });
      embedFails = 1;
      const second = (await runtime.runMutation("admin:replace", { namespace: target, key, text: "Bananas two." })) as { entryId: string };
      await until(async () => (await status(second.entryId))?.state === "errored");
      const args = target === "key" ? { namespace: target, key } : { entryId: target === "old" ? first : second.entryId };
      expect(await runtime.runMutation("admin:remove", args)).toBe(true);
      const entries = (await runtime.runQuery("admin:list", { namespace: target })).value as any;
      expect(entries.page).toEqual([]);
    }
  });

  test("large entries reach the embedder in batches", async () => {
    const chunks = Array.from({ length: 150 }, (_, i) => `banana chunk ${i}`);
    await addReady({ namespace: "ns", chunks });
    expect(embedBatchSizes).toEqual([64, 64, 22]);
    expect(await search({ namespace: "ns", query: "banana", limit: 3 })).toHaveLength(3);
  });

  test("a retry only embeds the chunks still missing a vector", async () => {
    const chunks = Array.from({ length: 70 }, (_, i) => `banana chunk ${i}`);
    const { entryId } = await add({ namespace: "ns", chunks });
    await until(async () => (await status(entryId))?.state === "ready");
    embedBatchSizes = [];
    await runtime.adminWrite(async (db) => {
      const row = await db.query("docs.chunks").withIndex("by_entry", (q: any) => q.eq("entryId", entryId).eq("ordinal", 69)).unique();
      await db.patch(row!._id, { vector: undefined });
      await db.patch(entryId as any, { state: "errored" });
    });
    await runtime.runAction("components/docs:embedEntry", { entryId }, { allowInternal: true, source: "dashboard" });
    expect(embedBatchSizes).toEqual([1]);
    expect(await status(entryId)).toMatchObject({ state: "ready" });
  });

  test("delete removes an entry and its chunks", async () => {
    const added = await add({ namespace: "ns", key: "gone", text: "Bananas again." });
    await until(async () => (await status(added.entryId))?.state === "ready");
    expect(await runtime.runMutation("admin:remove", { namespace: "ns", key: "gone" })).toBe(true);
    expect(await status(added.entryId)).toBeNull();
    expect(await search({ namespace: "ns", query: "bananas" })).toEqual([]);
    expect(await runtime.runMutation("admin:remove", { namespace: "ns", key: "gone" })).toBe(false);
  });

  test("namespaces and mounts are isolated", async () => {
    await addReady({ namespace: "a", text: "Bananas here." });
    await addReady({ namespace: "b", text: "Bananas there." });
    expect(await search({ namespace: "a", query: "banana" })).toHaveLength(1);
    await addReady({ namespace: "ns", text: "Bananas elsewhere." });
    const otherList = (await runtime.runQuery("admin:otherList", {})).value as any;
    expect(otherList.page).toHaveLength(0); // the other mount has none
  });

  test("a key is unique within a namespace", async () => {
    await add({ namespace: "ns", key: "taken", text: "first" });
    await expect(add({ namespace: "ns", key: "taken", text: "second" })).rejects.toThrow("already in namespace");
  });

  test("a failing embedder marks the entry errored, and the retry loop recovers it", async () => {
    embedFails = 1;
    const added = await add({ namespace: "ns", text: "Bananas someday." });
    await until(async () => (await status(added.entryId))?.state === "errored");
    expect((await status(added.entryId)).error).toBe("embedder down");
    expect((await status(added.entryId)).attempts).toBe(1);
    // The cron only picks up stale entries; age this one and run the retry pass by hand.
    await runtime.adminWrite((db) => db.patch(added.entryId, { updatedAt: Date.now() - 120_000 }));
    await runtime.runMutation("components/docs:retryPending", {}, { allowInternal: true, source: "dashboard" });
    await until(async () => (await status(added.entryId))?.state === "ready");
    expect(await search({ namespace: "ns", query: "banana" })).toHaveLength(1);
  });

  test("an embedder with the wrong dimensions is reported, not stored", async () => {
    embedBadDims = true;
    const added = await add({ namespace: "ns", text: "Bananas, wrong size." });
    await until(async () => (await status(added.entryId))?.state === "errored");
    expect((await status(added.entryId)).error).toContain("3 dimensions");
  });

  test("list pages through a namespace's entries", async () => {
    for (const key of ["a", "b", "c"]) await add({ namespace: "ns", key, text: `entry ${key}` });
    const list = (await runtime.runQuery("admin:list", { namespace: "ns" })).value as any;
    expect(list.page.map((e: any) => e.key)).toEqual(["a", "b", "c"]);
    expect(list.page[0]).toMatchObject({ namespace: "ns", state: "pending" });
  });

  test("chunkText splits on word boundaries with overlap", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, 40, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(40);
    expect(chunks[0]!.endsWith("word5")).toBe(true); // chunk ends land on word boundaries
    expect(chunks.at(-1)).toContain("word39");
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").ActionCtx<any, typeof components>) {
  const added = await ctx.components.docs.add({ namespace: "help", key: "k", title: "t", metadata: { a: 1 }, importance: 2, text: "hello" });
  await ctx.components.docs.add({ namespace: "help", chunks: ["a", "b"] });
  // @ts-expect-error: dimensions must match at mount; unknown args are rejected
  await ctx.components.docs.add({ namespace: "help", nope: 1 });
  const replaced = await ctx.components.docs.replace({ entryId: added.entryId, text: "new" });
  await ctx.components.docs.replace({ namespace: "help", key: "k", chunks: ["x"] });
  await ctx.components.docs.delete({ namespace: "help", key: "k" });
  await ctx.components.docs.delete({ entryId: added.entryId });
  const results = await ctx.components.docs.search({ namespace: "help", query: "q", limit: 5, mode: "hybrid" });
  const score: number | null = results[0]!.score;
  const page = await ctx.components.docs.list({ namespace: "help", paginationOpts: { numItems: 10, cursor: null } });
  const st = await ctx.components.docs.status({ entryId: added.entryId });
  void replaced; void score; void page; void st;
}
void _types;
