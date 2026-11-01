import { ConvexError, v } from "onebase/values";
import { getAuthUserId, paginationOptsValidator } from "onebase/server";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/** Returns the caller's user id, or throws if they aren't signed in. */
async function requireUserId(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new ConvexError("Sign in first");
  return userId;
}

/** The signed-in user as a document, so the page can greet them by name. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    return userId ? await ctx.db.get(userId) : null;
  },
});

/** Your notes, newest first, a page at a time. Live like any query. */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { page: [], isDone: true, continueCursor: "" };
    return await ctx.db
      .query("notes")
      .withIndex("by_owner", (q) => q.eq("owner", userId))
      .order("desc")
      .paginate(paginationOpts);
  },
});

/** Full-text search over your notes only: the index filters by owner. */
export const search = query({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    const userId = await requireUserId(ctx);
    return await ctx.db
      .query("notes")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("owner", userId))
      .take(20);
  },
});

export const add = mutation({
  args: { title: v.string(), body: v.string(), pinned: v.optional(v.boolean()) },
  handler: async (ctx, { title, body, pinned }) => {
    const userId = await requireUserId(ctx);
    return await ctx.db.insert("notes", {
      owner: userId,
      title: title.trim() || "Untitled",
      body,
      pinned: pinned ?? false,
    });
  },
});

export const edit = mutation({
  args: {
    id: v.id("notes"),
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    pinned: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, title, body, pinned }) => {
    const userId = await requireUserId(ctx);
    const note = await ctx.db.get(id);
    if (!note) throw new ConvexError("Note not found");
    if (note.owner !== userId) throw new ConvexError("Not your note");
    // patch merges shallowly; fields set to undefined are removed, so only
    // pass the ones that were actually sent.
    const changes: { title?: string; body?: string; pinned?: boolean } = {};
    if (title !== undefined) changes.title = title;
    if (body !== undefined) changes.body = body;
    if (pinned !== undefined) changes.pinned = pinned;
    await ctx.db.patch(id, changes);
  },
});

export const remove = mutation({
  args: { id: v.id("notes") },
  handler: async (ctx, { id }) => {
    const userId = await requireUserId(ctx);
    const note = await ctx.db.get(id);
    if (!note) return;
    if (note.owner !== userId) throw new ConvexError("Not your note");
    await ctx.db.delete(id);
  },
});
