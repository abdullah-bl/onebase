---
title: Agent
description: AI agents with threads, tool calling, usage tracking and streamable output — over any model provider you bring.
---

# Agent

The agent component gives your AI features the plumbing around the model: threads with ordered message history, a tool-calling loop, per-message usage, and text streams your clients can follow while a generation is running. The model call itself is yours — one action you write against any provider — registered once with the component.

## Set it up

```ts
// onebase/components.ts
import { defineComponents } from "onebase/components";
import { agent } from "onebase/components/agent";

export default defineComponents({
  bot: agent({ instructions: "You are concise.", maxSteps: 10, embeddingDimensions: 1536 }),
});
```

`instructions` is prepended to every chat call; `embeddingDimensions` (optional) gives threads searchable history.

Register your chat fn once, from one of your functions. It's an action that takes the conversation and returns the model's answer:

```ts
// onebase/ai.ts
import { internalAction } from "onebase/server";
import { v } from "onebase/values";
import { generateText } from "ai"; // or your provider's SDK

export const chat = internalAction({
  args: { messages: v.array(v.any()), tools: v.optional(v.array(v.any())), instructions: v.optional(v.string()) },
  handler: async (_ctx, { messages, tools, instructions }) => {
    const { text, usage } = await myModelCall({ messages, tools, system: instructions });
    return { text, usage }; // or { toolCalls: [{ name, args }], usage }
  },
});

// once (a setup mutation or the dashboard):
export const setup = mutation({
  args: {},
  handler: (ctx) => ctx.components.bot.setChat({ chat: internal.ai.chat }),
});
```

With `embeddingDimensions` set you can also register an embedder (`setEmbedder({ embed: internal.ai.embed })`) for `searchMessages`.

## Chat

```ts
// in an action
const { threadId } = await ctx.components.bot.createThread({ userId, title: "Support" });
const { text } = await ctx.components.bot.generateText({ threadId, prompt: "What's the weather in Paris?" });
```

`generateText` saves the prompt, sends the thread's recent history (the last `maxHistory`, default 50 messages) plus your tools to the chat fn, and saves the reply. If the model answers with tool calls, the component runs each tool — `kind` says whether it's a query, mutation or action — saves the results as a `tool` message, and calls the model again, up to `maxSteps` rounds. A tool that throws is reported to the model as an error result instead of failing the generation. Every assistant message keeps the response's `usage`.

```ts
const { text } = await ctx.components.bot.generateText({
  threadId,
  prompt,
  tools: [{ name: "weather", kind: "mutation", fn: internal.tools.weather, description: "Current weather", schema: { city: "string" } }],
});
```

Read a thread with `listMessages` (a live query — clients re-render as messages land) and search one with `searchMessages({ threadId, query })`, which embeds the query and matches message embeddings within that thread.

## Streams

To show text as it's produced, run the provider call in your own action and persist the pieces through the component's stream functions:

```ts
// in your streaming action
const { streamId } = await ctx.components.bot.createStream({ threadId });
for await (const delta of myStream) await ctx.components.bot.addDelta({ streamId, text: delta });
await ctx.components.bot.finishStream({ streamId });
```

Clients poll `getStreamChunks({ streamId, cursor })` (a live query — `{ text, cursor, done }`, a page at a time) and see the text grow. `cancelStream` marks a stream abandoned.

## Functions

| | |
|---|---|
| `setChat({ chat })` | Mutation. Registers your chat fn (once per mount; call again to change it). |
| `setEmbedder({ embed })` | Mutation. Registers your embedder for searchable history. |
| `createThread({ userId?, title? })` | Mutation. Returns `{ threadId }`. |
| `getThread({ threadId })` / `listThreads({ userId?, status?, paginationOpts })` | Queries. |
| `deleteThread({ threadId })` | Mutation. Removes the thread, its messages and streams. |
| `saveMessage({ threadId, role, text?, ... })` | Mutation. Appends a message by hand. |
| `listMessages({ threadId, paginationOpts })` | Live query. |
| `generateText({ threadId, prompt?, tools?, maxSteps? })` | Action. The chat loop; returns `{ threadId, messageId, text }`. |
| `searchMessages({ threadId, query, limit? })` | Action. Semantic search over one thread's messages. |
| `createStream / addDelta / finishStream / cancelStream` | Mutations. Persist a generation's text as it's produced. |
| `streamStatus({ streamId })` / `getStreamChunks({ streamId, cursor?, maxSize? })` | Queries. |

## Rules to keep in mind

- **The chat fn and embedder are registered, not mounted.** onebase components call your functions only through handles the app hands them, so callbacks are registered once from your code rather than passed in mount config.
- **`generateText` is an action.** Each `saveMessage` commits on its own, so a failed generation leaves the messages it saved — history stays truthful.
- **Threads are private by convention.** Nothing checks that a caller owns a thread; check `userId` in your own functions before passing a threadId through.
- **Expose with care.** If you expose `getStreamChunks` or `listMessages` to clients, remember anyone can call them with any arguments — gate them behind your own functions unless a public read is what you want.

## Coming from Convex

The Convex component's `agent({...})` with AI-SDK models becomes `agent({ instructions })` plus a registered `chat` action — the model code moves from mount config into your own action, which is where onebase's capability model wants it. Threads, `generateText` with tools, message listing and usage tracking map one-to-one; streaming uses the component's own stream functions instead of a separate `persistent-text-streaming` mount (onebase components can't nest).
