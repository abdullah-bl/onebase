---
title: Components
description: Mount reusable backend packages with their own tables and functions, and call them as ctx.components.<name>.<fn>().
---

# Components

A component is a package of backend code with its own tables and functions: a rate limiter, a counter, a work queue. You mount it in `onebase/components.ts` and call it from your functions as `ctx.components.<name>.<function>(args)`. Its data lives in the same database as yours, in tables only it can read or write.

Convex has components too. onebase's are used differently:

| | Convex | onebase |
|---|---|---|
| Install | `convex.config.ts` with `defineApp().use(...)`, then `npx convex dev` to generate code | `defineComponents({...})` in `components.ts`; types come straight from the package, with no extra codegen |
| Call | `ctx.runMutation(components.limiter.lib.limit, args)`, usually through a wrapper class | `ctx.components.limiter.limit(args)`, typed from what you mounted |
| Caller's identity | Never visible to components | Visible when you mount with `auth: true` |
| Configuration | Passed on every call or to a wrapper class | Given once, when mounting |
| Following a table | You add triggers to every write yourself | Table hooks: the component gets every change, in the same transaction |
| Calling from clients | Re-export each function from your own module | `expose: ["fn"]` when mounting |

## Mount a component

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { rateLimiter, MINUTE } from "onebase/components/rate-limiter";

export default defineComponents({
  limiter: rateLimiter({
    rates: { sendMessage: { kind: "token bucket", rate: 10, period: MINUTE } },
  }),
});
```

The key (`limiter`) is the mount name: letters, digits and `_`, starting with a letter. On the next start, or `onebase dev` restart, onebase creates the component's tables and indexes, and `_generated/server.ts` types `ctx.components`.

## Call it

```ts
// onebase/messages.ts
export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const userId = await getAuthUserId(ctx);
    await ctx.components.limiter.limit({ name: "sendMessage", key: userId!, throws: true });
    await ctx.db.insert("messages", { body, author: userId! });
  },
});
```

Calls follow the usual rules for the kind of function making them:

- **Queries** can call a component's queries. What the component reads is tracked like your own reads, so a live query that calls one re-runs when that component's data changes, and only then.
- **Mutations** can call its queries and mutations, in the same transaction. If the component's mutation throws and you catch the error, only the component's writes are rolled back; yours stay. If you don't catch it, the whole mutation is rolled back, as usual.
- **Actions** can call anything; each call is its own transaction, as with `ctx.runMutation`.

Arguments and return values are checked against the component's validators. Errors name the function, such as `components/limiter:limit`.

## Isolation

Each mount has its own tables. They are stored as `<mount>.<table>` (for example `limiter.rateLimits`) next to your tables, so backups, dashboards and database switches cover them too.

- Your functions can't read or write a component's tables, and a component can't read or write yours: `ctx.db.get()` returns null for the other side's ids, and `patch`, `replace` and `delete` refuse them.
- Ids cross the boundary as plain strings. Pass a component your document ids; it stores them as `v.string()`.
- Components can't call your functions or each other's, except through [function handles](#function-handles) you give them.
- Clients can't call component functions directly unless you [expose](#expose-functions-to-clients) them. Otherwise write your own query or mutation that calls the component, checking whatever your app needs first.

Isolation keeps components' data apart. It isn't a sandbox: components are npm packages running in your process, so install ones you trust.

## Table hooks

A component can follow one of your tables. The [aggregate](./aggregate.md) does: mounted with `table: "scores"`, it gets every insert, patch, replace and delete on `scores`, from any mutation, dashboard edits and sign-ups included.

- **Same transaction:** the component gets the changes in the transaction that wrote them, before the transaction commits. If it fails, the write fails with it.
- **Up to date:** if your mutation calls the component after writing, the component already has those writes.
- **One change per document:** several writes to one document in a transaction arrive as one change. A document inserted and deleted in the same transaction never reaches the component.
- **Existing documents:** documents written before the component was mounted are fed to it in the background, 200 per transaction. The component reports when it has caught up (the aggregate's `status()`).

## Expose functions to clients

To let browsers call some of a component's functions directly, list them when mounting:

```ts
presence: presence({ auth: true, expose: ["heartbeat", "list"] }),
```

Clients then call `api.components.presence.heartbeat` like any of your functions: `useQuery(api.components.presence.list, { room })`. `_generated/api.ts` has `api.components` for exposed functions only, and `internal.components` for all of a component's public functions, which you can schedule or run from crons. Nested functions are exposed by their dotted path: `expose: ["lib.list"]`.

Expose only what's safe for anyone to call with any arguments. A rate limiter's `reset`, for one, isn't.

## Function handles

`createFunctionHandle(ref)` (from `onebase/server`) turns a reference to one of your functions into a string the component can keep and call later:

```ts
await ctx.components.queue.enqueue({ fn: await createFunctionHandle(internal.emails.send), args: { to } });
```

When you pass a function reference itself in a component call's arguments (`{ fn: internal.emails.send }`), onebase converts it to a handle for you. The component calls the handle with `ctx.runMutation(handle, args)` (or `runQuery`, `runAction`), or schedules it with `ctx.scheduler.runAfter`.

Handles are signed with a key kept in the database. One can't be made up by hand, so a client can't pass an exposed component a handle to a function you never handed out. A handle keeps working after restarts and on every instance. Clients can't call handles; only server code can.

## Crons and HTTP routes

Components can declare cron jobs and HTTP routes; they run for every mount.

- **Cron jobs** are named `components/<mount>/<name>` and show up with yours in the dashboard.
- **HTTP routes** are served under the mount's prefix: `/<mount>` by default, so a component mounted as `stripe` with a `/webhook` route answers at `/stripe/webhook`. Change it with `httpPrefix: "/payments"`, or turn the routes off with `httpPrefix: false`. Routes in your own `http.ts` take precedence, so you can always override one.
- **Identity:** route handlers see the caller's identity only when the component is mounted with `auth: true`.

## The caller's identity

By default a component's `ctx.auth.getUserIdentity()` returns null. The app checks who the caller is and passes the component what it needs, such as a user id as a `key`. To let a component see the identity itself, mount it with `auth: true`:

```ts
presence: presence({ auth: true }),
```

## The same component twice

Mount it under two names and each copy gets its own tables and configuration:

```ts
export default defineComponents({
  apiLimiter: rateLimiter({ rates: { call: { kind: "fixed window", rate: 1000, period: HOUR } } }),
  loginLimiter: rateLimiter({ rates: { attempt: { kind: "token bucket", rate: 5, period: MINUTE } } }),
});
```

## Removing a component

Delete it from `components.ts`. Its indexes are dropped and its documents are kept: startup warns which tables still hold data. Mount it again under the same name to use them, or delete them from the dashboard's Data page, where the component's tables are listed under its name.

Renaming a mount is like removing one and adding another: the new name starts with empty tables.

## Components that ship with onebase

| Component | Import | |
|---|---|---|
| [Rate limiter](./rate-limiter.md) | `onebase/components/rate-limiter` | Token bucket and fixed window limits per key, stored in the database |
| [Aggregate](./aggregate.md) | `onebase/components/aggregate` | Counts, sums, ranks and the n-th item over a table in O(log n), kept in step with it |
| [Sharded counter](./sharded-counter.md) | `onebase/components/sharded-counter` | Counters that many writers can bump at once |
| [Work queue](./work-queue.md) | `onebase/components/work-queue` | Background actions and mutations with limited parallelism, retries and completion callbacks |
| [Migrations](./migrations.md) | `onebase/components/migrations` | Batched data migrations with progress tracking that keep going across restarts |

To write your own, see [Writing components](./components-authoring.md).

## Notes

- `components.ts` is a reserved file name, and so is a `components/` folder of functions while it exists.
- `components.ts` may import types from `./_generated/dataModel` (to type a configuration callback, say), but not from `./_generated/server` or `./_generated/api`: those are typed from `components.ts`, so the import would be circular. `onebase doctor` reports it.
- On MySQL, which can't index JSON values, a component's queries read all of that component's documents. That's fine for a few thousand; for more, use SQLite or Postgres.
