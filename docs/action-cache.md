---
title: Action cache
description: A TTL cache for expensive actions, with deduped concurrent runs.
---

# Action cache

The action cache stores the results of expensive actions — LLM calls, API fetches, reports — for a while: the first caller runs the action, everyone else within the TTL gets the stored result, and callers that arrive while the first is still running share its run instead of doubling the work.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { actionCache } from "onebase/components/action-cache";

export default defineComponents({
  cache: actionCache({ ttl: 5 * 60_000 }),
});
```

`ttl` is how long a stored result is served (default 1 minute); `claimMs` is how long a running computation's claim lasts before another caller may take over (default 30s).

## Use it

Wrap an action with `cached` — the mount name, the action, and a key from its arguments:

```ts
// onebase/reports.ts
import { cached } from "onebase/components/action-cache";

const salesReport = cached("cache", internal.reports.computeSales, (args) => `${args.org}:${args.month}`);

// in an action
const report = await salesReport(ctx, { org, month });
```

The cache key is the action's name plus your key, so one cache mount serves many functions. Arguments and return values must be storable JSON. On a miss the wrapper claims the key and runs the action; a caller that sees someone else's claim polls briefly for the stored result and, if the claim outlives its patience, runs the action itself rather than wait forever — so a crashed runner can't block a key. That caller's result isn't stored, since the claim isn't theirs. A computation that throws isn't cached and its error is rethrown. If you invalidate a key while its action is running, that run's result isn't stored either.

## Functions

| | |
|---|---|
| `read({ key })` | Mutation. `"hit"` with the value, `"miss"` with the `claim` you were granted, or `"inProgress"`. |
| `write({ key, value, ttl?, claim? })` | Mutation. Stores a result for the TTL. With `claim`, only if that claim still holds. |
| `release({ key, claim })` | Mutation. Gives a claim back after a failed run. |
| `invalidate({ key? , prefix? })` | Mutation. Forgets one key, or every key with a prefix; returns how many. |
| `peek({ key })` | Query. The stored result and its expiry, if any. |

`cached()` is the convenient way to use these; call `read`/`write` yourself if your flow needs something else (say, warming keys from a cron).

## Rules to keep in mind

- **Dedupe is best-effort.** Two callers that race before either claims the key can both run the action; one instance runs mutations one at a time, so in practice the claim wins. Don't rely on exactly-once for anything with side effects — this cache is for reads.
- **Values are JSON.** Functions, Dates and class instances don't survive the round trip.
- **Expiry is lazy plus swept.** Expired entries are replaced on the next read and deleted by a minute-cron, so `peek` can briefly miss an expiry the next `read` would catch.

## Coming from Convex

`@convex-dev/action-cache`'s `cache.wrap(fn, keyFn)` becomes the `cached(mount, fn, keyFor)` helper — the mount name stands in for the component client Convex passes. `read`/`write`/`invalidate` map directly.
