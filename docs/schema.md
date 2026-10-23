---
title: Schema
description: Define tables, field validators and indexes in schema.ts.
---

# Schema

The schema lives in `onebase/schema.ts`. It declares your tables, the shape of their documents, and their indexes. Every write is checked against it, and your functions get types from it.

```ts
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  users: defineTable({
    name: v.string(),
    email: v.string(),
    role: v.union(v.literal("admin"), v.literal("member")),
  }).index("by_email", ["email"]),

  posts: defineTable({
    author: v.id("users"),
    title: v.string(),
    tags: v.array(v.string()),
    published: v.boolean(),
    views: v.optional(v.number()),
  })
    .index("by_author", ["author"])
    .index("by_author_published", ["author", "published"]),
});
```

## Validators

| Validator | TypeScript type |
|---|---|
| `v.string()` | `string` |
| `v.number()` | `number` (alias: `v.float64()`) |
| `v.boolean()` | `boolean` |
| `v.null()` | `null` |
| `v.id("table")` | `Id<"table">` |
| `v.literal("x")` | `"x"` |
| `v.array(v.string())` | `string[]` |
| `v.object({ a: v.number() })` | `{ a: number }` |
| `v.record(v.string(), v.number())` | `Record<string, number>` |
| `v.union(a, b)` | `A \| B` |
| `v.optional(x)` | field may be missing |
| `v.any()` | anything |

Values are stored as JSON. Store dates as numbers (`Date.now()`), not `Date` objects; onebase rejects a `Date` and tells you so.

## System fields

Every document has `_id` and `_creationTime` (milliseconds). They're added automatically. Don't declare them, and don't pass them to `insert`.

Ids carry a tag for their table, so `ctx.db.normalizeId("users", someString)` can check an id without a database lookup.

## Indexes

```ts
defineTable({ ... }).index("by_author_published", ["author", "published"])
```

- **Usage:** index names are yours to choose. Use them with `.withIndex()` (see [Database](./database.md)).
- **Automatic use:** a `.filter()` on indexed fields uses the matching index automatically.
- **Built-in index:** every table has `by_creation_time`.
- **Changes:** indexes are created and dropped automatically at startup when `schema.ts` changes.
- **Nested fields:** use dots, e.g. `["profile.country"]`.

## Search indexes

```ts
defineTable({ ... }).searchIndex("search_body", { searchField: "body", filterFields: ["channel"] })
```

Full-text search over one string field. See [Search](./search.md).

## Changing a schema

When `schema.ts` changes, onebase checks every stored document against it at startup, like a Convex deploy. If some don't match, the server refuses to start and lists them:

```
schema.ts doesn't match 2 existing documents:
  - people k57… : document.age is required (expected v.number())
  - people k9a… : document.age is required (expected v.number())
```

Either make the schema accept the data (`v.optional(...)`, `v.union(...)`), or fix the data: start with `{ schemaValidation: false }`, update the documents in a mutation or the [dashboard](./dashboard.md), then turn validation back on. The check runs only when the schema changes.

## Validation errors

A bad write fails with a message that lists every problem:

```
Invalid "posts" document:
  - document.title must be v.string(), got number (42)
  - document.published is required (expected v.boolean())
  - document.extra is not allowed (known fields: author, title, tags, published, views)
```

To turn validation off (for example while migrating data), pass `defineSchema({ ... }, { schemaValidation: false })`.

## Without a schema

`schema.ts` is optional. Without it, any table accepts any document and `ctx.db` is untyped. `onebase doctor` will remind you to add one.
