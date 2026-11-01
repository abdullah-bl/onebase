// AI agents with threads: message history, tool calling, usage tracking and resumable text
// streams. The model call is yours — an app action registered once per mount — so any provider
// works and the component stays out of the key business.
//
//   // onebase/components.ts
//   export default defineComponents({
//     bot: agent({ instructions: "You are helpful.", embeddingDimensions: 1536 }),
//   });
//
//   // onebase/ai.ts — your provider call
//   export const chat = internalAction({
//     args: { messages: v.array(v.any()), tools: v.optional(v.array(v.any())), instructions: v.optional(v.string()) },
//     handler: async (ctx, { messages, tools, instructions }) => {
//       // call your LLM here; return { text } or { toolCalls: [{ name, args }], usage }
//       return { text: "Hello!" };
//     },
//   });
//   // once, from a mutation: await ctx.components.bot.setChat({ chat: internal.ai.chat });
//
//   // in an action
//   const { text } = await ctx.components.bot.generateText({ threadId, prompt, tools: [weatherTool] });

import type { FunctionHandle, FunctionReference, FunctionType } from "../../api";
import { componentServer, defineComponent, splitMountOptions, type ComponentFn, type Mount, type MountOptions } from "..";
import { paginationOptsValidator } from "../../server";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v, type GenericId } from "../../values";

type Config = {
  /** Prepended to the messages of every chat call. */
  instructions?: string;
  /** Tool-call rounds per generateText() before it gives up (default 10). */
  maxSteps?: number;
  /** How many stored messages a chat call sees (default 50, most recent). */
  maxHistory?: number;
  /** Set to give threads searchable history: the vector index for message embeddings. */
  embeddingDimensions?: number;
};

/** Documents deleteThread removes in one transaction. */
const PURGE_BATCH = 500;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const storable =(value: unknown): unknown => {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
};

/** One message as the chat fn sees it. */
export type ChatMessage = { role: "user" | "assistant" | "system" | "tool"; text: string | null; name?: string; toolCalls?: unknown; toolResults?: unknown };
/** What a tool passed to generateText() looks like to the chat fn. */
export type ChatTool = { name: string; description?: string; schema?: unknown };

type RegisteredChat = { text?: string | null; toolCalls?: { name: string; args?: unknown }[]; usage?: unknown; finishReason?: string | null };

/**
 * Mounts an agent: `agent({ instructions, embeddingDimensions })`. Register its callbacks once
 * from one of your functions — `setChat({ chat })` (required) and, if you gave the mount
 * `embeddingDimensions`, optionally `setEmbedder({ embed })`.
 */
export function agent<const E extends keyof AgentApi = never>(opts: Config & MountOptions<E>): Mount<AgentApi, E> {
  const { config, options } = splitMountOptions(opts);
  if (config?.maxSteps !== undefined && !(Number.isInteger(config.maxSteps) && config.maxSteps >= 1 && config.maxSteps <= 100)) {
    throw new Error("agent(): maxSteps must be a whole number from 1 to 100.");
  }
  if (config?.maxHistory !== undefined && !(Number.isInteger(config.maxHistory) && config.maxHistory >= 1)) {
    throw new Error("agent(): maxHistory must be a whole number of at least 1.");
  }

  const schema = defineSchema({
    threads: defineTable({
      title: v.optional(v.string()),
      userId: v.optional(v.string()),
      status: v.union(v.literal("active"), v.literal("archived")),
      lastMessageAt: v.number(),
    })
      .index("by_status", ["status", "lastMessageAt"])
      .index("by_user", ["userId", "status", "lastMessageAt"]),
    messages: defineTable({
      threadId: v.string(),
      order: v.number(),
      role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system"), v.literal("tool")),
      text: v.optional(v.string()),
      name: v.optional(v.string()),
      toolCalls: v.optional(v.any()),
      toolResults: v.optional(v.any()),
      usage: v.optional(v.any()),
      error: v.optional(v.string()),
      embedding: v.optional(v.array(v.number())),
    })
      .index("by_thread_order", ["threadId", "order"])
      .searchIndex("by_text", { searchField: "text", filterFields: ["threadId"] })
      .vectorIndex("by_vector", {
        vectorField: "embedding",
        dimensions: config.embeddingDimensions ?? 2,
        filterFields: ["threadId"],
      }),
    /** Deltas of in-progress generations, so clients can follow the text as it's produced. */
    streams: defineTable({
      threadId: v.optional(v.string()),
      state: v.union(v.literal("streaming"), v.literal("complete"), v.literal("canceled")),
      ordinal: v.number(),
      createdAt: v.number(),
    }).index("by_thread", ["threadId"]),
    deltas: defineTable({
      streamId: v.string(),
      ordinal: v.number(),
      text: v.string(),
    }).index("by_stream_ordinal", ["streamId", "ordinal"]),
    /** The callback handles the app registered with setChat() and setEmbedder(). */
    settings: defineTable({ key: v.string(), handle: v.string() }).index("by_key", ["key"]),
  });

  const { query, mutation, action, internalQuery, internalMutation, internalAction } = componentServer<DataModelFromSchema<typeof schema>, Config>();

  async function setting(ctx: { db: any }, key: string): Promise<FunctionHandle<"action", any, any> | null> {
    const row = await ctx.db.query("settings").withIndex("by_key", (q: any) => q.eq("key", key)).unique();
    return (row?.handle as FunctionHandle<"action", any, any>) ?? null;
  }

  const settingRow = internalQuery({
    args: { key: v.string() },
    handler: async (ctx, { key }) => setting(ctx, key),
  });

  async function requireChat(ctx: { runQuery: any }) {
    const handle = await ctx.runQuery(settingRow, { key: "chat" });
    if (!handle) throw new Error("agent: no chat fn registered yet. Call setChat({ chat: internal.yourModule.chat }) from one of your mutations.");
    return handle;
  }

  /** Registers the app's chat fn: an action taking `{ messages, tools, instructions }` and returning `{ text }` or `{ toolCalls, usage }`. */
  const setChat = mutation({
    args: { chat: v.string() },
    handler: async (ctx, { chat }) => {
      if (!chat.startsWith("function://")) throw new Error("setChat: chat must be a function reference (internal.x.y); onebase converts it to a handle.");
      const row = await ctx.db.query("settings").withIndex("by_key", (q: any) => q.eq("key", "chat")).unique();
      if (row) await ctx.db.patch(row._id, { handle: chat });
      else await ctx.db.insert("settings", { key: "chat", handle: chat });
      return null;
    },
  });

  /** Registers the app's embedder, for searchable history: an action taking `{ texts }`, returning one vector per text. */
  const setEmbedder = mutation({
    args: { embed: v.string() },
    handler: async (ctx, { embed }) => {
      if (!config.embeddingDimensions) throw new Error("setEmbedder: this mount has no embeddingDimensions, so it can't store message embeddings.");
      if (!embed.startsWith("function://")) throw new Error("setEmbedder: embed must be a function reference (internal.x.y); onebase converts it to a handle.");
      const row = await ctx.db.query("settings").withIndex("by_key", (q: any) => q.eq("key", "embed")).unique();
      if (row) await ctx.db.patch(row._id, { handle: embed });
      else await ctx.db.insert("settings", { key: "embed", handle: embed });
      return null;
    },
  });

  // ---- Threads ----

  const createThread = mutation({
    args: { userId: v.optional(v.string()), title: v.optional(v.string()) },
    handler: async (ctx, args) => ({ threadId: await ctx.db.insert("threads", { ...args, status: "active", lastMessageAt: Date.now() }) }),
  });

  const threadRow = internalQuery({
    args: { threadId: v.string() },
    handler: async (ctx, { threadId }) => {
      const thread = await ctx.db.get(threadId as GenericId<"threads">);
      return thread && thread.lastMessageAt !== undefined ? thread : null;
    },
  });

  const threadView = (t: any) => ({ id: t._id as string, title: t.title ?? null, userId: t.userId ?? null, status: t.status as "active" | "archived", lastMessageAt: t.lastMessageAt as number });

  const getThread = query({
    args: { threadId: v.string() },
    handler: async (ctx, { threadId }) => {
      const thread = await ctx.db.get(threadId as GenericId<"threads">);
      return thread && thread.lastMessageAt !== undefined ? threadView(thread) : null;
    },
  });

  const listThreads = query({
    args: { userId: v.optional(v.string()), status: v.optional(v.union(v.literal("active"), v.literal("archived"))), paginationOpts: paginationOptsValidator },
    handler: async (ctx, { userId, status: state, paginationOpts }) => {
      const status = state ?? "active";
      const page = userId
        ? await ctx.db.query("threads").withIndex("by_user", (q: any) => q.eq("userId", userId).eq("status", status)).paginate(paginationOpts)
        : await ctx.db.query("threads").withIndex("by_status", (q: any) => q.eq("status", status)).paginate(paginationOpts);
      return { ...page, page: page.page.map(threadView) };
    },
  });

  /** Deletes up to one transaction's worth of a thread's messages and streams, and schedules the rest. */
  async function purgeThread(ctx: { db: any; scheduler: any }, threadId: string): Promise<void> {
    let left = PURGE_BATCH;
    for (const m of await ctx.db.query("messages").withIndex("by_thread_order", (q: any) => q.eq("threadId", threadId)).take(left)) {
      await ctx.db.delete(m._id);
      left--;
    }
    while (left > 0) {
      const stream = await ctx.db.query("streams").withIndex("by_thread", (q: any) => q.eq("threadId", threadId)).first();
      if (!stream) return;
      for (const d of await ctx.db.query("deltas").withIndex("by_stream_ordinal", (q: any) => q.eq("streamId", stream._id)).take(left)) {
        await ctx.db.delete(d._id);
        left--;
      }
      if (left > 0) await ctx.db.delete(stream._id); // the page wasn't full, so no deltas remain
    }
    await ctx.scheduler.runAfter(0, purgeRest, { threadId });
  }

  const purgeRest = internalMutation({
    args: { threadId: v.string() },
    handler: async (ctx, { threadId }) => {
      await purgeThread(ctx, threadId);
      return null;
    },
  });

  /** Deletes a thread right away; what it holds goes in this call, or in the background for a long thread. */
  const deleteThread = mutation({
    args: { threadId: v.string() },
    handler: async (ctx, { threadId }): Promise<boolean> => {
      const thread = await ctx.db.get(threadId as GenericId<"threads">);
      if (!thread || thread.lastMessageAt === undefined) return false;
      await ctx.db.delete(thread._id);
      await purgeThread(ctx, threadId);
      return true;
    },
  });

  // ---- Messages ----

  async function nextOrder(ctx: { db: any }, threadId: string) {
    const last = await ctx.db.query("messages").withIndex("by_thread_order", (q: any) => q.eq("threadId", threadId)).order("desc").first();
    return (last?.order ?? -1) + 1;
  }

  async function touchThread(ctx: { db: any }, threadId: string) {
    const thread = await ctx.db.get(threadId as GenericId<"threads">);
    if (thread) await ctx.db.patch(thread._id, { lastMessageAt: Date.now() });
  }

  const saveMessage = mutation({
    args: { threadId: v.string(), role: v.union(v.literal("user"), v.literal("assistant"), v.literal("system"), v.literal("tool")), text: v.optional(v.string()), name: v.optional(v.string()), toolCalls: v.optional(v.any()), toolResults: v.optional(v.any()), usage: v.optional(v.any()) },
    handler: async (ctx, args) => {
      const order = await nextOrder(ctx, args.threadId);
      const id = await ctx.db.insert("messages", { ...args, order });
      await touchThread(ctx, args.threadId);
      return id;
    },
  });

  const messageView = (m: any) => ({
    id: m._id as string,
    threadId: m.threadId as string,
    order: m.order as number,
    role: m.role as ChatMessage["role"],
    text: m.text ?? null,
    name: m.name ?? null,
    toolCalls: m.toolCalls ?? null,
    toolResults: m.toolResults ?? null,
    usage: m.usage ?? null,
    error: m.error ?? null,
  });

  const listMessages = query({
    args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
    handler: async (ctx, { threadId, paginationOpts }) => {
      const page = await ctx.db.query("messages").withIndex("by_thread_order", (q: any) => q.eq("threadId", threadId)).paginate(paginationOpts);
      return { ...page, page: page.page.map(messageView) };
    },
  });

  const history = internalQuery({
    args: { threadId: v.string(), limit: v.number() },
    handler: async (ctx, { threadId, limit }): Promise<ChatMessage[]> => {
      const rows = await ctx.db.query("messages").withIndex("by_thread_order", (q: any) => q.eq("threadId", threadId)).order("desc").take(limit);
      // A window that opens on tool results has lost the call they answer, and model APIs can reject that.
      const first = rows.reverse().findIndex((m: any) => m.role !== "tool");
      return rows.slice(first === -1 ? rows.length : first).map((m: any) => ({ role: m.role, text: m.text ?? null, name: m.name, toolCalls: m.toolCalls, toolResults: m.toolResults }));
    },
  });

  /** Embeds a message's text for searchable history (no-op unless setEmbedder was called). */
  const embedMessage = internalAction({
    args: { messageId: v.string() },
    handler: async (ctx, { messageId }) => {
      const embed = await ctx.runQuery(settingRow, { key: "embed" });
      if (!embed) return null;
      const row = await ctx.runQuery(messageRow, { messageId });
      if (!row?.text) return null;
      const [vector] = (await ctx.runAction(embed, { texts: [row.text] })) as unknown[];
      if (!Array.isArray(vector) || vector.length !== config.embeddingDimensions) {
        throw new Error(`agent: the embedder returned ${Array.isArray(vector) ? vector.length : "no"} dimensions, this mount indexes ${config.embeddingDimensions}.`);
      }
      await ctx.runMutation(setEmbedding, { messageId, vector });
      return null;
    },
  });

  const messageRow = internalQuery({
    args: { messageId: v.string() },
    handler: async (ctx, { messageId }) => {
      const row = await ctx.db.get(messageId as GenericId<"messages">);
      return row && row.order !== undefined ? row : null;
    },
  });

  const setEmbedding = internalMutation({
    args: { messageId: v.string(), vector: v.array(v.number()) },
    handler: async (ctx, { messageId, vector }) => {
      await ctx.db.patch(messageId as GenericId<"messages">, { embedding: vector });
      return null;
    },
  });

  /** Searches a thread's own history by meaning. Needs setEmbedder() and embeddingDimensions. */
  const searchMessages = action({
    args: { threadId: v.string(), query: v.string(), limit: v.optional(v.number()) },
    handler: async (ctx, args) => {
      const embed = await ctx.runQuery(settingRow, { key: "embed" });
      if (!embed) throw new Error("searchMessages: no embedder registered. Call setEmbedder({ embed: internal.yourModule.embed }) from one of your mutations.");
      const limit = args.limit ?? 10;
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("searchMessages: limit must be a whole number from 1 to 256.");
      const [vector] = (await ctx.runAction(embed, { texts: [args.query] })) as unknown[];
      if (!Array.isArray(vector) || vector.length !== config.embeddingDimensions) {
        throw new Error(`searchMessages: the embedder returned ${Array.isArray(vector) ? vector.length : "no"} dimensions, this mount indexes ${config.embeddingDimensions}.`);
      }
      const hits = await ctx.vectorSearch("messages", "by_vector", { vector, limit, filter: (q: any) => q.eq("threadId", args.threadId) });
      const out = [];
      for (const hit of hits) {
        const row = await ctx.runQuery(messageRow, { messageId: hit._id });
        if (row) out.push({ ...messageView(row), score: hit._score });
      }
      return out;
    },
  });

  // ---- Generation ----

  /** Runs the chat loop: saves the prompt, calls the model, runs tools, saves the reply. */
  const generateText = action({
    args: {
      threadId: v.string(),
      prompt: v.optional(v.string()),
      tools: v.optional(v.array(v.object({ name: v.string(), kind: v.union(v.literal("query"), v.literal("mutation"), v.literal("action")), fn: v.string(), description: v.optional(v.string()), schema: v.optional(v.any()) }))),
      maxSteps: v.optional(v.number()),
    },
    handler: async (ctx, args) => {
      const chat = await requireChat(ctx);
      const maxSteps = args.maxSteps ?? config.maxSteps ?? 10;
      const tools = args.tools ?? [];
      const byName = new Map(tools.map((t) => [t.name, t]));
      const run = async (kind: FunctionType, fn: string, fnArgs: unknown): Promise<unknown> => {
        if (kind === "query") return ctx.runQuery(fn as FunctionHandle<"query">, fnArgs as any);
        if (kind === "mutation") return ctx.runMutation(fn as FunctionHandle<"mutation">, fnArgs as any);
        return ctx.runAction(fn as FunctionHandle<"action">, fnArgs as any);
      };

      if (args.prompt !== undefined) {
        const id = await ctx.runMutation(saveMessage, { threadId: args.threadId, role: "user", text: args.prompt });
        await ctx.scheduler.runAfter(0, embedMessage, { messageId: id });
      }

      for (let step = 0; step < maxSteps; step++) {
        const messages = await ctx.runQuery(history, { threadId: args.threadId, limit: config.maxHistory ?? 50 });
        const response = storable(await ctx.runAction(chat, { messages, tools: tools.map(({ name, description, schema: s }) => ({ name, description, schema: s })), instructions: config.instructions })) as RegisteredChat;
        if (!response || (typeof response !== "object")) throw new Error("agent: the chat fn must return an object.");
        const toolCalls = Array.isArray(response.toolCalls) ? response.toolCalls : [];

        if (toolCalls.length === 0) {
          const messageId = await ctx.runMutation(saveMessage, { threadId: args.threadId, role: "assistant", text: response.text ?? "", usage: response.usage ?? undefined });
          await ctx.scheduler.runAfter(0, embedMessage, { messageId });
          return { threadId: args.threadId, messageId, text: response.text ?? "" };
        }

        const toolResults: { name: string; result?: unknown; error?: string }[] = [];
        for (const call of toolCalls) {
          const tool = byName.get(call.name);
          if (!tool) {
            toolResults.push({ name: call.name, error: `Unknown tool "${call.name}".` });
            continue;
          }
          try {
            toolResults.push({ name: call.name, result: storable(await run(tool.kind, tool.fn, call.args ?? {})) });
          } catch (err) {
            toolResults.push({ name: call.name, error: message(err) });
          }
        }
        await ctx.runMutation(saveMessage, { threadId: args.threadId, role: "assistant", text: response.text ?? undefined, toolCalls, usage: response.usage ?? undefined });
        await ctx.runMutation(saveMessage, { threadId: args.threadId, role: "tool", name: toolCalls.map((c) => c.name).join(","), toolResults });
      }
      throw new Error(`agent: the chat fn kept calling tools for ${maxSteps} steps without a final answer. Raise maxSteps or check your chat fn.`);
    },
  });

  // ---- Streams (a generation's text as it's produced) ----

  const createStream = mutation({
    args: { threadId: v.optional(v.string()) },
    handler: async (ctx, { threadId }) => ({ streamId: await ctx.db.insert("streams", { threadId, state: "streaming", ordinal: 0, createdAt: Date.now() }) }),
  });

  /** Appends one chunk of text to a stream. Returns the delta's ordinal. */
  const addDelta = mutation({
    args: { streamId: v.string(), text: v.string() },
    handler: async (ctx, { streamId, text }) => {
      const stream = await ctx.db.get(streamId as GenericId<"streams">);
      if (!stream || stream.state !== "streaming") throw new Error("addDelta: the stream isn't streaming.");
      const ordinal = stream.ordinal;
      await ctx.db.insert("deltas", { streamId, ordinal, text });
      await ctx.db.patch(stream._id, { ordinal: ordinal + 1 });
      return ordinal;
    },
  });

  const finishStream = mutation({
    args: { streamId: v.string() },
    handler: async (ctx, { streamId }) => {
      const stream = await ctx.db.get(streamId as GenericId<"streams">);
      if (!stream) throw new Error("finishStream: no such stream.");
      await ctx.db.patch(stream._id, { state: "complete" });
      return null;
    },
  });

  const cancelStream = mutation({
    args: { streamId: v.string() },
    handler: async (ctx, { streamId }) => {
      const stream = await ctx.db.get(streamId as GenericId<"streams">);
      if (!stream) throw new Error("cancelStream: no such stream.");
      await ctx.db.patch(stream._id, { state: "canceled" });
      return null;
    },
  });

  const streamStatus = query({
    args: { streamId: v.string() },
    handler: async (ctx, { streamId }) => {
      const stream = await ctx.db.get(streamId as GenericId<"streams">);
      return stream ? { id: stream._id as string, threadId: stream.threadId ?? null, state: stream.state as "streaming" | "complete" | "canceled", deltas: stream.ordinal as number } : null;
    },
  });

  /** The stream's text so far, from `cursor` on, a page at a time. A delta bigger than `maxSize` comes back whole, alone in its page. */
  const getStreamChunks = query({
    args: { streamId: v.string(), cursor: v.optional(v.number()), maxSize: v.optional(v.number()) },
    handler: async (ctx, { streamId, cursor = 0, maxSize = 8_000 }) => {
      const stream = await ctx.db.get(streamId as GenericId<"streams">);
      if (!stream) return { text: "", cursor, done: true };
      // Deltas hold at least a character each, so a page never needs more than this many.
      const deltas = await ctx.db.query("deltas").withIndex("by_stream_ordinal", (q: any) => q.eq("streamId", streamId).gte("ordinal", cursor)).take(Math.max(1, Math.ceil(maxSize)) + 1);
      let text = "";
      let last = cursor;
      for (const d of deltas) {
        if (last > cursor && text.length + d.text.length > maxSize) break;
        text += d.text;
        last = d.ordinal + 1;
      }
      return { text, cursor: last, done: stream.state !== "streaming" && last >= stream.ordinal };
    },
  });

  const definition = defineComponent({
    name: "agent",
    schema,
    functions: {
      setChat, setEmbedder, createThread, getThread, listThreads, deleteThread, saveMessage, listMessages, generateText, searchMessages,
      createStream, addDelta, finishStream, cancelStream, streamStatus, getStreamChunks,
      threadRow, messageRow, history, settingRow, embedMessage, setEmbedding, purgeRest,
    },
  });

  return definition.mount(config, options) as unknown as Mount<AgentApi, E>;
}

// ---- Types for the app ----

export type AgentMessage = { id: string; threadId: string; order: number; role: "user" | "assistant" | "system" | "tool"; text: string | null; name: string | null; toolCalls: unknown; toolResults: unknown; usage: unknown; error: string | null };
export type AgentThread = { id: string; title: string | null; userId: string | null; status: "active" | "archived"; lastMessageAt: number };
export type AgentTool<Kind extends FunctionType = FunctionType> = { name: string; kind: Kind; fn: FunctionReference<Kind, any, any, any>; description?: string; schema?: unknown };
export type GenerateResult = { threadId: string; messageId: string; text: string };

type ChatFn = FunctionReference<"action", any, { messages: ChatMessage[]; tools: ChatTool[]; instructions?: string }, RegisteredChat>;
type EmbedFn = FunctionReference<"action", any, { texts: string[] }, number[][]>;

export type AgentApi = {
  setChat: ComponentFn<"mutation", (args: { chat: ChatFn | string }) => Promise<null>>;
  setEmbedder: ComponentFn<"mutation", (args: { embed: EmbedFn | string }) => Promise<null>>;
  createThread: ComponentFn<"mutation", (args: { userId?: string; title?: string }) => Promise<{ threadId: string }>>;
  getThread: ComponentFn<"query", (args: { threadId: string }) => Promise<AgentThread | null>>;
  listThreads: ComponentFn<"query", (args: { userId?: string; status?: "active" | "archived"; paginationOpts: { numItems: number; cursor: string | null } }) => Promise<{ page: AgentThread[]; isDone: boolean; continueCursor: string }>>;
  deleteThread: ComponentFn<"mutation", (args: { threadId: string }) => Promise<boolean>>;
  saveMessage: ComponentFn<"mutation", (args: { threadId: string; role: ChatMessage["role"]; text?: string; name?: string; toolCalls?: unknown; toolResults?: unknown }) => Promise<string>>;
  listMessages: ComponentFn<"query", (args: { threadId: string; paginationOpts: { numItems: number; cursor: string | null } }) => Promise<{ page: AgentMessage[]; isDone: boolean; continueCursor: string }>>;
  generateText: ComponentFn<"action", (args: { threadId: string; prompt?: string; tools?: AgentTool[]; maxSteps?: number }) => Promise<GenerateResult>>;
  searchMessages: ComponentFn<"action", (args: { threadId: string; query: string; limit?: number }) => Promise<(AgentMessage & { score: number })[]>>;
  createStream: ComponentFn<"mutation", (args: { threadId?: string }) => Promise<{ streamId: string }>>;
  addDelta: ComponentFn<"mutation", (args: { streamId: string; text: string }) => Promise<number>>;
  finishStream: ComponentFn<"mutation", (args: { streamId: string }) => Promise<null>>;
  cancelStream: ComponentFn<"mutation", (args: { streamId: string }) => Promise<null>>;
  streamStatus: ComponentFn<"query", (args: { streamId: string }) => Promise<{ id: string; threadId: string | null; state: "streaming" | "complete" | "canceled"; deltas: number } | null>>;
  getStreamChunks: ComponentFn<"query", (args: { streamId: string; cursor?: number; maxSize?: number }) => Promise<{ text: string; cursor: number; done: boolean }>>;
};
