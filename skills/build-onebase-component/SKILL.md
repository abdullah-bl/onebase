---
name: build-onebase-component
description: Build, mount, test and publish a onebase component, a reusable package with its own tables and functions called as ctx.components.<name>.<fn>(). Use when the user wants to write a component, extract a feature into one, follow a table with hooks, or package backend code for reuse in onebase. For porting a @convex-dev/* package, start with convex-to-onebase, which links back here for the API.
---

# Build a onebase component

A component is a schema, some functions and optional configuration. Apps mount it in `onebase/components.ts` and call it in their own transaction. Its tables are separate from the app's, but its code runs in the same process with no sandbox.

## First, check it should be a component

- **A built-in may already do it:** `onebase/components/rate-limiter`, `aggregate`, `sharded-counter` and `work-queue`.
- **A plain module is simpler** when one app uses the code and it doesn't need its own private tables. Suggest that instead when it fits.
- **A component doesn't protect the app.** Isolation only keeps the data apart. A slow component function blocks the whole server like any other function, and a failing table hook fails the app's write.

## Workflow

1. **Create it outside the functions folder**, at `components/<name>/index.ts` next to `onebase/`. Files inside `onebase/` load as app functions, and `onebase/components/` is reserved.

2. **Write it.** This is the whole shape:

   ```ts
   import { componentServer, defineComponent, splitMountOptions, type MountOptions } from "onebase/components";
   import { defineSchema, defineTable, type DataModelFromSchema } from "onebase/server";
   import { v } from "onebase/values";

   const schema = defineSchema({
     counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
   });

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

   export const definition = defineComponent({
     name: "counter",
     schema,
     functions: { add, get },
     checkConfig: (config: Config) => {
       if (typeof config?.start !== "number") throw new Error("counter({ start }) needs a number.");
     },
   });

   export function counter(opts: Config & MountOptions) {
     const { config, options } = splitMountOptions(opts);
     return definition.mount(config, options);
   }
   ```

3. **Mount it** in `onebase/components.ts`:

   ```ts
   import { defineComponents } from "onebase/components";
   import { counter } from "../components/counter";

   export default defineComponents({ counter: counter({ start: 0 }) });
   ```

   Then call it from the app's functions as `await ctx.components.counter.add({ name: "visits" })`.

4. **Check it:**

   ```bash
   bunx onebase codegen
   ```

   ```bash
   bunx onebase doctor
   ```

   ```bash
   bunx tsc --noEmit
   ```

5. **Test it through a real server**, as described below. Passing the checks in step 4 doesn't prove the behavior.

6. **Check it ships.** If the app uses them, run `bunx onebase build --out ./app` and `bunx onebase deploy --dry-run`, since both package the component's code. Report what you ran and what you couldn't check.

## Rules

Read `node_modules/onebase/docs/components-authoring.md` for the full API. Don't invent APIs; check there or in `node_modules/onebase/src/components/`. The rate limiter is a short example to copy.

- **`ctx.db`** sees only the component's own tables, by their names in its schema.
- **App ids are strings.** Store them with `v.string()`. `v.id("users")` can't refer to an app table from a component.
- **Calling its own functions:** pass the function itself, as in `ctx.runMutation(add, args)` or `ctx.scheduler.runAfter(0, add, args)`. There's no `_generated` folder, so declare a function before the ones that use it.
- **Calling app functions:** only through a function handle the app passes in.
- **Configuration** goes in `ctx.config`, given once when mounting. Read secrets and settings from there, not `process.env`.
- **Public or internal:** `query`, `mutation` and `action` are the API the app can call. Mark helpers `internalQuery`, `internalMutation` or `internalAction`.
- **Not available:** `ctx.storage`, and mounting a component inside a component.

## Following an app table

Use hooks instead of asking the app to call the component on every write:

```ts
import { tableChangesValidator, type TableChange } from "onebase/components";

const { internalMutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();

const onChange = internalMutation({
  args: tableChangesValidator,
  handler: async (ctx, { changes }) => {
    for (const change of changes as TableChange[]) {
      // change.op is "insert", "update" or "delete"; change.before and change.after are the documents.
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
  hooks: (config: Config) => [{ table: config.table, onChange, reset, fingerprint: config.table }],
});
```

- **`onChange` and `reset` must be in `functions`,** and the table must be in the app's schema.
- **`ctx.hooks.status(table)` returns a promise.** `await` it, or the caller gets `{}` instead of `{ table, state, ready }`.
- **Hooks add cost to writes.** `onChange` runs in the app's transaction, so its work slows every write to that table, and if it throws, the app's mutation fails. Keep it small, and don't call the network from it.
- **Existing documents arrive in the background,** 200 per transaction. Until `ready` is true, derived data is incomplete, so report that rather than returning partial results as final.
- **Changing `fingerprint` resets and rebuilds.** Derive it from the configuration that affects the derived data, and warn the user that a rebuild on a big table takes a while.

## Testing

A project can't import onebase's internal `Runtime`, so start a real server in a temporary folder and call it over HTTP. Component functions can't be called over HTTP unless they're exposed, so test through the app's own functions. Run the binary directly rather than through `bunx`, which leaves a child process behind when killed.

```ts
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "onebase-test-"));
const port = 18000 + Math.floor(Math.random() * 2000);
const url = `http://127.0.0.1:${port}`;
let server: ReturnType<typeof Bun.spawn>;

async function call(kind: "query" | "mutation" | "action", path: string, args: object = {}) {
  const res = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args }),
  });
  const body = (await res.json()) as any;
  if (body.status !== "success") throw new Error(body.errorMessage);
  return body.value;
}

beforeAll(async () => {
  server = Bun.spawn(["./node_modules/.bin/onebase", "serve", "--port", String(port), "--data", data], { stdout: "ignore", stderr: "inherit" });
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/api/health`).then((r) => r.ok, () => false)) return;
    await Bun.sleep(50);
  }
  throw new Error("server didn't start");
});

afterAll(async () => {
  server.kill();
  await server.exited;
  rmSync(data, { recursive: true, force: true });
});

test("add counts up", async () => {
  await call("mutation", "visits:record", { name: "home" }); // an app function that calls the component
  expect(await call("query", "visits:total", { name: "home" })).toBe(1);
});
```

Cover what could really go wrong: a caught component error rolling back only the component's writes, an uncaught one rolling back everything, two mounts staying separate, and, for hooks, inserts, updates, deletes and existing documents.

## Exposing and publishing

- **Exposing to clients:** `counter({ start: 0, expose: ["get"] })`. It's then callable as `api.components.counter.get`, or `components/counter:get` over HTTP. Anyone can call it with any arguments, so expose only what's safe.
- **The caller's identity:** `ctx.auth` is null unless mounted with `auth: true`. Prefer having the app check auth and pass in a key.
- **Publishing:** an ordinary package that imports `onebase/components`, `onebase/server` and `onebase/values`, with `onebase` as a peer dependency.
- **Tell the users of your component:** removing a mount keeps its documents, renaming a mount starts with empty tables, and on MySQL a component's queries read all of its documents.
