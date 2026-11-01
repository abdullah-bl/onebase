// Retrieval-augmented generation: entries of chunked text, embedded in the background, searched
// by vector and by full text. The embedder is yours — an app action passed at mount time.
//
//   // onebase/components.ts
//   export default defineComponents({
//     docs: rag({ dimensions: 1536, embedder: internal.ai.embed }),
//   });
//   // internal.ai.embed: internalAction({ args: { texts: v.array(v.string()) },
//   //   handler: async (ctx, { texts }) => texts.map(text => embed(text)) })
//
//   // in a mutation
//   const { entryId } = await ctx.components.docs.add({ namespace: "help", key: page.slug, text: page.body, title: page.title });
//   // in an action
//   const results = await ctx.components.docs.search({ namespace: "help", query: "how do I reset my password", limit: 5 });
//   // [{ entryId, text, score, title, metadata }]

import type { FunctionHandle, FunctionReference } from "../../api";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { paginationOptsValidator } from "../../server";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v, type GenericId } from "../../values";

/** How text is split into chunks when you add a whole document. */
export type Chunking = {
  /** The most characters in one chunk (default 1000). */
  maxChars?: number;
  /** Characters shared between neighboring chunks, so sentences at the seam keep context (default 100). */
  overlap?: number;
};

type Config = {
  dimensions: number;
  chunking?: Chunking;
};

const entryState = v.union(v.literal("pending"), v.literal("ready"), v.literal("replacing"), v.literal("errored"));

type Ctx = { db: any; config: Config; scheduler: any; runQuery: any; runMutation: any; runAction: any; vectorSearch: any };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Splits `text` into chunks of at most `maxChars`, sharing `overlap` characters between neighbors. */
export function chunkText(text: string, maxChars = 1000, overlap = 100): string[] {
  if (text.length <= maxChars) return text.trim() ? [text.trim()] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const break_ = Math.max(text.lastIndexOf("\n", end), text.lastIndexOf(" ", end));
      if (break_ > start + maxChars / 2) end = break_;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= text.length) break;
    start = Math.max(start + 1, end - Math.min(overlap, maxChars - 1));
  }
  return chunks;
}

function checkConfig(config: Config) {
  if (!Number.isInteger(config?.dimensions) || config.dimensions < 2 || config.dimensions > 4096) {
    throw new Error("rag(): dimensions must be a whole number from 2 to 4096.");
  }
  const chunking = config?.chunking ?? {};
  const maxChars = chunking.maxChars ?? 1000;
  const overlap = chunking.overlap ?? 100;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100_000) throw new Error("rag(): chunking.maxChars must be a whole number from 1 to 100000.");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxChars) throw new Error("rag(): chunking.overlap must be a whole number smaller than maxChars.");
}

const chunkingFor = (config: Config) => ({ maxChars: config.chunking?.maxChars ?? 1000, overlap: config.chunking?.overlap ?? 100 });

const entryView = (entry: any) => ({
  id: entry._id as string,
  namespace: entry.namespace as string,
  key: entry.key ?? null,
  title: entry.title ?? null,
  metadata: entry.metadata ?? null,
  importance: entry.importance as number,
  state: entry.state as "pending" | "ready" | "replacing" | "errored",
  chunkCount: entry.chunkCount as number,
  attempts: entry.attempts as number,
  error: entry.error ?? null,
  createdAt: entry._creationTime as number,
});

/**
 * Mounts a RAG index: `rag({ dimensions: 1536 })`. Each mount keeps its own entries; the vector
 * index is built with this mount's dimensions. The embedder is registered once per mount with
 * setEmbedder(), from one of your functions:
 */
export function rag<const E extends keyof RagApi = never>(opts: Config & MountOptions<E>): Mount<RagApi, E> {
  const { config, options } = splitMountOptions(opts);
  checkConfig(config);

  const schema = defineSchema({
    entries: defineTable({
      namespace: v.string(),
      /** The caller's stable id, for replace() and delete(); unique within a namespace. */
      key: v.optional(v.string()),
      title: v.optional(v.string()),
      metadata: v.optional(v.any()),
      importance: v.number(),
      state: entryState,
      chunkCount: v.number(),
      /** Set on the entry this one replaces, deleted once this entry is ready. */
      replaces: v.optional(v.string()),
      /** Set on the replaced entry while its replacement is embedding. */
      replacedBy: v.optional(v.string()),
      attempts: v.number(),
      error: v.optional(v.string()),
      updatedAt: v.number(),
    })
      .index("by_namespace_key", ["namespace", "key"])
      .index("by_state_updatedAt", ["state", "updatedAt"]),
    chunks: defineTable({
      namespace: v.string(),
      entryId: v.string(),
      ordinal: v.number(),
      text: v.string(),
      vector: v.optional(v.array(v.number())),
    })
      .index("by_entry", ["entryId", "ordinal"])
      .searchIndex("by_text", { searchField: "text", filterFields: ["namespace"] })
      .vectorIndex("by_vector", { vectorField: "vector", dimensions: config.dimensions, filterFields: ["namespace"] }),
    /** One row per setting; holds the embedder handle the app registered with setEmbedder(). */
    settings: defineTable({ key: v.string(), embed: v.string() }).index("by_key", ["key"]),
  });

  const { query, mutation, action, internalQuery, internalMutation, internalAction } = componentServer<DataModelFromSchema<typeof schema>, Config>();

  /** The embedder handle the app registered (actions fetch it with runQuery: they have no ctx.db). */
  const embedderRow = internalQuery({
    args: {},
    handler: async (ctx): Promise<FunctionHandle<"action", { texts: string[] }, number[][]>> => {
      const row = await ctx.db.query("settings").withIndex("by_key", (q: any) => q.eq("key", "embedder")).unique();
      if (!row) throw new Error("rag: no embedder registered yet. Call setEmbedder({ embed: internal.yourModule.embed }) from one of your mutations.");
      return row.embed as FunctionHandle<"action", { texts: string[] }, number[][]>;
    },
  });

  /** Registers the app's embedder: an action taking `{ texts: string[] }` and returning one vector per text. */
  const setEmbedder = mutation({
    args: { embed: v.string() },
    handler: async (ctx, { embed }) => {
      if (!embed.startsWith("function://")) {
        throw new Error("setEmbedder: embed must be a function reference (internal.x.y); onebase converts it to a handle.");
      }
      const row = await ctx.db.query("settings").withIndex("by_key", (q: any) => q.eq("key", "embedder")).unique();
      if (row) await ctx.db.patch(row._id, { embed });
      else await ctx.db.insert("settings", { key: "embedder", embed });
      return null;
    },
  });

  const entryRow = internalQuery({
    args: { entryId: v.string() },
    handler: async (ctx, { entryId }) => {
      const entry = await ctx.db.get(entryId as GenericId<"entries">);
      return entry && entry.chunkCount !== undefined ? entry : null;
    },
  });

  const chunkRow = internalQuery({
    args: { id: v.string() },
    handler: async (ctx, { id }) => {
      const chunk = await ctx.db.get(id as GenericId<"chunks">);
      return chunk && chunk.entryId !== undefined ? chunk : null;
    },
  });

  const searchText = internalQuery({
    args: { namespace: v.string(), query: v.string(), limit: v.number() },
    handler: async (ctx, { namespace, query: text, limit }) =>
      ctx.db.query("chunks").withSearchIndex("by_text", (q: any) => q.search("text", text).eq("namespace", namespace)).take(limit),
  });

  const missingVectors = internalQuery({
    args: { entryId: v.string() },
    handler: async (ctx, { entryId }) => {
      const chunks = await ctx.db.query("chunks").withIndex("by_entry", (q: any) => q.eq("entryId", entryId)).collect();
      return chunks.filter((c: any) => c.vector === undefined);
    },
  });

  /** Inserts the entry and its chunks, then schedules the embedder. */
  async function addEntry(ctx: { db: any; config: Config; scheduler: any }, args: { namespace: string; key?: string; title?: string; metadata?: unknown; importance?: number; replaces?: string; text?: string; chunks?: string[] }) {
    const texts = args.text !== undefined ? chunkText(args.text, chunkingFor(ctx.config).maxChars, chunkingFor(ctx.config).overlap) : args.chunks ?? [];
    if (args.text !== undefined && texts.length === 0) throw new Error("add: the text is empty.");
    for (const text of texts) {
      if (typeof text !== "string" || text.length === 0) throw new Error("add: chunks must be non-empty strings.");
    }
    const now = Date.now();
    const entryId = await ctx.db.insert("entries", {
      namespace: args.namespace,
      key: args.key,
      title: args.title,
      metadata: args.metadata,
      importance: args.importance ?? 0,
      state: "pending",
      chunkCount: texts.length,
      replaces: args.replaces,
      attempts: 0,
      updatedAt: now,
    });
    for (let ordinal = 0; ordinal < texts.length; ordinal++) {
      await ctx.db.insert("chunks", { namespace: args.namespace, entryId, ordinal, text: texts[ordinal]! });
    }
    await ctx.scheduler.runAfter(0, embedEntry, { entryId });
    return entryId;
  }

  /** Adds an entry. `key` must be free within the namespace; use replace() to take one over. */
  const add = mutation({
    args: { namespace: v.string(), key: v.optional(v.string()), title: v.optional(v.string()), metadata: v.optional(v.any()), importance: v.optional(v.number()), text: v.optional(v.string()), chunks: v.optional(v.array(v.string())) },
    handler: async (ctx, args): Promise<{ entryId: string }> => {
      if (args.key !== undefined) {
        const existing = await ctx.db.query("entries").withIndex("by_namespace_key", (q: any) => q.eq("namespace", args.namespace).eq("key", args.key)).first();
        if (existing) throw new Error(`add: key "${args.key}" is already in namespace "${args.namespace}". Use replace() to replace it.`);
      }
      return { entryId: await addEntry(ctx, args) };
    },
  });

  /** Replaces an entry (by id or by namespace + key) with new content: the old one serves until the new one is ready. */
  const replace = mutation({
    args: { entryId: v.optional(v.string()), namespace: v.optional(v.string()), key: v.optional(v.string()), title: v.optional(v.string()), metadata: v.optional(v.any()), importance: v.optional(v.number()), text: v.optional(v.string()), chunks: v.optional(v.array(v.string())) },
    handler: async (ctx, args): Promise<{ entryId: string }> => {
      let old: any = null;
      if (args.entryId !== undefined) old = await ctx.db.get(args.entryId as GenericId<"entries">);
      else if (args.namespace !== undefined && args.key !== undefined) {
        old = await ctx.db.query("entries").withIndex("by_namespace_key", (q: any) => q.eq("namespace", args.namespace).eq("key", args.key)).first();
      } else throw new Error("replace: pass entryId, or namespace and key.");
      if (!old) throw new Error("replace: no such entry.");
      const newId = await addEntry(ctx, {
        namespace: old.namespace,
        key: old.key ?? undefined,
        title: args.title ?? old.title ?? undefined,
        metadata: args.metadata ?? old.metadata ?? undefined,
        importance: args.importance ?? old.importance,
        replaces: old._id,
        text: args.text,
        chunks: args.chunks,
      });
      await ctx.db.patch(old._id, { state: "replacing", replacedBy: newId, updatedAt: Date.now() });
      return { entryId: newId };
    },
  });

  /** Deletes an entry and its chunks, by id or by namespace + key. */
  const delete_ = mutation({
    args: { entryId: v.optional(v.string()), namespace: v.optional(v.string()), key: v.optional(v.string()) },
    handler: async (ctx, args): Promise<boolean> => {
      let entry: any = null;
      if (args.entryId !== undefined) entry = await ctx.db.get(args.entryId as GenericId<"entries">);
      else if (args.namespace !== undefined && args.key !== undefined) {
        entry = await ctx.db.query("entries").withIndex("by_namespace_key", (q: any) => q.eq("namespace", args.namespace).eq("key", args.key)).first();
      } else throw new Error("delete: pass entryId, or namespace and key.");
      if (!entry) return false;
      await removeEntry(ctx, entry);
      return true;
    },
  });

  async function removeEntry(ctx: { db: any }, entry: any) {
    for (const chunk of await ctx.db.query("chunks").withIndex("by_entry", (q: any) => q.eq("entryId", entry._id)).collect()) {
      await ctx.db.delete(chunk._id);
    }
    await ctx.db.delete(entry._id);
  }

  /** Entries in a namespace, oldest first, a page at a time. */
  const list = query({
    args: { namespace: v.string(), paginationOpts: paginationOptsValidator },
    handler: async (ctx, { namespace, paginationOpts }) => {
      const page = await ctx.db.query("entries").withIndex("by_namespace_key", (q: any) => q.eq("namespace", namespace)).paginate(paginationOpts);
      return { ...page, page: page.page.map(entryView) };
    },
  });

  /** Where an entry stands: pending (not embedded yet), ready, errored, or replacing. */
  const status = query({
    args: { entryId: v.string() },
    handler: async (ctx, { entryId }) => {
      const entry = await ctx.db.get(entryId as GenericId<"entries">);
      return entry && entry.chunkCount !== undefined ? entryView(entry) : null;
    },
  });

  /** Searches a namespace. `mode`: "vector" (default), "text", or "hybrid" (both, merged). */
  const searchFn = action({
    args: { namespace: v.string(), query: v.string(), limit: v.optional(v.number()), mode: v.optional(v.union(v.literal("vector"), v.literal("text"), v.literal("hybrid"))) },
    handler: async (ctx, args): Promise<RagResult[]> => {
      const limit = args.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("search: limit must be a whole number from 1 to 256.");
      const mode = args.mode ?? "vector";
      const results: RagResult[] = [];
      const seen = new Set<string>(); // chunk ids, so hybrid doesn't list a chunk twice

      if (mode !== "text") {
        const vectors = (await ctx.runAction(await ctx.runQuery(embedderRow, {}), { texts: [args.query] })) as unknown;
        const vector = Array.isArray(vectors) ? vectors[0] : undefined;
        if (!Array.isArray(vector) || vector.length !== ctx.config.dimensions) {
          throw new Error(`search: the embedder returned ${Array.isArray(vector) ? vector.length : "no"} dimensions, this mount indexes ${ctx.config.dimensions}.`);
        }
        const hits = await ctx.vectorSearch("chunks", "by_vector", { vector, limit, filter: (q: any) => q.eq("namespace", args.namespace) });
        for (const hit of hits) {
          const chunk = await ctx.runQuery(chunkRow, { id: hit._id });
          if (!chunk || seen.has(chunk._id)) continue;
          seen.add(chunk._id);
          const entry = await ctx.runQuery(entryRow, { entryId: chunk.entryId });
          if (!entry) continue;
          results.push({ entryId: entry._id, text: chunk.text, score: hit._score + (entry.importance ?? 0), title: entry.title ?? null, metadata: entry.metadata ?? null });
        }
      }
      if (mode !== "vector") {
        const rows = await ctx.runQuery(searchText, { namespace: args.namespace, query: args.query, limit });
        for (const chunk of rows) {
          if (seen.has(chunk._id)) continue;
          seen.add(chunk._id);
          const entry = await ctx.runQuery(entryRow, { entryId: chunk.entryId });
          if (!entry) continue;
          results.push({ entryId: entry._id, text: chunk.text, score: null, title: entry.title ?? null, metadata: entry.metadata ?? null });
        }
      }
      return results.sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
    },
  });

  /** Embeds an entry's chunks in batches, then marks it ready and drops what it replaced. */
  const embedEntry = internalAction({
    args: { entryId: v.string() },
    handler: async (ctx, { entryId }) => {
      const entry = await ctx.runQuery(entryRow, { entryId });
      if (!entry || (entry.state !== "pending" && entry.state !== "errored")) return null;
      for (;;) {
        const batch = await ctx.runQuery(missingVectors, { entryId });
        if (batch.length === 0) break;
        let vectors: unknown;
        try {
          vectors = await ctx.runAction(await ctx.runQuery(embedderRow, {}), { texts: batch.map((c: any) => c.text) });
        } catch (err) {
          await ctx.runMutation(markErrored, { entryId, error: message(err) });
          return null;
        }
        if (!Array.isArray(vectors) || vectors.length !== batch.length) {
          await ctx.runMutation(markErrored, { entryId, error: `The embedder returned ${Array.isArray(vectors) ? vectors.length : "no"} vectors for ${batch.length} texts.` });
          return null;
        }
        for (let i = 0; i < batch.length; i++) {
          const vector = vectors[i];
          if (!Array.isArray(vector) || vector.length !== ctx.config.dimensions) {
            await ctx.runMutation(markErrored, { entryId, error: `The embedder returned a ${Array.isArray(vector) ? vector.length : "non-vector"} for "${batch[i]!.text.slice(0, 40)}…", this mount indexes ${ctx.config.dimensions} dimensions.` });
            return null;
          }
          await ctx.runMutation(setVector, { id: batch[i]!._id, vector });
        }
      }
      await ctx.runMutation(markReady, { entryId });
      return null;
    },
  });

  const setVector = internalMutation({
    args: { id: v.string(), vector: v.array(v.number()) },
    handler: async (ctx, { id, vector }) => {
      await ctx.db.patch(id as GenericId<"chunks">, { vector });
      return null;
    },
  });

  const markErrored = internalMutation({
    args: { entryId: v.string(), error: v.string() },
    handler: async (ctx, { entryId, error }) => {
      const entry = await ctx.db.get(entryId as GenericId<"entries">);
      if (!entry || (entry.state !== "pending" && entry.state !== "errored")) return null;
      await ctx.db.patch(entry._id, { state: "errored", error, attempts: entry.attempts + 1, updatedAt: Date.now() });
      return null;
    },
  });

  const markReady = internalMutation({
    args: { entryId: v.string() },
    handler: async (ctx, { entryId }) => {
      const entry = await ctx.db.get(entryId as GenericId<"entries">);
      if (!entry) return null;
      await ctx.db.patch(entry._id, { state: "ready", error: undefined, updatedAt: Date.now() });
      if (entry.replaces) {
        const old = await ctx.db.get(entry.replaces as GenericId<"entries">);
        if (old) await removeEntry(ctx, old);
      }
      return null;
    },
  });

  /** Every minute: retries entries whose embedding failed (up to 5 attempts). */
  const retryPending = internalMutation({
    args: {},
    handler: async (ctx) => {
      const now = Date.now();
      for (const state of ["pending", "errored"] as const) {
        const stale = await ctx.db
          .query("entries")
          .withIndex("by_state_updatedAt", (q: any) => q.eq("state", state).lt("updatedAt", now - 60_000))
          .take(50);
        for (const entry of stale) {
          if (entry.attempts >= 5) continue;
          await ctx.scheduler.runAfter(0, embedEntry, { entryId: entry._id });
        }
      }
      return null;
    },
  });

  const definition = defineComponent({
    name: "rag",
    schema,
    functions: { add, replace, delete: delete_, list, status, search: searchFn, setEmbedder, entryRow, chunkRow, searchText, embedderRow, missingVectors, embedEntry, setVector, markErrored, markReady, retryPending },
    crons: () => [{ name: "retryPending", schedule: { minutes: 1 }, fn: retryPending }],
  });

  return definition.mount(config, options) as unknown as Mount<RagApi, E>;
}

// ---- Types for the app ----

export type RagResult = { entryId: string; text: string; score: number | null; title: string | null; metadata: unknown };
export type RagEntry = { id: string; namespace: string; key: string | null; title: string | null; metadata: unknown; importance: number; state: "pending" | "ready" | "replacing" | "errored"; chunkCount: number; attempts: number; error: string | null; createdAt: number };

type Content = { title?: string; metadata?: unknown; importance?: number; /** The whole text, chunked by the mount's settings. */ text?: string; /** Pre-split chunks, used as-is. */ chunks?: string[] };

export type RagApi = {
  setEmbedder: ComponentFn<"mutation", (args: { embed: FunctionReference<"action", any, { texts: string[] }, number[][]> | string }) => Promise<null>>;
  add: ComponentFn<"mutation", (args: { namespace: string; key?: string } & Content) => Promise<{ entryId: string }>>;
  replace: ComponentFn<"mutation", (args: ({ entryId: string } | { namespace: string; key: string }) & Content) => Promise<{ entryId: string }>>;
  delete: ComponentFn<"mutation", (args: { entryId: string } | { namespace: string; key: string }) => Promise<boolean>>;
  list: ComponentFn<"query", (args: { namespace: string; paginationOpts: { numItems: number; cursor: string | null } }) => Promise<{ page: RagEntry[]; isDone: boolean; continueCursor: string }>>;
  status: ComponentFn<"query", (args: { entryId: string }) => Promise<RagEntry | null>>;
  search: ComponentFn<"action", (args: { namespace: string; query: string; limit?: number; mode?: "vector" | "text" | "hybrid" }) => Promise<RagResult[]>>;
};
