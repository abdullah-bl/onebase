---
title: Migrations
description: Batched data migrations with progress tracking, that keep going across restarts.
---

# Migrations

The migrations component changes the documents of one of your tables a batch at a time, in the background: rename a field, backfill a computed value, denormalize an author name. Progress is stored in the database, so a migration that was interrupted by a restart or a crash continues where it stopped, and you can watch it move with `status()`.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { migrations } from "onebase/components/migrations";

export default defineComponents({
  migrations: migrations(),
});
```

## Write a migration

A migration has two halves. The runner is an app function you write with `defineMigration`: it reads your table and knows how to change one document. You export it from your functions folder like any other function.

```ts
// onebase/backfill.ts
import { defineMigration } from "onebase/components/migrations";

export const renameAuthor = defineMigration({
  table: "messages",
  mutateOne: async (ctx, doc) => {
    if (doc.authorName === undefined) {
      const user = await ctx.db.get(doc.authorId);
      if (user) await ctx.db.patch(doc._id, { authorName: user.name });
    }
  },
});
```

You start it wherever it makes sense — a mutation you call from the dashboard, a deploy script, a cron:

```ts
// onebase/admin.ts
import { mutation } from "onebase/server";
import { v } from "onebase/values";

export const runRenameAuthor = mutation({
  args: {},
  handler: (ctx) =>
    ctx.components.migrations.migrate({ name: "rename-author", runner: internal.backfill.renameAuthor }),
});
```

`migrate()` registers the migration under its `name` and runs batches until it's done, or for about a second — then it continues in the background, one batch per transaction. It returns the migration's status either way, so calling it from the dashboard shows you progress as you go.

## Watch it run

```ts
const st = await ctx.components.migrations.status({ name: "rename-author" });
// { name, state, processed, batchSize, startedAt, updatedAt, completedAt, error }
```

`state` is `"inProgress"`, `"completed"`, `"failed"` or `"canceled"`. `list()` returns every migration the component knows about, by name.

## Functions

| | |
|---|---|
| `migrate({ name, runner, batchSize?, maxMs?, force? })` | Mutation. Registers the migration and runs it: batches of `batchSize` documents (default 100) until done or `maxMs` (default 1000) has passed, then continues in the background. Returns the status. |
| `status({ name })` | Query. Where one migration stands; null for an unknown name. |
| `list()` | Query. Every migration's status. |
| `cancel({ name })` | Mutation. Stops a running migration mid-flight. `migrate()` resumes where it stopped. |

Pass `force: true` to run a completed migration again from the first document.

## Rules to keep in mind

- **One batch per transaction.** A `mutateOne` that throws rolls back its whole batch and fails the migration with its error; fix the problem (or the document) and call `migrate()` again to resume. Make `mutateOne` idempotent, since a resumed batch re-runs from its beginning.
- **Don't insert into the migration's own table** from `mutateOne`. Documents written ahead of the cursor would keep the migration going; documents written behind it would never be seen.
- **One name, one function.** Calling `migrate()` for a name that already processed documents with a different runner is refused; pass `force: true` to start it over.
- **Batches follow creation order** (`by_creation_time`), so a document written while the migration runs is migrated if it was created before the cursor got there, and skipped if it was created behind it.
- **Several instances:** batches are one transaction each, but two instances running the same migration at the same time can process the same batch twice. Run migrations from one place, as you would on Convex.

## Coming from Convex

The Convex component's `Migrations` class and `migrations.define(...)` become `defineMigration(...)` plus a `migrate()` call with the name you choose. Migration state starts fresh: documents the old component already migrated on Convex are migrated again here, so keep `mutateOne` idempotent and it's safe.
