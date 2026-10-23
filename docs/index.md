---
title: Introduction
description: What onebase is, what it's for, and how it compares to Convex.
---

# Introduction

onebase is a reactive backend you run yourself. You write your backend as TypeScript functions, store data in a typed document database, and clients subscribe to queries that update live when the data changes. It all ships as **one executable file**.

```ts
// onebase/messages.ts
export const list = query({
  args: { channel: v.id("channels") },
  handler: (ctx, { channel }) =>
    ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect(),
});

export const send = mutation({
  args: { channel: v.id("channels"), body: v.string() },
  handler: (ctx, args) => ctx.db.insert("messages", args),
});
```

```tsx
// In your React app: re-renders whenever anyone sends a message.
const messages = useQuery(api.messages.list, { channel });
```

## Why onebase

onebase follows [Convex](https://convex.dev)'s programming model and API, and makes different trade-offs:

- **Small.** One Bun process with SQLite. It uses about 40 MB of memory at startup and needs no separate database server.
- **Node and npm everywhere.** Queries, mutations and actions all run in Bun, so any npm package works in any function. There is no `"use node"` split.
- **One file to deploy.** Copy the binary to a server and run it. The functions can sit next to it in a folder, or be compiled into it along with your frontend.
- **Hard to misuse.** Errors explain how to fix the problem, `.filter()` picks indexes automatically, and `onebase doctor` catches common mistakes. This matters when an LLM writes the code.
- **Grows with you.** Start on SQLite. When you need several instances, switch to Postgres or Turso with one flag.

## What's included

| | |
|---|---|
| [Schema](./schema.md) | Tables, validators, indexes, and checks on every write |
| [Functions](./functions.md) | Queries, mutations, actions and internal functions, with argument validation |
| [Database](./database.md) | `ctx.db`, indexes, filters, ordering and pagination |
| [Search](./search.md) | Full-text search indexes, live like any query |
| [Live queries](./client.md) | WebSocket subscriptions that update only when relevant data changes |
| [Scheduling](./scheduling.md) | `runAfter` / `runAt`, plus cron jobs that survive restarts |
| [File storage](./file-storage.md) | Uploads and downloads, on local disk or in S3 / R2 / MinIO |
| [Auth](./auth.md) | JWT verification for Clerk, Auth0, WorkOS and any OIDC provider |
| [HTTP actions](./http-actions.md) | Webhooks and custom HTTP endpoints |
| [Databases](./databases.md) | SQLite, Postgres or Turso, including multiple instances |
| [Backups](./backups.md) | SQLite snapshots to S3, with restore |
| [Dashboard](./dashboard.md) | Browse and edit data, run functions, and watch logs, jobs and files at `/_admin` |

## When to use something else

onebase is a young project. Use Convex if you want a managed service, vector search, and a team supporting it. Use onebase if you want to own the whole stack, run it on a small VPS or your own hardware, or need full Node.js in every function.

Next: [Quick start](./getting-started.md).
