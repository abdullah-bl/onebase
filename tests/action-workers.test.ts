// Actions on worker threads: a CPU-bound action doesn't hold up other calls, one past its time
// limit is stopped (even in `while (true) {}`), and what actions do through ctx works as on the
// main thread.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import type { Logger, Runtime, RuntimeOptions } from "../src/engine/runtime";
import { bundleProject } from "../src/deploy";
import { importBundle, loadProjectCode } from "../src/project";
import { openRuntime, quiet } from "./helpers";

const LIMIT = 300;

/** A project on disk, as `onebase serve` loads it: workers load it from there too. */
const FILES: Record<string, string> = {
  "schema.ts": `
    import { defineSchema, defineTable } from "onebase/server";
    import { v } from "onebase/values";
    export default defineSchema({
      notes: defineTable({ text: v.string() }),
      docs: defineTable({ tag: v.string(), embedding: v.array(v.number()) }).vectorIndex("by_embedding", { vectorField: "embedding", dimensions: 2, filterFields: ["tag"] }),
    });
  `,
  "notes.ts": `
    import { action, internalMutation, internalQuery, mutation, query, createFunctionHandle } from "onebase/server";
    import { ConvexError, v } from "onebase/values";
    import { api, internal } from "./_generated/api";

    export const ping = query({ args: {}, handler: async () => "pong" });
    export const add = mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) });
    export const texts = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n) => n.text).sort() });
    export const secret = internalQuery({ args: {}, handler: async () => "internal ok" });
    export const addDoc = internalMutation({
      args: { tag: v.string(), embedding: v.array(v.number()) },
      handler: (ctx, args) => ctx.db.insert("docs", args),
    });

    /** A fixed amount of computation: it never yields. */
    export const burn = action({
      args: { iterations: v.number() },
      handler: async (_ctx, { iterations }) => {
        let x = 1;
        for (let i = 0; i < iterations; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; }
        return x >>> 0;
      },
    });
    export const forever = action({ args: {}, handler: async () => { while (true) {} } });
    export const sleepy = action({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => { await Bun.sleep(ms); return "woke"; } });

    export const everything = action({
      args: { text: v.string() },
      handler: async (ctx, { text }) => {
        console.log("from the worker", text);
        const id = await ctx.runMutation(api.notes.add, { text });
        const texts = await ctx.runQuery(api.notes.texts, {});
        const secret = await ctx.runQuery(internal.notes.secret, {});
        const nested = await ctx.runAction(api.notes.sleepy, { ms: 1 });
        const job = await ctx.scheduler.runAfter(60_000, internal.notes.secret, {});
        await ctx.scheduler.cancel(job);
        const handle = await createFunctionHandle(internal.notes.secret);
        const viaHandle = await ctx.runQuery(handle, {});
        const blobId = await ctx.storage.store(new Blob(["hello"], { type: "text/plain" }));
        const blob = await ctx.storage.get(blobId);
        const url = await ctx.storage.getUrl(blobId);
        await ctx.runMutation(internal.notes.addDoc, { tag: "a", embedding: [1, 0] });
        await ctx.runMutation(internal.notes.addDoc, { tag: "b", embedding: [0, 1] });
        const hits = await ctx.vectorSearch("docs", "by_embedding", { vector: [0.1, 1], limit: 5, filter: (q) => q.eq("tag", "a") });
        const identity = await ctx.auth.getUserIdentity();
        let caught = null;
        try { await ctx.runMutation(api.notes.fail, {}); } catch (err) { caught = { isConvex: err instanceof ConvexError, data: err.data }; }
        let noDb = null;
        try { ctx.db; } catch (err) { noDb = err.message; }
        return { id: typeof id, texts, secret, nested, handle: handle.startsWith("function://"), viaHandle, blob: await blob.text(), url: url.includes("/api/storage/"), hits: hits.length, identity: identity?.subject ?? null, caught, noDb };
      },
    });
    export const fail = mutation({ args: {}, handler: async () => { throw new ConvexError({ code: "nope" }); } });
    export const throws = action({ args: {}, handler: async () => { throw new ConvexError({ code: 42 }); } });
    export const exits = action({ args: {}, handler: async () => { process.exit(1); } });
    export const careless = action({
      args: {},
      handler: async (ctx) => {
        void ctx.runQuery(api.notes.texts, {}).then(() => {}, (err) => console.log("late:", err.message));
        return "returned";
      },
    });
    export const where = action({ args: {}, handler: async () => (Bun.isMainThread ? "main" : "worker") });

    /** Hands the component a function reference, which reaches it as a handle it can call back. */
    export const useKeeper = action({
      args: {},
      handler: async (ctx) => ctx.components.keeper.work({ text: "x", callback: internal.notes.secret }),
    });
  `,
  "components.ts": `
    import { defineComponents } from "onebase/components";
    import { keeper } from "../lib/keeper";
    export default defineComponents({ keeper: keeper.mount({ prefix: "k:" }) });
  `,
  "../lib/keeper.ts": `
    import { componentServer, defineComponent } from "onebase/components";
    import { defineSchema, defineTable, httpAction } from "onebase/server";
    import { v } from "onebase/values";
    const schema = defineSchema({ items: defineTable({ text: v.string() }) });
    const c = componentServer<any, { prefix: string }>();
    const add = c.mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("items", { text: ctx.config.prefix + text }) });
    const list = c.query({ args: {}, handler: async (ctx) => (await ctx.db.query("items").collect()).map((i) => i.text) });
    const work = c.action({
      args: { text: v.string(), callback: v.string() },
      handler: async (ctx, { text, callback }) => {
        await ctx.runMutation(add, { text }); // its own function, passed as itself
        return { mine: await ctx.runQuery(list, {}), back: await ctx.runQuery(callback as any, {}), mount: ctx.component.mount, config: ctx.config, worker: !Bun.isMainThread };
      },
    });
    export const keeper = defineComponent({
      name: "keeper",
      schema,
      functions: { add, list, work },
      http: () => [{ method: "GET", path: "/items", handler: httpAction(async (ctx) => Response.json(await ctx.runQuery(list, {}))) }],
    });
  `,
  "http.ts": `
    import { httpRouter, httpAction } from "onebase/server";
    import { api } from "./_generated/api";
    const http = httpRouter();
    http.route({ path: "/echo", method: "POST", handler: httpAction(async (ctx, req) => {
      const texts = await ctx.runQuery(api.notes.texts, {});
      return Response.json({ got: await req.text(), texts, header: req.headers.get("x-test") });
    }) });
    http.route({ path: "/stream", method: "GET", handler: httpAction(async () => {
      let i = 0;
      return new Response(new ReadableStream({ async pull(c) { if (i < 3) c.enqueue(new TextEncoder().encode("chunk" + i++ + ";")); else c.close(); } }), { headers: { "content-type": "text/plain" } });
    }) });
    http.route({ path: "/empty", method: "GET", handler: httpAction(async () => new Response(null, { status: 204, headers: { "x-done": "1" } })) });
    http.route({ path: "/spin", method: "GET", handler: httpAction(async () => { while (true) {} }) });
    export default http;
  `,
};

const root = mkdtempSync(join(tmpdir(), "onebase-action-workers-"));
const opened: { runtime: Runtime; driver: SqliteDriver }[] = [];

/** Writes a project folder (paths relative to its onebase/ directory) and returns that directory. */
function writeProject(name: string, files: Record<string, string>): string {
  const project = join(root, name, "onebase");
  mkdirSync(join(project, "_generated"), { recursive: true });
  mkdirSync(join(root, name, "lib"), { recursive: true });
  for (const [file, source] of Object.entries(files)) writeFileSync(join(project, file), source);
  writeFileSync(join(project, "_generated", "api.ts"), `import { anyApi } from "onebase/server"; export const api: any = anyApi; export const internal: any = anyApi;`);
  return project;
}

/** A runtime running a project from disk, as `onebase serve` does. */
async function start(name: string, files: Record<string, string>, opts: Partial<RuntimeOptions> = {}): Promise<Runtime> {
  const code = await loadProjectCode(writeProject(name, files));
  const started = (await openRuntime(() => new SqliteDriver(join(root, name, "db.sqlite")), { ...code, timeLimits: { actionMs: LIMIT }, ...opts })) as {
    runtime: Runtime;
    driver: SqliteDriver;
  };
  opened.push(started);
  return started.runtime;
}

let runtime: Runtime;

beforeAll(async () => {
  runtime = await start("main", FILES, { actionWorkers: 2 });
});

afterAll(async () => {
  for (const { runtime, driver } of opened) {
    runtime.stop();
    await driver.close();
  }
  rmSync(root, { recursive: true, force: true });
});

const failure = (call: Promise<unknown>): Promise<Error> =>
  call.then(
    () => {
      throw new Error("expected the call to fail");
    },
    (err: Error) => err,
  );

test("actions run on workers, and ctx works there as on the main thread", async () => {
  const result = await runtime.runAction("notes:everything", { text: "hi" }, { identity: { subject: "u1", tokenIdentifier: "t|u1", issuer: "t" } as any });
  expect(result).toEqual({
    id: "string",
    texts: ["hi"],
    secret: "internal ok",
    nested: "woke",
    handle: true,
    viaHandle: "internal ok",
    blob: "hello",
    url: true,
    hits: 1,
    identity: "u1",
    caught: { isConvex: true, data: { code: "nope" } },
    noDb: "ctx.db isn't available in actions. Read with ctx.runQuery(internal.x.y, args) and write with ctx.runMutation(...).",
  });
  expect(runtime.actionPool!.size).toBeGreaterThan(0);
  const record = runtime.calls.recent().find((r) => r.name === "notes:everything");
  expect(record?.lines).toContainEqual({ level: "log", text: "from the worker hi" });
});

test("an action's ConvexError reaches the caller with its data", async () => {
  const err = (await failure(runtime.runAction("notes:throws", {}))) as any;
  expect(err.data).toEqual({ code: 42 });
  expect(runtime.toClientError(err).data).toEqual({ code: 42 });
});

test("a CPU-bound action over its limit is stopped, while queries keep answering", async () => {
  const started = performance.now();
  const spinning = failure(runtime.runAction("notes:forever", {}));
  const pings: number[] = [];
  while (performance.now() - started < LIMIT + 200) {
    const t = performance.now();
    expect((await runtime.runQuery("notes:ping", {})).value).toBe("pong");
    pings.push(performance.now() - t);
    await Bun.sleep(10);
  }
  expect((await spinning).message).toBe(`notes:forever didn't finish within the action time limit (${LIMIT}ms).`);
  expect(pings.length).toBeGreaterThan(10);
  expect(Math.max(...pings)).toBeLessThan(50);
  // The worker was stopped and the pool still works.
  expect(await runtime.runAction("notes:sleepy", { ms: 1 })).toBe("woke");
});

test("a CPU-bound action within its limit doesn't block other calls", async () => {
  const burn = runtime.runAction("notes:burn", { iterations: 3e8 });
  const t = performance.now();
  expect((await runtime.runQuery("notes:ping", {})).value).toBe("pong");
  expect(performance.now() - t).toBeLessThan(50);
  expect(typeof (await burn)).toBe("number");
});

test("ctx calls left running when an action returns fail, without harming its thread", async () => {
  const errors: string[] = [];
  const original = quiet.error;
  (quiet as Logger).error = (message: string) => void errors.push(message); // where the pool reports a worker that died
  try {
    expect(await runtime.runAction("notes:careless", {})).toEqual("returned");
    await Bun.sleep(50);
    expect(await runtime.runAction("notes:where", {})).toBe("worker");
  } finally {
    quiet.error = original;
  }
  expect(errors).toEqual([]);
});

test("an action that ends its thread fails, and the next one gets a new thread", async () => {
  const err = await failure(runtime.runAction("notes:exits", {}));
  expect(err.message).toContain("thread stopped");
  expect(await runtime.runAction("notes:sleepy", { ms: 1 })).toBe("woke");
});

test("component actions run on workers, with their own functions, config and handles", async () => {
  expect(await runtime.runAction("notes:useKeeper", {})).toEqual({ mine: ["k:x"], back: "internal ok", mount: "keeper", config: { prefix: "k:" }, worker: true });
});

describe("HTTP actions", () => {
  const http = async (method: string, path: string, init: RequestInit = {}) => {
    const route = runtime.lookupHttp(method, path)!;
    return runtime.runHttpAction(route.handler.handler, new Request(`http://localhost${path}`, { method, ...init }), null, route.mount);
  };

  test("get the request and return a response", async () => {
    const res = await http("POST", "/echo", { body: "payload", headers: { "x-test": "yes" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: "payload", texts: ["hi"], header: "yes" });
  });

  test("stream their response body", async () => {
    const res = await http("GET", "/stream");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("chunk0;chunk1;chunk2;");
  });

  test("may answer without a body", async () => {
    const res = await http("GET", "/empty");
    expect(res.status).toBe(204);
    expect(res.headers.get("x-done")).toBe("1");
    expect(await res.text()).toBe("");
  });

  test("of components are served from workers", async () => {
    const res = await http("GET", "/keeper/items");
    expect(await res.json()).toEqual(["k:x"]);
  });

  test("are stopped past their time limit", async () => {
    const err = await failure(http("GET", "/spin"));
    expect(err.message).toBe(`GET /spin didn't finish within the action time limit (${LIMIT}ms).`);
  });
});

describe("actions sharing a thread", () => {
  const SHARED = 500;
  const files = {
    "notes.ts": `
      import { action, mutation, query } from "onebase/server";
      import { v } from "onebase/values";
      export const add = mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) });
      export const count = query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).length });
      export const forever = action({ args: {}, handler: async () => { while (true) {} } });
      export const sleepy = action({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => { await Bun.sleep(ms); return "woke"; } });
      export const late = action({ args: {}, handler: async (ctx) => { await Bun.sleep(${SHARED} + 300); await ctx.runMutation("notes:add", { text: "late" }); } });
    `,
  };
  let shared: Runtime;
  beforeAll(async () => {
    shared = await start("shared", files, { actionWorkers: 1, timeLimits: { actionMs: SHARED } });
  });

  test("a stuck action's thread is stopped, and the actions stuck with it fail", async () => {
    const stuck = failure(shared.runAction("notes:forever", {}));
    await Bun.sleep(SHARED - 100);
    const neighbour = failure(shared.runAction("notes:sleepy", { ms: 1 })); // same thread: it can't start
    expect((await stuck).message).toBe(`notes:forever didn't finish within the action time limit (${SHARED}ms).`);
    expect((await neighbour).message).toBe("The action's thread was stopped: another action on it ran past its time limit and didn't yield.");
    expect(await shared.runAction("notes:sleepy", { ms: 1 })).toBe("woke");
  });

  test("an overdue action that still yields lets the others on its thread finish, then its thread stops", async () => {
    const overdue = failure(shared.runAction("notes:late", {}));
    await Bun.sleep(SHARED - 200);
    const neighbour = shared.runAction("notes:sleepy", { ms: 400 }); // still running when the other's time is up
    expect((await overdue).message).toBe(`notes:late didn't finish within the action time limit (${SHARED}ms).`);
    expect(await neighbour).toBe("woke");
    expect(shared.actionPool!.size).toBe(0);
    await Bun.sleep(400);
    expect((await shared.runQuery("notes:count", {})).value).toBe(0); // the overdue action never got to write
  });
});

test("ONEBASE_ACTION_WORKERS=0 (actionWorkers: 0) runs actions on the main thread", async () => {
  const inProcess = await start("in-process", FILES, { actionWorkers: 0 });
  expect(inProcess.actionPool).toBeNull();
  expect(await inProcess.runAction("notes:where", {})).toBe("main");
  expect(await runtime.runAction("notes:where", {})).toBe("worker");
});

test("after a deploy, new calls run the new code on new workers, and running ones finish on the old", async () => {
  const version = (v: string) => ({
    "notes.ts": `
      import { action } from "onebase/server";
      import { v } from "onebase/values";
      export const version = action({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => { await Bun.sleep(ms); return { v: "${v}", worker: !Bun.isMainThread }; } });
    `,
  });
  const deployed = await start("deploys", version("local"), { loadCode: importBundle, actionWorkers: 2 });
  await deployed.deploy({ code: (await bundleProject(writeProject("v1", version("v1")))).code });
  expect(await deployed.runAction("notes:version", { ms: 0 })).toEqual({ v: "v1", worker: true });
  const old = deployed.runAction("notes:version", { ms: 150 });
  await Bun.sleep(20);
  await deployed.deploy({ code: (await bundleProject(writeProject("v2", version("v2")))).code });
  expect(await deployed.runAction("notes:version", { ms: 0 })).toEqual({ v: "v2", worker: true });
  expect(await old).toEqual({ v: "v1", worker: true });
});

describe("code that workers can't run as the main thread does", () => {
  const where = `export const where = action({ args: {}, handler: async () => (Bun.isMainThread ? "main" : "worker") });`;
  const cases = {
    "fails to load in a worker": `if (!Bun.isMainThread) throw new Error("not in a worker");`,
    "has other functions in a worker": `export const extra = Bun.isMainThread ? undefined : action({ args: {}, handler: async () => 1 });`,
  };
  for (const [name, top] of Object.entries(cases)) {
    test(`runs on the main thread when it ${name}, with a warning`, async () => {
      const warnings: string[] = [];
      const log = { ...quiet, warn: (message: string) => void warnings.push(message) };
      const odd = await start(name.replace(/ /g, "-"), { "notes.ts": `import { action } from "onebase/server";\n${top}\n${where}` }, { log, actionWorkers: 1 });
      expect(await odd.runAction("notes:where", {})).toBe("main");
      expect(await odd.runAction("notes:where", {})).toBe("main");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toStartWith("Actions run on the main thread: ");
      expect(odd.actionPool!.size).toBe(0);
    });
  }
});
