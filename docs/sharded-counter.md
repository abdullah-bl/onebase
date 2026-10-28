---
title: Sharded counter
description: Counters that many writers can bump at the same time, split over several documents.
---

# Sharded counter

A counter kept in one document is fine until many requests bump it at once: page views, likes on a popular post, a global "messages sent" total. Every write then changes the same document, and with several instances on Postgres or MySQL those writes conflict and retry. The sharded counter spreads each counter over several documents (shards). Each write touches one shard at random, and reading the counter adds them up.

With a single instance this matters less, because onebase runs one process's mutations one at a time anyway. It still keeps live queries that read one shard from re-running on every write.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { shardedCounter } from "onebase/components/sharded-counter";

export default defineComponents({
  counter: shardedCounter({ shards: 16, perName: { pageViews: 64 } }),
});
```

Counters don't need declaring: any name works. `shards` (default 16) sets the number of documents per counter, and `perName` changes it for some counters.

## Use it

```ts
export const view = mutation({
  args: { page: v.string() },
  handler: async (ctx, { page }) => {
    await ctx.components.counter.inc({ name: `views:${page}` });
  },
});

export const views = query({
  args: { page: v.string() },
  handler: (ctx, { page }) => ctx.components.counter.count({ name: `views:${page}` }),
});
```

| | |
|---|---|
| `inc({ name })`, `dec({ name })` | Mutations: add or subtract 1. |
| `add({ name, count?, shard? })` | Mutation: adds `count` (default 1, negative to subtract). `shard` picks the shard, say to keep one user's writes on one shard. |
| `count({ name })` | Query: the exact value, reading every shard. |
| `estimateCount({ name, readShards? })` | Query: reads `readShards` random shards (default 1) and scales up. Fewer reads, and a live query over it re-runs only when those shards change. |
| `reset({ name })` | Mutation: back to 0. |

To show a count on a page many people watch, `estimateCount` keeps updates down; use `count` where the exact number matters.
