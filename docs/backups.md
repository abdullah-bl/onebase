---
title: Backups
description: Automatic SQLite snapshots to S3, and restoring them.
---

# Backups

With SQLite, onebase can take consistent snapshots of the database and upload them to S3, R2 or MinIO on a schedule. (Postgres and Turso have their own backup tools.)

## Automatic backups

```bash
export S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... S3_ENDPOINT=...   # S3_ENDPOINT only for R2/MinIO/etc.
onebase serve --backup s3://my-bucket/backups --backup-every 1h --backup-keep 24
```

- **Snapshots:** `VACUUM INTO` gives a consistent copy without blocking writes. It's gzipped and uploaded as `db/onebase-<time>.sqlite.gz`.
- **Schedule:** the first backup runs a few seconds after startup, then one every `--backup-every` (`30m`, `1h`, `1d`, …).
- **Retention:** only the newest `--backup-keep` snapshots are kept.
- **Files:** uploaded files in the local `files/` folder are synced to `files/` in the bucket. Only new files are uploaded, since files never change.

How much data you can lose depends on the interval: with `--backup-every 15m`, at most 15 minutes of writes.

## One-off backup

```bash
onebase backup --backup s3://my-bucket/backups
```

```bash
onebase backups --backup s3://my-bucket/backups
```

## Restore

Stop the server, then:

```bash
onebase restore --backup s3://my-bucket/backups --data ./onebase_data
```

```bash
onebase restore --backup s3://my-bucket/backups --at 20261022T0300 --force
```

`restore` downloads the newest snapshot, or the one whose name contains `--at`, into `<data>/db.sqlite`, and downloads any files that are missing. It refuses to overwrite an existing database unless you pass `--force`.

You can also use it to move a project to a new server: install onebase there, run `restore`, then `serve`.
