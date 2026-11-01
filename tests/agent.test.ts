import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineComponents } from "../src/components";
import { agent } from "../src/components/agent";
import type { Driver } from "../src/engine/driver";
import type { Runtime } from "../src/engine/runtime";
import { anyApi, action, defineSchema, defineTable, internalAction, internalMutation, mutation, query } from "../src/server";
import { v } from "../src/values";
import { DRIVERS, openRuntime } from "./helpers";

const internal = anyApi;

type Script = "echo" | "tools" | "loop" | "unknownTool";
let script: Script = "echo";
let lastCall: { messages: any[]; tools: any[]; instructions?: string } | null = null;

const chat = internalAction({
  args: { messages: v.array(v.any()), tools: v.optional(v.array(v.any())), instructions: v.optional(v.string()) },
  handler: async (_ctx, { messages, tools, instructions }) => {
    lastCall = { messages, tools: tools ?? [], instructions };
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const sawTool = messages.some((m) => m.role === "tool");
    if (script === "tools") {
      if (sawTool) return { text: `weather:${messages.find((m) => m.role === "tool").toolResults[0].result}`, usage: { in: 3, out: 1 } };
      return { toolCalls: [{ name: "weather", args: { city: "Paris" } }], usage: { in: 10, out: 2 } };
    }
    if (script === "loop") return { toolCalls: [{ name: "weather", args: { city: "Nowhere" } }] };
    if (script === "unknownTool") {
      if (sawTool) return { text: "done anyway" };
      return { toolCalls: [{ name: "nope", args: {} }] };
    }
    return { text: `echo:${lastUser?.text ?? ""}`, usage: { in: 1, out: 1 } };
  },
});

const embed = internalAction({
  args: { texts: v.array(v.string()) },
  handler: async (_ctx, { texts }) => texts.map((t) => [t.includes("rain") ? 1 : 0, t.length % 2, 0.5]),
});

const components = defineComponents({
  bot: agent({ instructions: "be brief", embeddingDimensions: 3 }),
  other: agent({}),
  short: agent({ maxHistory: 3 }),
});

const schema = defineSchema({
  log: defineTable({ text: v.string() }),
});

const modules = {
  ai: { chat, embed },
  tools: {
    weather: internalMutation({
      args: { city: v.string() },
      handler: async (ctx, { city }) => {
        await ctx.db.insert("log", { text: `checked ${city}` });
        return `sunny in ${city}, 21C`;
      },
    }),
  },
  admin: {
    init: mutation({ args: {}, handler: (ctx: any) => ctx.components.bot.setChat({ chat: internal.ai.chat }) }),
    initEmbed: mutation({ args: {}, handler: (ctx: any) => ctx.components.bot.setEmbedder({ embed: internal.ai.embed }) }),
    initShort: mutation({ args: {}, handler: (ctx: any) => ctx.components.short.setChat({ chat: internal.ai.chat }) }),
    createThread: mutation({ args: { title: v.optional(v.string()), userId: v.optional(v.string()), mount: v.optional(v.string()) }, handler: (ctx: any, { mount = "bot", ...args }) => ctx.components[mount].createThread(args) }),
    generate: action({
      args: { threadId: v.string(), prompt: v.string(), maxSteps: v.optional(v.number()), mount: v.optional(v.string()) },
      handler: (ctx: any, { mount = "bot", ...args }) => ctx.components[mount].generateText({ ...args, tools: [{ name: "weather", kind: "mutation", fn: internal.tools.weather, description: "current weather" }] }),
    }),
    messages: query({ args: { threadId: v.string() }, handler: (ctx: any, { threadId }) => ctx.components.bot.listMessages({ threadId, paginationOpts: { numItems: 50, cursor: null } }) }),
    threads: query({ args: { userId: v.optional(v.string()), status: v.optional(v.union(v.literal("active"), v.literal("archived"))), mount: v.optional(v.string()) }, handler: (ctx: any, { mount = "bot", ...args }) => ctx.components[mount].listThreads({ ...args, paginationOpts: { numItems: 50, cursor: null } }) }),
    thread: query({ args: { threadId: v.string() }, handler: (ctx: any, { threadId }) => ctx.components.bot.getThread({ threadId }) }),
    deleteThread: mutation({ args: { threadId: v.string() }, handler: (ctx: any, { threadId }) => ctx.components.bot.deleteThread({ threadId }) }),
    searchMessages: action({ args: { threadId: v.string(), query: v.string() }, handler: (ctx: any, { threadId, query }) => ctx.components.bot.searchMessages({ threadId, query }) }),
    createStream: mutation({ args: {}, handler: (ctx: any) => ctx.components.bot.createStream({}) }),
    addDelta: mutation({ args: { streamId: v.string(), text: v.string() }, handler: (ctx: any, { streamId, text }) => ctx.components.bot.addDelta({ streamId, text }) }),
    finishStream: mutation({ args: { streamId: v.string() }, handler: (ctx: any, { streamId }) => ctx.components.bot.finishStream({ streamId }) }),
    streamStatus: query({ args: { streamId: v.string() }, handler: (ctx: any, { streamId }) => ctx.components.bot.streamStatus({ streamId }) }),
    streamChunks: query({ args: { streamId: v.string(), cursor: v.optional(v.number()), maxSize: v.optional(v.number()) }, handler: (ctx: any, args) => ctx.components.bot.getStreamChunks(args) }),
    logCount: query({ args: {}, handler: async (ctx) => (await ctx.db.query("log").collect()).length }),
  },
};

for (const D of DRIVERS) describe(`${D.name}: agent`, () => {
  let dir: string;
  let driver: Driver;
  let runtime: Runtime;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "onebase-agent-"));
    ({ driver, runtime } = await openRuntime(() => D.make(dir), { schema, modules, components: components as any }));
    await runtime.startScheduler();
    script = "echo";
    lastCall = null;
  });

  afterEach(async () => {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const thread = async (args: Record<string, unknown> = {}) => (await runtime.runMutation("admin:createThread", args)) as { threadId: string };
  const q = async (name: string, args: Record<string, unknown> = {}) => (await runtime.runQuery(name, args)).value as any;
  const messages = async (threadId: string) => ((await runtime.runQuery("admin:messages", { threadId })).value as any).page as any[];
  const until = async (check: () => Promise<boolean>, ms = 5000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (await check()) return;
    throw new Error("timed out waiting");
  };

  test("generateText saves the prompt and reply and reports the text", async () => {
    await runtime.runMutation("admin:init", {});
    const { threadId } = await thread({ title: "Hello", userId: "u1" });
    const result = (await runtime.runAction("admin:generate", { threadId, prompt: "hi there" })) as any;
    expect(result.text).toBe("echo:hi there");
    const msgs = await messages(threadId);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.usage).toEqual({ in: 1, out: 1 });
    expect(lastCall!.instructions).toBe("be brief");
    expect(await q("admin:thread", { threadId })).toMatchObject({ title: "Hello", userId: "u1" });
  });

  test("runs tools and feeds their results back to the model", async () => {
    await runtime.runMutation("admin:init", {});
    script = "tools";
    const { threadId } = await thread();
    const result = (await runtime.runAction("admin:generate", { threadId, prompt: "weather?" })) as any;
    expect(result.text).toBe("weather:sunny in Paris, 21C");
    expect(await q("admin:logCount")).toBe(1);
    const msgs = await messages(threadId);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs[1]!.toolCalls).toEqual([{ name: "weather", args: { city: "Paris" } }]);
    expect(msgs[2]!.toolResults[0]).toMatchObject({ name: "weather", result: "sunny in Paris, 21C" });
    expect(lastCall!.tools.map((t: any) => t.name)).toEqual(["weather"]);
  });

  test("gives up after maxSteps when the model keeps calling tools", async () => {
    await runtime.runMutation("admin:init", {});
    script = "loop";
    const { threadId } = await thread();
    await expect(runtime.runAction("admin:generate", { threadId, prompt: "x", maxSteps: 2 })).rejects.toThrow("kept calling tools");
  });

  test("an unknown tool is reported to the model instead of crashing", async () => {
    await runtime.runMutation("admin:init", {});
    script = "unknownTool";
    const { threadId } = await thread();
    const result = (await runtime.runAction("admin:generate", { threadId, prompt: "x" })) as any;
    expect(result.text).toBe("done anyway");
    const msgs = await messages(threadId);
    expect(msgs[2]!.toolResults[0]).toMatchObject({ name: "nope", error: 'Unknown tool "nope".' });
  });

  test("a mount without setChat refuses to generate", async () => {
    const { threadId } = await thread();
    await expect(runtime.runAction("admin:generate", { threadId, prompt: "x" })).rejects.toThrow("no chat fn registered");
  });

  test("searchMessages finds a thread's own messages by meaning", async () => {
    await runtime.runMutation("admin:init", {});
    await runtime.runMutation("admin:initEmbed", {});
    const { threadId } = await thread();
    await runtime.runAction("admin:generate", { threadId, prompt: "will it rain tomorrow" });
    const other = await thread();
    await runtime.runAction("admin:generate", { threadId: other.threadId, prompt: "sunny skies" });
    await until(async () => ((await runtime.runAction("admin:searchMessages", { threadId, query: "rain" })) as any[]).length > 0);
    const hits = (await runtime.runAction("admin:searchMessages", { threadId, query: "rain" })) as any[];
    // The prompt and its echo both mention rain and both got embedded.
    expect(hits).toHaveLength(2);
    for (const hit of hits) expect(hit.text).toContain("rain");
    expect(hits[0]!.score).toBeGreaterThan(0);
    // The other thread's sunny message stays out.
    const otherHits = (await runtime.runAction("admin:searchMessages", { threadId: (await q("admin:threads", {})).page[0].id, query: "rain" })) as any[];
    expect(otherHits.every((h) => !h.text.includes("sunny"))).toBe(true);
  });

  test("streams accumulate deltas for clients to follow", async () => {
    const { streamId } = (await runtime.runMutation("admin:createStream", {})) as any;
    expect(await runtime.runMutation("admin:addDelta", { streamId, text: "he" })).toBe(0);
    expect(await runtime.runMutation("admin:addDelta", { streamId, text: "llo" })).toBe(1);
    expect(await q("admin:streamChunks", { streamId })).toMatchObject({ text: "hello", cursor: 2, done: false });
    await runtime.runMutation("admin:finishStream", { streamId });
    expect(await q("admin:streamStatus", { streamId })).toMatchObject({ state: "complete", deltas: 2 });
    expect(await q("admin:streamChunks", { streamId })).toMatchObject({ text: "hello", done: true });
    await expect(runtime.runMutation("admin:addDelta", { streamId, text: "x" })).rejects.toThrow("isn't streaming");
  });

  test("getStreamChunks always advances, even past a delta bigger than maxSize", async () => {
    const { streamId } = (await runtime.runMutation("admin:createStream", {})) as any;
    const big = "x".repeat(9_000);
    await runtime.runMutation("admin:addDelta", { streamId, text: big });
    await runtime.runMutation("admin:addDelta", { streamId, text: "aaa" });
    await runtime.runMutation("admin:addDelta", { streamId, text: "bbb" });
    expect(await q("admin:streamChunks", { streamId })).toMatchObject({ text: big, cursor: 1 });
    expect(await q("admin:streamChunks", { streamId, cursor: 1, maxSize: 4 })).toMatchObject({ text: "aaa", cursor: 2 });
    expect(await q("admin:streamChunks", { streamId, cursor: 2, maxSize: 4 })).toMatchObject({ text: "bbb", cursor: 3, done: false });
  });

  test("deleting a long thread finishes in the background, and leaves other threads alone", async () => {
    const long = await thread({ userId: "a" });
    const other = await thread({ userId: "b" });
    await runtime.adminWrite(async (db) => {
      // Past one 500-document batch in both messages and deltas, so each path has to continue.
      for (let order = 0; order < 520; order++) await db.insert("bot.messages", { threadId: long.threadId, order, role: "user", text: "hi" });
      await db.insert("bot.messages", { threadId: other.threadId, order: 0, role: "user", text: "stay" });
      const stream = await db.insert("bot.streams", { threadId: long.threadId, state: "streaming", ordinal: 0, createdAt: Date.now() });
      for (let ordinal = 0; ordinal < 520; ordinal++) await db.insert("bot.deltas", { streamId: stream, ordinal, text: "x" });
    });
    expect(await runtime.runMutation("admin:deleteThread", { threadId: long.threadId })).toBe(true);
    expect(await q("admin:thread", { threadId: long.threadId })).toBeNull();
    const count = async (table: string) => {
      let n = 0;
      await runtime.adminWrite(async (db) => void (n = (await db.query(table).collect()).length));
      return n;
    };
    await until(async () => (await count("bot.messages")) === 1 && (await count("bot.streams")) === 0 && (await count("bot.deltas")) === 0, 25_000);
    expect((await messages(other.threadId)).map((m) => m.text)).toEqual(["stay"]);
  }, 30_000); // a thousand inserts take a while on a networked database

  test("listThreads filters by status, with or without a user", async () => {
    const live = await thread({ userId: "a" });
    const archived = await thread({ userId: "a" });
    await thread({ userId: "b" });
    await runtime.adminWrite((db) => db.patch(archived.threadId as any, { status: "archived" }));
    const ids = async (args: Record<string, unknown>) => ((await q("admin:threads", args)) as any).page.map((t: any) => t.id);
    expect(await ids({ userId: "a" })).toEqual([live.threadId]);
    expect(await ids({ userId: "a", status: "active" })).toEqual([live.threadId]);
    expect(await ids({ userId: "a", status: "archived" })).toEqual([archived.threadId]);
    expect(await ids({ status: "archived" })).toEqual([archived.threadId]);
  });

  test("the history window never opens on a tool result", async () => {
    await runtime.runMutation("admin:initShort", {});
    const { threadId } = await thread({ mount: "short" });
    await runtime.adminWrite(async (db) => {
      for (const [order, row] of [
        { role: "user", text: "weather?" },
        { role: "assistant", toolCalls: [{ name: "weather", args: {} }] },
        { role: "tool", name: "weather", toolResults: [{ name: "weather", result: "sunny" }] },
        { role: "assistant", text: "It's sunny." },
      ].entries()) {
        await db.insert("short.messages", { threadId, order, ...row });
      }
    });
    // The prompt makes five messages; the last three would start on the tool result.
    await runtime.runAction("admin:generate", { threadId, prompt: "thanks", mount: "short" });
    expect(lastCall!.messages.map((m) => m.role)).toEqual(["assistant", "user"]);
  });

  test("threads are listed per user and deleting one removes its messages", async () => {
    await runtime.runMutation("admin:init", {});
    const a = await thread({ userId: "a", title: "A" });
    await thread({ userId: "b", title: "B" });
    const list = (await q("admin:threads", { userId: "a" })) as any;
    expect(list.page.map((t: any) => t.id)).toEqual([a.threadId]);
    await runtime.runAction("admin:generate", { threadId: a.threadId, prompt: "hi" });
    expect(await runtime.runMutation("admin:deleteThread", { threadId: a.threadId })).toBe(true);
    expect(await q("admin:thread", { threadId: a.threadId })).toBeNull();
    expect(await messages(a.threadId)).toEqual([]);
    expect(((await q("admin:threads")) as any).page).toHaveLength(1);
  });

  test("two mounts keep separate threads", async () => {
    await runtime.runMutation("admin:init", {});
    const mine = await thread();
    const other = await thread({ mount: "other" });
    const mineList = (await runtime.runQuery("admin:threads", {})).value as any;
    const otherList = (await runtime.runQuery("admin:threads", { mount: "other" })).value as any;
    expect(mineList.page.map((t: any) => t.id)).toEqual([mine.threadId]);
    expect(otherList.page.map((t: any) => t.id)).toEqual([other.threadId]);
  });
});

// Type checks: never run, only compiled by `bun run typecheck`.
async function _types(ctx: import("../src/server").ActionCtx<any, typeof components>) {
  const weather = {} as import("../src/api").FunctionReference<"mutation", "internal", { city: string }, string>;
  const tool: import("../src/components/agent").AgentTool<"mutation"> = { name: "weather", kind: "mutation", fn: weather };
  const { threadId } = await ctx.components.bot.createThread({ userId: "u1", title: "t" });
  const r = await ctx.components.bot.generateText({ threadId, prompt: "hi", tools: [tool], maxSteps: 3 });
  const text: string = r.text;
  // @ts-expect-error: tools must match AgentTool
  await ctx.components.bot.generateText({ threadId, prompt: "hi", tools: [{ name: "w", kind: "mutation", fn: 5 }] });
  const msgs = await ctx.components.bot.listMessages({ threadId, paginationOpts: { numItems: 10, cursor: null } });
  const role: string = msgs.page[0]!.role;
  const chunks = await ctx.components.bot.getStreamChunks({ streamId: "s" });
  const done: boolean = chunks.done;
  void text; void role; void done;
}
void _types;
