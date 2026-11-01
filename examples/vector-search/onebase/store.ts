import { v } from "onebase/values";
import { internalMutation, internalQuery } from "./_generated/server";

// Internal helpers for items.ts: the actions embed and search, then load and
// write through these. They live in their own module because actions can't
// touch the database directly.

export const insert = internalMutation({
  args: { text: v.string(), kind: v.string(), embedding: v.array(v.float64()) },
  handler: async (ctx, { text, kind, embedding }) => await ctx.db.insert("items", { text, kind, embedding }),
});

export const withScores = internalQuery({
  args: { hits: v.array(v.object({ _id: v.id("items"), _score: v.float64() })) },
  handler: async (ctx, { hits }) => {
    return Promise.all(
      hits.map(async (hit) => ({ score: hit._score, item: await ctx.db.get(hit._id) })),
    );
  },
});
