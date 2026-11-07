import { defineMcp, tool } from "onebase/mcp";
import { v } from "onebase/values";
import { api } from "./_generated/api";

// The app as an MCP server at /mcp. An agent connects with that one URL: the user signs in and
// approves it on public/connect.html, and its tools then run as that user, so they reuse the same
// functions (and the same "Not your note" checks) as the page.
export default defineMcp({
  name: "Notes",
  version: "1.0.0",
  instructions: "The user's private notes. Search before adding, so you don't create duplicates.",
  consentUrl: "/connect.html",
  scopes: {
    read: "Read and search your notes",
    write: "Add and pin notes",
  },
});

const note = v.object({ id: v.id("notes"), title: v.string(), body: v.string(), pinned: v.boolean() });
const shape = (n: { _id: any; title: string; body: string; pinned: boolean }) => ({ id: n._id, title: n.title, body: n.body, pinned: n.pinned });

export const recentNotes = tool({
  description: "The user's most recent notes, newest first.",
  scope: "read",
  annotations: { readOnlyHint: true },
  args: { limit: v.optional(v.number()) },
  returns: v.object({ notes: v.array(note) }),
  handler: async (ctx, { limit }) => {
    const numItems = Math.min(Math.max(Math.floor(limit ?? 10), 1), 50);
    const { page } = await ctx.runQuery(api.notes.page, { paginationOpts: { numItems, cursor: null } });
    return { notes: page.map(shape) };
  },
});

export const searchNotes = tool({
  description: "Full-text search over the bodies of the user's notes.",
  scope: "read",
  annotations: { readOnlyHint: true },
  args: { text: v.string() },
  returns: v.object({ notes: v.array(note) }),
  handler: async (ctx, { text }) => ({ notes: (await ctx.runQuery(api.notes.search, { text })).map(shape) }),
});

export const addNote = tool({
  description: "Adds a note for the user.",
  scope: "write",
  args: { title: v.string(), body: v.string(), pinned: v.optional(v.boolean()) },
  returns: v.object({ id: v.id("notes") }),
  handler: async (ctx, args) => ({ id: await ctx.runMutation(api.notes.add, args) }),
});

export const pinNote = tool({
  description: "Pins or unpins one of the user's notes.",
  scope: "write",
  annotations: { idempotentHint: true },
  args: { id: v.id("notes"), pinned: v.boolean() },
  handler: async (ctx, { id, pinned }) => {
    await ctx.runMutation(api.notes.edit, { id, pinned });
    return pinned ? "Pinned." : "Unpinned.";
  },
});
