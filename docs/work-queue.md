---
title: Work queue
description: Run background actions and mutations with a limit on how many run at once, retries with backoff, and a callback when each finishes.
---

# Work queue

`ctx.scheduler.runAfter(0, ...)` starts work right away, all of it at once. The work queue component runs it at a pace you set instead:

- **Parallelism:** at most `maxParallelism` items run at the same time, so a burst of 10,000 emails doesn't open 10,000 connections or hit an API's rate limit.
- **Retries:** failed items are retried with exponential backoff, up to `maxAttempts`.
- **Completion callback:** each item can name an `onComplete` mutation that runs when it succeeds, fails for good or is canceled, with your `context`.
- **Status:** `status(id)` and `list(state)` show where items stand, live like any query.

Items are documents, so the queue survives restarts and is shared by every instance.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { workQueue } from "onebase/components/work-queue";

export default defineComponents({
  emails: workQueue({ maxParallelism: 5, retry: { maxAttempts: 4 } }),
});
```

| | |
|---|---|
| `maxParallelism` | Items running at once (default 10). |
| `retry` | `{ maxAttempts, initialBackoffMs, base }`. `maxAttempts` counts every run, the first included (default 1: no retries). The first retry waits `initialBackoffMs` (default 250), and each later one `base` times longer (default 2), ±50% so retries don't line up. |
| `timeoutMs` | A running item that hasn't finished after this long counts as a failed attempt (default 15 minutes). This catches work lost when an instance stops mid-action. |
| `retentionMs` | How long finished items are kept for `status()` and `list()` (default 7 days). |

## Queue work

```ts
export const signUp = mutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const userId = await ctx.db.insert("users", { email });
    await ctx.components.emails.enqueueAction({
      fn: internal.emails.sendWelcome,
      args: { to: email },
      onComplete: internal.emails.welcomeSent,
      context: { userId },
    });
  },
});

export const welcomeSent = internalMutation({
  args: onCompleteArgs(v.object({ userId: v.id("users") })), // from "onebase/components/work-queue"
  handler: async (ctx, { context, result }) => {
    if (result.kind === "success") await ctx.db.patch(context.userId, { welcomed: true });
    if (result.kind === "failed") console.error(`Welcome email failed: ${result.error}`);
  },
});
```

The item is queued in your mutation's transaction, so if the mutation fails, nothing is queued. `fn` and `onComplete` are function references (or [handles](./components.md#function-handles)), and `args` is checked against `fn`'s arguments at compile time.

| | |
|---|---|
| `enqueueAction({ fn, args, ... })` | Queues an action. Returns the item's id. |
| `enqueueMutation({ fn, args, ... })` | Queues a mutation. It runs in its own transaction, together with recording its result, so each attempt happens exactly once. |
| Options | `runAt` (a timestamp) or `delayMs` to start later; `retry` to override the queue's; `onComplete` and `context`. |
| `cancel({ id })` | Stops an item that hasn't finished. An action already running can't be interrupted, but its result is ignored. `onComplete` gets `{ kind: "canceled" }`. |
| `status({ id })` | `{ id, state, attempts, runAt, error, result }`, or null once the item has been forgotten. `state` is `pending`, `running`, `succeeded`, `failed` or `canceled`. |
| `list({ state, paginationOpts })` | Items in one state, oldest first. |

`onComplete` receives `{ id, context, result }`. Its args are `onCompleteArgs(contextValidator)`, which checks and types `context`, or `onCompleteValidator` for any context. `result` is `{ kind: "success", returnValue }`, `{ kind: "failed", error }` (after the last attempt) or `{ kind: "canceled" }`. If `onComplete` throws, its writes are rolled back and the error is logged; the item's own result stands.

## How it runs

- **Starting items:** a `pump` mutation starts due items while slots are free, by scheduling them with the [scheduler](./scheduling.md). It runs again whenever an item finishes and when a delayed item becomes due, and only one run of it is scheduled at a time.
- **Recording results:** an action's result is recorded in a mutation after it returns. A mutation's result is recorded in the same transaction it runs in.
- **Recovery:** a `sweep` cron runs every minute. It fails attempts that went past `timeoutMs`, so they're retried if attempts remain, and deletes finished items older than `retentionMs`. If an attempt that timed out finishes late, its result is ignored.
- **Retrying actions:** an action that fails partway through, after sending an email for instance, is retried from the start. Make actions that retry idempotent, or leave `maxAttempts` at 1.
