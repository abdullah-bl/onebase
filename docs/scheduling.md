---
title: Scheduling & crons
description: Run functions later with ctx.scheduler, or on a schedule with crons.ts.
---

# Scheduling & crons

## Scheduling a function

```ts
// Run in 5 minutes
await ctx.scheduler.runAfter(5 * 60_000, internal.emails.sendReminder, { userId });

// Run at a specific time
const jobId = await ctx.scheduler.runAt(new Date("2026-12-31T23:59:00Z"), internal.party.start, {});

// Cancel a job that hasn't run yet
await ctx.scheduler.cancel(jobId);
```

- **From a mutation:** the job is created only if the mutation commits. Throw, and nothing is scheduled.
- **Storage:** jobs are kept in the database, so they survive restarts. A job that was running when the server stopped runs again on the next start.
- **Mutations run exactly once:** a scheduled mutation is marked done inside its own transaction.
- **Actions and queries run at most once,** unless the server crashes mid-run (then the job is retried).
- **Failures:** a failed job is logged and kept with its error for 7 days.
- **Several instances:** each job is claimed by exactly one instance.

A common pattern is to start long work from a mutation without making the user wait:

```ts
export const requestSummary = mutation({
  args: { id: v.id("posts") },
  handler: async (ctx, { id }) => {
    await ctx.db.patch(id, { summary: "pending" });
    await ctx.scheduler.runAfter(0, internal.ai.summarize, { id }); // an action
  },
});
```

Scheduled functions all start when they're due and aren't retried. For many jobs at once, a limit on how many run together, retries or a callback when each finishes, use the [work queue](./work-queue.md).

## Cron jobs

Declare recurring jobs in `onebase/crons.ts`:

```ts
import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("sync feeds", { minutes: 15 }, internal.feeds.sync);
crons.hourly("rollup", { minuteUTC: 5 }, internal.stats.rollup);
crons.daily("prune", { hourUTC: 3, minuteUTC: 0 }, internal.messages.prune, { days: 30 });
crons.weekly("digest", { dayOfWeek: "monday", hourUTC: 8, minuteUTC: 0 }, internal.email.digest);
crons.monthly("invoices", { day: 1, hourUTC: 6, minuteUTC: 0 }, internal.billing.invoice);
crons.cron("weekday mornings", "30 9 * * mon-fri", internal.reports.daily); // standard 5-field cron

export default crons;
```

- **Times:** all times are UTC.
- **Missed runs:** the next run time is stored in the database. A restart doesn't repeat or skip runs, and a run missed while the server was down happens once on startup.
- **No overlap:** a job that is still running when it comes due again is skipped.
- **Several instances:** each run happens on exactly one of them.
- **Changing a schedule:** edit `crons.ts`. Changed jobs get a new schedule, and removed jobs are deleted.

`onebase doctor` reports crons that point at functions that don't exist, and the server refuses to start with one.
