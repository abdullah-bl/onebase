---
title: Workflow
description: Durable multi-step workflows that survive restarts, with sleeps, out-of-band actions, retries and per-step status.
---

# Workflow

The workflow component runs a multi-step function durably: each step's result is journaled in the database, so a workflow that was interrupted by a restart or a crash picks up where it stopped instead of starting over. Steps can wait (sleeps), run out of band (actions), and retry on failure, and you can watch every step's state with `status()`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { workflow } from "onebase/components/workflow";

export default defineComponents({
  jobs: workflow(),
});
```

## Write a workflow

`defineWorkflow` creates the workflow's runner. Inside `run`, do everything through `step` — a plain `ctx.runMutation` would work once but wouldn't be journaled, so a replay would run it again.

```ts
// onebase/flows.ts
import { defineWorkflow } from "onebase/components/workflow";

export const onboarding = defineWorkflow({
  run: async (step, args: { userId: string }) => {
    const user = await step.runQuery(internal.users.get, { id: args.userId });
    await step.runMutation(internal.emails.welcome, { userId: user._id });
    await step.sleep(3 * 24 * 60 * 60 * 1000); // wait 3 days
    return await step.runAction(internal.reports.generate, { userId: args.userId });
  },
});
```

Start it from a mutation, an action or the dashboard:

```ts
export const beginOnboarding = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const id = await ctx.components.jobs.start({ fn: internal.flows.onboarding, args: { userId } });
    return id;
  },
});
```

## How it runs

The workflow executes inside one mutation until it reaches a durable point, then the component takes over:

- **`step.runQuery` / `step.runMutation`** run in the workflow's transaction and their results are journaled. On a replay they're skipped: the journaled result comes back instead.
- **`step.runAction`** pauses the workflow, runs the action out of band, then continues with its result journaled. Pass `retry` to try again on failure: `{ retry: { maxAttempts: 3, initialBackoffMs: 250 } }`.
- **`step.sleep(ms)`** pauses the workflow until the wake time, which survives restarts.
- When `run` returns, the workflow is `completed` and its return value is kept for `status()`.

A workflow's steps always run in call order, and a replay repeats the same calls — so make the same step calls in the same order every run: branch on journaled results, not on the clock or random values. A run executes at most 100 steps before it yields and continues, so a long workflow can't hold the mutation queue forever.

## Watch it run

```ts
const st = await ctx.components.jobs.status({ id });
// { id, status, result, error, startedAt, updatedAt, completedAt,
//   steps: [{ number, kind, state, result, error, wakeAt, attempts }] }
```

`status` is `"running"`, `"completed"`, `"failed"` or `"canceled"`; each step is `"pending"`, `"inProgress"`, `"completed"` or `"failed"`. `list({ status, paginationOpts })` pages through workflows, and `cancel({ id })` stops a running one — a running action can't be interrupted, but its outcome is ignored.

## Rules to keep in mind

- **A failed step fails the workflow** unless it has a retry policy; the error is on the workflow and the step. Fix the cause and start the workflow again — completed steps re-run from their journals, so keep their functions idempotent.
- **Steps should be idempotent.** If the process dies mid-run, the whole run's transaction rolls back and the steps of that run execute again.
- **`args` pass through as-is** and must be storable JSON; validate them in your own start wrapper.
- **The sweep** (a cron the component runs every minute) fails actions that ran too long, re-kicks workflows whose continuation went missing, and forgets finished workflows after `retentionMs` (default 7 days).

## Coming from Convex

`workflow.define(...)` becomes `defineWorkflow(...)`, `workflow.start(ctx, fn, args)` becomes `ctx.components.<mount>.start({ fn, args })`, and the Workpool it ran on is onebase's scheduler: actions run through the component itself, so there's nothing extra to mount. Workflow state starts fresh — running Convex workflows don't come across, so let them finish (or cancel them) before you migrate.
