# Porting a Convex component to a onebase component

For components with no onebase built-in, whether they come from npm (`@convex-dev/*` and others) or live in the app itself (a folder with its own `convex.config.ts`, usually `convex/components/<name>/`).

npm components are small TypeScript packages, usually Apache-2.0. Their source ships in the package under `node_modules/@convex-dev/<name>/src/`: `component/` holds the backend, and `client/` the class the app uses.

Read `node_modules/onebase/docs/components-authoring.md` first. It's the onebase API this guide targets.

## 1. Set up the files

- **Where:** create a folder outside the functions folder, for example `components/<name>/index.ts` next to `onebase/` (or `convex/`). Files inside the functions folder are loaded as app functions, and `components/` in it is reserved for mounts.
- **An app's own component already in `convex/components/<name>/`:** move it out to that folder. Its `convex.config.ts` and `_generated/` imports go away in the rewrite below.
- **What to copy from an npm package:** `src/component/schema.ts` and the component's function files. Skip `_generated/`, tests and `convex.config.ts`.
- **License, for npm packages:** keep the package's `LICENSE` and a note of where the code came from, as Apache-2.0 requires.

## 2. Rewrite the component

| Convex (inside the component) | onebase |
|---|---|
| `import { query, mutation, ... } from "./_generated/server"` | `const { query, mutation, internalMutation, ... } = componentServer<DataModelFromSchema<typeof schema>, Config>()` from `onebase/components` |
| `import { api, internal } from "./_generated/api"` (the component's own) | Remove; refer to the component's functions directly (next rows) |
| `defineSchema` / `defineTable` / `v` from `convex/server` / `convex/values` | from `onebase/server` / `onebase/values` |
| `convex.config.ts`: `defineComponent("name")` | `defineComponent({ name, schema, functions: { ... } })` |
| A function calling another function of the component: `ctx.runMutation(api.lib.foo, args)` or `internal.lib.foo` | Pass the function itself: `ctx.runMutation(foo, args)`. The same goes for `ctx.scheduler.runAfter(ms, foo, args)`. Declare `foo` before the functions that use it. |
| Module layout (`lib.ts` → `components.x.lib.add`) | Keep it with nesting: `functions: { lib: { add, list } }`, so the app calls `ctx.components.x.lib.add(...)` as before |
| `v.id("ownTable")` | Unchanged. Inside the component it refers to its own table. |
| App ids received as `v.id("users")` or similar | `v.string()`. A component can't refer to the app's tables. |
| Values the component reads with `env.X` / `process.env.X` | Put them in the component's configuration (`ctx.config`), set in `components.ts`. |
| `ctx.db.vars.commitTs` | Use `Date.now()` when it's only an ordering hint, or a counter document when grouping must be exact. Look at what the code needs. |
| `ctx.db.system` | Not available. Track the state you need in the component's own table. |
| `ctx.storage` | Not available in components. Move file handling to the app and pass storage ids in. |
| HTTP actions in `http.ts` | `http: (config) => [{ path, method, handler: httpAction(...) }]` in `defineComponent`, served under `/<mount>` by default. |
| Crons in `crons.ts` | `crons: (config) => [{ name, schedule: { minutes: 5 }, fn }]` |
| Function handles passed in by the app (`v.string()` holding a handle) | Unchanged: `ctx.runMutation(handle, args)` and `ctx.scheduler.runAfter(0, handle, args)` work with handles from `createFunctionHandle`. |
| A child component (`component.use(child)` in its convex.config) | onebase components don't nest. Port the child too, then either inline its code into the parent (simplest when the parent is its only user) or mount it beside the parent and pass the parent a handle. |

Functions built with `query`, `mutation` and `action` are the component's public API. Mark helpers `internal*`.

## 3. Replace the client class with a factory

Convex components ship a client class (`new Presence(components.presence, opts)`) whose methods call `ctx.runQuery(this.component.x, ...)`. onebase calls components directly, so:

- **Constructor options** become the component's configuration, passed once: `export function presence(opts: Config & MountOptions) { const { config, options } = splitMountOptions(opts); return definition.mount(config, options); }`.
- **Client methods that only forward to a component function** go away: call sites use `ctx.components.<mount>.<fn>(args)`.
- **Client methods with real logic** (checking auth, combining calls) become functions in the app that call `ctx.components`. Or, if the logic only uses the component's data, move it into a component function.
- **Precise types:** to type the API more precisely than the validators allow (literal names, say), give the factory a `Mount<Api>` type with `ComponentFn<...>` entries, as `node_modules/onebase/src/components/rate-limiter/index.ts` does.

## 4. Mount it and update call sites

```ts
// onebase/components.ts
import { presence } from "../components/presence";
export default defineComponents({ presence: presence({ ... }) });
```

- **Call sites:** `await presence.heartbeat(ctx, room, user)` becomes `await ctx.components.presence.heartbeat({ room, user })`, and `ctx.runMutation(components.notes.lib.add, args)` becomes `ctx.components.notes.lib.add(args)`.
- **React hooks the package shipped** (`usePresence`, say): rewrite them on onebase's `useQuery` / `useMutation`. Call either the app's own wrapper functions or the component's functions, exposed with `expose: [...]` and called as `api.components.<mount>.<fn>`.
- **Auth:** if the component needs the caller's identity, mount it with `auth: true` rather than passing user ids through.

## 5. Check it

Run `npx onebase codegen && npx onebase doctor && npx tsc --noEmit`. If the package had tests (`src/component/*.test.ts`, usually with `convex-test`), port the important cases to `bun test` against a real server (the build-onebase-component skill has the setup, under "Testing"), or at least run each function once from the dashboard. A project can't import onebase's internal `Runtime`, so `convex-test`-style tests don't carry over directly.
