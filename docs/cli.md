---
title: CLI
description: Every onebase command and flag.
---

# CLI

```
onebase <command> [flags]
```

| Command | |
|---|---|
| `serve` | Run the server |
| `dev` | Run the server, regenerate `_generated/` and restart when files change; full error messages and index warnings |
| `codegen` | Write `onebase/_generated/` (`api.ts`, `server.ts`, `dataModel.ts`) |
| `doctor` | Check the schema, functions, crons and imports for common mistakes; exits 1 on errors |
| `deploy` | Push functions (and `public/`) to a running server with no restart; `--dry-run` checks only, `--rollback` goes back one (see [Deployment](./deployment.md#onebase-deploy)) |
| `build` | Compile functions and frontend into one executable |
| `backup` | Take one SQLite snapshot to `--backup` now |
| `backups` | List snapshots in `--backup` |
| `restore` | Restore the newest snapshot (or `--at`) into `--data` |
| `vacuum` | Shrink the SQLite file to the data it holds; stop the server first (see [vacuum](#vacuum)) |
| `version` | Print the version |

## Flags

Each flag can also be set with an environment variable, which can come from a [.env file](./deployment.md#env-files).

| Flag | Default | |
|---|---|---|
| `--dir <path>` | `./onebase` / `$ONEBASE_DIR` | Functions folder. A Convex project's `./convex` folder is used if there's no `./onebase`. |
| `--data <path>` | `./onebase_data` / `$ONEBASE_DATA` | Data folder (SQLite database and local files) |
| `--public <path>` | `./public` if present / `$ONEBASE_PUBLIC` | Static frontend; unknown paths fall back to `index.html`. `deploy` ships it. |
| `--port <n>` | `8090` / `$PORT` | |
| `--host <addr>` | `0.0.0.0` / `$ONEBASE_HOST` | |
| `--url <url>` | `http://localhost:<port>` / `$ONEBASE_URL` | Public URL, used in file URLs. For `deploy`: the server to push to (`$ONEBASE_DEPLOY_URL`). |
| `--db <url>` | `<data>/db.sqlite` / `$ONEBASE_DB` / `$DATABASE_URL` | SQLite path, `postgres://…`, `mysql://…`, or `libsql://…` / `https://…` |
| `--files <s3url>` | local `<data>/files` / `$ONEBASE_FILES` | `s3://bucket/prefix` |
| `--backup <s3url>` | / `$ONEBASE_BACKUP` | `s3://bucket/prefix` |
| `--backup-every <d>` | `1h` / `$ONEBASE_BACKUP_EVERY` | `30m`, `6h`, `1d`, … |
| `--backup-keep <n>` | `24` / `$ONEBASE_BACKUP_KEEP` | Snapshots to keep |
| `--at <time>` | newest | `restore`: pick a snapshot |
| `--force` | | `restore`: overwrite an existing database |
| `--cors <origins>` | any / `$ONEBASE_CORS` | Browser origins allowed to call the API, comma-separated |
| `--rate-limit <r>` | off / `$ONEBASE_RATE_LIMIT` | Per-IP limit on calls, subscriptions and uploads, e.g. `100/10s`, `600/m` |
| `--trust-proxy` | off / `$ONEBASE_TRUST_PROXY=1` | Take the client IP from `X-Forwarded-For` |
| `--no-dashboard` | dashboard on / `$ONEBASE_DASHBOARD=off` | Don't serve the dashboard or admin API at `/_admin` (this also turns off deploys) |
| `--no-deploy` | deploys on / `$ONEBASE_DEPLOY=off` | Refuse `onebase deploy` and run the local code instead of what was pushed |
| `--dry-run` | | `deploy`: check the code against the server's data without changing anything |
| `--rollback` | | `deploy`: go back to the previous deployment |
| `--env-file <path>` | `.env` files for the command | Read only this file; repeat for several |
| `--out <file>` | `./app` | `build`: output file |
| `--target <t>` | current platform | `build`: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64` |

## Environment variables

| | |
|---|---|
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` | S3 credentials for `--files` and `--backup` (`AWS_*` equivalents also work) |
| `TURSO_AUTH_TOKEN` / `LIBSQL_AUTH_TOKEN` | Token for `--db libsql://…` |
| `ONEBASE_ADMIN_KEY` | Dashboard and deploy key (default: generated into `<data>/admin.key`) |
| `ONEBASE_DEPLOY_URL`, `ONEBASE_DEPLOY_KEY` | `deploy`: the server, and its admin key. Keep them in `.env.local`. |
| `ONEBASE_QUERY_TIMEOUT`, `ONEBASE_MUTATION_TIMEOUT`, `ONEBASE_ACTION_TIMEOUT` | How long a call may run (default `10s`, `10s`, `10m`; `off` for no limit). See [Time limits](./functions.md#time-limits). |

## doctor

```
✗ error posts.ts:2: Imports from the convex package instead of onebase.
         fix: Use "./_generated/server" for query/mutation/action and "onebase/values" for v.
✗ error schema.ts › posts.index("by_athor"): Field "athor" doesn't exist on "posts".
         fix: Known fields: title, author
⚠ warn  posts.ts › add: mutation has no args validator, so any input is accepted.
         fix: Add args: { ... } (use args: {} if it takes none).
```

`doctor` checks:
- files that fail to load
- index fields that don't exist, and duplicate or reserved index names
- `v.id()` pointing at missing tables
- functions without `args`
- crons that call missing functions
- imports from `convex/*`
- `"use node"`
- `.filter(doc => doc.x === …)` mistakes
- stale `_generated/` files
- a SQLite database (`--db`, or `<data>/db.sqlite`) where deleted documents left a lot of free space

## vacuum

SQLite doesn't shrink its file when documents are deleted: it keeps the free pages and reuses them for new writes. A database created by this version of onebase gives them back by itself. Every 5 minutes, once free pages are at least 64 MB and a quarter of the file, the server frees up to 256 MB, in small slices so writes keep going. The same pass cuts the WAL file back to nothing. Databases created by older versions can't do this until they've been vacuumed once:

```
onebase vacuum --data ./onebase_data
```

`vacuum` rewrites the whole file, so it needs about as much free disk as the data takes up. Writes wait while it runs, so stop the server first. `onebase doctor` tells you when it's worth running.
