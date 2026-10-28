# Convex components → onebase built-ins

Each section shows the Convex usage, then its onebase replacement. All built-ins are mounted the same way, in `components.ts` next to `schema.ts`:

```ts
// onebase/components.ts (import only types from ./_generated/dataModel here)
import { defineComponents } from "onebase/components";
export default defineComponents({ /* mounts */ });
```

Then delete `convex.config.ts`'s `app.use(...)` for that component and the `new X(components.x, ...)` client object. Call sites use `ctx.components.<mount>` instead of passing `ctx` to a client.

## Rate limiter

```ts
// Convex
const rateLimiter = new RateLimiter(components.rateLimiter, {
  sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 },
});
await rateLimiter.limit(ctx, "sendMessage", { key: userId, throws: true });
const { ok, retryAfter } = await rateLimiter.check(ctx, "sendMessage", { key: userId });
await rateLimiter.reset(ctx, "sendMessage", { key: userId });
```

```ts
// onebase: components.ts
import { rateLimiter, MINUTE } from "onebase/components/rate-limiter";
limiter: rateLimiter({ rates: { sendMessage: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 } } }),

// call sites
await ctx.components.limiter.limit({ name: "sendMessage", key: userId, throws: true });
const { ok, retryAfter } = await ctx.components.limiter.check({ name: "sendMessage", key: userId });
await ctx.components.limiter.reset({ name: "sendMessage", key: userId });
```

| | |
|---|---|
| Same | Config fields (`kind`, `rate`, `period`, `capacity`, `maxReserved`, `shards`, `start`), the options `key`, `count`, `reserve`, `throws` and an inline `config`, the `{ ok, retryAfter }` result, `isRateLimitError` (import it from `onebase/components/rate-limiter`), and the thrown `ConvexError` data `{ kind: "RateLimited", name, retryAfter }`. |
| `WEEK` | Not exported: use `7 * DAY`. |
| `getValue(ctx, name, opts)` | `ctx.components.limiter.getValue({ name, key })`, which returns `{ value, ts }` only. |
| `hookAPI` / `useRateLimit` (React) | No equivalent. Write a query that calls `check()` and use it with `useQuery`. |

## Aggregate

```ts
// Convex
const byScore = new TableAggregate<{ Key: number; DataModel: DataModel; TableName: "scores" }>(components.byScore, {
  sortKey: (doc) => doc.points,
  sumValue: (doc) => doc.points,
});
// Kept in sync by hand or with triggers:
triggers.register("scores", byScore.trigger());
// reads
await byScore.count(ctx, { bounds });
await byScore.indexOf(ctx, points, { order: "desc" });
await byScore.at(ctx, offset);
```

```ts
// onebase: components.ts
import { aggregate } from "onebase/components/aggregate";
import type { Doc } from "./_generated/dataModel";
byScore: aggregate({ table: "scores", sortKey: (d: Doc<"scores">) => d.points, sumValue: (d) => d.points }),

// reads
await ctx.components.byScore.count({ bounds });
await ctx.components.byScore.indexOf({ key: points, order: "desc" });
await ctx.components.byScore.at({ index: offset });
```

- **Writes:** delete every write to the aggregate, because onebase's aggregate follows its table through a table hook. That means `byScore.insert`, `delete`, `replace`, `insertIfDoesNotExist` and `replaceOrInsert` calls, `triggers.register(...)`, and the `Triggers` / `customMutation` wrapper if it only existed for this.
- **Backfill:** delete the migration that backfilled existing documents too. onebase backfills by itself, and `status()` says when it's done.
- **Options:** `sortKey`, `sumValue` and `namespace` are the same. To leave documents out, use `filter: (d) => boolean`.
- **Reads:** `count`, `sum`, `min`, `max`, `indexOf` (with `id` and `order`) and `bounds: { lower, upper }` are the same, with `namespace` passed in the same object. Items' `id` is typed as `string`, so cast it to load the document: `ctx.db.get(item.id as Id<"scores">)`.
  - `at(ctx, offset, opts)` becomes `at({ index, order, namespace })`, which returns `{ key, id, sumValue }` or null. If the code passes a negative offset, use `order: "desc"` with `index: -offset - 1`.
  - `paginate(ctx, { pageSize, cursor, order, bounds })` becomes `paginate({ numItems, cursor, order, bounds })`, which returns `{ page, isDone, continueCursor }`.
  - `bounds: { prefix: [...] }` isn't supported. Express it as `lower` / `upper` on the array key.
- **Not available:**
  - `random()`: use `at({ index: Math.floor(Math.random() * count) })`.
  - batch reads such as `countBatch` and `atBatch`: call once per item.
  - the `stale` option and `iter`.
- **DirectAggregate** (no table) becomes `aggregate<KeyType>()` with no `table`, plus `insert({ key, id, sumValue, namespace })`, `delete({ key, id })`, `replace({ from, to })` and `clear()`. For `insertIfDoesNotExist` and `deleteIfExists`, use `delete` (it returns false when the item is missing), then `insert`.

## Sharded counter

```ts
// Convex
const counter = new ShardedCounter(components.shardedCounter, { shards: { beans: 10 }, defaultShards: 8 });
await counter.add(ctx, "beans", 5);
await counter.subtract(ctx, "beans", 2);
const n = await counter.count(ctx, "beans");
```

```ts
// onebase: components.ts
import { shardedCounter } from "onebase/components/sharded-counter";
counter: shardedCounter({ shards: 8, perName: { beans: 10 } }),

// call sites
await ctx.components.counter.add({ name: "beans", count: 5 });
await ctx.components.counter.add({ name: "beans", count: -2 });
const n = await ctx.components.counter.count({ name: "beans" });
```

| | |
|---|---|
| `inc`, `dec`, `reset`, `count` | `({ name })` |
| `estimateCount(ctx, name, readFromShards)` | `estimateCount({ name, readShards })` |
| `counter.for("beans")` | Call with `{ name: "beans" }` directly. |
| `rebalance` | Not needed: remove it. |
| `counter.trigger(name)` (counting a table's documents) | Use an `aggregate({ table })` and `count()`, which stays exact without triggers. |

## Workpool → work queue

```ts
// Convex
const pool = new Workpool(components.emailWorkpool, {
  maxParallelism: 10,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 },
});
const workId = await pool.enqueueAction(ctx, internal.emails.send, { to }, {
  onComplete: internal.emails.sent,
  context: { userId },
  runAfter: 5000,
});
export const sent = internalMutation({
  args: vOnCompleteArgs(v.object({ userId: v.id("users") })),
  handler: async (ctx, { workId, context, result }) => { /* ... */ },
});
```

```ts
// onebase: components.ts
import { workQueue } from "onebase/components/work-queue";
emailWorkpool: workQueue({ maxParallelism: 10, retry: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 } }),

// call site
const id = await ctx.components.emailWorkpool.enqueueAction({
  fn: internal.emails.send,
  args: { to },
  onComplete: internal.emails.sent,
  context: { userId },
  delayMs: 5000,
});

// onComplete
import { onCompleteValidator } from "onebase/components/work-queue";
export const sent = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, { id, context, result }) => { /* ... */ },
});

// or, with the context checked and typed like vOnCompleteArgs(v.object(...)):
import { onCompleteArgs } from "onebase/components/work-queue";
export const sent = internalMutation({
  args: onCompleteArgs(v.object({ userId: v.id("users") })),
  handler: async (ctx, { id, context, result }) => { /* context.userId is an Id<"users"> */ },
});
```

- **Retries:** onebase's `retry` applies to every item in the queue, mutations included, unless an item sets its own `retry`. To copy `retryActionsByDefault: false`, leave `retry` off the queue and pass `retry` on the enqueue calls that should retry. Per item, `retry: true` becomes the queue's `retry` object, and `retry: false` becomes `retry: { maxAttempts: 1 }`.
- **Timing:** `runAfter` becomes `delayMs`; `runAt` is the same.
- **onComplete:** the arguments are `{ id, context, result }`; rename `workId` to `id`. `result` has the same `kind`s: `success` with `returnValue`, `failed` with `error`, and `canceled`.
  - `vOnCompleteArgs(contextValidator)` becomes `onCompleteArgs(contextValidator)`, which validates and types the context the same way. `vOnCompleteArgs()` with no validator becomes `onCompleteValidator`.
  - `pool.defineOnComplete({ context, handler })` becomes `internalMutation({ args: onCompleteArgs(context), handler })`.
- **`status(ctx, id)`** becomes `status({ id })`. Its `state` is `pending`, `running`, `succeeded`, `failed` or `canceled` where Convex had `pending`, `running` or `finished`, and `attempts` replaces `previousAttempts`.
- **`cancel(ctx, id)`** becomes `cancel({ id })`.
- **Not available:** `enqueueQuery` (wrap the query in a mutation), the `*Batch` functions (loop), `cancelAll` (`list({ state: "pending" })`, then cancel each), `onCompleteExcludeKinds` (check `result.kind` in the handler), `logLevel` and `name`.
