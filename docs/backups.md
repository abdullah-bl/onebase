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

- **Snapshots:** `VACUUM INTO` gives a consistent copy without blocking writes. It's written next to the database (so allow free space for one more copy), checked with SQLite's `quick_check`, gzipped and uploaded as `db/onebase-<time>.sqlite.gz`. A snapshot that fails the check isn't uploaded, and the failure is logged.
- **Schedule:** the first backup runs a few seconds after startup, then one every `--backup-every` (`30m`, `1h`, `1d`, …).
- **Retention:** the newest `--backup-keep` snapshots are kept (default 24), and also the newest snapshot of each of the last `--backup-keep-daily` days (default 7). With hourly backups that is a day of hourly copies and a week of daily ones, for the mistake you only notice days later. `--backup-keep-daily 0` keeps just the newest ones.
- **Encryption:** with `ONEBASE_SECRET_KEY` set (at least 32 characters; `openssl rand -base64 32`), snapshots are encrypted before upload (AES-256-GCM) and named `….sqlite.gz.enc`. Restoring one needs the same key, so keep it somewhere other than the bucket. Uploaded files are encrypted the same way (as `files/<id>.enc`), and files that were backed up before the key was set are replaced with encrypted copies on the next backup. Without the key, treat the bucket like the database itself: a snapshot holds your data, password hashes and the code you deployed, and whoever can replace a snapshot decides what a restore runs.
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

`restore` downloads the newest snapshot, or the one whose name contains `--at`, into `<data>/db.sqlite`, and downloads any files that are missing. It refuses to overwrite an existing database unless you pass `--force`. The download is checked before it replaces anything: a damaged or wrongly decrypted snapshot is an error, and the database that was there stays. For an encrypted snapshot or encrypted files, set `ONEBASE_SECRET_KEY` to the key the server had.

You can also use it to move a project to a new server: install onebase there, run `restore`, then `serve`.
