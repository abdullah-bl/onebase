---
title: Dashboard
description: Browse and edit data, run functions, and watch logs, jobs and files at /_admin.
---

# Dashboard

Every onebase server includes a dashboard at **`/_admin`**. It's built into the binary (about 100 KB) and updates live. Press **⌘K** (Ctrl+K) anywhere to jump to a page, table or function.

| Page | What you can do |
|---|---|
| **Overview** | What needs attention (failed jobs and crons, failing or slow functions, overdue jobs, tables outside the schema), calls and p95 latency over the last minute, 15 minutes or hour, per-function health, what runs next, table sizes, and the setup, with a rollback button when a deployment is live |
| **Data** | Browse any table, filter (`{"author": "ali"}`) or look up an id, add and edit documents, delete or export a selection |
| **Functions** | Run any function, internal ones included, with JSON arguments (prefilled from its validator), optionally as a signed-in user. Also shows its numbers for the last hour and its latest calls |
| **Logs** | The last 1,000 calls, live: duration, source, errors and each call's `console.log` output. Filter by function, type, source or text |
| **Scheduler** | Pending, failed and finished jobs (run now, cancel, retry) and every cron with its next and last run (run now) |
| **Files** | Uploaded files with previews; upload, copy an id, delete |

## Signing in

The dashboard is protected by an **admin key**:

- **Generated key:** on first start, onebase generates one and saves it to `<data>/admin.key`, readable only by its owner.
- **Your own key:** set `ONEBASE_ADMIN_KEY` instead. Do this when you run several instances, so they all accept the same key.
- **In dev:** `onebase dev` prints a link that signs you in directly. The key is in the URL's `#` fragment, which browsers never send to the server.

```
  dashboard  http://localhost:8090/_admin#key=…
```

In production the startup output says where the key is:

```
  dashboard  http://localhost:8090/_admin (admin key: onebase_data/admin.key)
```

The browser keeps the key in local storage until you sign out (the button at the bottom of the sidebar). Every API call is checked against it with a constant-time comparison.

## Editing data

Edits go through the same path as a mutation:
- **Validation:** they're checked against `schema.ts`, with the same error messages.
- **Transactions:** each edit runs in a transaction.
- **Live queries:** subscribed clients see the change immediately.

**Saving replaces the whole document.** The editor shows the document without `_id` and `_creationTime`.

Tables that have documents but are no longer in `schema.ts` still show up, marked "not in schema", so you can inspect old data. **Delete all** empties such a table.

[Components](./components.md)' tables are listed under each component's name, and are checked against the component's schema when you edit them. Their functions show up under `components/<name>` on the Functions page, where you can run them.

## Running functions

**Functions** lists every query, mutation and action. The arguments box starts with an example built from the function's `args` validator.

- **As a user:** tick "Run as a signed-in user" and edit the identity. `ctx.auth.getUserIdentity()` will return it.
- **Side effects are real:** mutations and actions really run, so writes, scheduled jobs and outside calls all happen.

## Logs

The runtime records every call: from clients, HTTP, subscription re-runs, the scheduler, crons and the dashboard. For each one it keeps the duration, the result or error, and any `console.*` output from inside the function, even when calls overlap. Records are kept in memory (the last 1,000), so they cost nothing on disk and reset on restart.

Calls still go to the server's stdout as usual, so your log collector keeps working.

## Metrics

The Overview's numbers come from fixed-size counters, not from the 1,000 records, so they stay accurate on a busy server. They cover the last hour, live in memory, reset on restart, and are per instance.

- **Latency:** percentiles are read from a histogram, so they're accurate to within about 20%. Cached query answers count as calls but not toward latency; the **Cached** column shows their share.
- **Function rows:** they roll over in 10-minute steps, so "last hour" means the last 50 to 60 minutes.

## Retrying jobs

**Retry** puts a failed job back in the queue, due now. Mutations that failed were rolled back, so running them again is safe. An action may have done part of its work before it failed, and that part happens again.

**Run now** on a cron runs its function once with its arguments. The schedule doesn't change, and neither does the "last run" shown for it.

## Turning it off

```bash
onebase serve --no-dashboard
```

You can also set `ONEBASE_DASHBOARD=off`. `/_admin` then returns 404.

## Security notes

- **Admin key:** treat it like a database password. Anyone with it can read and change all data, and push code with [`onebase deploy`](./deployment.md#onebase-deploy).
- **Exposure:** the dashboard is served on the same port as your API. If you don't want it reachable from the internet, block `/_admin` at your reverse proxy, or run with `--no-dashboard` and keep a separate internal instance with the dashboard on.
- **Rotating the key:** delete `admin.key` and restart, or change `ONEBASE_ADMIN_KEY`.
