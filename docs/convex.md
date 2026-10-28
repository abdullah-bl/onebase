---
title: Coming from Convex
description: What carries over from Convex, what differs, and how to port a project.
---

# Coming from Convex

onebase uses Convex's programming model and most of its API. If you know Convex, you already know onebase.

## What's the same

- `query`, `mutation`, `action` and their `internal*` versions, with `args` and `returns` validators
- `v.*` validators, `defineSchema`, `defineTable`, `.index()`
- `ctx.db.get / query / insert / patch / replace / delete / normalizeId`, `withIndex`, `filter`, `order`, `paginate`, `paginationOptsValidator`, including the table-first forms `ctx.db.get("messages", id)` and `ctx.db.patch("messages", id, value)`
- `ctx.scheduler.runAfter / runAt / cancel`, `cronJobs()`
- `ctx.storage.generateUploadUrl / getUrl / delete / store / get`, `v.id("_storage")`
- `ctx.auth.getUserIdentity()` and the `auth.config.ts` provider format
- Built-in sign-in shaped like Convex Auth: `authTables`, `getAuthUserId`, `signIn("password" | "github" | …)`, `signOut()`, `useAuthActions()`, `<Authenticated>` (configured in `auth.config.ts` instead of a separate package)
- `httpRouter` / `httpAction`
- `api` / `internal` references, `ConvexError`
- `.searchIndex()` and `withSearchIndex(...)` full-text search
- Optimistic updates: `useMutation(ref).withOptimisticUpdate(...)` and `client.mutation(ref, args, { optimisticUpdate })`
- React: `useQuery`, `useMutation`, `useAction`, `usePaginatedQuery`, plus the `ConvexProvider` / `ConvexReactClient` aliases

## What's different

| | Convex | onebase |
|---|---|---|
| Hosting | Managed cloud or self-hosted backend | One binary you run anywhere |
| Runtime | V8 isolates; Node only in `"use node"` actions | Bun everywhere; any npm package in any function |
| Database | Convex's own | SQLite (default), Postgres, MySQL or Turso |
| `.filter()` | Builder only; never uses indexes | Builder or `{ field: value }`; uses matching indexes automatically |
| Mutations | Optimistic concurrency | Serial per process; serializable across instances |
| Imports | `convex/server`, `convex/values` | `onebase/server`, `onebase/values` (builders still come from `./_generated/server`) |
| Functions folder | `convex/` | `onebase/` (a `convex/` folder also works) |
| Full-text search | ✓ | ✓ (`searchIndex`, `withSearchIndex`) |
| Vector search | ✓ | ✓ (`vectorIndex`, `ctx.vectorSearch`) |
| Components | `convex.config.ts`, `ctx.runMutation(components.x.lib.fn)` | `components.ts`, `ctx.components.x.fn()`; Convex component packages don't run unmodified yet |
| Function handles | `createFunctionHandle` | ✓ (signed, so they can't be forged) |
| Dashboard | ✓ | ✓ (built in, at `/_admin`) |

## Porting a project

1. Rename `convex/` to `onebase/`, or keep the name: onebase picks it up.
2. Replace `from "convex/values"` with `from "onebase/values"`, and `from "convex/server"` with `from "onebase/server"`. `onebase doctor` lists every place to change.
3. Remove `"use node"` lines.
4. Run `onebase dev` to regenerate `_generated/`.
5. In the frontend, import from `onebase/react` instead of `convex/react`.

Data doesn't migrate automatically. Export it from Convex as JSON and insert it with a mutation.

## Components

onebase has its own [components](./components.md) and doesn't run `@convex-dev/*` packages. The common ones have built-in equivalents:

| Convex | onebase |
|---|---|
| `@convex-dev/rate-limiter` | [Rate limiter](./rate-limiter.md) |
| `@convex-dev/aggregate` | [Aggregate](./aggregate.md); it follows its table, so the triggers go away |
| `@convex-dev/sharded-counter` | [Sharded counter](./sharded-counter.md) |
| `@convex-dev/workpool` | [Work queue](./work-queue.md) |

Other components can be ported into local onebase components; their source ships in the npm package. `onebase doctor` reports a leftover `convex.config.ts`.

## Migrating with an AI agent

onebase ships a skill that walks an agent such as Claude Code through the whole migration: the inventory, imports, each component's exact before/after mapping, porting the rest, and the checks to run. To install it into a project for Claude Code:

```bash
mkdir -p .claude/skills && cp -r node_modules/onebase/skills/convex-to-onebase .claude/skills/
```

Then ask: "migrate this project from Convex to onebase". Other agents can be pointed at `node_modules/onebase/skills/convex-to-onebase/SKILL.md`, which links to the rest.
