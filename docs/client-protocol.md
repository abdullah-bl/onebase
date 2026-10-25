---
title: Client protocol
description: The /api/sync WebSocket and HTTP API contract that every onebase client implements.
---

# Client protocol

One documented wire contract, one SDK per platform. The JS client (`onebase/browser`) and the
Swift client (`clients/swift` in the repository) both speak it; this page is everything a new
client needs — an Android one, say — to work with any onebase server.

## WebSocket: `/api/sync`

One WebSocket per client carries the auth token, live query subscriptions and function calls.
Message boundaries are frames; each message is one JSON object. Send the auth message before
anything else on every (re)connect: the server runs subscriptions under the identity in effect
when they (re)start.

The server closes idle connections after 120 seconds, so a client pings (WebSocket ping frames
are fine; the server answers them) at least once a minute, reconnects with backoff, and
re-sends its auth token, subscriptions and queued calls in that order.

### Client → server

```json
{ "type": "auth", "token": "ob_s_…" }
```

The session token (or any token your `auth.config.ts` accepts), or `null` to be anonymous. Send
once per connection, before subscriptions and calls.

```json
{ "type": "sub", "id": 1, "path": "notes:list", "args": {} }
```

Subscribe to a query. `id` is a number the client picks; every update for this subscription
carries it. Re-sending with the same `id` replaces the subscription. `path` is
`"<file>:<export>"` of a public query; `args` is the function's arguments object.

```json
{ "type": "unsub", "id": 1 }
```

```json
{ "type": "call", "requestId": 7, "kind": "mutation", "path": "notes:add", "args": { "text": "Hi" } }
```

`kind` is `"query"`, `"mutation"` or `"action"`. `requestId` is a number the client picks; the
answer carries it back.

### Server → client

```json
{ "type": "auth", "ok": true, "identity": { "subject": "m17…", "email": "…" } }
```

`identity` is `null` when anonymous. On failure: `{ "type": "auth", "ok": false, "error": "…" }`
with `ended: true` when the token is gone for good (signed out, expired, deleted) — forget it
and show signed-out state. Any other failure may be transient: keep the token and retry on the
next reconnect.

```json
{ "type": "update", "id": 1, "ok": true, "value": [ … ] }
```

A subscription's new result. Errors: `{ "type": "update", "id": 1, "ok": false, "error": "…",
"data": … }` — keep the subscription; it recovers when the problem is fixed (a deploy adds the
missing function, the data matches the schema again).

```json
{ "type": "result", "requestId": 7, "ok": true, "value": "m57…" }
```

The answer to a call. Errors carry `error` (and optional `data`) instead of `value`.

```json
{ "type": "transition", "updates": [ …updates… ], "results": [ …results… ] }
```

A mutation's result and the query updates that include its writes, in one message. Apply the
updates and the result together: that's what lets a client drop an optimistic update at exactly
the moment the real data arrives, with no flicker.

### Semantics a client should keep

- **Identical subscriptions share results.** Two subscriptions to the same (function, args,
  user) get the same values; the server already runs the query once per unique subscription.
- **Calls are at-most-once per send.** If the connection drops before an answer, the call may
  or may not have run; report it, never re-send it silently. Offline queues (below) persist a
  mutation *until it is first sent*, then follow this same rule.
- **Errors from `ConvexError` are user-facing;** anything else the server may replace with
  `Server Error` outside dev mode.
- **Ordering:** messages are processed in order; a client that sends `auth` → `sub`s → queued
  calls on reconnect sees them applied in that order.

## HTTP

| Endpoint | |
|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action`, `/api/run` | `{ path, args }` → `{ status: "success", value }` or `{ status: "error", errorMessage, errorData }` |
| `GET /api/health` | `{ ok, functions, subscriptions, deployment }` |
| `POST /api/auth/signin`, `/api/auth/signout` | built-in auth: see [Auth](./auth.md#http-api) |
| `GET /api/storage/<id>` | file downloads |

`Authorization: Bearer <token>` authenticates any request. `429` responses carry a
`Retry-After` header — the server's `--rate-limit`.

## Offline support (a client convention, not a protocol feature)

The clients implement offline the same way, so apps behave alike on every platform:

1. **Query cache.** Keep the newest N results for subscribed (path, args) pairs, keyed by
   function path and arguments. On a cold start, show the cached result immediately (it's
   stale), then the live value when it arrives. With auth configured, hold a cached result
   back until the server confirms the same user is asking, and clear the cache when the user
   changes: cached data belongs to one user.
2. **Mutation outbox.** Persist mutations made while disconnected, and send them in the order
   they were made once the connection returns — across restarts. An entry is removed when the
   server answers. One lost mid-send is dropped with a warning, never silently re-sent.
3. **Optimistic updates** stay in memory: they cover what happens while the app is running.

An Android client that follows this page will match the JS and Swift clients feature for
feature.
