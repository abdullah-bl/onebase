---
title: How it works
description: The architecture — storage, transactions, reactivity and the sync protocol.
---

# How it works

onebase is about 4,000 lines of TypeScript running in a single Bun process.

```
 browser ──WebSocket /api/sync──┐
 scripts ──HTTP /api/*──────────┤
                                ▼
                      ┌──────────────────┐     ┌─────────────────────┐
                      │   HTTP / WS      │     │ subscriptions        │
                      │   server         │────▶│ (shared, re-run on   │
                      └────────┬─────────┘     │  matching commits)   │
                               ▼               └──────────▲──────────┘
                      ┌──────────────────┐                │ commit events
                      │     runtime      │────────────────┘
                      │ validate · run · │◀──── scheduler · crons
                      │ ctx.db · storage │
                      └────────┬─────────┘
                               ▼
              ┌────────────── driver ──────────────┐
              │  SQLite  │  Postgres  │  libSQL     │
              └────────────────────────────────────┘
```

## Storage

All documents live in one table: `documents(id, tbl, ct, doc)`. Each schema index becomes a **partial expression index**:

```sql
CREATE INDEX cl_messages__by_channel ON documents(json_extract(doc, '$.channel'), ct, id)
  WHERE tbl = 'messages';
```

Queries compile to SQL against those same expressions, so the database's own planner chooses an index for `withIndex` and for `.filter()` alike. Ordering is always `(index fields…, ct, id)`, which also makes pagination cursors stable.

## Transactions

- **Mutations** run one at a time per process, each inside a transaction. On Postgres they're `SERIALIZABLE` and retried on serialization failures, so several instances can write concurrently without lost updates.
- **Nested `ctx.runMutation`** calls use savepoints.
- **Queries** read a consistent snapshot: a separate WAL reader connection on SQLite, `REPEATABLE READ` on Postgres.

## Reactivity

Each query run records what it read:
- **Ids** from `db.get(id)`.
- **Ranges:** table plus equality conditions from `withIndex(...eq...)` and `.filter(eq...)`, such as `messages where channel = X`.

Each commit produces a list of writes, with each document's before and after state. A subscription re-runs only if one of the writes touched an id it read, or a document (old or new version) matches one of its ranges. A new message in channel A never re-runs the query for channel B.

Identical subscriptions (same function, arguments and user) share one execution. Results are compared as JSON and pushed only when they change. A mutation's response is sent after the affected queries have been updated, so a client that awaits a mutation sees its effect right away.

**With several instances,** each commit is also broadcast inside the transaction, so it's delivered only if the transaction commits. Postgres uses `pg_notify`; libSQL uses a commit-log table. Large commits are sent as "these tables changed".

## Sync protocol

JSON messages over one WebSocket:

```js
// client → server
{ type: "auth", token }
{ type: "sub", id: 1, path: "messages:list", args: { channel } }
{ type: "unsub", id: 1 }
{ type: "call", requestId: 7, kind: "mutation", path: "messages:send", args: { … } }

// server → client
{ type: "update", id: 1, ok: true, value: [ … ] }
{ type: "result", requestId: 7, ok: true, value: "k3m8…" }
```

## Single-file binaries

`bun build --compile` bundles the runtime. Function files on disk import `onebase/server` and `onebase/values`. A Bun runtime plugin serves those imports from inside the binary, so no `node_modules` is needed on the server. `onebase build` goes a step further and imports your functions and `public/` files statically, embedding them in the binary.
