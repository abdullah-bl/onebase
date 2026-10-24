import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp } from "../src/app";
import { OnebaseClient } from "../src/client/index";
import { ConvexError, defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";

const schema = defineSchema({ counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]) });

const get = (ctx: any, name: string) => ctx.db.query("counters").withIndex("by_name", (q: any) => q.eq("name", name)).unique();

const modules = {
  counters: {
    value: query({ args: { name: v.string() }, handler: async (ctx, { name }) => (await get(ctx, name))?.value ?? 0 }),
    add: mutation({
      args: { name: v.string(), by: v.number() },
      handler: async (ctx, { name, by }) => {
        await Bun.sleep(30); // long enough to observe the optimistic value
        if (by < 0) throw new ConvexError("Counters only go up");
        const doc = await get(ctx, name);
        if (doc) await ctx.db.patch(doc._id, { value: doc.value + by });
        else await ctx.db.insert("counters", { name, value: by });
      },
    }),
  },
};

let app: Awaited<ReturnType<typeof startApp>>;
let dataDir: string;
let client: OnebaseClient;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "onebase-optimistic-"));
  app = await startApp({ schema, modules, dataDir, port: 0, hostname: "127.0.0.1", dev: false, quiet: true });
  client = new OnebaseClient(`http://127.0.0.1:${app.server.port}`);
});

afterAll(async () => {
  client.close();
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const bump = (store: any, { name, by }: { name: string; by: number }) => {
  const current = store.getQuery("counters:value", { name });
  if (current !== undefined) store.setQuery("counters:value", { name }, current + by);
};

test("optimistic updates show at once, then give way to the server's result without flicker", async () => {
  const seen: number[] = [];
  client.onUpdate("counters:value", { name: "a" }, (value: number) => seen.push(value));
  await Bun.sleep(50);
  expect(seen).toEqual([0]);

  const done = client.mutation("counters:add", { name: "a", by: 5 }, { optimisticUpdate: bump });
  expect(seen).toEqual([0, 5]); // synchronously, before any server round trip
  expect(client.localQueryResult("counters:value", { name: "a" })).toEqual({ ok: true, value: 5 });
  await done;
  await Bun.sleep(20);
  expect(seen).toEqual([0, 5]); // the server confirmed 5: no extra updates
});

test("a failed mutation rolls its optimistic update back", async () => {
  const seen: number[] = [];
  client.onUpdate("counters:value", { name: "b" }, (value: number) => seen.push(value));
  await Bun.sleep(50);
  const err = (await client.mutation("counters:add", { name: "b", by: -1 }, { optimisticUpdate: bump }).catch((e) => e)) as Error;
  expect(err.message).toBe("Counters only go up");
  expect(seen).toEqual([0, -1, 0]);
});

test("updates stack, can read every instance of a query, and survive unrelated server updates", async () => {
  const seen: Record<string, number[]> = { c: [], d: [] };
  for (const name of ["c", "d"]) client.onUpdate("counters:value", { name }, (value: number) => seen[name]!.push(value));
  await Bun.sleep(50);
  const everyCounter = (store: any) => {
    for (const { args, value } of store.getAllQueries("counters:value")) {
      if (["c", "d"].includes(args.name) && value !== undefined) store.setQuery("counters:value", args, value + 100);
    }
  };
  const first = client.mutation("counters:add", { name: "c", by: 1 }, { optimisticUpdate: bump });
  const second = client.mutation("counters:add", { name: "d", by: 2 }, { optimisticUpdate: everyCounter });
  expect(seen.c!.at(-1)).toBe(101); // 0 + 1, then + 100
  expect(seen.d!.at(-1)).toBe(100);
  await Promise.all([first, second]);
  await Bun.sleep(20);
  expect(seen.c!.at(-1)).toBe(1);
  expect(seen.d!.at(-1)).toBe(2);
});
