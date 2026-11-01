# vector-search — "find similar items" without external services

Adds items with embeddings and finds the closest ones by cosine similarity. The embedding function is a deterministic hashed bag-of-words computed locally, so the demo runs with no API keys or network; in a real app you'd call a model there instead.

## Run it

```bash
cd examples/vector-search
bun ../../src/cli.ts dev
```

Open the printed URL (http://localhost:8090), click **Similar** with the seeded data, add your own items, and compare the vector results with the keyword-search panel underneath.

## What it shows

- **`vectorIndex` in the schema** — `by_embedding` over a `v.optional(v.array(v.float64()))` field, 64 dimensions, with `kind` as a filter field. Documents without the field aren't indexed.
- **`ctx.vectorSearch` in an action** — `{ vector, limit, filter }` returning `{ _id, _score }` hits, most similar first.
- **Both filter styles** — `q.eq("kind", kind)` for one value, `q.or(...)` to match any of several (the "facts or ideas" option).
- **The action → mutation split** — the action computes the embedding, then writes through an internal mutation; results are loaded for display by `ctx.runQuery(internal.items.withScores)`.
- **Keyword search for comparison** — a `searchIndex` live query in the same app, so you can see the difference between FTS and similarity.

## Files

```
onebase/
  schema.ts   items with by_kind, search_text and by_embedding indexes
  items.ts    embed(), list, search, addAndIndex, similar, insert, withScores, seed
public/index.html  search + add UI, no build step
```
