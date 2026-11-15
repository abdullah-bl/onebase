---
title: Presence
description: Who's online per room, with heartbeats and live lists.
---

# Presence

The presence component tracks who's online, per room: clients heartbeat every few seconds, and the component marks sessions offline when the heartbeats stop (or when they say goodbye). The room list is a live query, so everyone sees people come and go without polling.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { presence } from "onebase/components/presence";

export default defineComponents({
  here: presence({ heartbeatInterval: 10_000, auth: true, expose: ["heartbeat", "list"] }),
});
```

`heartbeatInterval` is how long a session stays counted online after its last heartbeat (default 10s); `heartbeatTimer` adds grace before the scheduled check gives up on it (default 5s); `offlineRetentionMs` is how long an offline session stays in `list` before it's forgotten (default 1 hour).

`expose` lets browser clients heartbeat and read rooms directly. Always pair it with `auth: true`: then `heartbeat` takes the user from the caller's identity (its `subject`, which with built-in auth is the user id), refuses callers who aren't signed in, and refuses a `user` argument that isn't theirs. Without `auth: true`, `heartbeat` stores whatever `user` it's given, so exposing it would let anyone appear as anyone. And anyone can call an exposed `list` for any room, so expose it only if who's online is public to your users.

### Private rooms

When rooms belong to someone (a document, a team), don't expose the functions. Wrap them in your own, which check access first:

```ts
// onebase/presence.ts
import { getAuthUserId } from "onebase/server";
import { v } from "onebase/values";
import { mutation, query } from "./_generated/server";

export const heartbeat = mutation({
  args: { docId: v.id("docs"), sessionId: v.string() },
  handler: async (ctx, { docId, sessionId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await canOpen(ctx, userId, docId))) throw new Error("Not allowed");
    await ctx.components.here.heartbeat({ room: docId, user: userId, sessionId });
  },
});

export const list = query({
  args: { docId: v.id("docs") },
  handler: async (ctx, { docId }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId || !(await canOpen(ctx, userId, docId))) return [];
    return ctx.components.here.list({ room: docId });
  },
});
```

Mounted without `auth: true`, as here, the component trusts the `user` your function passes.

## Use it

```ts
// the client, signed in, every few seconds (and on page load):
api.components.here.heartbeat({ room: "lobby", sessionId });

// live:
useQuery(api.components.here.list, { room: "lobby" });
// [{ id, user, online, lastActive, disconnectedAt }]
```

`sessionId` identifies one browser tab or device: the same user in two tabs is two sessions. Make it random and keep it on that client, because whoever holds it can heartbeat or disconnect the session; `list` returns a separate `id` instead, for React keys and the like. On page unload (or sign-out), call `disconnect` for an immediate goodbye rather than waiting out the window. When a client just stops heartbeating, the component's scheduled checks take the session offline on their own — a check that finds the session still fresh re-schedules itself until it isn't.

## Functions

| | |
|---|---|
| `heartbeat({ room, user?, sessionId, interval? })` | Mutation. Records the heartbeat and schedules the offline check. With `auth: true` the user is the caller's identity (a signed-in caller is required, and `user` may be left out); otherwise `user` is required. `interval` overrides the mount's, per session, up to 5 minutes. |
| `list({ room })` | Live query. The room's sessions, online first, then most recently active. |
| `disconnect({ sessionId })` | Mutation. Marks one session offline right away. |

Rooms are just strings — a chat channel, a document id, `"global"`. Sessions in different rooms don't see each other; a session that heartbeats a different room moves there.

## Coming from Convex

`presence({ heartbeatInterval, heartbeatTimer })` mounts the same shape as `@convex-dev/presence`: `ping` is `heartbeat` here, and `listRoom` is `list`. Client code calls `api.components.<mount>.heartbeat` after exposing it, instead of re-exporting wrappers.
