import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("todos").order("desc").take(100);
  },
});

export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    return await ctx.db.insert("todos", { text, done: false });
  },
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => {
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("todo not found");
    await ctx.db.patch(id, { done: !todo.done });
  },
});

export const remove = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

export const clear = mutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("todos").collect();
    for (const d of docs) await ctx.db.delete(d._id);
    return docs.length;
  },
});

export const count = query({
  args: {},
  handler: async (ctx) => {
    return (await ctx.db.query("todos").collect()).length;
  },
});
