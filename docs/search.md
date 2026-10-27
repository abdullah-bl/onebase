---
title: Search
description: Full-text search indexes — defining them, querying with withSearchIndex, filters, pagination and limits.
---

# Search

A search index finds documents by the words in one string field, best matches first. The API is the same as Convex's.

## Define a search index

```ts
// onebase/schema.ts
messages: defineTable({
  channel: v.id("channels"),
  body: v.string(),
}).searchIndex("search_body", {
  searchField: "body",       // the text to search (a string field)
  filterFields: ["channel"], // optional: fields you can narrow results by
}),
```

The index is created at startup and filled from the documents already in the table. After that, every insert, patch, replace and delete keeps it up to date in the same transaction. Removing it from `schema.ts` drops it.

## Search

```ts
export const search = query({
  args: { channel: v.id("channels"), text: v.string() },
  handler: async (ctx, { channel, text }) => {
    return await ctx.db
      .query("messages")
      .withSearchIndex("search_body", (q) => q.search("body", text).eq("channel", channel))
      .take(10);
  },
});
```

- **Matching:** a document matches if its field contains **any** of the words, ignoring case. The **last word also matches as a prefix**, so results appear as the user types: `"onebase sea"` finds "search".
- **Order:** best matches first. Documents with more of the words, rarer words and shorter text rank higher. Ties go to newer documents.
- **`.eq(field, value)`:** keeps only documents where a `filterFields` field equals the value. Chain several to combine them.
- **After `withSearchIndex`** you can use `.filter(...)` and any ending: `.take(n)`, `.first()`, `.unique()`, `.collect()` or `.paginate(...)`. `.order()` isn't available, because results are ordered by relevance.
- **Live:** a search query is reactive like any other. A subscription re-runs when a document in the table changes, or only documents with the same filter values when you use `.eq()`.

## Pagination

```ts
export const searchPage = query({
  args: { text: v.string(), paginationOpts: paginationOptsValidator },
  handler: (ctx, { text, paginationOpts }) =>
    ctx.db.query("messages").withSearchIndex("search_body", (q) => q.search("body", text)).paginate(paginationOpts),
});
```

`usePaginatedQuery` works with it as usual. Cursors are positions in the relevance order, so a document added while someone is paging can shift later pages by one.

## Limits

| | |
|---|---|
| Results per query | 1024 (`.collect()` returns at most this many) |
| Words used from the search text | the first 16 |
| `filterFields` per index | 16 |
| Empty search text (or only punctuation) | no results |

## Language support

Words are split on anything that isn't a letter, digit or combining mark, so text in any script works. There's no stemming: "running" doesn't match "run", though typing "run" finds "running" through the prefix rule.

- **SQLite, Turso and MySQL** ignore accents: "cafe" finds "café".
- **Postgres** keeps them: "cafe" and "café" are different words.
- **MySQL** skips words shorter than 3 characters and common stopwords such as "the".

## How it's stored

- **SQLite / Turso:** one [FTS5](https://www.sqlite.org/fts5.html) table per search index, ranked with BM25. It lives in the same database file, so [backups](./backups.md) include it.
- **Postgres:** a GIN index on `to_tsvector('simple', field)` over the documents table, ranked with `ts_rank`. Writes need no extra work.
- **MySQL:** a side table per search index with a `FULLTEXT` index, searched in boolean mode.

`onebase doctor` checks that `searchField` and `filterFields` exist and that the search field is a string.
