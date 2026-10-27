---
title: Vector search
description: Vector indexes — defining them, ctx.vectorSearch in actions, filters, limits and how each database runs them.
---

# Vector search

A vector index finds the documents whose vector (an embedding, say) is closest to a query vector, by cosine similarity. The API is the same as Convex's.

## Define a vector index

```ts
// onebase/schema.ts
foods: defineTable({
  description: v.string(),
  cuisine: v.string(),
  embedding: v.optional(v.array(v.float64())),
}).vectorIndex("by_embedding", {
  vectorField: "embedding", // an array of numbers
  dimensions: 1536,         // every vector's length, from 2 to 4096
  filterFields: ["cuisine"], // optional: fields you can narrow results by
}),
```

The index is created at startup and filled from the documents already in the table. After that, every insert, patch, replace and delete keeps it up to date in the same transaction. Removing it from `schema.ts` drops it, and changing `dimensions` rebuilds it.

A document without the field isn't indexed. Writing any other value than an array of `dimensions` numbers fails the mutation with an error that names the field and index.

## Search

Like Convex, vector search runs in actions, where you'll usually call an embedding API first:

```ts
export const similarFoods = action({
  args: { text: v.string(), cuisine: v.optional(v.string()) },
  handler: async (ctx, { text, cuisine }) => {
    const vector = await embed(text); // your embedding API
    const results = await ctx.vectorSearch("foods", "by_embedding", {
      vector,
      limit: 16,
      filter: cuisine ? (q) => q.eq("cuisine", cuisine) : undefined,
    });
    // [{ _id, _score }, ...], most similar first
    return await ctx.runQuery(internal.foods.fetchResults, { ids: results.map((r) => r._id) });
  },
});
```

- **Results:** `{ _id, _score }` for each match, most similar first. `_score` is the cosine similarity, from -1 (opposite) to 1 (same direction). Load the documents with `ctx.runQuery()`.
- **`limit`:** from 1 to 256, default 10.
- **`filter`:** `q.eq(field, value)` on a `filterFields` field, and `q.or(...)` to match any of several: `(q) => q.or(q.eq("cuisine", "French"), q.eq("cuisine", "Thai"))`.
- **The query vector** must have `dimensions` numbers and can't be all zeros.

## How each database runs it

| Database | How | Scale |
|---|---|---|
| **SQLite** | A side table of float32 vectors per index, compared in a SQL function (`vector_distance_cos`) onebase adds to `bun:sqlite`. Every matching vector is compared, so results are exact. | Linear: about 30 ms per search over 10k vectors of 1536 dimensions, 130 ms over 50k. |
| **Turso / libSQL** | The same side table, compared with libSQL's built-in `vector_distance_cos`. Exact, and the comparison runs in the database. | Linear, like SQLite. |
| **Postgres** | An HNSW index from [pgvector](https://github.com/pgvector/pgvector) on the documents table, so writes need no extra work. onebase runs `CREATE EXTENSION IF NOT EXISTS vector`; the database user needs the right to do that, or create the extension yourself. With pgvector 0.8+, filtered searches keep scanning until the limit is filled. | Large tables. HNSW is approximate: results are very close but not guaranteed to be the exact nearest. Indexes over 2000 dimensions are searched without an index. |
| **MySQL** | MySQL Community has no vector distance function, so onebase reads the matching documents' vectors and ranks them in the server. Exact. | Small tables only: every search reads every matching vector. |

The SQLite side tables are stored in the same file as the documents, so [backups](./backups.md) include them, and vectors are stored the way libSQL stores `F32_BLOB` values.

`onebase doctor` checks that `vectorField` and `filterFields` exist and that the vector field holds arrays of numbers.
