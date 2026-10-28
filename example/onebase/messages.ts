import { ConvexError, v } from "onebase/values";
import { paginationOptsValidator } from "onebase/server";
import { internal } from "./_generated/api";
import { internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: { channel: v.id("channels") },
  handler: async (ctx, { channel }) => {
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(50);
    return Promise.all(
      messages.reverse().map(async (m) => ({
        ...m,
        imageUrl: m.image ? await ctx.storage.getUrl(m.image) : null,
      })),
    );
  },
});

export const page = query({
  args: { channel: v.id("channels"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { channel, paginationOpts }) => {
    return await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** Full-text search within a channel, best matches first. Live like any query. */
export const search = query({
  args: { channel: v.id("channels"), text: v.string() },
  handler: async (ctx, { channel, text }) => {
    return await ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("channel", channel))
      .take(20);
  },
});

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

export const send = mutation({
  args: { channel: v.id("channels"), author: v.string(), body: v.string(), image: v.optional(v.id("_storage")) },
  handler: async (ctx, args) => {
    const body = args.body.trim();
    if (!body && !args.image) throw new ConvexError("Message can't be empty");
    const { ok, retryAfter } = await ctx.components.limiter.limit({ name: "sendMessage", key: args.author });
    if (!ok) throw new ConvexError(`Slow down: you can send another message in ${Math.ceil(retryAfter / 1000)}s.`);
    const id = await ctx.db.insert("messages", { ...args, body });
    if (body.startsWith("/tmp ")) {
      // Self-destructing message: deleted by a scheduled internal mutation.
      await ctx.scheduler.runAfter(5000, internal.messages.remove, { id });
    }
    return id;
  },
});

export const like = mutation({
  args: { id: v.id("messages") },
  handler: async (ctx, { id }) => {
    const message = await ctx.db.get(id);
    if (!message) throw new ConvexError("Message not found");
    await ctx.db.patch(id, { likes: (message.likes ?? 0) + 1 });
  },
});

export const remove = internalMutation({
  args: { id: v.id("messages") },
  handler: async (ctx, { id }) => {
    const message = await ctx.db.get(id);
    if (!message) return;
    if (message.image) await ctx.storage.delete(message.image);
    await ctx.db.delete(id);
  },
});

/** Run daily by crons.ts: deletes messages older than `days`. */
export const prune = internalMutation({
  args: { days: v.number() },
  handler: async (ctx, { days }) => {
    const cutoff = Date.now() - days * 86_400_000;
    const old = await ctx.db
      .query("messages")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(500);
    for (const m of old) {
      if (m.image) await ctx.storage.delete(m.image);
      await ctx.db.delete(m._id);
    }
    return old.length;
  },
});
