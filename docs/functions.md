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
