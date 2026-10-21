import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { OnebaseClient, OnebaseHttpClient, ConvexError } from "../src/client/index";
import { loadProject } from "../src/project";
import { api } from "../example/convex/_generated/api";

let app: Awaited<ReturnType<typeof startApp>>;
let dataDir: string;
let url: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "onebase-e2e-"));
  const project = await loadProject(join(import.meta.dir, "../example/convex"));
  const { schema, modules, http, crons, authenticate } = project;
  app = await startApp({ schema, modules, http, crons, authenticate, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  url = `http://127.0.0.1:${app.server.port}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function nextValue<T>(client: OnebaseClient, ref: any, args: any, predicate: (v: T) => boolean): Promise<T> {
  return new Promise((resolve, reject) => {
    const unsub = client.onUpdate(ref, args, (value: any) => {
      if (predicate(value)) {
        unsub();
        resolve(value);
      }
    }, reject);
  });
}

test("live queries over WebSocket", async () => {
  const alice = new OnebaseClient(url);
  const bob = new OnebaseClient(url);
  const channel = await alice.mutation(api.channels.getOrCreate, { name: "general" });

  const seen: string[][] = [];
  bob.onUpdate(api.messages.list, { channel }, (msgs) => seen.push(msgs.map((m) => m.body)));
  await nextValue(bob, api.messages.list, { channel }, () => true);

  await alice.mutation(api.messages.send, { channel, author: "alice", body: "hello" });
  const latest = await nextValue<any[]>(bob, api.messages.list, { channel }, (m) => m.length === 1);
  expect(latest[0]).toMatchObject({ author: "alice", body: "hello" });
  expect(seen.at(-1)).toEqual(["hello"]);

  // ConvexError reaches the client with its message; other errors would be hidden in production.
  const err = await alice.mutation(api.messages.send, { channel, author: "alice", body: "   " }).catch((e) => e);
  expect(err).toBeInstanceOf(ConvexError);
  expect(err.message).toBe("Message can't be empty");

  const invalid = await alice.mutation(api.messages.send, { channel, author: "alice" } as any).catch((e) => e);
  expect(invalid.message).toContain("args.body is required");

  alice.close();
  bob.close();
});

test("HTTP API, http actions and static client bundle", async () => {
  const http = new OnebaseHttpClient(url);
  const hook = await fetch(`${url}/hooks/post`, {
    method: "POST",
    body: JSON.stringify({ channel: "webhooks", body: "from a webhook" }),
  });
  expect(await hook.json()).toEqual({ ok: true });

  const channels = await http.query(api.channels.list);
  const webhooks = channels.find((c) => c.name === "webhooks")!;
  const msgs = await http.query("messages:list", { channel: webhooks._id });
  expect(msgs.map((m: any) => m.body)).toEqual(["from a webhook"]);

  const internal = await fetch(`${url}/api/mutation`, {
    method: "POST",
    body: JSON.stringify({ path: "messages:remove", args: { id: msgs[0]._id } }),
  });
  expect(((await internal.json()) as any).errorMessage).toContain("is internal");

  const bundle = await fetch(`${url}/_onebase/client.js`);
  expect(bundle.headers.get("content-type")).toContain("javascript");
  expect(await bundle.text()).toContain("api/sync");
});

test("scheduled function runs and the change is pushed to subscribers", async () => {
  const client = new OnebaseClient(url);
  const channel = await client.mutation(api.channels.getOrCreate, { name: "tmp" });
  await client.mutation(api.messages.send, { channel, author: "a", body: "/tmp bye" });
  // The example deletes "/tmp" messages after 5s; speed it up by running due jobs now.
  await app.driver.write((tx) => tx.run("UPDATE _scheduled SET run_at = 0 WHERE state = 'pending'"));
  app.runtime.pokeScheduler();
  const after = await nextValue<any[]>(client, api.messages.list, { channel }, (m) => m.length === 0);
  expect(after).toEqual([]);
  client.close();
});
