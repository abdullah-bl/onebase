import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";

// Vector-search bench: 1536-dim (OpenAI text-embedding-3-small size).
// Vectors are generated server-side from a seed (deterministic on both
// platforms, same corpus everywhere) so the HTTP argument stays tiny —
// the Convex 16MiB arg limit would reject a real 1536-float array anyway.

export const DIM = 1536;

/** Deterministic unit vector from a seed. fround() keeps every component
 *  exactly representable in the float32 the vector indexes store. */
function makeVector(seed: number, dim: number): number[] {
  let a = seed | 0;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const vec = Array.from({ length: dim }, () => Math.fround(next()));
  let norm = 0;
  for (const x of vec) norm += x * x;
  norm = Math.sqrt(norm);
  return vec.map((x) => Math.fround(x / norm));
}

// ---------- seeding ----------
export const vectorSeed = mutation({
  args: { start: v.number(), n: v.number() },
  handler: async (ctx, { start, n }) => {
    for (let i = start; i < start + n; i++) {
      await ctx.db.insert("embeddings", {
        idx: i,
        kind: i % 2 === 0 ? "even" : "odd",
        embedding: makeVector(i, DIM),
      });
    }
    const metas = await ctx.db.query("vectorsMeta").collect();
    const counter = metas.find((m) => m.name === "count");
    if (counter) await ctx.db.patch(counter._id, { n: counter.n + n });
    else await ctx.db.insert("vectorsMeta", { name: "count", n });
    return n;
  },
});

export const vectorCount = query({
  args: {},
  handler: async (ctx) => {
    const metas = await ctx.db.query("vectorsMeta").collect();
    return metas.find((m) => m.name === "count")?.n ?? 0;
  },
});

// ---------- search ----------
export const vectorSearchRun = action({
  args: { seed: v.number(), limit: v.number(), kind: v.optional(v.string()) },
  handler: async (ctx, { seed, limit, kind }) => {
    const vector = makeVector(seed, DIM);
    const opts: any = { vector, limit };
    if (kind) opts.filter = (q: any) => q.eq("kind", kind);
    const results = await ctx.vectorSearch("embeddings", "by_embedding", opts);
    return { n: results.length, top: results[0] ? results[0]._score : -1 };
  },
});

/** Search with the exact vector of seeded doc `seed` — used to measure how
 *  quickly a just-written doc becomes visible to the vector index. */
export const vectorExact = action({
  args: { seed: v.number() },
  handler: async (ctx, { seed }) => {
    const results = await ctx.vectorSearch("embeddings", "by_embedding", {
      vector: makeVector(seed, DIM),
      limit: 1,
    });
    return { n: results.length, top: results[0] ? results[0]._score : -1 };
  },
});

// ---------- cleanup ----------
export const vectorClear = mutation({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const docs = await ctx.db.query("embeddings").withIndex("by_idx").take(limit);
    for (const d of docs) await ctx.db.delete(d._id);
    if (docs.length < limit) {
      const metas = await ctx.db.query("vectorsMeta").collect();
      for (const m of metas) await ctx.db.delete(m._id);
    }
    return docs.length;
  },
});
