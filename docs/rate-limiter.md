---
title: Rate limiter
description: Limit how often something happens per user, IP or anything else, with limits stored in the database and checked in the caller's transaction.
---

# Rate limiter

The rate limiter component limits how often something happens, per key: messages per user, sign-in attempts per email, API calls per account. Limits are stored in the database, so they hold across restarts and across several instances. They're checked in your mutation's transaction, so if the mutation fails afterwards, the token is given back.

This isn't the server's `--rate-limit` flag. That one caps requests per IP before any function runs, in memory, per instance. Use the flag to protect the server, and this component for rules about your app.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { rateLimiter, MINUTE, HOUR } from "onebase/components/rate-limiter";

export default defineComponents({
  limiter: rateLimiter({
    rates: {
      // Bursts of up to 10 messages, then one every 6 seconds on average.
      sendMessage: { kind: "token bucket", rate: 10, period: MINUTE },
      // 3 attempts per hour, counted in fixed hourly windows.
      signUp: { kind: "fixed window", rate: 3, period: HOUR },
    },
  }),
});
```

## Use it

```ts
export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new ConvexError("Sign in first");
    const { ok, retryAfter } = await ctx.components.limiter.limit({ name: "sendMessage", key: userId });
    if (!ok) throw new ConvexError(`Slow down: try again in ${Math.ceil(retryAfter / 1000)}s.`);
    await ctx.db.insert("messages", { body, author: userId });
  },
});
```

Or let it throw, and the whole mutation is rolled back:

```ts
await ctx.components.limiter.limit({ name: "sendMessage", key: userId, throws: true });
```

It throws a `ConvexError` whose `data` is `{ kind: "RateLimited", name, retryAfter }`. Clients get that `data` with the error, and `isRateLimitError(err)` (from `onebase/components/rate-limiter`) recognizes it on the server.

## Functions

| | |
|---|---|
| `limit({ name, key?, count?, reserve?, throws? })` | Mutation. Takes `count` tokens (default 1). Returns `{ ok: true }`, or `{ ok: false, retryAfter }` with the ms to wait. |
| `check({ name, key?, count? })` | Query. Whether `limit()` would be allowed now, without taking anything. Useful to disable a button. |
| `reset({ name, key? })` | Mutation. Forgets what was used: the full capacity is available again. |
| `getValue({ name, key? })` | Query. `{ value, ts }`: tokens available now. |

`key` makes a separate limit per user, IP, email or whatever you pass; leave it out for one global limit. Every function also takes `config` instead of a configured name, for limits you decide at runtime: `limit({ name: "export", key: orgId, config: { kind: "fixed window", rate: plan.exportsPerDay, period: DAY } })`.

## Configuration

| | |
|---|---|
| `kind` | `"token bucket"`: tokens refill continuously, so after a burst the next one comes back in `period / rate`. `"fixed window"`: `rate` tokens are added at the start of each period. |
| `rate`, `period` | Tokens added per period. Periods are in ms; use `SECOND`, `MINUTE`, `HOUR` and `DAY`. |
| `capacity` | The most tokens that can be saved up (default `rate`). A larger capacity allows larger bursts. |
| `shards` | Splits the limit over this many documents with an equal share each, so many writes to one busy limit don't conflict. Only useful with several instances on Postgres or MySQL; one instance runs mutations one at a time anyway. |
| `start` | Fixed window only: when windows start, in ms since the epoch (default 0, so windows line up with the clock). |
| `maxReserved` | How far `reserve: true` may go into debt (default: no limit). |

## Reserving ahead

With `reserve: true`, a call that would be refused is allowed anyway and returns `{ ok: true, retryAfter }`: the time when its tokens will have been earned. Use it to queue work rather than reject it, say by scheduling the work to run after `retryAfter`.

```ts
const { retryAfter } = await ctx.components.limiter.limit({ name: "llmRequests", reserve: true });
await ctx.scheduler.runAfter(retryAfter ?? 0, internal.ai.generate, { prompt });
```
