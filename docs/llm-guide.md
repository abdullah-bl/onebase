---
title: LLM guide
description: A compact, complete guide to give an AI assistant that writes onebase code.
---

# Writing onebase functions

A short, complete guide for writing a onebase backend. Give it to an LLM (e.g. copy it into your app's `AGENTS.md`). The API follows Convex, so Convex knowledge applies, with the differences listed at the end.

## Files

```
onebase/
  schema.ts          tables, fields, indexes
  <module>.ts        queries, mutations, actions (file name = module name)
  http.ts            optional HTTP routes (webhooks)
  crons.ts           optional scheduled jobs
  auth.config.ts     optional auth providers
  _generated/        written by `onebase codegen` / `onebase dev`; never edit
```

Imports: builders come from `./_generated/server`, validators from `onebase/values`, and `defineSchema`/`defineTable`/`paginationOptsValidator`/`httpRouter`/`cronJobs` from `onebase/server`.

## Schema

```ts
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  users: defineTable({ name: v.string(), email: v.string() }).index("by_email", ["email"]),
  posts: defineTable({
    author: v.id("users"),
    title: v.string(),
    tags: v.array(v.string()),
    published: v.boolean(),
    views: v.optional(v.number()),
  }).index("by_author", ["author"]),
});
```

Validators: `v.string() v.number() v.boolean() v.null() v.id("table") v.array(x) v.object({...}) v.record(v.string(), x) v.union(a, b) v.literal("x") v.optional(x) v.any()`.
Every document gets `_id` and `_creationTime` automatically. Don't declare them, and don't pass them to `insert`.
Store dates as numbers (`Date.now()`), not `Date` objects.

## Queries (read-only, live on the client)

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

- `ctx.db.get(id)` returns the document or `null`.
- `ctx.db.query(table)`, then optionally `.withIndex(name, q => q.eq(...).gt(...))`, `.order("asc" | "desc")`, `.filter(...)`. End with `.collect()`, `.take(n)`, `.first()`, `.unique()` or `.paginate(opts)`.
- `.filter` takes `q => q.eq(q.field("published"), true)` **or** the shorthand `{ published: true }`. It does **not** take a document callback. For arbitrary JS logic, use `(await query.collect()).filter(doc => ...)`.
- You don't have to use `withIndex`: if an index exists for the fields you filter on, it is used automatically. In dev mode a warning tells you when a filter scans the whole table, and which index to add.
- In `withIndex`, call `.eq()` on index fields in order, then at most one lower bound (`gt`/`gte`) and one upper bound (`lt`/`lte`) on the next field.
- Full-text search: declare `.searchIndex("search_title", { searchField: "title", filterFields: ["author"] })` on the table, then `ctx.db.query("posts").withSearchIndex("search_title", (q) => q.search("title", text).eq("author", author)).take(10)`. Results are best match first (no `.order()`), at most 1024; any word matches and the last word also matches as a prefix.
- Vector search: declare `.vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 1536, filterFields: ["cuisine"] })` with `embedding: v.optional(v.array(v.float64()))`, then in an **action**: `await ctx.vectorSearch("foods", "by_embedding", { vector, limit: 16, filter: (q) => q.eq("cuisine", c) })`. It returns `[{ _id, _score }]` (cosine similarity, most similar first; limit 1–256, default 10); load the documents with `ctx.runQuery`. Writing a vector of the wrong length fails the mutation.

## Mutations (transactional writes)

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

- `insert(table, doc)` returns the id. `patch(id, fields)` does a shallow merge (a field set to `undefined` is removed). `replace(id, doc)` swaps the whole document. `delete(id)` removes it.
- A mutation is all-or-nothing: if it throws, none of its writes happen.
- `throw new ConvexError("message")` for errors the user should see. Other errors show as "Server Error" in production.
- `ctx.runQuery` and `ctx.runMutation` run inside the same transaction. `ctx.scheduler.runAfter(ms, internal.x.y, args)` schedules work that only happens if the mutation commits.

## Actions (side effects: fetch, npm packages, AI calls)

```ts
import { v } from "onebase/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";

export const summarize = action({
  args: { id: v.id("posts") },
  handler: async (ctx, { id }) => {
    const post = await ctx.runQuery(internal.posts.get, { id });
    const res = await fetch("https://api.example.com/summarize", { method: "POST", body: post!.title });
    await ctx.runMutation(internal.posts.setSummary, { id, summary: await res.text() });
  },
});
```

Actions have no `ctx.db`: read through `ctx.runQuery` and write through `ctx.runMutation`. Any npm package or `node:*` module works in every kind of function, so no `"use node"` is needed. Only actions may call `fetch()`; in a query or mutation it throws.

## Internal functions, scheduling, pagination, HTTP

- `internalQuery` / `internalMutation` / `internalAction` can't be called by clients; reference them as `internal.module.fn`.
- Scheduling: `ctx.scheduler.runAfter(delayMs, ref, args)`, `ctx.scheduler.runAt(timestamp, ref, args)` and `ctx.scheduler.cancel(id)`. Jobs survive restarts.
- Pagination: take `args: { paginationOpts: paginationOptsValidator }` and return `.paginate(paginationOpts)`. On the client, use `usePaginatedQuery(api.x.y, args, { initialNumItems: 20 })`.
- HTTP routes: in `http.ts`, `const http = httpRouter(); http.route({ path, method, handler: httpAction(async (ctx, req) => Response) }); export default http;`.

## Cron jobs

```ts
// onebase/crons.ts
import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("sync feeds", { minutes: 15 }, internal.feeds.sync);
crons.daily("prune", { hourUTC: 3, minuteUTC: 0 }, internal.messages.prune, { days: 30 });
crons.weekly("digest", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.email.digest);
crons.cron("workday mornings", "30 9 * * mon-fri", internal.reports.daily); // standard cron syntax
export default crons;
```

- All times are in UTC.
- A run that was missed while the server was down happens once on startup.
- A job that is still running when it comes due again is skipped.

## File storage

```ts
export const generateUploadUrl = mutation({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl() });
export const save = mutation({
  args: { image: v.id("_storage") },
  handler: (ctx, { image }) => ctx.db.insert("photos", { image }),
});
// When reading: imageUrl: await ctx.storage.getUrl(photo.image)
```

On the client:
1. Get a URL: `const url = await client.mutation(api.x.generateUploadUrl)`.
2. Upload: `fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file })`, which returns `{ storageId }`.
3. Save `storageId` in a document.

Store references as `v.id("_storage")`. The storage functions:
- `ctx.storage.getUrl(id)` and `getMetadata(id)` work everywhere.
- `generateUploadUrl()` and `delete(id)` work in mutations and actions. A delete in a mutation that fails is rolled back.
- `store(blob)` and `get(id)` work in actions.

Files are kept in `<data>/files`, or in S3 with `--files s3://bucket/prefix`. Set `--url https://your.domain` so file URLs use your public address.

## Auth

Built-in sign-in (like Convex Auth): spread `authTables` into the schema and list methods in `auth.config.ts`.

```ts
// onebase/schema.ts
import { authTables, defineSchema } from "onebase/server";
export default defineSchema({ ...authTables, /* your tables */ });

// onebase/auth.config.ts
import { github, google, password } from "onebase/auth";
export default {
  methods: [password(), github(), google()], // OAuth credentials from $AUTH_GITHUB_ID / $AUTH_GITHUB_SECRET etc.
  redirects: ["https://app.example.com"],    // where OAuth may return to, besides --url and --cors origins
};
```

- Client: `signIn("password", { flow: "signUp" | "signIn", email, password })`, `signIn("github")`, `signOut()`. React: `useAuthActions()`, `useOnebaseAuth()` (`{ isLoading, isAuthenticated }`), `<Authenticated>`, `<Unauthenticated>`, `<AuthLoading>`.
- Functions: `const userId = await getAuthUserId(ctx)` (from `onebase/server`) returns `Id<"users"> | null`. Users are normal documents in `users`.
- Password reset and email verification: `password({ sendCode: async ({ email, code, purpose }) => { /* email it */ }, verifyEmail: true })`. Flows: `"reset"` (email) → `"reset-verification"` (email, code, newPassword); with verifyEmail, `signUp` resolves `{ signingIn: false }` and `"email-verification"` (email, code) signs in.

External providers use the Convex format, and `authenticate` checks any other token with read access to the database:

```ts
export default {
  providers: [{ domain: "https://your-app.clerk.accounts.dev", applicationID: "onebase" }],
  authenticate: async (token, ctx) => {
    const key = await ctx.db.query("apiKeys").withIndex("by_key", (q) => q.eq("key", token)).unique();
    return key ? { subject: key.owner, tokenIdentifier: `apikey|${key._id}` } : null;
  },
};
```

With providers, the client calls `client.setAuth(async () => await getToken())`. In functions, `await ctx.auth.getUserIdentity()` returns `{ subject, tokenIdentifier, email, name, ... }` or `null`.

## Client

```ts
import { OnebaseClient } from "onebase/browser";               // or a React app:
import { OnebaseProvider, useQuery, useMutation } from "onebase/react";
import { api } from "../onebase/_generated/api";

const client = new OnebaseClient("http://localhost:8090");
client.onUpdate(api.posts.byAuthor, { author }, (posts) => render(posts));
await client.mutation(api.posts.publish, { id });
```

`useQuery` returns `undefined` while loading. Pass `"skip"` as the args to not subscribe.

Optimistic updates show a mutation's effect before the server replies, and are replaced by the real result when it arrives:

```ts
const like = useMutation(api.posts.like).withOptimisticUpdate((store, { id }) => {
  const posts = store.getQuery(api.posts.list, {});
  if (posts) store.setQuery(api.posts.list, {}, posts.map((p) => (p._id === id ? { ...p, likes: p.likes + 1 } : p)));
});
```

## Components

Mount packages with their own tables in `onebase/components.ts`, then call them from functions:

```ts
// onebase/components.ts (import types only from ./_generated/dataModel here)
import { defineComponents } from "onebase/components";
import { rateLimiter, MINUTE } from "onebase/components/rate-limiter";
export default defineComponents({
  limiter: rateLimiter({ rates: { send: { kind: "token bucket", rate: 10, period: MINUTE } } }),
});

// in a mutation
await ctx.components.limiter.limit({ name: "send", key: userId, throws: true });
```

- Queries call component queries; mutations call queries and mutations in the same transaction; actions call anything.
- Your `ctx.db` can't see component tables (stored as `limiter.rateLimits`), and components can't see yours. Pass ids as strings.
- Clients can't call components directly: wrap them in your own query or mutation.
- Components get `ctx.auth` only when mounted with `auth: true`.
- Counts, sums and ranks over a table: mount `aggregate({ table: "scores", sortKey: (d: Doc<"scores">) => d.points })` from `onebase/components/aggregate` (it follows the table by itself), then `ctx.components.leaderboard.count()`, `.sum()`, `.indexOf({ key, order: "desc" })`, `.at({ index })`. Don't count with `.collect().length` on large tables.

## Differences from Convex

- Functions run in Bun, on SQLite by default, or on Postgres, MySQL or Turso with `--db`. Any npm package works anywhere, and there is no `"use node"`.
- Mutations run one at a time; reads use a consistent snapshot.
- `.filter` also accepts an object shorthand, and indexes are picked automatically for filters.
- `auth.config.ts` can also export a custom `authenticate(token)`.
- Components are mounted with `defineComponents` in `components.ts` and called as `ctx.components.x.fn(args)`, not through `convex.config.ts` and `ctx.runMutation(components.x.lib.fn)`.
- Not supported yet: `ctx.db.system`.

Run `onebase doctor` after changes: it checks the schema, indexes, imports and common mistakes, and prints the fix for each.
