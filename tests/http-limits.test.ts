// Request body limits (uploads), rate-limited live queries that start on their own once the
// limit allows, and the onebase modules pushed code may import.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { DEFAULT_MAX_BODY_BYTES, parseSize } from "../src/engine/http";
import { BUILT_IN_COMPONENTS, importBundle, SERVER_MODULES, unknownOnebaseImports } from "../src/project";
import { mutation, query } from "../src/server";

describe("request body limit", () => {
  const modules = {
    files: {
      uploadUrl: mutation({ args: {}, handler: (ctx) => ctx.storage.generateUploadUrl() }),
      echo: query({ handler: (_ctx, args: any) => String(args?.text ?? "").length }),
    },
  };
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-body-"));
    app = await startApp({ schema: null, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, maxBodyBytes: 1024 });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const uploadUrl = async () => {
    const res = await fetch(`${base}/api/mutation`, { method: "POST", body: JSON.stringify({ path: "files:uploadUrl", args: {} }) });
    return ((await res.json()) as any).value as string;
  };
  /** A body sent without a Content-Length (chunked), so its size is only known while it streams. */
  const chunked = (bytes: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let sent = 0; sent < bytes; sent += 256) c.enqueue(new Uint8Array(Math.min(256, bytes - sent)).fill(120));
        c.close();
      },
    });
  const storedFiles = () => (existsSync(join(dataDir, "files")) ? readdirSync(join(dataDir, "files")) : []);

  test("parses sizes; the default is 1 GB, not Bun's 128 MB", () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(2 ** 30);
    expect(parseSize("1gb")).toBe(2 ** 30);
    expect(parseSize("512MB")).toBe(512 * 2 ** 20);
    expect(parseSize("1.5g")).toBe(1.5 * 2 ** 30);
    expect(parseSize("100k")).toBe(102_400);
    expect(parseSize("4096")).toBe(4096);
    expect(() => parseSize("lots")).toThrow("Invalid size");
    expect(() => parseSize("0")).toThrow("Invalid size");
  });

  test("an upload within the limit is stored", async () => {
    const res = await fetch(await uploadUrl(), { method: "POST", body: new Uint8Array(1024).fill(97) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).storageId).toBeString();
  });

  test("a larger upload gets 413 with a JSON error (not Bun's empty body)", async () => {
    const before = storedFiles().length;
    const res = await fetch(await uploadUrl(), { method: "POST", body: new Uint8Array(1025) });
    expect(res.status).toBe(413);
    expect(res.headers.get("Content-Type")).toBe("application/json");
    expect(((await res.json()) as any).error).toContain("larger than this server accepts (1 KB");
    expect(storedFiles().length).toBe(before);
  });

  test("a chunked upload is cut off once it passes the limit, and nothing is kept", async () => {
    const before = storedFiles().length;
    const res = await fetch(await uploadUrl(), { method: "POST", body: chunked(4096), duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error).toContain("--max-upload");
    expect(storedFiles().length).toBe(before);
    // Within the limit, a chunked upload still streams through.
    const ok = await fetch(await uploadUrl(), { method: "POST", body: chunked(1000), duplex: "half" } as RequestInit);
    expect(ok.status).toBe(200);
    const id = ((await ok.json()) as any).storageId;
    const file = await fetch(`${base}/api/storage/${id}`);
    expect((await file.arrayBuffer()).byteLength).toBe(1000);
  });

  test("other API calls get the same limit as JSON", async () => {
    const big = JSON.stringify({ path: "files:echo", args: { text: "x".repeat(2000) } });
    const res = await fetch(`${base}/api/query`, { method: "POST", body: big });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).errorMessage).toContain("larger than this server accepts");
    const small = await fetch(`${base}/api/query`, { method: "POST", body: JSON.stringify({ path: "files:echo", args: { text: "hi" } }) });
    expect(((await small.json()) as any).value).toBe(2);
  });
});

describe("rate-limited live queries", () => {
  const modules = { ping: { ping: query({ args: {}, handler: () => "pong" }) } };
  let app: Awaited<ReturnType<typeof startApp>>;
  let dataDir: string;
  let base: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "onebase-subretry-"));
    // Two subscriptions at once, then one more every 150ms.
    app = await startApp({ schema: null, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true, rateLimit: { max: 2, windowMs: 300 } });
    base = `http://127.0.0.1:${app.server.port}`;
  });
  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const connect = async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/sync`);
    const updates: any[] = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "update") updates.push(msg);
    };
    await new Promise((resolve) => (ws.onopen = resolve));
    return { ws, updates };
  };
  const until = async (check: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(10)) if (check()) return;
    throw new Error("timed out waiting");
  };

  test("a subscription refused by the rate limit starts on its own once a token is free", async () => {
    const { ws, updates } = await connect();
    for (const id of [1, 2, 3]) ws.send(JSON.stringify({ type: "sub", id, path: "ping:ping", args: {} }));
    await until(() => updates.some((u) => u.id === 3));
    expect(updates.find((u) => u.id === 3)).toMatchObject({ ok: false });
    expect(updates.find((u) => u.id === 3).error).toContain("Too many requests");
    // No new sub message from the client: the server retries it after the advertised wait.
    await until(() => updates.some((u) => u.id === 3 && u.ok));
    expect(updates.filter((u) => u.id === 3).at(-1)).toMatchObject({ ok: true, value: "pong" });
    ws.close();
  });

  test("an unsubscribed query isn't retried", async () => {
    await Bun.sleep(400); // a full bucket again
    const { ws, updates } = await connect();
    for (const id of [1, 2, 3]) ws.send(JSON.stringify({ type: "sub", id, path: "ping:ping", args: {} }));
    await until(() => updates.some((u) => u.id === 3));
    ws.send(JSON.stringify({ type: "unsub", id: 3 }));
    await Bun.sleep(400);
    expect(updates.filter((u) => u.id === 3).every((u) => !u.ok)).toBe(true);
    ws.close();
  });
});

describe("onebase modules for pushed code", () => {
  test("every built-in component is importable from pushed code, even in a compiled binary", () => {
    const dirs = readdirSync(join(import.meta.dir, "../src/components"), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(Object.keys(BUILT_IN_COMPONENTS).sort()).toEqual(dirs);
    for (const name of dirs) expect(SERVER_MODULES).toContain(`onebase/components/${name}`);
    // And every server-side entry in package.json's exports (the client ones aren't for server code).
    const exports = Object.keys(JSON.parse(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).exports);
    for (const sub of exports.filter((e) => !["./browser", "./react", "./components/*"].includes(e))) {
      expect(SERVER_MODULES).toContain(sub === "." ? "onebase" : `onebase/${sub.slice(2)}`);
    }
  });

  test("finds the onebase imports a bundle needs that the server doesn't have", () => {
    const code = [
      'import { query } from "onebase/server";',
      'import { defineMigration } from "onebase/components/migrations";',
      'import {useQuery} from"onebase/react";',
      'const lazy = await import("onebase/browser");',
      'import "onebase/nope";',
      'import x from "onebased";',
    ].join("\n");
    expect(unknownOnebaseImports(code)).toEqual(["onebase/browser", "onebase/nope", "onebase/react"]);
  });

  test("a bundle importing a module the server lacks is refused by name", async () => {
    const code = 'import { useQuery } from "onebase/react";\nexport default { modules: {} };\n';
    await expect(importBundle(code, "unknownimport")).rejects.toThrow('The pushed code imports "onebase/react", which this server');
  });
});
