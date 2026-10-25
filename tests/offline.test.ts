// Offline support: query results cached across sessions, mutations queued while the server is
// unreachable and sent (in order) once it is, and the cache never crossing users.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { OnebaseClient, type AuthStorage } from "../src/client/index";
import { mutation, query } from "../src/server";
import { v } from "../src/values";

const modules = {
  notes: {
    list: query({ args: {}, handler: async (ctx) => (await ctx.db.query("notes").collect()).map((n: any) => ({ text: n.text })) }),
    add: mutation({ args: { text: v.string() }, handler: (ctx, { text }) => ctx.db.insert("notes", { text }) }),
  },
  echo: { n: query({ args: { n: v.number() }, handler: (_ctx, { n }) => n }) },
};

/** In-memory stand-in for localStorage, shared between "sessions" to survive a reload. */
function memoryStorage(): AuthStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

const entries = (storage: ReturnType<typeof memoryStorage>, key: string) =>
  Object.keys((JSON.parse(storage.data.get(key) ?? "{}") as { entries?: object }).entries ?? {});

describe("offline support", () => {
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let url: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-offline-"));
    app = await startApp({ schema: null, modules: modules as any, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
    url = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("the newest results are cached, and hydrate the next session before the server answers", async () => {
    const storage = memoryStorage();
    const first = new OnebaseClient(url, { offline: { storage } });
    await first.mutation("notes:add", { text: "cached" } as any);
    await first.mutation("notes:add", { text: "also cached" } as any);
    const seen: string[][] = [];
    first.onUpdate("notes:list", {}, (v) => seen.push(v.map((n: any) => n.text)));
    for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(50);
    expect(seen.at(-1)).toEqual(["cached", "also cached"]);
    first.close(); // flushes the cache

    // Data changes while this "reload" is offline; the cache is what the new session sees first.
    const writer = new OnebaseClient(url);
    await writer.mutation("notes:add", { text: "fresh" } as any);
    writer.close();

    const seen2: string[][] = [];
    const second = new OnebaseClient(url, { offline: { storage } });
    second.onUpdate("notes:list", {}, (v) => seen2.push(v.map((n: any) => n.text)));
    for (let i = 0; i < 100 && seen2.length < 2; i++) await Bun.sleep(50);
    expect(seen2[0]).toEqual(["cached", "also cached"]); // from the cache, before the network
    expect(seen2.at(-1)).toEqual(["cached", "also cached", "fresh"]); // then live
    second.close();
  });

  test("only the newest maxCachedQueries results are kept", async () => {
    const storage = memoryStorage();
    const client = new OnebaseClient(url, { offline: { storage, maxCachedQueries: 3 } });
    for (const n of [1, 2, 3, 4, 5]) {
      const seen: number[] = [];
      client.onUpdate("echo:n", { n }, (v) => seen.push(v));
      for (let i = 0; i < 100 && seen.length === 0; i++) await Bun.sleep(50);
      expect(seen.at(-1)).toBe(n);
    }
    client.close();
    const keys = entries(storage, `onebase:cache:${url}`);
    expect(keys).toHaveLength(3);
    expect(keys.some((k) => k.includes('"n":1'))).toBe(false); // the oldest fell out
    expect(keys.some((k) => k.includes('"n":5'))).toBe(true);
  });

  test("mutations made while disconnected are queued, replayed in order, and never cross users' caches", async () => {
    // A port nothing is listening on yet: the client queues, the "server appears" later.
    const holder = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {} } });
    const port = holder.port;
    holder.stop();

    const storage = memoryStorage();
    const offline = new OnebaseClient(`http://127.0.0.1:${port}`, { offline: { storage } });
    await Bun.sleep(200); // clearly in its retry loop, not connected
    void offline.mutation("notes:add", { text: "queued-1" } as any).catch(() => {});
    void offline.mutation("notes:add", { text: "queued-2" } as any).catch(() => {});
    expect(offline.queuedMutations).toBe(2);
    offline.close(); // the page goes away; the queue lives in storage

    const dir = mkdtempSync(join(tmpdir(), "onebase-offline-late-"));
    const late = await startApp({ schema: null, modules: modules as any, dataDir: dir, port, hostname: "127.0.0.1", dev: false, quiet: true });
    try {
      const reloaded = new OnebaseClient(`http://127.0.0.1:${port}`, { offline: { storage } });
      for (let i = 0; i < 100 && reloaded.queuedMutations > 0; i++) await Bun.sleep(50);
      expect(reloaded.queuedMutations).toBe(0); // drained
      const texts = ((await reloaded.query("notes:list", {})) as any[]).map((n) => n.text);
      expect(texts).toEqual(["queued-1", "queued-2"]); // in the order they were made
      reloaded.close();
    } finally {
      await late.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("offline cache is held back until the server confirms who is asking", () => {
  const whoami = async (ctx: any) => (await ctx.auth.getUserIdentity())?.subject ?? null;
  const who = { auth: { who: query({ args: {}, handler: whoami }) } };
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let url: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-offline-auth-"));
    app = await startApp({
      schema: null,
      modules: who as any,
      authenticate: (token) => ({ subject: token, tokenIdentifier: `test|${token}` }),
      dataDir,
      port: 0,
      hostname: "127.0.0.1",
      dev: false,
      quiet: true,
    });
    url = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("a cached result waits for the same user; another user never sees it", async () => {
    const storage = memoryStorage();
    const alice = new OnebaseClient(url, { offline: { storage } });
    alice.setAuth(() => "alice");
    const seenA: (string | null)[] = [];
    alice.onUpdate("auth:who", {}, (v) => seenA.push(v));
    for (let i = 0; i < 100 && !seenA.includes("alice"); i++) await Bun.sleep(50);
    expect(seenA.at(-1)).toBe("alice");
    alice.close(); // the cache is written under alice

    // The same user, next session: the cached answer shows once the server confirms the token.
    const aliceAgain = new OnebaseClient(url, { offline: { storage } });
    aliceAgain.setAuth(() => "alice");
    const seenAgain: (string | null)[] = [];
    aliceAgain.onUpdate("auth:who", {}, (v) => seenAgain.push(v));
    for (let i = 0; i < 100 && seenAgain.length === 0; i++) await Bun.sleep(50);
    expect(seenAgain[0]).toBe("alice");
    aliceAgain.close();

    // A different user on the same storage: alice's cached answer never reaches them.
    const bob = new OnebaseClient(url, { offline: { storage } });
    bob.setAuth(() => "bob");
    const seenB: (string | null)[] = [];
    bob.onUpdate("auth:who", {}, (v) => seenB.push(v));
    for (let i = 0; i < 100 && seenB.length === 0; i++) await Bun.sleep(50);
    expect(seenB[0]).toBe("bob");
    expect(seenB).not.toContain("alice");
    bob.close();
  });
});
