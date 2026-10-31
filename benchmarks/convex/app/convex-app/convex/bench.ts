import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ---------- latency / sanity ----------
export const ping = query({
  args: {},
  handler: async () => "pong",
});

// ---------- argument size limit ----------
export const echo = mutation({
  args: { blob: v.string() },
  handler: async (_ctx, { blob }) => blob.length,
});

// ---------- single document size limit ----------
export const addOne = mutation({
  args: { size: v.number() },
  handler: async (ctx, { size }) => {
    const payload = "x".repeat(size);
    const id = await ctx.db.insert("docs", { payload, tag: "single" });
    await ctx.db.delete(id); // keep the table clean
    return size;
  },
});

// ---------- documents written per transaction ----------
export const writeDocs = mutation({
  args: { n: v.number(), size: v.number() },
  handler: async (ctx, { n, size }) => {
    const payload = "x".repeat(size);
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("docs", { payload, tag: "bench" });
    }
    return n * size;
  },
});

// ---------- documents scanned per transaction ----------
// `tag` is not indexed: the filter must scan the whole table.
export const scanDocs = query({
  args: { tag: v.string() },
  handler: async (ctx, { tag }) => {
    const docs = await ctx.db
      .query("docs")
      .filter((q) => q.eq(q.field("tag"), tag))
      .collect();
    return docs.length;
  },
});

// ---------- data read per transaction ----------
export const readVolume = query({
  args: { n: v.number() },
  handler: async (ctx, { n }) => {
    const docs = await ctx.db.query("docs").order("desc").take(n);
    let total = 0;
    for (const d of docs) total += d.payload.length;
    return total;
  },
});

// ---------- CPU-bound work ----------
// A fixed amount of computation that reports what it did. It never reads the
// clock: Convex documents a clock that doesn't advance during a function, so a
// loop waiting on Date.now() can't measure anything there. The caller times it.
// The same iterations give the same checksum on every backend.
export const busy = mutation({
  args: { iterations: v.number() },
  handler: async (_ctx, { iterations }) => {
    let x = 1;
    for (let i = 0; i < iterations; i++) {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
    }
    return { iterations, checksum: x >>> 0 };
  },
});

// ---------- housekeeping ----------
export const docCount = query({
  args: {},
  handler: async (ctx) => {
    return (await ctx.db.query("docs").collect()).length;
  },
});

export const clearDocs = mutation({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const docs = await ctx.db.query("docs").take(limit);
    for (const d of docs) await ctx.db.delete(d._id);
    return docs.length;
  },
});
