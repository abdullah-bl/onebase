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
  here: presence({ heartbeatInterval: 10_000, expose: ["heartbeat", "list"] }),
});
```

`heartbeatInterval` is how long a session stays counted online after its last heartbeat (default 10s); `heartbeatTimer` adds grace before the scheduled check gives up on it (default 5s); `offlineRetentionMs` is how long an offline session stays in `list` before it's forgotten (default 1 hour). `expose` lets browser clients heartbeat and read rooms directly — anyone can call exposed functions, so only do this if the data is public to your signed-in users. Mount with `auth: true` too if you want the component to see the caller's identity.

## Use it

```ts
// the client, every few seconds (and on page load):
api.components.here.heartbeat({ room: "lobby", user: userId, sessionId });

// live:
useQuery(api.components.here.list, { room: "lobby" });
// [{ id, user, online, lastActive, disconnectedAt }]
```

`sessionId` identifies one browser tab or device: the same user in two tabs is two sessions. Make it random and keep it on that client, because whoever holds it can heartbeat or disconnect the session; `list` returns a separate `id` instead, for React keys and the like. On page unload (or sign-out), call `disconnect` for an immediate goodbye rather than waiting out the window. When a client just stops heartbeating, the component's scheduled checks take the session offline on their own — a check that finds the session still fresh re-schedules itself until it isn't.

## Functions

| | |
|---|---|
| `heartbeat({ room, user, sessionId, interval? })` | Mutation. Records the heartbeat and schedules the offline check. `interval` overrides the mount's, per session, up to 5 minutes. |
| `list({ room })` | Live query. The room's sessions, online first, then most recently active. |
| `disconnect({ sessionId })` | Mutation. Marks one session offline right away. |

Rooms are just strings — a chat channel, a document id, `"global"`. Sessions in different rooms don't see each other; a session that heartbeats a different room moves there.

## Coming from Convex

`presence({ heartbeatInterval, heartbeatTimer })` mounts the same shape as `@convex-dev/presence`: `ping` is `heartbeat` here, and `listRoom` is `list`. Client code calls `api.components.<mount>.heartbeat` after exposing it, instead of re-exporting wrappers.
