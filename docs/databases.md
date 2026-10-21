---
title: Databases
description: SQLite, Postgres or Turso — and running several instances against one database.
---

# Databases

Pick a database with `--db`. Your functions don't change.

| | `--db` | Instances | Notes |
|---|---|---|---|
| **SQLite** | a path (default `<data>/db.sqlite`) | one | Fastest: reads take microseconds. The default. |
| **Postgres** | `postgres://user:pass@host:5432/db` | many | Live queries are shared through `LISTEN/NOTIFY`. Works with Neon, Supabase, RDS, … |
| **Turso / libSQL** | `libsql://my-db.turso.io` | many | Token from `$TURSO_AUTH_TOKEN` or `?authToken=`. Also works with self-hosted `sqld`. |

Postgres support is built into Bun, and the libSQL client is pure JavaScript, so all three work from the same single binary.

## SQLite

The default needs no setup. onebase uses WAL mode with a separate reader connection, so queries never wait for writes. Back it up to S3 with `--backup` (see [Backups](./backups.md)).

SQLite can only be used by one server process. When you need more than one, switch to Postgres or Turso.

## Postgres

```bash
onebase serve --db postgres://onebase:secret@db.internal:5432/app
```

- **Tables:** onebase creates its tables on first start: `documents` (with `jsonb`) plus a few system tables.
- **Indexes:** each schema index becomes a `jsonb` expression index, and Postgres's planner uses it for both `withIndex` and `.filter()`.
- **Isolation:** queries run in `REPEATABLE READ` read-only transactions, mutations in `SERIALIZABLE`.

## Turso / libSQL

```bash
export TURSO_AUTH_TOKEN=...
onebase serve --db libsql://my-app-myorg.turso.io
```

The schema and indexes are the same as with local SQLite. Each `ctx.db` call is a round trip to Turso, so put your server in the same region as the database.

## Running several instances

With Postgres or Turso you can run as many onebase processes as you like behind a load balancer:

```bash
onebase serve --db $DATABASE_URL --files s3://bucket/files --port 8090   # machine A
onebase serve --db $DATABASE_URL --files s3://bucket/files --port 8090   # machine B
```

What onebase guarantees:

- **Live queries everywhere.** A commit on any instance updates subscribers on all of them: through `NOTIFY` on Postgres, and through a small commit log on Turso that each instance polls every 200 ms.
- **No lost updates.** Mutations are serializable. When two instances conflict, one of them is retried automatically. This is why side effects belong in actions, not mutations.
- **Each job runs once.** Each scheduled job and cron run is claimed by exactly one instance.

Use `--files s3://…` when you run several instances, so they all see the same files. Sticky sessions aren't required.

## How data is stored

Every document is one row: `documents(id, tbl, ct, doc)`. The document is JSON (SQLite) or `jsonb` (Postgres), `ct` is the creation time, and `tbl` is the table name. Schema indexes are partial expression indexes per table. Ids carry a 4-character tag for their table. See [How it works](./how-it-works.md).
