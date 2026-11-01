import { ConvexError, v } from "onebase/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    // Unfinished first, then by recency.
    return await ctx.db
      .query("todos")
      .withIndex("by_done", (q) => q.eq("done", false))
      .order("desc")
      .take(100);
  },
});

export const done = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("todos")
      .withIndex("by_done", (q) => q.eq("done", true))
      .order("desc")
      .take(100);
  },
});

export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const trimmed = text.trim();
    if (!trimmed) throw new ConvexError("Write something first");
    return await ctx.db.insert("todos", { text: trimmed, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => {
    const todo = await ctx.db.get(id);
    if (!todo) throw new ConvexError("Already deleted");
    await ctx.db.patch(id, { done: !todo.done });
  },
});

export const remove = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => await ctx.db.delete(id),
});
