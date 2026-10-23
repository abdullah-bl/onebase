---
title: Database
description: Reading and writing documents with ctx.db — indexes, filters, ordering and pagination.
---

# Database

## Reading

```ts
const post = await ctx.db.get(id);                 // document or null
const all = await ctx.db.query("posts").collect(); // every document, oldest first
```

A query is built from these steps, in order:

```ts
ctx.db
  .query("posts")                                        // 1. table
  .withIndex("by_author", (q) => q.eq("author", userId)) // 2. optional: index range
  .order("desc")                                         // 3. optional: "asc" (default) or "desc"
  .filter((q) => q.gt(q.field("views"), 100))           // 4. optional: more conditions
  .take(10);                                             // 5. collect() | take(n) | first() | unique() | paginate(opts)
```

| Ending | Returns |
|---|---|
| `.collect()` | every match |
| `.take(n)` | up to `n` matches |
| `.first()` | the first match or `null` |
| `.unique()` | the only match or `null`; throws if more than one matches |
| `.paginate({ numItems, cursor })` | `{ page, isDone, continueCursor }` |

You can also loop with `for await (const post of ctx.db.query("posts")) { ... }`.

## Indexes

`withIndex` reads a slice of an index. Call `.eq()` on the index's fields in order. After that, you may add one lower bound (`gt` / `gte`) and one upper bound (`lt` / `lte`) on the next field:

```ts
// index "by_author_published": ["author", "published"]
.withIndex("by_author_published", (q) => q.eq("author", userId).eq("published", true))

// every table has "by_creation_time"
.withIndex("by_creation_time", (q) => q.gt("_creationTime", Date.now() - 86_400_000))
```

Results come back in index order: by the index fields, then by `_creationTime`.

If you get the order wrong or use a field the index doesn't have, the error says which fields the index has and in what order.

## Filters

`.filter()` accepts either form:

```ts
.filter({ published: true, author: userId })               // shorthand: field equals value
.filter((q) => q.and(q.eq(q.field("published"), true), q.gte(q.field("views"), 10)))
```

Builder operators:
- **Comparison:** `eq`, `neq`, `lt`, `lte`, `gt`, `gte`
- **Logic:** `and`, `or`, `not`
- **Arithmetic:** `add`, `sub`, `mul`, `div`, `mod`, `neg`
- **Fields:** `q.field("a.b")` reads a (nested) field.

**Filters use indexes automatically.** When an index matches the fields you filter on, the database uses it. You don't have to use `withIndex`. In dev mode, a filter that has to read the whole table logs a warning with the index to add:

```
warn Query on "posts" reads every document to apply .filter().
     Add .index("by_author", ["author"]) to "posts" in schema.ts and it will be used automatically.
```

The callback receives a filter builder, not a document. For logic the builder can't express, filter in JavaScript:

```ts
const posts = (await ctx.db.query("posts").collect()).filter((p) => p.title.includes("onebase"));
```

For full-text search, use `.withSearchIndex(...)` instead of `.withIndex(...)`. See [Search](./search.md).

## Pagination

```ts
import { paginationOptsValidator } from "onebase/server";

export const feed = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, { paginationOpts }) => ctx.db.query("posts").order("desc").paginate(paginationOpts),
});
```

Pass `{ numItems: 20, cursor: null }` for the first page, then `cursor: continueCursor` for the next one. Cursors are stable when documents are inserted. In React, `usePaginatedQuery` handles this for you and keeps every loaded page live (see [Client](./client.md)).

## Writing (mutations only)

```ts
const id = await ctx.db.insert("posts", { author, title, tags: [], published: false });
await ctx.db.patch(id, { title: "New title", views: undefined }); // shallow merge; undefined removes a field
await ctx.db.replace(id, { author, title, tags: [], published: true }); // replace the whole document
await ctx.db.delete(id);
```

Every write is validated against the schema. Writes in one mutation are atomic, and if the mutation throws, none of them happen.
