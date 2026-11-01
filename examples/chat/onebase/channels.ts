import { v } from "onebase/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("channels").collect();
  },
});

/** Returns the channel with this name, creating it if needed. */
export const getOrCreate = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const existing = await ctx.db
      .query("channels")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("channels", { name });
  },
});
