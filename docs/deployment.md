---
title: Deployment
description: Ship onebase as one binary, behind a reverse proxy, with systemd or Docker.
---

# Deployment

There are two ways to ship, and both produce a single executable.

## 1. Generic binary + functions folder

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

## 2. Everything in one file

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

Every flag also has an environment variable:

| Flag | Env | Default |
|---|---|---|
| `--port` | `PORT` | `8090` |
| `--host` | | `0.0.0.0` |
| `--url` | `ONEBASE_URL` | `http://localhost:<port>`; the public URL, used in file URLs |
| `--dir` | | `./onebase` |
| `--data` | | `./onebase_data` |
| `--public` | | `./public` if it exists |
| `--db` | `ONEBASE_DB`, `DATABASE_URL` | `<data>/db.sqlite` (see [Databases](./databases.md)) |
| `--files` | `ONEBASE_FILES` | `<data>/files` (see [File storage](./file-storage.md)) |
| `--backup` | `ONEBASE_BACKUP` | none (see [Backups](./backups.md)) |
| `--cors` | `ONEBASE_CORS` | any origin; comma-separated list of allowed browser origins |
| `--rate-limit` | `ONEBASE_RATE_LIMIT` | off; per-IP limit on calls, e.g. `100/10s` or `600/m` |
| `--trust-proxy` | | off; read the client IP from `X-Forwarded-For` (set it behind a proxy) |
| `--no-dashboard` | `ONEBASE_DASHBOARD=off` | dashboard on at `/_admin` (see [Dashboard](./dashboard.md)) |
| | `ONEBASE_ADMIN_KEY` | generated into `<data>/admin.key` |

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
WorkingDirectory=/srv/app
ExecStart=/usr/local/bin/onebase serve --port 8090 --url https://api.example.com
Environment=ONEBASE_BACKUP=s3://my-bucket/backups
EnvironmentFile=-/srv/app/.env
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

## Production checklist

- **Public URL:** set `--url`, so file URLs point at your public domain.
- **Durable data:** keep `onebase_data` on persistent disk, and add `--backup` (or use Postgres or Turso).
- **Before deploying:** run `onebase doctor`.
- **Behind a proxy:** pass `--trust-proxy` so `--rate-limit` counts real client IPs.
- **Dashboard:** keep the admin key secret, or block `/_admin` at the proxy (see [Dashboard](./dashboard.md)).
- **Errors:** in production (no `--dev`), unexpected errors reach clients as `Server Error`. Use `ConvexError` for messages users should see.
- **Memory:** expect about 40 MB at startup with SQLite; Postgres adds a few MB for its connection pool.
