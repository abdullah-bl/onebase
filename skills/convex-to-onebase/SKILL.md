---
name: convex-to-onebase
description: Migrate a Convex backend to onebase, including its Convex components (rate-limiter, aggregate, sharded-counter, workpool and others). Use when a project has a convex/ folder or convex.config.ts and the user wants it to run on onebase, asks to "port", "move" or "migrate" from Convex, or asks how to replace a @convex-dev/* component with a onebase one.
---

# Migrate from Convex to onebase

onebase runs Convex-style code: the same `query` / `mutation` / `action`, `v.*`, `ctx.db`, `api.x.y` and React hooks. Most of a migration is changing imports. The real work is **components**: onebase has its own component system and doesn't run `@convex-dev/*` packages, so each component in `convex.config.ts` is either swapped for onebase's built-in equivalent or ported into a local onebase component.

## Workflow

Work in this order, and run the checks at each step before moving on.

1. **Inventory.** Read `convex/convex.config.ts` (if any), `convex/schema.ts` and `package.json`. List:
   - each `app.use(x)`: its package and mount name, and whether it's in the table below
   - each `new SomeComponent(components.x, ...)` client and the files that use it
   - local components: folders with their own `convex.config.ts`, usually `convex/components/<name>/`
   - `convex-helpers` imports, especially `Triggers` and `customMutation` used to feed an aggregate
   - Convex features onebase lacks (see "Stop and ask" below): search for `v.int64`, `v.bytes`, `ctx.db.system`, `ctx.db.vars`, `"use node"` and `ctx.storage` inside components.

   Show the user this list and the plan for each component before changing anything.

2. **Move the app code.** Follow [references/app-code.md](references/app-code.md): imports, the functions folder, `"use node"`, client imports. Leave `convex.config.ts` and local component folders alone; steps 3–5 replace them. Then run:

   ```bash
   npx onebase codegen && npx onebase doctor
   ```

   `doctor` lists the remaining `convex/*` imports; fix those in app files. Until components are migrated, it also reports errors for files that import `@convex-dev/*` or `convex-helpers` ("Failed to load", "Cannot find package"). Those clear up in steps 3–4.

3. **Replace components with built-ins** where one exists:

   | Convex package | onebase built-in | Mapping |
   |---|---|---|
   | `@convex-dev/rate-limiter` | `onebase/components/rate-limiter` | [rate limiter](references/components.md#rate-limiter) |
   | `@convex-dev/aggregate` | `onebase/components/aggregate` | [aggregate](references/components.md#aggregate) |
   | `@convex-dev/sharded-counter` | `onebase/components/sharded-counter` | [sharded counter](references/components.md#sharded-counter) |
   | `@convex-dev/workpool` | `onebase/components/work-queue` | [work queue](references/components.md#workpool--work-queue) |

   Mount them in `components.ts` in the functions folder (`onebase/components.ts` or `convex/components.ts`) with `defineComponents`, keeping Convex's mount names (`app.use(x, { name })`) so call sites read the same. Rewrite each call site as the mapping shows, and delete the Convex client objects. For the aggregate, also delete the triggers that fed it (`convex-helpers` `Triggers`, and `customMutation` wrappers that only existed for them): onebase's aggregate follows its table by itself.

4. **Port the other components** into local onebase components, following [references/porting.md](references/porting.md). That includes the app's own local components, which must move out of the functions folder. Port only what the app calls. If a component is large or relies on something under "Stop and ask", say so and agree on a plan with the user first.

5. **Remove Convex.** Delete `convex.config.ts`, uninstall `convex`, `convex-helpers` (once nothing imports it) and the `@convex-dev/*` packages, and delete Convex's `_generated/` (onebase writes its own).

6. **Verify.**

   ```bash
   npx onebase codegen
   npx onebase doctor
   npx tsc --noEmit
   ```

   Run the project's tests if it has any. Otherwise start `npx onebase dev`, call each migrated function once (from the dashboard at `/_admin`, Functions → Run), and check the data under Data. Report what you ran and what you couldn't check.

## Rules

- **Change behavior only where onebase requires it.** Keep function names, argument validators and return shapes, so the frontend keeps working.
- **Don't invent APIs.** If unsure whether onebase supports something, check the docs in `node_modules/onebase/docs/` (components: `components.md`, `components-authoring.md`; built-ins: `rate-limiter.md`, `aggregate.md`, `sharded-counter.md`, `work-queue.md`; general: `convex.md`, `llm-guide.md`) or the `onebase` source.
- **Ids crossing into a component are strings.** A component can't read the app's tables, and the app can't read a component's. Ids that come back from a component, such as an aggregate's `item.id` or a work queue `context`, are typed as `string`: cast them where you use them (`item.id as Id<"scores">`).
- **Keep the ordering logic.** A `sortKey` that negates its value (`-d.points`) still works as is; there's no need to turn it into `order: "desc"`.
- **Don't copy data.** Convex data doesn't move automatically. Say so, and point to `convex export` plus a mutation that inserts it. Components rebuild their own data: an aggregate backfills from its table, and rate limits and counters start fresh.

## Stop and ask

Tell the user and propose an alternative instead of guessing when you find:

- **`v.int64()` / `v.bytes()`:** onebase stores JSON. Suggest numbers or strings (bigint as a decimal string, bytes as base64), and say this changes stored data.
- **`ctx.db.system`:** onebase has no system tables API yet. Usually used for `_scheduled_functions` state, which can be replaced with the app's own status field.
- **`ctx.storage` inside a component:** onebase components can't use file storage. Keep the file handling in the app and pass storage ids to the component.
- **Components that mount other components** (`component.use(child)` in their `convex.config`): onebase components can't nest. Port the child as a sibling mount, or inline it (see porting.md).
- **Component HTTP routes behind auth or app environment variables:** check porting.md.
