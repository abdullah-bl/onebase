---
title: RAG
description: Chunk and embed documents into a searchable index, with vector, text and hybrid search.
---

# RAG

The RAG component stores your documents as embedded chunks and searches them by meaning (vector), by keyword (full text), or both. The embedder is yours — a function over your own model provider — and embedding runs in the background, so `add()` returns before the vectors exist.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { rag } from "onebase/components/rag";

export default defineComponents({
  docs: rag({ dimensions: 1536, chunking: { maxChars: 1000, overlap: 100 } }),
});
```

`dimensions` is the size of the vectors your embedder returns; it shapes the mount's vector index, so pick it when you mount.

Register your embedder once, from one of your functions — it must be an action that takes `{ texts }` and returns one vector per text:

```ts
// onebase/ai.ts
import { internalAction } from "onebase/server";
import { v } from "onebase/values";
import { embedMany } from "ai"; // or your provider's SDK

export const embed = internalAction({
  args: { texts: v.array(v.string()) },
  handler: async (_ctx, { texts }) => {
    const { embeddings } = await embedMany({ model: openai.embedding("text-embedding-3-small"), values: texts });
    return embeddings;
  },
});

// run once (a setup mutation, or the dashboard):
export const setup = mutation({
  args: {},
  handler: (ctx) => ctx.components.docs.setEmbedder({ embed: internal.ai.embed }),
});
```

The component stores the embedder as a function handle, so it survives restarts. Call `setEmbedder` again to point the mount at a different action.

## Add and search

```ts
// in a mutation
await ctx.components.docs.add({ namespace: "help", key: page.slug, title: page.title, text: page.body });

// in an action
const hits = await ctx.components.docs.search({ namespace: "help", query: "how do I reset my password", limit: 5 });
// [{ entryId, text, score, title, metadata }]
```

`add` splits `text` into chunks (or takes `chunks: string[]` as-is), stores them, and embeds them in the background; `status({ entryId })` reports `"pending"` → `"ready"`. `key` names the entry within its namespace, so you can `replace` or `delete` it later without holding the id.

`search` runs in an action (it calls the embedder). Each result is one chunk, with its entry's title and metadata and a cosine `score` (plus the entry's `importance`, if you set one). Modes:

- **`"vector"`** (default): the query is embedded and the nearest chunks come back, best first.
- **`"text"`**: full-text search over the chunk text, in relevance order (`score` is null).
- **`"hybrid"`**: both, vector scores first, every chunk once.

## Functions

| | |
|---|---|
| `setEmbedder({ embed })` | Mutation. Registers your embedder action (once per mount). |
| `add({ namespace, key?, title?, metadata?, importance?, text?, chunks? })` | Mutation. Stores an entry and schedules embedding; returns `{ entryId }`. |
| `replace({ entryId \| namespace+key, ... })` | Mutation. Adds a new entry under the same key; the old one serves until the new one is ready, then it's removed. |
| `delete({ entryId \| namespace+key })` | Mutation. Removes an entry and its chunks. |
| `search({ namespace, query, limit?, mode? })` | Action. The `limit` (default 10, at most 256) best chunks. |
| `status({ entryId })` | Query. `{ state, chunkCount, attempts, error }` for one entry. |
| `list({ namespace, paginationOpts })` | Query. A namespace's entries, oldest first. |

Namespaces keep indices apart: a help center, a per-tenant corpus, whatever you pass. Entries are only searchable within their namespace.

## Rules to keep in mind

- **Embedding is asynchronous.** Until an entry is `ready` it isn't searchable. A failed embedder marks the entry `errored` with the error; the component retries it every minute, up to 5 attempts.
- **`key` is unique per namespace** — `add` with a taken key is refused; use `replace`.
- **Chunk texts must be non-empty**; `text` that trims to nothing is refused.
- **The embedder must agree with the mount.** Vectors of the wrong size are rejected with an error naming both counts.

## Coming from Convex

The Convex component's `rag(...)` mount becomes `rag({ dimensions })` plus a one-time `setEmbedder({ embed: internal.ai.embed })` — onebase components may only call your functions through handles the app hands them, so the embedder is registered once rather than taken from mount config. `add`/`search`/`replace`/`delete`/`list` cover the same ground; metadata filtering inside `search` isn't supported yet (namespace scoping is).
