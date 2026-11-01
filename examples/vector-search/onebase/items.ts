import { ConvexError, v } from "onebase/values";
import { action, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * A deterministic stand-in for an embedding API: a normalized bag-of-words
 * hashed into 64 dimensions. Real apps would call a model here instead, but
 * this keeps the example runnable with no keys and no network.
 */
function embed(text: string): number[] {
  const vector = new Array<number>(64).fill(0);
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  for (const word of words) {
    let hash = 2166136261;
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % 64]! += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!norm) throw new ConvexError("Write some words to embed");
  return vector.map((x) => x / norm);
}

export const list = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("items").withIndex("by_creation_time").collect(),
});

/** Keyword search, for comparing against the vector results. */
export const search = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    return await ctx.db
      .query("items")
      .withSearchIndex("search_text", (q) => q.search("text", text))
      .take(10);
  },
});

/**
 * Stores an item and its embedding. Embedding happens here in the action;
 * the write goes through an internal mutation in store.ts.
 */
export const addAndIndex = action({
  args: { text: v.string(), kind: v.string() },
  handler: async (ctx, { text, kind }) => {
    const vector = embed(text);
    return await ctx.runMutation(internal.store.insert, { text, kind, embedding: vector });
  },
});

/**
 * "Find similar items": vector search + filters + loading the documents.
 * Both filter styles the API supports: one value, or any of several.
 */
export const similar = action({
  args: {
    text: v.string(),
    kind: v.optional(v.string()),
    kinds: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { text, kind, kinds, limit }) => {
    const vector = embed(text);
    const results =
      kind !== undefined
        ? await ctx.vectorSearch("items", "by_embedding", {
            vector,
            limit: Math.min(Math.max(limit ?? 5, 1), 32),
            filter: (q) => q.eq("kind", kind),
          })
        : kinds !== undefined && kinds.length > 0
          ? await ctx.vectorSearch("items", "by_embedding", {
              vector,
              limit: Math.min(Math.max(limit ?? 5, 1), 32),
              filter: (q) => q.or(...kinds.map((k) => q.eq("kind", k))),
            })
          : await ctx.vectorSearch("items", "by_embedding", {
              vector,
              limit: Math.min(Math.max(limit ?? 5, 1), 32),
            });
    // { _id, _score } hits, most similar first; load the documents to show them.
    return await ctx.runQuery(internal.store.withScores, { hits: results });
  },
});

/** A few starter items so the page has something to search right away. */
export const seed = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("items").first();
    if (existing) return;
    for (const [text, kind] of [
      ["Kubernetes orchestrates containers across a cluster of machines", "fact"],
      ["Postgres streams WAL to standbys for replication", "fact"],
      ["A good password manager is the highest-leverage security habit", "idea"],
      ["Batching database writes amortizes the cost of each commit", "idea"],
      ["The martinez is basically a gin margarita with maraschino", "note"],
      ["Sourdough starters ferment faster in a warm kitchen", "note"],
    ] as const) {
      // embed() is plain local code, so mutations can use it too.
      await ctx.db.insert("items", { text, kind, embedding: embed(text) });
    }
  },
});
