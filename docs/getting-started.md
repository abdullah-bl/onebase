---
title: Quick start
description: Install onebase, run the example chat app, and create your first project.
---

# Quick start

## Install

onebase needs [Bun](https://bun.sh) 1.4 or later to develop with. The binary it builds runs anywhere, without Bun.

**Option 1: download a binary.** Prebuilt binaries are attached to each [GitHub release](https://github.com/abdullah-bl/onebase/releases):

```bash
curl -fsSL -o onebase https://github.com/abdullah-bl/onebase/releases/latest/download/onebase-linux-x64
```

```bash
sudo install onebase /usr/local/bin/onebase && rm onebase && onebase --help
```

Replace `linux-x64` with `linux-arm64`, `darwin-arm64`, `darwin-x64` or `windows-x64.exe` for your platform.

**Option 2: add it to a Bun project.** This gives you the CLI, the TypeScript types and the client libraries:

```bash
bun add github:abdullah-bl/onebase
```

```bash
bunx onebase --help
```

**Option 3: build from source.**

```bash
git clone https://github.com/abdullah-bl/onebase && cd onebase && bun install && bun run build:binary
```

The binary ends up in `dist/onebase`.

## Run the example

The repository includes several self-contained apps under [`examples/`](../examples). The chat app has channels, likes, image uploads, self-destructing messages and a cleanup cron; the others demo auth, components, vector search, background jobs and offline clients.

```bash
bun run example
```

Open http://localhost:8090 in two browser windows. Messages appear in both at once.

## Create a project

```
my-app/
  onebase/
    schema.ts      tables and indexes
    tasks.ts       your functions; the file name is the module name
  public/
    index.html     optional frontend, served at /
```

**1. Define the schema** in `onebase/schema.ts`:

```ts
import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  tasks: defineTable({
    text: v.string(),
    done: v.boolean(),
  }),
});
```

**2. Write functions** in `onebase/tasks.ts`:

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

export const toggle = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => {
    const task = await ctx.db.get(id);
    if (task) await ctx.db.patch(id, { done: !task.done });
  },
});
```

**3. Start the dev server:**

```bash
onebase dev
```

Dev mode generates `onebase/_generated/` (types for your schema and functions), restarts when a file changes, shows full error messages, and warns about slow queries.

**4. Call your functions** from a page. No build step is needed: the server serves its own client.

```html
<script type="module">
  import { OnebaseClient, anyApi as api } from "/_onebase/client.js";
  const client = new OnebaseClient();

  client.onUpdate(api.tasks.list, {}, (tasks) => {
    document.body.textContent = tasks.map((t) => `${t.done ? "✓" : "○"} ${t.text}`).join("\n");
  });

  await client.mutation(api.tasks.add, { text: "Try onebase" });
</script>
```

For React, see [Client](./client.md).

## Check your work

```bash
onebase doctor
```

`doctor` loads every file and checks the schema, indexes, imports and common mistakes. It prints a fix for each problem it finds.

## Next steps

- [Schema](./schema.md) and [Functions](./functions.md) cover the core API.
- [Deployment](./deployment.md) shows how to run it in production.
- Using an AI assistant? Give it the [LLM guide](./llm-guide.md). If you installed onebase in your project, the `node_modules/onebase/skills/` folder also has step-by-step skills for setting up an app, building a component and migrating from Convex. For Claude Code, copy the one you want: `mkdir -p .claude/skills && cp -r node_modules/onebase/skills/setup-onebase-app .claude/skills/`.
