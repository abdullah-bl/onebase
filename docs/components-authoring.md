---
title: Writing components
description: Define a component's tables, functions and configuration with defineComponent, and publish it as an npm package.
---

# Writing components

A component is a schema, some functions and, optionally, a configuration check. You write it with the same API the components that ship with onebase use (the [rate limiter](./rate-limiter.md) is a short example to read).

```ts
// counter/index.ts
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "onebase/components";
import { defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
import { v } from "onebase/values";

// 1. Tables, only the component can use them.
const schema = defineSchema({
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
});

// 2. Builders typed with those tables and the configuration.
type Config = { start: number };
const { query, mutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();

const find = (ctx: { db: any }, name: string) =>
  ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", name)).unique();

const add = mutation({
  args: { name: v.string(), by: v.optional(v.number()) },
  handler: async (ctx, { name, by = 1 }) => {
    const row = await find(ctx, name);
    const value = (row?.value ?? ctx.config.start) + by;
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("counters", { name, value });
    return value;
  },
});

const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => (await find(ctx, name))?.value ?? ctx.config.start,
});

// 3. The component.
export const definition = defineComponent({
  name: "counter",
  schema,
  functions: { add, get },
  checkConfig: (config: Config) => {
    if (typeof config?.start !== "number") throw new Error("counter({ start }) needs a number.");
  },
});

// 4. A factory apps call in components.ts.
export function counter(opts: Config & MountOptions) {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options);
}
```

The app mounts it with `counter: counter({ start: 0 })` and calls `ctx.components.counter.add({ name: "visits" })`.

## What a component's functions get

| | |
|---|---|
| `ctx.db` | The component's own tables, by their names in its schema (`"counters"`, not `"counter.counters"`). Documents are validated against its schema, always. |
| `ctx.config` | The configuration the app mounted this copy with. It can hold functions, such as a callback that picks a field. |
| `ctx.component.mount` | The name this copy is mounted under. |
| `ctx.auth` | The caller's identity when mounted with `auth: true`, otherwise always null. |
| `ctx.runQuery(fn, args)` / `ctx.runMutation(fn, args)` | Calls another of the component's functions. Pass the function itself (`ctx.runMutation(add, {...})`), since components don't have generated references. Also takes a [function handle](./components.md#function-handles) the app passed in, which can be one of the app's functions. |
| `ctx.scheduler.runAfter(ms, fn, args)` | Schedules one of the component's functions or a handle, the same way. `ctx.scheduler.cancel(id)` cancels only the component's own jobs. |
| `ctx.vectorSearch(...)` | In actions, over the component's tables. |
| `ctx.hooks.status(table?)` | Whether a table hook has caught up with its table: `{ table, state, ready }`. |

`ctx.storage` isn't available to components.

## Following a table

To keep something derived from an app table, give the component `hooks`. Each hook names the table and an internal mutation that receives the changes:

```ts
import { tableChangesValidator, type TableChange } from "onebase/components";

const onChange = internalMutation({
  args: tableChangesValidator,
  handler: async (ctx, { changes }) => {
    for (const change of changes as TableChange[]) {
      // change.op is "insert", "update" or "delete"; before and after are the documents (null when absent).
    }
    return null;
  },
});

const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    const batch = await ctx.db.query("derived").take(200);
    for (const doc of batch) await ctx.db.delete(doc._id);
    return { done: batch.length === 0 };
  },
});

export const definition = defineComponent({
  name: "follower",
  schema,
  functions: { onChange, reset /* , ...the public API */ },
  hooks: (config: Config) => [{ table: config.table, onChange, reset, fingerprint: String(config.pick) }],
});
```

How hooks run:

- **Timing:** `onChange` runs in the writing transaction, before the component is next called and before commit, with one change per document. If it throws, the writing mutation fails.
- **Existing documents:** documents already in the table arrive as inserts, 200 per transaction, after `reset` has returned `{ done: true }`. `reset` should delete what the component derived earlier, a batch per call.
- **Rebuilds:** a different `fingerprint` (typically derived from the configuration) resets and rebuilds.
- **Progress:** `ctx.hooks.status(table)` returns `{ state, ready }`, so the component can report whether it has caught up.
- **Validation:** the hooked table must be in the app's `schema.ts`. `onChange` and `reset` must be listed in the component's `functions`.

## Cron jobs and HTTP routes

```ts
const { internalMutation, httpAction } = componentServer<DataModel, Config>();

const cleanUp = internalMutation({ args: {}, handler: async (ctx) => { /* ... */ } });

export const definition = defineComponent({
  name: "sessions",
  schema,
  functions: { cleanUp /* , ... */ },
  crons: (config) => [{ name: "cleanUp", schedule: { minutes: 10 }, fn: cleanUp }],
  http: (config) => [
    { path: "/webhook", method: "POST", handler: httpAction(async (ctx, request) => new Response("ok")) },
  ],
});
```

- **Cron schedules:** an interval (`{ seconds, minutes, hours }`, at least 1 second) or a cron expression (`"0 3 * * *"`, UTC). The job must run one of the component's own functions.
- **HTTP routes:** take `path` or `pathPrefix`, relative to the mount's `httpPrefix`. Their `ctx` is the component's action ctx, so they reach the component's tables through `ctx.runQuery` and `ctx.runMutation`.

## Public and internal functions

Functions built with `query`, `mutation` and `action` are the component's API: the app can call them. Ones built with `internalQuery`, `internalMutation` and `internalAction` can only be called by the component itself, for example from its scheduler.

Group functions with nesting: `functions: { lib: { add, get } }` is called as `ctx.components.counter.lib.add()`.

## Typing the API

The app's types come from the functions' validators, with no codegen. To make them more precise than the validators can, such as accepting only the limit names the app configured, give the mount a hand-written API type, as the rate limiter does:

```ts
export type CounterApi<Name extends string> = {
  add: ComponentFn<"mutation", (args: { name: Name; by?: number }) => Promise<number>>;
  get: ComponentFn<"query", (args: { name: Name }) => Promise<number>>;
};

export function counter<const N extends string>(opts: { names: N[] } & Config & MountOptions): Mount<CounterApi<N>> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options) as Mount<CounterApi<N>>;
}
```

## Publishing

A component is an ordinary npm package that imports `onebase/components`, `onebase/server` and `onebase/values`. List `onebase` as a peer dependency: the server provides those modules itself, also to code pushed with `onebase deploy` and inside compiled binaries.
