# onebase examples

Each folder is a self-contained app with its own `onebase/` functions folder and (mostly) a `public/index.html` frontend. Run one with:

```bash
cd examples/<name>
bun ../../src/cli.ts dev
```

Every example passes `bun ../../src/cli.ts doctor`; CI runs that check for all of them.

| Example | What it shows |
|---|---|
| [`chat`](./chat) | The flagship: schema with indexes, live queries, optimistic likes, full-text search, pagination, image uploads, self-destructing messages, a cron, the rate limiter and aggregate components, and an HTTP webhook |
| [`notes-auth`](./notes-auth) | Built-in password sign-in, per-user data, protected queries, user-scoped search, pagination |
| [`counters`](./counters) | Components: `aggregate` ranks a live poll, `shardedCounter` totals votes, `rateLimiter` paces them |
| [`vector-search`](./vector-search) | `vectorIndex` + `ctx.vectorSearch` for "find similar items", with filters and locally computed embeddings |
| [`jobs`](./jobs) | The work-queue component with retries and completion callbacks, the scheduler, cron jobs, HTTP routes |
| [`offline-todo`](./offline-todo) | The client's offline mode: cached results, optimistic updates, mutations queued while disconnected and replayed on reconnect |

Starting from scratch instead? The [docs](../docs/getting-started.md) walk through creating a project with `onebase dev`.
