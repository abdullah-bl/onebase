---
title: Aggregate
description: Counts, sums, ranks and the n-th item over a table in O(log n), kept in step with the table automatically.
---

# Aggregate

Counting documents with `.collect().length` reads every one of them. The aggregate component keeps a counted tree of a table's documents, sorted by a key you choose, so these take a few document reads however large the table is:

- **how many:** "players", "messages in this channel", "scores between 100 and 200"
- **sums:** total points, revenue this month
- **ranks:** "you're #42"
- **the n-th item:** the leaderboard page 3, a random document, the median

It follows the table through a [table hook](./components.md#table-hooks): every insert, patch, replace and delete updates it in the same transaction, including dashboard edits and sign-ups. There are no triggers to wire up and nothing to forget.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { aggregate } from "onebase/components/aggregate";
import type { Doc } from "./_generated/dataModel";

export default defineComponents({
  leaderboard: aggregate({
    table: "scores",
    sortKey: (d: Doc<"scores">) => d.points,
    sumValue: (d) => d.points,
  }),
});
```

| | |
|---|---|
| `table` | The app table to follow. |
| `sortKey(doc)` | What to order by: a number, string, boolean, null or an array of them (to sort by several fields: `[d.level, d.points]`). Documents with equal keys are ordered by id. |
| `sumValue(doc)` | Optional: the number `sum()` adds up (default 0). |
| `namespace(doc)` | Optional: keeps a separate tree per value, such as per channel or per game. Queries then pass `namespace`. Separate trees also mean writes to different namespaces don't touch the same documents. |
| `filter(doc)` | Optional: only documents it returns true for are counted. |
| `maxNodeSize` | Items per tree node (default 32). |

When the component is first mounted, documents already in the table are added in the background, 200 per transaction, while the app keeps running. Until that's done, `status()` returns `{ ready: false, state: "backfilling" }` and counts cover only part of the table. Changing `sortKey`, `sumValue`, `namespace`, `filter` or `maxNodeSize` rebuilds it the same way.

## Query it

From queries (live like any query), mutations or actions:

```ts
export const myRank = query({
  args: { points: v.number() },
  handler: async (ctx, { points }) => ({
    rank: (await ctx.components.leaderboard.indexOf({ key: points, order: "desc" })) + 1,
    of: await ctx.components.leaderboard.count(),
  }),
});

export const page = query({
  args: { page: v.number() },
  handler: async (ctx, { page }) => {
    const top = [];
    for (let i = page * 10; i < page * 10 + 10; i++) {
      const item = await ctx.components.leaderboard.at({ index: i, order: "desc" });
      if (item) top.push(await ctx.db.get(item.id as Id<"scores">));
    }
    return top;
  },
});
```

| | |
|---|---|
| `count({ namespace?, bounds? })` | How many items. |
| `sum({ namespace?, bounds? })` | The total of `sumValue`. |
| `indexOf({ namespace?, key, id?, order? })` | How many items come before `key` (with `order: "desc"`, after it): a 0-based rank. With `id`, the position of that exact document. |
| `at({ namespace?, index, order? })` | The item at a position: `{ key, id, sumValue }`, or null. |
| `min({ namespace? })`, `max({ namespace? })` | The first and last items. |
| `paginate({ namespace?, bounds?, cursor?, numItems, order? })` | Items in order, a page at a time: `{ page, isDone, continueCursor }`. |
| `status()` | `{ ready, state }`: whether it has caught up with the table. |

`bounds` narrows by key: `{ lower: { key: 100, inclusive: true }, upper: { key: 200, inclusive: false } }`. Either side can be left out.

Items hold the document's id. Load the document with `ctx.db.get(item.id)`.

## Without a table

Leave out `table` to add items yourself, for data that isn't one row per document:

```ts
pageViews: aggregate<number, string>(), // key: a timestamp; namespace: the page
```

```ts
await ctx.components.pageViews.insert({ namespace: path, key: Date.now(), id: crypto.randomUUID(), sumValue: 1 });
const today = await ctx.components.pageViews.count({ namespace: path, bounds: { lower: { key: startOfDay, inclusive: true } } });
```

`insert`, `delete({ key, id })`, `replace({ from, to })` and `clear({ namespace? })` are mutations, so they run in your transaction. An aggregate that follows a table refuses them.

## Costs

- **Writes:** each write to the table updates a few tree documents, about 0.1 ms per write on SQLite. Every write in a namespace updates that namespace's root, so writes to one namespace don't run in parallel, even across instances. Use namespaces to spread busy tables.
- **Reads:** a count without bounds reads one document; ranks and positions read one document per tree level (3 to 4 for a million items). About 30 µs on SQLite over 10,000 rows.
- **Live queries:** every write to the table changes the root of its namespace, so every live query over that namespace re-runs. That's what makes counts live; keep namespaces narrow if a table is written to constantly.
