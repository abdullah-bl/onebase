---
title: Deployment
description: Ship onebase as one binary, push updates with onebase deploy, and run it behind a reverse proxy, with systemd or Docker.
---

# Deployment

A onebase server is one executable. There are three ways to get your code onto it:

- **`onebase deploy`:** push from your machine to a running server, like `npx convex deploy`. There's no restart, the new schema is checked against the data first, and you can roll back.
- **Binary + functions folder:** copy your `onebase/` folder next to the binary and restart, like PocketBase with `pb_hooks`.
- **Everything in one file:** compile functions, frontend and runtime into a single executable.

## onebase deploy

Set up the server once. It needs only the binary and its settings, not your functions:

```bash
sudo install onebase-linux-x64 /usr/local/bin/onebase
```

```bash
# /srv/app/.env
ONEBASE_URL=https://api.example.com
ONEBASE_ADMIN_KEY=a-long-random-secret
RESEND_API_KEY=re_...
```

```bash
cd /srv/app && onebase serve
```

Run it with [systemd](#systemd) or [Docker](#docker) to keep it up. Then, on your machine, put the server's address and its admin key in `.env.local`, which git ignores:

```bash
# .env.local
ONEBASE_DEPLOY_URL=https://api.example.com
ONEBASE_DEPLOY_KEY=a-long-random-secret
```

Ship a new feature with one command:

```bash
onebase deploy
```

```
Deploying 5 source file(s) (6.0 KB) and 1 static file(s) from public/ (7.7 KB) to https://api.example.com…
✓ Deployed 8awwre3jhj9nc8w182j7 to https://api.example.com in 310ms: 10 function(s), indexes +1 -0, 1 static file(s).
```

What happens:

1. **On your machine:** `codegen` and `doctor` run, and doctor errors stop the deploy. Your functions and the npm packages they import are bundled into one module. The `public/` folder is included (pick another folder with `--public ./dist`).
2. **On the server:** the new code is loaded, and auth config and crons are checked. When `schema.ts` changed, every document is checked against the new schema, in the same transaction that updates the indexes, like a Convex push. If any check fails, nothing changes and the old code keeps running.
3. **The swap:** new calls use the new code, and calls already running finish with the old code. Connected clients stay connected, and their live queries re-run on the new code.

Two more forms:

```bash
onebase deploy --dry-run    # check the code against the server's data, change nothing
```

```bash
onebase deploy --rollback   # go back to the deployment that was live before this one (the last 10 are kept)
```

Things to know:

- **Where it's kept:** in the database. A restart keeps running the deployment, backups include it, and with [several instances](./databases.md) on Postgres or Turso they all switch to it together. The other instances switch a moment after the deploy commits (under a second), and until then they check writes against the old schema. So with several instances, a write that lands on another instance in that moment isn't checked against a validator the deploy tightened.
- **It replaces the local code:** a deployment runs instead of the server's `onebase/` folder or the code built into the binary. Start with `--no-deploy` (or `ONEBASE_DEPLOY=off`; `0`, `false` and `no` work too) to run the local code and refuse pushes. `onebase dev` servers always refuse them.
- **Secrets stay on the server:** a deploy ships code, not environment variables. Functions read `process.env` on the server, so put API keys in the server's `.env`.
- **The key:** `ONEBASE_DEPLOY_KEY` is the server's [admin key](./dashboard.md): `ONEBASE_ADMIN_KEY` there, or the contents of its `onebase_data/admin.key`. Anyone with it can run code on the server. Deploy over `https://`.
- **The admin API:** deploys go to `/_admin/api/deploy`, so `--no-dashboard` turns them off too. If you block `/_admin` at the proxy, deploy through an SSH tunnel (`--url http://localhost:8090`) or allow that path from your CI's addresses.
- **The frontend:** its files are stored in the database and served from memory. Keep large media in [file storage](./file-storage.md) or a CDN. A deployment without a `public/` folder leaves the server serving its own `--public`.

## Binary + functions folder

Like PocketBase with `pb_hooks`: one `onebase` binary loads your functions from the `onebase/` folder of the directory you run it in.

Put the binary on your PATH, from the [releases](https://github.com/abdullah-bl/onebase/releases) or from `bun run build:binary`. It can't sit next to the `onebase/` folder, because they'd have the same name.

```bash
sudo install onebase-linux-x64 /usr/local/bin/onebase
```

```
server/
  onebase/             your .ts functions (schema.ts, messages.ts, …)
  public/              optional frontend
  onebase_data/        created automatically: db.sqlite, files/, admin.key
```

```bash
cd server && onebase serve --port 8090 --url https://api.example.com
```

You update functions by copying files and restarting, with no rebuild. Functions can import npm packages from a `node_modules` folder next to them.

## Everything in one file

`onebase build` compiles your functions, your `public/` frontend and the onebase runtime into a single executable:

```bash
onebase build --out ./chat
```

```bash
onebase build --out ./chat-arm --target bun-linux-arm64
```

```bash
./chat --port 8090 --data ./onebase_data
```

The targets are `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-x64`, `bun-darwin-arm64` and `bun-windows-x64`. Run `build` from a project that has onebase installed (it needs the source).

## Configuration

Every flag also has an environment variable, and environment variables can come from `.env` files:

| Flag | Env | Default |
|---|---|---|
| `--port` | `PORT` | `8090` |
| `--host` | `ONEBASE_HOST` | `0.0.0.0` |
| `--url` | `ONEBASE_URL` | `http://localhost:<port>`; the public URL, used in file URLs |
| `--dir` | `ONEBASE_DIR` | `./onebase` |
| `--data` | `ONEBASE_DATA` | `./onebase_data` |
| `--public` | `ONEBASE_PUBLIC` | `./public` if it exists |
| `--db` | `ONEBASE_DB`, `DATABASE_URL` | `<data>/db.sqlite` (see [Databases](./databases.md)) |
| `--files` | `ONEBASE_FILES` | `<data>/files` (see [File storage](./file-storage.md)) |
| `--backup` | `ONEBASE_BACKUP` | none (see [Backups](./backups.md)) |
| `--backup-every` | `ONEBASE_BACKUP_EVERY` | `1h` |
| `--backup-keep` | `ONEBASE_BACKUP_KEEP` | `24` |
| `--cors` | `ONEBASE_CORS` | any origin; comma-separated list of allowed browser origins |
| `--rate-limit` | `ONEBASE_RATE_LIMIT` | off; per-IP limit on calls, e.g. `100/10s` or `600/m` |
| `--trust-proxy` | `ONEBASE_TRUST_PROXY=1` | off; read the client IP from `X-Forwarded-For` (set it behind a proxy) |
| `--no-dashboard` | `ONEBASE_DASHBOARD=off` | dashboard on at `/_admin` (see [Dashboard](./dashboard.md)) |
| `--no-deploy` | `ONEBASE_DEPLOY=off` | deploys on (see [onebase deploy](#onebase-deploy)) |
| | `ONEBASE_ADMIN_KEY` | generated into `<data>/admin.key` |

### .env files

onebase reads `.env` files from the directory you run it in, so a server needs no long command line:

| Command | Files, lowest priority first |
|---|---|
| `onebase dev` | `.env`, `.env.local`, `.env.development`, `.env.development.local` |
| everything else (`serve`, `deploy`, binaries, …) | `.env`, `.env.local`, `.env.production`, `.env.production.local` |

- **Priority:** later files win, flags win over everything, and real environment variables win over the files. So `PORT=9000 onebase serve` overrides a `PORT` in `.env`.
- **Your own files:** `--env-file <path>` reads only the files you name (repeat it for several).
- **Syntax:** the same as bun's, so a project behaves the same whether it runs from source or as a binary. That means `KEY=value`, optional `export`, `#` comments, quotes that may span lines, and `$VAR`, `${VAR}` and `${VAR:-default}` references. `#` starts a comment in unquoted values, so quote values that contain one, like `"https://x/#y"`.
- **Your functions** see the same variables in `process.env`.
- **`onebase dev`** restarts when a `.env` file changes.
- **Keep secrets out of git:** the `.local` files are for secrets, and the usual `.gitignore` excludes them. On a server, a plain `.env` next to the data is fine.

## Behind a reverse proxy

onebase uses WebSockets at `/api/sync`, so make sure your proxy forwards upgrades. With Caddy, it works out of the box:

```
api.example.com {
  reverse_proxy localhost:8090
}
```

With nginx:

```nginx
location / {
  proxy_pass http://127.0.0.1:8090;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

## systemd

```ini
# /etc/systemd/system/onebase.service
[Unit]
Description=onebase
After=network.target

[Service]
# onebase reads /srv/app/.env itself (PORT, ONEBASE_URL, secrets, …).
WorkingDirectory=/srv/app
ExecStart=/usr/local/bin/onebase serve
Restart=always
User=onebase

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now onebase
```

## Docker

```dockerfile
FROM debian:bookworm-slim
WORKDIR /app
COPY onebase-linux-x64 /usr/local/bin/onebase
COPY onebase/ ./onebase/
COPY public/ ./public/
VOLUME /app/onebase_data
EXPOSE 8090
CMD ["onebase", "serve"]
```

Pass settings with `docker run --env-file .env`, or mount a `.env` into `/app`. To ship code with `onebase deploy` instead of baking it into the image, leave out the two `COPY` lines for `onebase/` and `public/`. The deployment lives in the database on the volume, so it survives a new container.

## Production checklist

- **Public URL:** set `--url`, so file URLs point at your public domain.
- **Durable data:** keep `onebase_data` on persistent disk, and add `--backup` (or use Postgres or Turso).
- **Before deploying:** run `onebase doctor` (`onebase deploy` runs it for you), and try a risky schema change with `onebase deploy --dry-run`.
- **Behind a proxy:** pass `--trust-proxy` so `--rate-limit` counts real client IPs.
- **Dashboard:** keep the admin key secret, or block `/_admin` at the proxy (see [Dashboard](./dashboard.md)).
- **Errors:** in production (no `--dev`), unexpected errors reach clients as `Server Error`. Use `ConvexError` for messages users should see.
- **Memory:** expect about 40 MB at startup with SQLite; Postgres adds a few MB for its connection pool.
