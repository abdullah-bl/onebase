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

## Migrations

```ts
// Convex
export const migrations = new Migrations(components.migrations);
export const renameAuthor = migrations.define({
  table: "messages",
  mutateOne: async (ctx, doc) => { await ctx.db.patch(doc._id, { authorName: doc.author }); },
});
export const migrate = migrations.migrate(renameAuthor);
// progress: migrations.status(ctx, renameAuthor)
```

```ts
// onebase: components.ts
import { migrations } from "onebase/components/migrations";
migrations: migrations(),

// onebase/backfill.ts — the runner is a plain export, created by defineMigration
import { defineMigration } from "onebase/components/migrations";
export const renameAuthor = defineMigration({
  table: "messages",
  mutateOne: async (ctx, doc) => { await ctx.db.patch(doc._id, { authorName: doc.author }); },
});

// wherever you start it (a mutation, the dashboard, a cron)
await ctx.components.migrations.migrate({ name: "rename-author", runner: internal.backfill.renameAuthor });
// progress: ctx.components.migrations.status({ name: "rename-author" }), cancel({ name }), list()
```

- **Names are yours:** pass a `name` to `migrate()` instead of deriving one from the function.
- **Force:** running the same name with a different runner is refused; `force: true` starts over. Convex's `errorOnComplete` and `startBatch`/`lastCompletedBatch` have no equivalent — resume is automatic.
- `mutateOne` stays idempotent: a failed batch rolls back and re-runs from its start on resume.

## Workflow

```ts
// Convex
const workflow = new WorkflowClient(components.workflow, { workpool });
export const onboarding = workflow.define({
  args: { userId: v.id("users") },
  handler: async (step, { userId }) => {
    await step.runMutation(internal.emails.welcome, { userId });
    await step.sleep(3 * DAY);
    await step.runAction(internal.reports.generate, { userId });
  },
});
const id = await workflow.start(ctx, onboarding, { userId });
```

```ts
// onebase: components.ts
import { workflow } from "onebase/components/workflow";
jobs: workflow(),

// onebase/flows.ts
import { defineWorkflow } from "onebase/components/workflow";
export const onboarding = defineWorkflow({
  run: async (step, args: { userId: string }) => {
    await step.runMutation(internal.emails.welcome, { userId: args.userId });
    await step.sleep(3 * 24 * 60 * 60 * 1000);
    await step.runAction(internal.reports.generate, { userId: args.userId });
  },
});

// start (validate userId in your own wrapper; args pass through as JSON)
const id = await ctx.components.jobs.start({ fn: internal.flows.onboarding, args: { userId } });
// status({ id }) with per-step states, cancel({ id }), list({ status, paginationOpts })
```

- **No workpool:** the component schedules its own actions; don't mount one.
- **No args validator:** `start`'s args pass through unchecked — validate in your wrapper (Convex checked them at `define`).
- `step.runQuery/runMutation/runAction/sleep` are the same; per-step `retry: { maxAttempts, initialBackoffMs }` replaces the workpool's retry policy; `logLevel`, `onComplete` and `newWorkflowId` have no equivalent.
- Running workflows don't migrate: let them finish (or cancel) before switching.

## RAG

```ts
// Convex
const rag = new Rag(components.rag, { textEmbeddingModel: embeddingModel, dimensions: 1536 });
const { entryId } = await rag.add(ctx, namespace, { key, title, metadata }, chunkedText);
const results = await rag.search(ctx, namespace, { query, limit: 5, filter });
```

```ts
// onebase: components.ts
import { rag } from "onebase/components/rag";
docs: rag({ dimensions: 1536, chunking: { maxChars: 1000, overlap: 100 } }),

// once, from a mutation — the embedder is one of your actions:
await ctx.components.docs.setEmbedder({ embed: internal.ai.embed }); // ({ texts }) => number[][]

// call sites
const { entryId } = await ctx.components.docs.add({ namespace, key, title, metadata, text });
const results = await ctx.components.docs.search({ namespace, query, limit: 5, mode: "hybrid" }); // an action
// replace / delete / list / status round it out
```

- **The embedder is registered, not mounted:** onebase components call your functions only through handles the app created, so the reference is handed over once with `setEmbedder` and stored as a handle.
- **Filtering:** `namespace` scoping works like Convex's; metadata filters inside `search` aren't supported yet.
- Results are per chunk (`{ entryId, text, score, title, metadata }`); `mode` picks vector (default), text or hybrid search.
- Entries re-embed from scratch: Convex's stored chunks don't come across.

## Agent

```ts
// Convex
export const agent = new Agent(components.agent, { textEmbeddingModel, chat: openai.chat("gpt-4o"), instructions });
const { threadId, messageId } = await agent.continueThread(ctx, { threadId }, prompt); // or createThread + generateText
const tools = { weather: tool({ args: v.object({ city: v.string() }), handler: ... }) };
```

```ts
// onebase: components.ts
import { agent } from "onebase/components/agent";
bot: agent({ instructions, maxSteps: 10, embeddingDimensions: 1536 }),

// once, from a mutation:
await ctx.components.bot.setChat({ chat: internal.ai.chat }); // ({ messages, tools, instructions }) => { text } or { toolCalls, usage }
await ctx.components.bot.setEmbedder({ embed: internal.ai.embed });

// in an action
const { threadId } = await ctx.components.bot.createThread({ userId });
const { text } = await ctx.components.bot.generateText({ threadId, prompt, tools: [{ name: "weather", kind: "mutation", fn: internal.tools.weather, description }] });
const hits = await ctx.components.bot.searchMessages({ threadId, query });
```

- **The model call moves into your action** (`setChat`), exactly where Convex's AI-SDK call lived in your code — same provider setup, one registration.
- `createThread`/`generateText` replace `generateText`/`continueThread` (pass `threadId` yourself); `listMessages` is a live query; usage is stored per message.
- Streaming: persist deltas through `createStream`/`addDelta`/`finishStream` from your own streaming action; clients follow with `getStreamChunks` — no separate `persistent-text-streaming` mount (onebase components can't nest).

## Presence

```ts
// Convex
const presence = new Presence(components.presence);
await presence.ping(ctx, roomId, userId, sessionId, heartbeatInterval);
const room = await presence.listRoom(ctx, roomId);
```

```ts
// onebase: components.ts
import { presence } from "onebase/components/presence";
here: presence({ heartbeatInterval: 10_000, expose: ["heartbeat", "list"] }),

// client-side (exposed) or through your own functions
api.components.here.heartbeat({ room: roomId, user: userId, sessionId });
useQuery(api.components.here.list, { room: roomId }); // was listRoom
await ctx.components.here.disconnect({ sessionId }); // was disconnect
```

`formatRoom`/`listRoom`'s shape becomes `list`'s array of `{ id, user, online, lastActive }`; sessions go offline on their own when heartbeats stop.

## Action cache

```ts
// Convex
const cache = new ActionCache(components.cache, { ttl: 60_000 });
const slowThing = cache.wrap(internal.ai.slowThing, (args) => args.query);
```

```ts
// onebase: components.ts
import { actionCache } from "onebase/components/action-cache";
cache: actionCache({ ttl: 60_000 }),

// onebase/reports.ts
import { cached } from "onebase/components/action-cache";
const slowThing = cached("cache", internal.ai.slowThing, (args) => args.query);
// in an action: await slowThing(ctx, { query })
// invalidate: ctx.components.cache.invalidate({ key }) or ({ prefix })
```

`cached` takes the mount name where Convex's wrapper took the component client. Dedupe of concurrent runs is best-effort here; don't cache anything with side effects.

## What needs no component

- **`@convex-dev/crons`:** onebase has native cron jobs (`crons.ts`, `Crons.interval/cron/...`) and component crons; migrate the schedules and delete the component.
- **`@convex-dev/batch-worker` and `@convex-dev/action-retrier`:** the work queue covers both (batched background work and retries with backoff).
- **`@convex-dev/resend`, stripe, twilio, expo-push-notifications, polar:** no built-in yet. Keep the calls in your own actions and queue them through the work queue until a port exists.
