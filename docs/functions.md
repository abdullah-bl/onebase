---
title: Functions
description: Queries, mutations, actions, internal functions, validation and errors.
---

# Functions

Each file in `onebase/` is a module, and each exported function becomes an endpoint named `module:export`. For example, `onebase/messages.ts` exporting `list` becomes `messages:list`, which clients reference as `api.messages.list`. Subfolders nest: `onebase/admin/users.ts` → `api.admin.users.fn`.

Import the builders from `./_generated/server`. They're typed for your schema.

## Queries

Queries read data. They're read-only, see a consistent snapshot, and clients can subscribe to them.

```ts
import { v } from "onebase/values";
import { query } from "./_generated/server";

export const byAuthor = query({
  args: { author: v.id("users") },
  handler: async (ctx, { author }) => {
    return await ctx.db
      .query("posts")
      .withIndex("by_author", (q) => q.eq("author", author))
      .order("desc")
      .take(20);
  },
});
```

A subscribed query re-runs only when a write could change its result. Identical subscriptions (same function, arguments and user) share a single execution.

### Repeated reads

One-off reads (`client.query()` and `POST /api/query`) reuse an earlier result when the function, arguments and user are the same and no write since could have changed it. They never return data older than a write that has already been acknowledged, and identical reads arriving together share one run. Results are dropped when a write could affect them or when new code is deployed, and the least recently used go first once they reach `ONEBASE_QUERY_CACHE_MB` (default 64). Set it to `0` to run every read. That limit counts results and an estimate of their bookkeeping, not all the memory they cost: in [our tests](./benchmarks.md#repeated-reads) the process grew by 89–142 MiB at the default.

This applies on SQLite only. With Postgres, MySQL or Turso, other instances learn about commits a moment later, so every read runs. `POST /api/run` and `ctx.runQuery` always run the query too.

A query that reads the clock or a random source (`Date.now()`, `new Date()`, `Math.random()`, `performance.now()`, `crypto.randomUUID()` or `crypto.getRandomValues()`) runs for every read, so its one-off results stay as fresh as before. onebase can't see other things a query might depend on, such as a file, an environment variable or a module-level variable. A result based on those stays until a write or deploy drops it, which is also how a subscribed query behaves.

## Mutations

Mutations write data in a transaction: either all of their writes happen, or none do.

```ts
import { ConvexError, v } from "onebase/values";
import { mutation } from "./_generated/server";

export const publish = mutation({
  args: { id: v.id("posts") },
  handler: async (ctx, { id }) => {
    const post = await ctx.db.get(id);
    if (!post) throw new ConvexError("Post not found");
    await ctx.db.patch(id, { published: true });
  },
});
```

Inside a mutation you can use:
- `ctx.runQuery` and `ctx.runMutation`, which run in the same transaction.
- `ctx.scheduler`, whose jobs only happen if the mutation commits.
- `ctx.storage`.

## Actions

Actions are for side effects: calling APIs, sending email, running AI models. They don't have `ctx.db`. Read with `ctx.runQuery` and write with `ctx.runMutation`.

```ts
import { v } from "onebase/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import OpenAI from "openai"; // any npm package works

export const summarize = action({
  args: { id: v.id("posts") },
  handler: async (ctx, { id }) => {
    const post = await ctx.runQuery(internal.posts.get, { id });
    const summary = await new OpenAI().responses.create({ model: "gpt-5", input: post!.title });
    await ctx.runMutation(internal.posts.setSummary, { id, summary: summary.output_text });
  },
});
```

Every function runs in Bun, so `node:*` modules and npm packages work in queries and mutations too. **`fetch()` is the exception: only actions can call it.** A query re-runs whenever its data changes, and a mutation holds the write lock and may be retried when it conflicts with another instance (see [Databases](./databases.md)), so outside calls belong in actions. Calling `fetch()` from a query or mutation fails with an error that says so.

## Internal functions

`internalQuery`, `internalMutation` and `internalAction` can't be called by clients, only from other functions, the scheduler and crons. Reference them through `internal` instead of `api`:

```ts
import { internal } from "./_generated/api";
await ctx.scheduler.runAfter(0, internal.emails.send, { to });
```

## Arguments and return values

`args` is validated before the handler runs. A bad call fails with a clear message, and the handler's `args` parameter is fully typed.

```
Invalid arguments for "messages:send":
  - args.body is required (expected v.string())
```

Use `args: {}` for functions that take no arguments. `onebase doctor` warns about functions without `args`, since they accept any input. You can also declare `returns: v.array(...)` to check what a function returns.

## Errors

`throw new ConvexError("message")`, or `new ConvexError({ code: "LIMIT", max: 5 })`, for errors the caller should see. The client receives the message and the `data`.

Any other error appears as `Server Error` to clients in production; the full message is logged on the server. In `onebase dev` every message is shown.

## Time limits

A query or mutation may run for 10 seconds, and an action (including an HTTP action) for 10 minutes. A call that runs longer fails with `notes:list didn't finish within the query time limit (10s).` A mutation's writes are rolled back.

JavaScript can't stop a function in the middle of an `await`, so the function itself keeps running until it next yields. Anything it then tries fails with the same error, so it can't read or write any more, call other functions, or schedule them. Code that never yields, such as `while (true) {}`, can't be stopped this way and blocks the whole server.

The limit counts from when the call gets its database snapshot (a query) or the write lock (a mutation), not from when it was queued. A mutation called from a mutation shares its caller's limit; one called from an action gets its own.

Change the limits with `ONEBASE_QUERY_TIMEOUT`, `ONEBASE_MUTATION_TIMEOUT` and `ONEBASE_ACTION_TIMEOUT`, e.g. `30s`, `2m`, or `off`. Keep mutations short: while one runs, every other write waits for it.

## The context object

| | query | mutation | action |
|---|:-:|:-:|:-:|
| `ctx.db` | read | read + write | – |
| `ctx.auth.getUserIdentity()` | ✓ | ✓ | ✓ |
| `ctx.storage` | read | + upload, delete | + store, get |
| `ctx.scheduler` | – | ✓ (transactional) | ✓ |
| `ctx.runQuery` | – | ✓ | ✓ |
| `ctx.runMutation` | – | ✓ | ✓ |
| `ctx.runAction` | – | – | ✓ |
