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
| `build` | Compile functions and frontend into one executable |
| `backup` | Take one SQLite snapshot to `--backup` now |
| `backups` | List snapshots in `--backup` |
| `restore` | Restore the newest snapshot (or `--at`) into `--data` |
| `version` | Print the version |

## Flags

| Flag | Default | |
|---|---|---|
| `--dir <path>` | `./onebase` | Functions folder. A Convex project's `./convex` folder is used if there's no `./onebase`. |
| `--data <path>` | `./onebase_data` | Data folder (SQLite database and local files) |
| `--public <path>` | `./public` if present | Static frontend; unknown paths fall back to `index.html` |
| `--port <n>` | `8090` / `$PORT` | |
| `--host <addr>` | `0.0.0.0` | |
| `--url <url>` | `http://localhost:<port>` / `$ONEBASE_URL` | Public URL, used in file URLs |
| `--db <url>` | `<data>/db.sqlite` / `$ONEBASE_DB` / `$DATABASE_URL` | SQLite path, `postgres://…`, or `libsql://…` / `https://…` |
| `--files <s3url>` | local `<data>/files` / `$ONEBASE_FILES` | `s3://bucket/prefix` |
| `--backup <s3url>` | / `$ONEBASE_BACKUP` | `s3://bucket/prefix` |
| `--backup-every <d>` | `1h` | `30m`, `6h`, `1d`, … |
| `--backup-keep <n>` | `24` | Snapshots to keep |
| `--at <time>` | newest | `restore`: pick a snapshot |
| `--force` | | `restore`: overwrite an existing database |
| `--out <file>` | `./app` | `build`: output file |
| `--target <t>` | current platform | `build`: `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64` |

## Environment variables

| | |
|---|---|
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT`, `S3_REGION` | S3 credentials for `--files` and `--backup` (`AWS_*` equivalents also work) |
| `TURSO_AUTH_TOKEN` / `LIBSQL_AUTH_TOKEN` | Token for `--db libsql://…` |

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
