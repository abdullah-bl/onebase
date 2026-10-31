# onebase

A lightweight, Convex-style reactive backend: TypeScript functions, a typed document database and live queries. It runs as one Bun process on SQLite and ships as a single executable.

- **Small:** about 40 MB RSS on startup, dashboard included. One process with no isolates and no separate database server.
- **Full Node/npm everywhere:** queries, mutations and actions all run in Bun. There is no `"use node"` split.
- **Convex-shaped API:** `query`, `mutation`, `action`, `v.*`, `ctx.db`, `api.module.fn`, `useQuery`. Code and LLM knowledge carry over.
- **Forgiving and explicit:** errors say how to fix the problem, indexes are picked automatically for filters, and `onebase doctor` checks your project.
- **Batteries included:** sign-in with passwords and OAuth, full-text search, optimistic updates, scheduler, cron jobs, file storage, JWT auth (Clerk, Auth0, any OIDC), HTTP routes and pagination.
- **Components:** mount packages with their own tables, like the built-in rate limiter, aggregate (counts, sums and ranks in O(log n)), sharded counter and work queue, and call them as `ctx.components.limiter.limit({ ... })`, in your transaction. Components can follow your tables through table hooks, with no triggers to wire up.
- **Dashboard built in** at `/_admin`: browse and edit data, run functions, live logs, jobs and files.
- **Your choice of database:** SQLite by default; Postgres, MySQL or Turso (libSQL) when you need several instances. Files on disk or in S3/R2/MinIO, and SQLite backups to S3.
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
onebase deploy       # push your code to a running server, no restart
```

**Website and docs:** https://abdullah-bl.github.io/onebase/ (source in [docs/](docs/)). The [LLM guide](docs/llm-guide.md) is a one-page summary of the API to give an AI assistant.

## Compared to Convex

In our tests on one machine, onebase used far less memory than self-hosted Convex and was faster at writes and vector search. It lost none of 32,606 acknowledged writes when the process was killed with `kill -9`.

| 60 seconds of load | Convex | onebase |
|---|---|---|
| 1 KB writes, 100 workers | 971/s | **10,665/s** (4,389/s with `synchronous=FULL`) |
| 512 KB writes, 50 workers | 805/s | **1,383/s** |
| Vector search, 10,000 × 1536 dimensions, 50 workers | 1,575/s | **2,099/s** |
| Repeated scan of 2,000 documents, 100 workers | **12,936/s** | 2,467/s |
| Memory during 1 KB writes | 3,035 MiB | **39 MiB** |

**What to keep in mind:**

- **Long-running functions block the server.** Functions share one thread with no isolates, so a 3-second CPU-bound function delayed a ping by 3 seconds.
- **Power loss is untested.** `kill -9` only tests a process crash. With the default `synchronous=NORMAL`, a power cut can lose the most recent commits.
- **Convex wasn't tuned.** It ran with default settings and limits, on a volume with history that inflates its memory use. We didn't test Convex Cloud.
- **Convex won on repeated scans** in this comparison, most likely from its query cache. onebase has since added a [cache for repeated reads](docs/functions.md#repeated-reads) on SQLite. In a separate run outside Docker it took a similar scan from about 1,700/s to about 114,000/s, but we haven't run it against Convex.
- **The test was narrow.** It's mostly single runs on one machine, with the load generator on the same machine. Nothing was measured on x86-64.

**How we tested:** an NVIDIA DGX Spark (arm64, 20 cores, 121 GiB RAM, NVMe) running both backends in Docker with no resource limits, driven over loopback HTTP by a Node load generator. [Benchmarks](docs/benchmarks.md) has the full setup, all the results, and what we haven't tested.

## Skills for AI agents

[`skills/`](skills) has step-by-step instructions for coding agents such as Claude Code. Each one includes the checks to run and the limits to tell the user about.

| Skill | Use it to |
|---|---|
| [`setup-onebase-app`](skills/setup-onebase-app/SKILL.md) | Go from an empty folder to a checked, running app, with a list of what to settle before production |
| [`build-onebase-component`](skills/build-onebase-component/SKILL.md) | Write, mount and test your own component, including table hooks |
| [`convex-to-onebase`](skills/convex-to-onebase/SKILL.md) | Move a Convex project over: code, `@convex-dev/*` components, and what moving the data involves |

To install one into a project for Claude Code:

```bash
mkdir -p .claude/skills && cp -r node_modules/onebase/skills/setup-onebase-app .claude/skills/
```

Other agents can be pointed at the `SKILL.md` file. An agent can still get things wrong, so review its work and run your own tests.

## Deploying

**1. Push with `onebase deploy`** (like `npx convex deploy`): run `onebase serve` on the server once, then ship each change from your machine:

```bash
# .env.local (git ignores it)
ONEBASE_DEPLOY_URL=https://api.example.com
ONEBASE_DEPLOY_KEY=…                 # the server's admin key
```

```bash
onebase deploy                       # also: --dry-run, --rollback
```

The server checks the new schema against its data, updates indexes, and swaps the code in without a restart. Connected clients' live queries re-run on the new code. If a check fails, nothing changes.

**2. Generic binary + functions folder** (like PocketBase + `pb_hooks`):

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

Every flag has an environment variable, and onebase reads `.env`, `.env.local`, `.env.production` and `.env.production.local` (`.env.development*` for `onebase dev`).

Functions can import npm packages from a `node_modules` folder next to them.

**3. Everything in one executable** (functions + frontend embedded):

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
| **MySQL 8** | `--db mysql://user:pass@host/db` | several instances, on an existing MySQL server (schema indexes aren't used) |
| **Turso / libSQL** | `--db libsql://my-db.turso.io` (+ `$TURSO_AUTH_TOKEN`) | managed SQLite, several instances |
| **Files in S3** | `--files s3://bucket/files` | any of the above; works with AWS S3, Cloudflare R2, MinIO, etc. |

S3 credentials come from `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` / `S3_ENDPOINT` / `S3_REGION` (or the `AWS_*` equivalents). Postgres, MySQL and S3 support are built into Bun, so they don't make the binary bigger.

**Multiple instances (Postgres / MySQL / Turso):**
- **Live queries:** a commit on one instance updates live queries on all the others (Postgres `LISTEN/NOTIFY`; for MySQL and Turso, a small commit log that each instance polls).
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
| `WS /api/sync` | live subscriptions, mutations and actions (used by the clients; [protocol spec](docs/client-protocol.md)) |
| `GET /api/health` | status |
| `GET /_onebase/client.js` | browser client as an ES module (no build step needed) |
| `POST /api/storage/upload?token=…` / `GET /api/storage/<id>` | file upload (via `generateUploadUrl`) and download |
| your `http.ts` routes | webhooks etc. |

Send `Authorization: Bearer <token>` for auth: a built-in session token, or a token checked by the providers or `authenticate()` in `onebase/auth.config.ts`. Built-in sign-in lives under `/api/auth/*` (see [docs/auth.md](docs/auth.md)).

**Clients:** the JS/TS client (browser, React, Bun) ships with the package, with optimistic updates and offline support ([docs/client.md](docs/client.md)). A Swift package for iOS and macOS lives in [onebase-swift](https://github.com/abdullah-bl/onebase-swift) ([docs/swift.md](docs/swift.md)), and the [client protocol](docs/client-protocol.md) is the documented contract for any other platform.

## How it works

- **Storage:** all documents live in one `documents` table (JSON in SQLite, `jsonb` in Postgres). Each schema index becomes a partial expression index, so the database's planner chooses indexes for both `withIndex` and `filter`.
- **Drivers:** the engine talks to a small async driver interface (`read`, `write`, `publish`, `subscribe`) with SQLite (`bun:sqlite`), Postgres and MySQL (`Bun.SQL`), and libSQL implementations. The same tests run against all four.
- **Transactions:** mutations from one process run one at a time in a serializable transaction. Queries read a consistent snapshot (a separate WAL reader on SQLite; `REPEATABLE READ` on Postgres).
- **Reactivity:** each query records the documents, equality ranges, index bounds and the slice of rows it read (for example `messages where channel = X`, the latest 50). After a commit, only subscriptions whose reads overlap the writes re-run. Identical subscriptions share one execution, and results are pushed only when they change.
- **Components:** each mount's tables are stored as `<mount>.<table>` in the same `documents` table; every database handle is scoped to the app's tables or one component's, and component calls reuse the nested query and mutation paths (one snapshot, or a savepoint in the caller's transaction).
- **Search:** SQLite and Turso keep an FTS5 table per search index; Postgres uses a GIN `tsvector` index on the documents table; MySQL a `FULLTEXT` side table.
- **Vector search:** SQLite and Turso keep a float32 side table per vector index; SQLite also keeps a copy in shared memory and ranks it on worker threads with WebAssembly SIMD, and Turso compares with libSQL's `vector_distance_cos`; Postgres uses a pgvector HNSW index; MySQL ranks in the server.
- **Scheduler and crons:** jobs and cron schedules are stored in SQLite, so they survive restarts. Scheduled mutations run exactly once.
- **Files:** stored on disk in `<data>/files`, with metadata in SQLite. Deletes inside a mutation only take effect if it commits.
- **Auth:** built-in sign-in stores users in your `users` table; password hashes (argon2id), OAuth links, sessions and one-time codes live in system tables, with tokens stored as SHA-256 hashes. External JWTs are verified with WebCrypto (RS256/384/512, PS256, ES256/384, EdDSA). Keys come from OIDC discovery or a JWKS URL, are cached, and are refetched when they rotate.

## Development

```bash
bun test               # engine + end-to-end tests (SQLite, local files)
# Also against Postgres (with pgvector), MySQL, libSQL and S3:
TEST_POSTGRES_URL=postgres://… TEST_MYSQL_URL="mysql://…?allowPublicKeyRetrieval=true" TEST_LIBSQL_URL=http://127.0.0.1:8080 \
TEST_S3_URL="s3://bucket/prefix?endpoint=http://127.0.0.1:9000" S3_ACCESS_KEY_ID=… S3_SECRET_ACCESS_KEY=… bun test
bun run typecheck      # includes type-level tests in tests/types.ts
bun run build:assets   # rebuild the embedded browser client and dashboard (src/client, src/dashboard)
bun run site           # build the website into site/dist
```

## License

[MIT](LICENSE)
