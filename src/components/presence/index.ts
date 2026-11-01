// Who's online, per room: sessions heartbeat, and the component marks them offline when the
// heartbeats stop. Rooms are live queries, so clients see people come and go.
//
//   // onebase/components.ts
//   export default defineComponents({ here: presence({ heartbeatInterval: 10_000 }) });
//
//   // client, every few seconds (expose heartbeat and list when mounting)
//   api.components.here.heartbeat({ room: "lobby", user: userId, sessionId });
//   // live query
//   useQuery(api.components.here.list, { room: "lobby" }) // [{ user, sessionId, online, lastActive }]

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v } from "../../values";

type Config = {
  /** How long after a heartbeat a session is still counted online (default 10_000 ms). */
  heartbeatInterval?: number;
  /** Extra grace before the scheduled check gives up on a session (default 5_000 ms). */
  heartbeatTimer?: number;
};

const schema = defineSchema({
  presence: defineTable({
    room: v.string(),
    user: v.string(),
    sessionId: v.string(),
    online: v.boolean(),
    lastActive: v.number(),
    disconnectedAt: v.optional(v.number()),
  })
    .index("by_room", ["room", "online", "lastActive"])
    .index("by_session", ["sessionId"]),
});

const { query, mutation, internalMutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();

const intervalFor = (config: Config, override?: number) => Math.max(1_000, override ?? config.heartbeatInterval ?? 10_000);
const staleAfter = (config: Config, interval: number) => interval + (config.heartbeatTimer ?? 5_000);

/** Records a heartbeat and schedules the check that marks the session offline if it goes quiet. */
const heartbeat = mutation({
  args: { room: v.string(), user: v.string(), sessionId: v.string(), interval: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db.query("presence").withIndex("by_session", (q: any) => q.eq("sessionId", args.sessionId)).unique();
    if (row) await ctx.db.patch(row._id, { room: args.room, user: args.user, online: true, lastActive: now, disconnectedAt: undefined });
    else await ctx.db.insert("presence", { room: args.room, user: args.user, sessionId: args.sessionId, online: true, lastActive: now });
    const interval = intervalFor(ctx.config, args.interval);
    await ctx.scheduler.runAfter(staleAfter(ctx.config, interval), checkSession, { sessionId: args.sessionId, interval });
    return null;
  },
});

/** Marks the session offline if it hasn't heartbeat within its window; otherwise checks again when it would go stale. */
const checkSession = internalMutation({
  args: { sessionId: v.string(), interval: v.number() },
  handler: async (ctx, { sessionId, interval }) => {
    const row = await ctx.db.query("presence").withIndex("by_session", (q: any) => q.eq("sessionId", sessionId)).unique();
    if (!row || !row.online) return null;
    const window = staleAfter(ctx.config, interval);
    const quietFor = Date.now() - row.lastActive;
    if (quietFor > window) {
      await ctx.db.patch(row._id, { online: false, disconnectedAt: Date.now() });
      return null;
    }
    await ctx.scheduler.runAfter(window - quietFor, checkSession, { sessionId, interval });
    return null;
  },
});

/** Marks one session offline right away (the tab closed, the user signed out). */
const disconnect = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    const row = await ctx.db.query("presence").withIndex("by_session", (q: any) => q.eq("sessionId", sessionId)).unique();
    if (!row || !row.online) return false;
    await ctx.db.patch(row._id, { online: false, disconnectedAt: Date.now() });
    return true;
  },
});

/** A room's sessions, online ones first then most recently active; a live query. */
const list = query({
  args: { room: v.string() },
  handler: async (ctx, { room }) => {
    const rows = await ctx.db.query("presence").withIndex("by_room", (q: any) => q.eq("room", room)).collect();
    return rows
      .sort((a: any, b: any) => Number(b.online) - Number(a.online) || b.lastActive - a.lastActive)
      .map((row: any) => ({ user: row.user as string, sessionId: row.sessionId as string, online: row.online as boolean, lastActive: row.lastActive as number, disconnectedAt: row.disconnectedAt ?? null }));
  },
});

export const definition = defineComponent({
  name: "presence",
  schema,
  functions: { heartbeat, list, disconnect, checkSession },
});

// ---- Types for the app ----

export type PresenceEntry = { user: string; sessionId: string; online: boolean; lastActive: number; disconnectedAt: number | null };

export type PresenceApi = {
  heartbeat: ComponentFn<"mutation", (args: { room: string; user: string; sessionId: string; interval?: number }) => Promise<null>>;
  list: ComponentFn<"query", (args: { room: string }) => Promise<PresenceEntry[]>>;
  disconnect: ComponentFn<"mutation", (args: { sessionId: string }) => Promise<boolean>>;
};

/** Mounts presence: `presence({ heartbeatInterval: 10_000 })`. */
export function presence<const E extends keyof PresenceApi = never>(opts: Config & MountOptions<E> = {}): Mount<PresenceApi, E> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as unknown as Mount<PresenceApi, E>;
}
