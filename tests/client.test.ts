import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { OnebaseClient } from "../src/client/index";
import { combinePages } from "../src/client/react";
import { mutation, query } from "../src/server";

describe("usePaginatedQuery pages", () => {
  const page = (items: number[], isDone = false) => ({ ok: true as const, value: { page: items, isDone, continueCursor: `c${items.at(-1)}` } });

  test("status and items follow the loaded pages", () => {
    expect(combinePages(0, {}).status).toBe("LoadingFirstPage");
    expect(combinePages(1, {}).status).toBe("LoadingFirstPage");
    expect(combinePages(1, { 0: page([1, 2]) })).toMatchObject({ status: "CanLoadMore", items: [1, 2], error: null });
    expect(combinePages(2, { 0: page([1, 2]) })).toMatchObject({ status: "LoadingMore", items: [1, 2] });
    expect(combinePages(2, { 0: page([1, 2]), 1: page([3], true) })).toMatchObject({ status: "Exhausted", items: [1, 2, 3] });
  });

  test("a failed page is reported as an error (the hook throws it) instead of loading forever", () => {
    const error = new Error("Not allowed");
    expect(combinePages(1, { 0: { ok: false, error } }).error).toBe(error);
    expect(combinePages(2, { 0: page([1]), 1: { ok: false, error } }).error).toBe(error);
  });
});

describe("auth tokens reach the server before anything that depends on them", () => {
  const whoami = async (ctx: any) => (await ctx.auth.getUserIdentity())?.subject ?? null;
  const modules = { who: { query: query({ args: {}, handler: whoami }), mutation: mutation({ args: {}, handler: whoami }) } };
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let url: string;
  const slowToken = (name: string) => async () => {
    await Bun.sleep(50);
    return name;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-client-"));
    app = await startApp({
      schema: null,
      modules,
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

  test("set before connecting: calls made while the token loads wait for it", async () => {
    const client = new OnebaseClient(url);
    client.setAuth(slowToken("alice"));
    await Bun.sleep(15); // the socket is open, the token isn't there yet
    expect(client.connectionState).toBe("connecting");
    const seen: unknown[] = [];
    client.onUpdate("who:query", {}, (v) => seen.push(v));
    expect(await client.mutation("who:mutation", {})).toBe("alice");
    await Bun.sleep(30);
    expect(seen).toEqual(["alice"]); // never a signed-out result first
    client.close();
  });

  test("changed after connecting: the next calls run as the new user", async () => {
    const client = new OnebaseClient(url);
    const seen: unknown[] = [];
    client.onUpdate("who:query", {}, (v) => seen.push(v));
    expect(await client.query("who:query", {})).toBeNull();
    client.setAuth(slowToken("bob"));
    expect(await client.mutation("who:mutation", {})).toBe("bob");
    await Bun.sleep(30);
    expect(seen.at(-1)).toBe("bob");
    client.clearAuth();
    expect(await client.mutation("who:mutation", {})).toBeNull();
    client.close();
  });
});

describe("frames the client doesn't understand never strand a call", () => {
  /** A socket the test plays the server for: it sees what the client sends and pushes raw frames back. */
  class FakeSocket {
    static last: FakeSocket;
    readyState = 0;
    sent: any[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) {
      FakeSocket.last = this;
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
      });
    }
    send(text: string) {
      this.sent.push(JSON.parse(text));
    }
    close() {}
    push(frame: unknown) {
      this.onmessage!({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
    }
  }

  const connect = async () => {
    const client = new OnebaseClient("http://onebase.test", { webSocketConstructor: FakeSocket as any });
    await Bun.sleep(0);
    return { client, ws: FakeSocket.last };
  };
  const callId = (ws: FakeSocket) => ws.sent.find((m) => m.type === "call").requestId;
  const quietly = async <T>(fn: () => Promise<T>) => {
    const { warn, error } = console;
    console.warn = console.error = () => {};
    try {
      return await fn();
    } finally {
      Object.assign(console, { warn, error });
    }
  };

  test("non-JSON, non-object and malformed transition frames are skipped; the real answer still lands", async () => {
    await quietly(async () => {
      const { client, ws } = await connect();
      const done = client.mutation("notes:add", {});
      await Bun.sleep(0);
      const requestId = callId(ws);
      for (const frame of ["not json", "null", "[1,2]", "42", { type: "transition", updates: {}, results: {} }, { type: "transition", updates: [null, 3], results: [null, "x"] }]) {
        expect(() => ws.push(frame)).not.toThrow();
      }
      ws.push({ type: "result", requestId, ok: true, value: "saved" });
      expect(await done).toBe("saved");
      client.close();
    });
  });

  test("a listener that throws while a transition applies still settles the mutation in it", async () => {
    await quietly(async () => {
      const { client, ws } = await connect();
      client.onUpdate("notes:list", {}, () => {
        throw new Error("render failed");
      });
      const done = client.mutation("notes:add", {});
      await Bun.sleep(0);
      const sub = ws.sent.find((m) => m.type === "sub");
      ws.push({ type: "transition", updates: [{ type: "update", id: sub.id, ok: true, value: [1] }], results: [{ type: "result", requestId: callId(ws), ok: true, value: "saved" }] });
      expect(await Promise.race([done, Bun.sleep(200).then(() => "STILL PENDING")])).toBe("saved");
      client.close();
    });
  });
});
