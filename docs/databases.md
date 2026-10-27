---
title: Databases
description: SQLite, Postgres, MySQL or Turso — and running several instances against one database.
---

# Databases

Pick a database with `--db`. Your functions don't change.

| | `--db` | Instances | Notes |
|---|---|---|---|
| **SQLite** | a path (default `<data>/db.sqlite`) | one | Fastest: reads take microseconds. The default. |
| **Postgres** | `postgres://user:pass@host:5432/db` | many | Live queries are shared through `LISTEN/NOTIFY`. Works with Neon, Supabase, RDS, … |
| **MySQL** | `mysql://user:pass@host:3306/db` | many | MySQL 8.0.21 or later. Schema indexes aren't used (see below). Not MariaDB. |
| **Turso / libSQL** | `libsql://my-db.turso.io` | many | Token from `$TURSO_AUTH_TOKEN` or `?authToken=`. Also works with self-hosted `sqld`. |

Postgres and MySQL support are built into Bun, and the libSQL client is pure JavaScript, so all four work from the same single binary.

## SQLite

The default needs no setup. onebase uses WAL mode with a separate reader connection, so queries never wait for writes. Back it up to S3 with `--backup` (see [Backups](./backups.md)).

SQLite can only be used by one server process. When you need more than one, switch to Postgres, MySQL or Turso.

## Postgres

```bash
onebase serve --db postgres://onebase:secret@db.internal:5432/app
```

- **Tables:** onebase creates its tables on first start: `documents` (with `jsonb`) plus a few system tables.
- **Indexes:** each schema index becomes a `jsonb` expression index, and Postgres's planner uses it for both `withIndex` and `.filter()`.
- **Isolation:** queries run in `REPEATABLE READ` read-only transactions, mutations in `SERIALIZABLE`.

## MySQL

```bash
onebase serve --db mysql://onebase:secret@db.internal:3306/app
```

- **Tables:** `documents` (with a `JSON` column) plus the system tables, created on first start.
- **Indexes:** MySQL can't index a JSON value, so schema indexes are recorded but not built. `withIndex` and `.filter()` give the same results as on the other databases, but each query reads the table's documents and sorts them. Fine for small and medium tables; use Postgres when tables get large.
- **Search:** each search index is a `FULLTEXT` side table. MySQL skips words shorter than 3 characters and [stopwords](https://dev.mysql.com/doc/refman/8.4/en/fulltext-stopwords.html) like "the".
- **Isolation:** queries run in `REPEATABLE READ` read-only snapshots, mutations in `SERIALIZABLE`. Deadlocks are retried automatically.
- **Live queries** across instances use a small commit log that each instance polls every 200 ms, as with Turso.
- **Connecting:** with MySQL 8's default `caching_sha2_password` and no TLS, add `?allowPublicKeyRetrieval=true` to the URL, or connect over TLS.

**MariaDB isn't supported.** Its `JSON` type is plain text, so it compares and sorts document fields as strings (`"10" < "9"`). onebase stops at startup with an explanation rather than return wrong results.

## Turso / libSQL

```bash
export TURSO_AUTH_TOKEN=...
onebase serve --db libsql://my-app-myorg.turso.io
```

The schema and indexes are the same as with local SQLite. Each `ctx.db` call is a round trip to Turso, so put your server in the same region as the database.

## Running several instances

With Postgres, MySQL or Turso you can run as many onebase processes as you like behind a load balancer:

```bash
onebase serve --db $DATABASE_URL --files s3://bucket/files --port 8090   # machine A
onebase serve --db $DATABASE_URL --files s3://bucket/files --port 8090   # machine B
```

What onebase guarantees:

- **Live queries everywhere.** A commit on any instance updates subscribers on all of them: through `NOTIFY` on Postgres, and through a small commit log on MySQL and Turso that each instance polls every 200 ms.
- **No lost updates.** Mutations are serializable. When two instances conflict, one of them is retried automatically. This is why side effects belong in actions, not mutations.
- **Each job runs once.** Each scheduled job and cron run is claimed by exactly one instance.

Use `--files s3://…` when you run several instances, so they all see the same files. Sticky sessions aren't required.

## How data is stored

Every document is one row: `documents(id, tbl, ct, doc)`. The document is JSON (SQLite, MySQL) or `jsonb` (Postgres), `ct` is the creation time, and `tbl` is the table name. Schema indexes are partial expression indexes per table (not on MySQL). Ids carry a 4-character tag for their table. See [How it works](./how-it-works.md).
