// Who's online, per room: sessions heartbeat, and the component marks them offline when the
// heartbeats stop. Rooms are live queries, so clients see people come and go.
//
//   // onebase/components.ts
//   export default defineComponents({ here: presence({ auth: true, expose: ["heartbeat", "list"] }) });
//
//   // client, every few seconds, signed in: the user is the caller's identity
//   api.components.here.heartbeat({ room: "lobby", sessionId });
//   // live query
//   useQuery(api.components.here.list, { room: "lobby" }) // [{ id, user, online, lastActive }]

import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { OneBaseError, v } from "../../values";

type Config = {
  /** How long after a heartbeat a session is still counted online (default 10_000 ms). */
  heartbeatInterval?: number;
  /** Extra grace before the scheduled check gives up on a session (default 5_000 ms). */
  heartbeatTimer?: number;
  /** How long an offline session stays in `list` before it's forgotten (default 1 hour). */
  offlineRetentionMs?: number;
};

/** Set from the mount's `auth: true`: heartbeats then need a signed-in caller, who is the user. */
type InternalConfig = Config & { userFromAuth?: boolean };

const schema = defineSchema({
  presence: defineTable({
    room: v.string(),
    user: v.string(),
    sessionId: v.string(),
    online: v.boolean(),
    lastActive: v.number(),
    disconnectedAt: v.optional(v.number()),
    /** The heartbeat interval this session last asked for. */
    interval: v.number(),
    /** When the session's one live check is due; a check due at any other time does nothing. */
    checkAt: v.optional(v.number()),
  })
    .index("by_room", ["room", "online", "lastActive"])
    .index("by_session", ["sessionId"])
    .index("by_online_disconnectedAt", ["online", "disconnectedAt"]),
});

const { query, mutation, internalMutation } = componentServer<DataModelFromSchema<typeof schema>, InternalConfig>();

/** The longest `interval` a heartbeat may ask for, so a client can't stay online long after it's gone. */
const MAX_SESSION_INTERVAL = 5 * 60_000;

const intervalFor = (config: Config, override?: number) =>
  Math.max(1_000, override === undefined ? (config.heartbeatInterval ?? 10_000) : Math.min(override, MAX_SESSION_INTERVAL));
const staleAfter = (config: Config, interval: number) => interval + (config.heartbeatTimer ?? 5_000);

/** Makes this the session's one live check, due `delayMs` from now. */
async function scheduleCheck(ctx: { db: any; scheduler: any }, id: unknown, sessionId: string, delayMs: number) {
  const at = Date.now() + delayMs;
  await ctx.scheduler.runAfter(delayMs, checkSession, { sessionId, at });
  await ctx.db.patch(id, { checkAt: at });
}

/**
 * Records a heartbeat, making sure a check is due to mark the session offline if it goes quiet.
 * Mounted with `auth: true`, the user is the caller's identity (`subject`, the user id with
 * built-in auth), and a `user` argument, if any, must match it: otherwise anyone could appear as
 * anyone. Without it, `user` is whatever the caller passes, so only the app's own functions,
 * which set it themselves, should call heartbeat.
 */
const heartbeat = mutation({
  args: { room: v.string(), user: v.optional(v.string()), sessionId: v.string(), interval: v.optional(v.number()) },
  handler: async (ctx, input) => {
    const identity = await ctx.auth.getUserIdentity();
    let user = input.user;
    if (identity) {
      if (user !== undefined && user !== identity.subject) throw new OneBaseError("presence.heartbeat: `user` must be the signed-in user; leave it out.");
      user = identity.subject;
    } else if (ctx.config.userFromAuth) {
      throw new OneBaseError("presence.heartbeat: sign in first (this presence is mounted with auth: true).");
    }
    if (user === undefined) throw new OneBaseError("presence.heartbeat: pass `user`, or mount with auth: true to take it from the caller's identity.");
    const args = { ...input, user };
    const now = Date.now();
    const interval = intervalFor(ctx.config, args.interval);
    const window = staleAfter(ctx.config, interval);
    const row = await ctx.db.query("presence").withIndex("by_session", (q: any) => q.eq("sessionId", args.sessionId)).unique();
    const id = row?._id ?? (await ctx.db.insert("presence", { room: args.room, user: args.user, sessionId: args.sessionId, online: true, lastActive: now, interval }));
    if (row) await ctx.db.patch(row._id, { room: args.room, user: args.user, online: true, lastActive: now, disconnectedAt: undefined, interval });
    // A live check re-arms itself, so it covers this heartbeat too. Schedule a new one only if
    // there's none, the last one is overdue, or a shorter interval needs an earlier one.
    const due = row?.checkAt;
    if (due === undefined || due <= now || due > now + window) await scheduleCheck(ctx, id, args.sessionId, window);
    return null;
  },
});

/** Marks the session offline if it hasn't heartbeat within its window; otherwise checks again when it would go stale. */
const checkSession = internalMutation({
  args: { sessionId: v.string(), at: v.number() },
  handler: async (ctx, { sessionId, at }) => {
    const row = await ctx.db.query("presence").withIndex("by_session", (q: any) => q.eq("sessionId", sessionId)).unique();
    if (!row || row.checkAt !== at) return null; // a newer check took over
    if (!row.online) {
      await ctx.db.patch(row._id, { checkAt: undefined });
      return null;
    }
    const window = staleAfter(ctx.config, row.interval);
    const quietFor = Date.now() - row.lastActive;
    if (quietFor > window) {
      await ctx.db.patch(row._id, { online: false, disconnectedAt: Date.now(), checkAt: undefined });
      return null;
    }
    await scheduleCheck(ctx, row._id, sessionId, window - quietFor);
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
      // Never the sessionId: holding one is what lets a client heartbeat or disconnect that session.
      .map((row: any) => ({ id: row._id as string, user: row.user as string, online: row.online as boolean, lastActive: row.lastActive as number, disconnectedAt: row.disconnectedAt ?? null }));
  },
});

/** Every minute: forgets sessions that have been offline past the retention window. */
const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const before = Date.now() - (ctx.config.offlineRetentionMs ?? 3_600_000);
    const old = await ctx.db.query("presence").withIndex("by_online_disconnectedAt", (q: any) => q.eq("online", false).lt("disconnectedAt", before)).take(500);
    for (const row of old) await ctx.db.delete(row._id);
    return null;
  },
});

export const definition = defineComponent({
  name: "presence",
  schema,
  functions: { heartbeat, list, disconnect, checkSession, prune },
  crons: () => [{ name: "prune", schedule: { minutes: 1 }, fn: prune }],
});

// ---- Types for the app ----

export type PresenceEntry = { id: string; user: string; online: boolean; lastActive: number; disconnectedAt: number | null };

export type PresenceApi = {
  /** `user` comes from the caller's identity when mounted with `auth: true`; otherwise pass it. */
  heartbeat: ComponentFn<"mutation", (args: { room: string; user?: string; sessionId: string; interval?: number }) => Promise<null>>;
  list: ComponentFn<"query", (args: { room: string }) => Promise<PresenceEntry[]>>;
  disconnect: ComponentFn<"mutation", (args: { sessionId: string }) => Promise<boolean>>;
};

/** Mounts presence: `presence({ heartbeatInterval: 10_000 })`. */
export function presence<const E extends keyof PresenceApi = never>(opts: Config & MountOptions<E> = {}): Mount<PresenceApi, E> {
  const { config, options } = splitMountOptions(opts);
  const internal: InternalConfig = options.auth ? { ...config, userFromAuth: true } : config;
  return definition.mount(internal, options) as unknown as Mount<PresenceApi, E>;
}
