# onebase

A lightweight, Convex-style reactive backend: TypeScript functions, a typed document database and live queries. It runs as one Bun process on SQLite and ships as a single executable.

- **Small:** about 40 MB RSS on startup, dashboard included. One process with no isolates and no separate database server.
- **Full Node/npm everywhere:** queries, mutations and actions all run in Bun. There is no `"use node"` split.
- **Convex-shaped API:** `query`, `mutation`, `action`, `v.*`, `ctx.db`, `api.module.fn`, `useQuery`. Code and LLM knowledge carry over.
- **Forgiving and explicit:** errors say how to fix the problem, indexes are picked automatically for filters, and `onebase doctor` checks your project.
- **Batteries included:** scheduler, cron jobs, file storage, JWT auth (Clerk, Auth0, any OIDC), HTTP routes and pagination.
- **Dashboard built in** at `/_admin`: browse and edit data, run functions, live logs, jobs and files.
- **Your choice of database:** SQLite by default; Postgres or Turso (libSQL) when you need several instances. Files on disk or in S3/R2/MinIO, and SQLite backups to S3.
- **Single file deploy**, PocketBase style.

## Quick start

```bash
bun install
bun run example        # runs example/ (a chat app) in dev mode on http://localhost:8090
```

In your own project:

```
my-app/
  onebase/schema.ts
  onebase/messages.ts
  public/index.html     optional frontend, served at /
```

```bash
onebase dev          # codegen + restart on change
onebase doctor       # check for mistakes
onebase serve        # production
```

**Website and docs:** https://abdullah-bl.github.io/onebase/ (source in [docs/](docs/)). The [LLM guide](docs/llm-guide.md) is a one-page summary of the API to give an AI assistant.

## Deploying as a single file

**1. Generic binary + functions folder** (like PocketBase + `pb_hooks`):

```bash
bun run build:binary                 # → dist/onebase
```

```bash
sudo install dist/onebase /usr/local/bin/onebase   # the binary goes on your PATH
```

```
server/
  onebase/              # your .ts functions, loaded at startup
  public/               # optional frontend
  onebase_data/         # created automatically: db.sqlite, files/, admin.key
```

```bash
cd server && onebase serve --port 8090
```

Functions can import npm packages from a `node_modules` folder next to them.

**2. Everything in one executable** (functions + frontend embedded):

```bash
onebase build --out ./app          # cross-compile with --target bun-linux-arm64 etc.
./app --port 8090 --data ./onebase_data
```

## Database, files and backups

| Setup | Flags | Good for |
|---|---|---|
| **SQLite** (default) | none; data in `./onebase_data` | one server, lowest latency and memory |
| **SQLite + S3 backups** | `--backup s3://bucket/backups` | one server, with a durable copy of the data |
| **Postgres** | `--db postgres://user:pass@host/db` | several instances behind a load balancer |
| **Turso / libSQL** | `--db libsql://my-db.turso.io` (+ `$TURSO_AUTH_TOKEN`) | managed SQLite, several instances |
| **Files in S3** | `--files s3://bucket/files` | any of the above; works with AWS S3, Cloudflare R2, MinIO, etc. |

S3 credentials come from `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT` / `S3_REGION` (or the `AWS_*` equivalents). Postgres and S3 support are built into Bun, so they don't make the binary bigger.

**Multiple instances (Postgres / Turso):**
- **Live queries:** a commit on one instance updates live queries on all the others (Postgres `LISTEN/NOTIFY`; for Turso, a small commit log that each instance polls).
- **Mutations:** they run as serializable transactions and are retried on conflicts.
- **Scheduler and crons:** each job and each cron run is claimed by exactly one instance.

**Backups (SQLite):**
- A consistent snapshot (`VACUUM INTO`) is gzipped and uploaded every `--backup-every` (default `1h`). The newest `--backup-keep` (default 24) are kept.
- Local files are synced too.
- `onebase backup`, `onebase backups` and `onebase restore [--at 20261022T03] [--force]` handle one-off backups, listing and restores.

## HTTP API

| Endpoint | |
|---|---|
| `POST /api/query` / `mutation` / `action` | `{ "path": "messages:list", "args": {} }` → `{ status, value }` |
| `WS /api/sync` | live subscriptions, mutations and actions (used by the client) |
| `GET /api/health` | status |
| `GET /_onebase/client.js` | browser client as an ES module (no build step needed) |
| `POST /api/storage/upload?token=…` / `GET /api/storage/<id>` | file upload (via `generateUploadUrl`) and download |
| your `http.ts` routes | webhooks etc. |

Send `Authorization: Bearer <token>` for auth. Tokens are checked by the providers in `onebase/auth.config.ts`.

## How it works

- **Storage:** all documents live in one `documents` table (JSON in SQLite, `jsonb` in Postgres). Each schema index becomes a partial expression index, so the database's planner chooses indexes for both `withIndex` and `filter`.
- **Drivers:** the engine talks to a small async driver interface (`read`, `write`, `publish`, `subscribe`) with SQLite (`bun:sqlite`), Postgres (`Bun.SQL`) and libSQL implementations. The same tests run against all three.
- **Transactions:** mutations from one process run one at a time in a serializable transaction. Queries read a consistent snapshot (a separate WAL reader on SQLite; `REPEATABLE READ` on Postgres).
- **Reactivity:** each query records the documents and equality ranges it read (for example `messages where channel = X`). After a commit, only subscriptions whose reads overlap the writes re-run. Identical subscriptions share one execution, and results are pushed only when they change.
- **Scheduler and crons:** jobs and cron schedules are stored in SQLite, so they survive restarts. Scheduled mutations run exactly once.
- **Files:** stored on disk in `<data>/files`, with metadata in SQLite. Deletes inside a mutation only take effect if it commits.
- **Auth:** JWTs are verified with WebCrypto (RS256/384/512, PS256, ES256/384, EdDSA). Keys come from OIDC discovery or a JWKS URL, are cached, and are refetched when they rotate.

## Development

```bash
bun test               # engine + end-to-end tests (SQLite, local files)
# Also against Postgres, libSQL and S3:
TEST_POSTGRES_URL=postgres://… TEST_LIBSQL_URL=http://127.0.0.1:8080 \
TEST_S3_URL="s3://bucket/prefix?endpoint=http://127.0.0.1:9000" S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… bun test
bun run typecheck      # includes type-level tests in tests/types.ts
bun run build:assets   # rebuild the embedded browser client and dashboard (src/client, src/dashboard)
bun run site           # build the website into site/dist
```
