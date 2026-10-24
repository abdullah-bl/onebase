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
