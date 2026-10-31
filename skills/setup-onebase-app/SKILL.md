---
name: setup-onebase-app
description: Set up a new onebase app, from an empty folder to a checked, running backend with a frontend and a production plan. Use when the user wants to start a project on onebase, add onebase to a repository, scaffold a schema and functions, or asks how to get a onebase backend running. For moving an existing Convex project, use convex-to-onebase instead.
---

# Set up a onebase app

onebase is a Convex-style backend: TypeScript functions, a typed document database and live queries, in one Bun process on SQLite by default.

## First, check it fits

Tell the user up front if any of these apply, and let them decide:

- **CPU-heavy work in functions** (image processing, big loops, parsing large files). Functions share one thread, so this stalls every other request. A 3-second CPU-bound function delayed a ping by 3 seconds in our tests. It needs a separate worker or service.
- **Untrusted code.** Functions and components run in the server process, with no sandbox.
- **Wanting a managed service.** onebase is self-hosted, so upgrades, backups and uptime are the user's job.
- **Needing automatic failover or several regions.** SQLite means one server. Postgres, MySQL and Turso allow several instances, but they haven't been benchmarked.

## Workflow

Run the checks at each step before moving on.

1. **Install.** It needs Bun 1.4.4 or later (`bun --version`). onebase isn't on the npm registry, so install it from GitHub:

   ```bash
   bun init -y
   ```

   ```bash
   bun add github:abdullah-bl/onebase
   ```

   Delete the `index.ts` that `bun init` creates. Add `onebase_data` to `.gitignore`, and make sure `.env.local` is listed too. Don't ignore `onebase/_generated`: commit it.

2. **Write the schema** in `onebase/schema.ts`, and add an index for each way the app looks data up:

   ```ts
   import { defineSchema, defineTable } from "onebase/server";
   import { v } from "onebase/values";

   export default defineSchema({
     tasks: defineTable({ text: v.string(), done: v.boolean() }),
   });
   ```

3. **Write functions** in `onebase/<module>.ts`. The file name is the module name, so this one is `tasks:list` over HTTP and `api.tasks.list` in code:

   ```ts
   import { v } from "onebase/values";
   import { mutation, query } from "./_generated/server";

   export const list = query({
     args: {},
     handler: (ctx) => ctx.db.query("tasks").order("desc").collect(),
   });

   export const add = mutation({
     args: { text: v.string() },
     handler: (ctx, { text }) => ctx.db.insert("tasks", { text, done: false }),
   });
   ```

   Read `node_modules/onebase/docs/llm-guide.md` before writing more. It's short and lists the mistakes that come from assuming plain Convex.

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

5. **Add a frontend** if the app has one. A page in `public/` is served at `/` and needs no build step:

   ```html
   <!doctype html>
   <script type="module">
     import { OnebaseClient, anyApi as api } from "/_onebase/client.js";
     const client = new OnebaseClient();
     client.onUpdate(api.tasks.list, {}, (tasks) => {
       document.body.textContent = tasks.map((t) => t.text).join("\n");
     });
   </script>
   ```

   For React, read `node_modules/onebase/docs/client.md`.

6. **Run it and call every function.** Passing `doctor` doesn't prove the logic works. Start `bunx onebase dev`, which listens on port 8090 and restarts on changes. If something else already uses that port, pass `--port` and change the commands below to match, and don't test against the other server. Then call each function:

   ```bash
   curl -s -X POST localhost:8090/api/mutation -H 'content-type: application/json' -d '{"path":"tasks:add","args":{"text":"hello"}}'
   ```

   ```bash
   curl -s -X POST localhost:8090/api/query -H 'content-type: application/json' -d '{"path":"tasks:list","args":{}}'
   ```

   The dashboard at `/_admin` shows the data. Its key is in `onebase_data/admin.key`. Report what you ran and what you couldn't check.

## Before production

Raise these with the user. The defaults are for getting started, and some choices can lose data:

- **Power loss.** The default `synchronous=NORMAL` survives a process crash, but a power cut or OS crash can lose the most recent commits. Set `ONEBASE_SYNCHRONOUS=FULL` if that's not acceptable. It's slower: in our tests, 4,389 against 10,665 small writes/s at 100 concurrent workers, and 152 against about 400/s one at a time. Power loss itself hasn't been tested.
- **Backups.** There are none by default. Use `--backup s3://bucket/prefix`, and test a restore (`docs/backups.md`).
- **Access.** Put the server behind HTTPS and set `--cors`. Consider `--rate-limit`. Anyone with the admin key can run code on the server. Every public function can be called by anyone, so check `ctx.auth` in the ones that need it (`docs/auth.md`).
- **Architecture.** Our benchmarks ran on arm64 only. Run your own load test on your hardware, especially on x86-64. Don't quote our numbers as a promise.

Then pick how to ship it (`docs/deployment.md`):

- **`onebase deploy`:** pushes code to a running server with no restart. `--dry-run` checks the schema against the live data first.
- **`onebase build --out ./app`:** one executable with functions and frontend inside, about 110 MB. `--target` cross-compiles.

## Gotchas

- **`bunx` starts a child process.** Killing `bunx onebase serve` can leave the server running on its port. In scripts and tests, run `./node_modules/.bin/onebase` instead.
- **`.filter()` doesn't take a document callback.** Use `.filter({ published: true })` or the `q` builder, or `collect()` and filter in JavaScript.
- **Don't pass `_id` or `_creationTime` to `insert`.** It's an error; both are set for you.
- **Only actions should call the network.** Keep mutations short, because every other write waits for the one that's running. The default limit is 10 seconds for queries and mutations and 10 minutes for actions, but it can't interrupt code that never yields.
- **Check for a built-in before writing a component:** rate limiter, aggregate, sharded counter and work queue ship with onebase. To write one, use the build-onebase-component skill.
