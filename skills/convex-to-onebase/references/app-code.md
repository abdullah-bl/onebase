# App code: Convex → onebase

## Folder and imports

This covers app files: schema, functions, `http.ts`, `crons.ts` and the frontend. Don't apply it to `convex.config.ts` (it's deleted) or to local component folders (porting.md covers them). `defineApp` and `defineComponent` don't exist in `onebase/server`.

- **Folder:** keep `convex/` (onebase picks it up when there's no `onebase/` folder) or rename it to `onebase/`.
- **Imports:**

  | Convex | onebase |
  |---|---|
  | `from "convex/server"` | `from "onebase/server"` |
  | `from "convex/values"` | `from "onebase/values"` |
  | `from "convex/react"` | `from "onebase/react"` (`ConvexProvider` and `ConvexReactClient` are aliases) |
  | `from "convex/browser"` | `from "onebase/browser"` |
  | `from "./_generated/server"` | unchanged (onebase generates it) |
  | `from "./_generated/api"` | unchanged |
  | `from "./_generated/dataModel"` | unchanged |

- **`"use node"`:** remove these lines. Every onebase function runs in Bun with npm packages available, and only actions may call `fetch`.
- **Codegen:** `npx convex dev` / `npx convex codegen` become `npx onebase dev` / `npx onebase codegen`.

## What works as it is

These need no change:
- `defineSchema`, `defineTable`, `.index`, `.searchIndex`, `.vectorIndex`, and `v.*` except `int64` and `bytes`
- `ctx.db` with `withIndex`, `withSearchIndex`, `filter`, `order`, `paginate`, `first`, `unique`, `take` and `collect`
- the table-first forms `ctx.db.get("table", id)`, `patch("table", id, v)`, `replace("table", id, v)` and `delete("table", id)`, as well as the id-only forms
- `ctx.scheduler`, `cronJobs()`, `httpRouter` / `httpAction`
- `ctx.storage`, `ctx.auth.getUserIdentity()`, `ctx.vectorSearch`
- `ConvexError`, `paginationOptsValidator`, `createFunctionHandle`
- `useQuery`, `useMutation`, `useAction`, `usePaginatedQuery`, and optimistic updates

## Differences to handle

- **Auth:** a Convex `auth.config.ts` with JWT providers (Clerk, Auth0, WorkOS, any OIDC provider) works as is. Convex Auth (`@convex-dev/auth`) maps to onebase's built-in sign-in; read `docs/auth.md`. Spread `authTables` into the schema and replace `useAuthActions` imports with `onebase/react`.
- **Environment variables:** read `process.env` as usual. onebase loads `.env` and `.env.local` itself.
- **Deploy:** `npx convex deploy` becomes `npx onebase deploy --url <server>`, or `onebase build` for a single binary. Read `docs/deployment.md`.
- **Not supported:** `ctx.db.system` and `v.int64` / `v.bytes`. See SKILL.md, "Stop and ask".

## Checks

`npx onebase doctor` reports `convex/*` imports, `.filter()` called with a document callback instead of a filter builder, missing indexes, and stale generated files. Run it after every batch of changes.
