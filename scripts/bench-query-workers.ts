/**
 * What query workers (ONEBASE_QUERY_WORKERS) do for a write that many per-user live queries depend on.
 *
 *   bun scripts/bench-query-workers.ts            # every configuration, each in its own process
 *   bun scripts/bench-query-workers.ts 2 heavy    # one: 2 workers, the heavier query
 *
 * 2,000 subscribers, one per user, to one query that reads the caller's identity, so nothing is
 * shared between them. Each write changes a document every one of them reads. Reported per write
 * (median of the measured writes):
 *   - write: how long the mutation took to return (it waits for none of these queries)
 *   - stall: the longest the main thread was busy without a break (event-loop lag), from the write
 *     until every subscriber had the new result
 *   - main busy: how long the main thread spent on the fan-out. Measured in separate writes while
 *     the main thread also runs other work in small pieces: whatever time that other work didn't
 *     get, from the write until every subscriber had the new result, went to the fan-out. (Plain
 *     CPU time misleads here: the event loop may spin while it waits for a worker's answer.)
 *   - all updated: time from the write until every subscriber had the new result
 * and the process's memory once the subscribers are in place.
 *
 * In-process (Runtime + SubscriptionManager), no sockets: a real server also sends one WebSocket
 * message per subscriber, on the main thread, with or without workers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { SubscriptionManager } from "../src/engine/sync";
import { loadProjectCode } from "../src/project";

/** A small, fixed piece of other work for the main thread, and how long it takes. */
const PIECE = 20_000;
function piece() {
  let x = 1;
  for (let i = 0; i < PIECE; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
  }
  return x;
}
function pieceMs(): number {
  for (let i = 0; i < 200; i++) piece();
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) piece();
  return (performance.now() - t0) / 2000;
}

const SUBSCRIBERS = 2000;
const WRITES = 12;
const WARMUP = 2;

const QUERIES = {
  /** Reads every note (about 50) and filters them in JS. */
  heavy: `async (ctx) => {
    const me = (await ctx.auth.getUserIdentity())?.subject;
    const notes = await ctx.db.query("notes").collect();
    return notes.filter((n) => n.owner === me || n.owner === "all").map((n) => n.text);
  }`,
  /** Two indexed reads: the caller's own notes and the 3 newest shared ones. */
  light: `async (ctx) => {
    const me = (await ctx.auth.getUserIdentity())?.subject ?? "";
    const own = await ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("owner", me)).collect();
    const shared = await ctx.db.query("notes").withIndex("by_owner", (q) => q.eq("owner", "all")).order("desc").take(3);
    return [...own, ...shared].map((n) => n.text);
  }`,
};

async function one(workers: number, kind: keyof typeof QUERIES) {
  const root = mkdtempSync(join(tmpdir(), "onebase-bench-qw-"));
  const dir = join(root, "onebase");
  mkdirSync(join(dir, "_generated"), { recursive: true });
  writeFileSync(join(dir, "_generated", "api.ts"), `import { anyApi } from "onebase/server"; export const api: any = anyApi; export const internal: any = anyApi;`);
  writeFileSync(
    join(dir, "schema.ts"),
    `import { defineSchema, defineTable } from "onebase/server"; import { v } from "onebase/values";
     export default defineSchema({ notes: defineTable({ text: v.string(), owner: v.string() }).index("by_owner", ["owner"]) });`,
  );
  writeFileSync(
    join(dir, "notes.ts"),
    `import { mutation, query } from "onebase/server"; import { v } from "onebase/values";
     export const add = mutation({ args: { text: v.string(), owner: v.string() }, handler: (ctx, a) => ctx.db.insert("notes", a) });
     export const feed = query({ args: {}, handler: ${QUERIES[kind]} });`,
  );
  const driver = new SqliteDriver(join(root, "db.sqlite"));
  const runtime = new Runtime({ driver, ...(await loadProjectCode(dir)), queryWorkers: workers, log: { info() {}, warn() {}, error() {} } });
  await runtime.init();
  for (let i = 0; i < 50; i++) await runtime.runMutation("notes:add", { text: `n${i}`, owner: `user${i}` }, { settle: "none" });
  const subs = new SubscriptionManager(runtime);

  let marker = "";
  let updated = 0;
  let seen = 0;
  let allUpdated: () => void = () => {};
  for (let i = 0; i < SUBSCRIBERS; i++) {
    subs.subscribe("notes:feed", {}, { subject: `user${i}`, issuer: "bench", tokenIdentifier: `bench|user${i}` }, (_u, json) => {
      seen++;
      if (marker && json?.includes(marker) && ++updated === SUBSCRIBERS) allUpdated();
    });
  }
  while (seen < SUBSCRIBERS) await Bun.sleep(5);

  // Event-loop lag: a timer every millisecond; a late tick means the thread was busy that long.
  let lag = 0;
  let expected = performance.now() + 1;
  const ticker = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - expected);
    expected = now + 1;
  }, 1);

  const writer = {}; // a connection with no subscriptions of its own: its write waits for nothing
  const rows: { write: number; stall: number; all: number }[] = [];
  for (let k = 0; k < WARMUP + WRITES; k++) {
    marker = `w${k}-${Math.random().toString(36).slice(2, 8)}`;
    updated = 0;
    const done = new Promise<void>((resolve) => (allUpdated = resolve));
    await Bun.sleep(20);
    lag = 0;
    expected = performance.now() + 1;
    const t0 = performance.now();
    await runtime.runMutation("notes:add", { text: marker, owner: "all" }, { settle: writer });
    const write = performance.now() - t0;
    await done;
    const all = performance.now() - t0;
    if (k >= WARMUP) rows.push({ write, stall: lag, all });
  }
  clearInterval(ticker);

  // The same writes with other work running on the main thread all the while.
  const unit = pieceMs();
  const busy: number[] = [];
  for (let k = 0; k < WRITES; k++) {
    marker = `b${k}-${Math.random().toString(36).slice(2, 8)}`;
    updated = 0;
    const done = new Promise<void>((resolve) => (allUpdated = resolve));
    await Bun.sleep(20);
    let pieces = 0;
    let running = true;
    const other = () => {
      if (!running) return;
      piece();
      pieces++;
      setImmediate(other);
    };
    const t0 = performance.now();
    setImmediate(other);
    await runtime.runMutation("notes:add", { text: marker, owner: "all" }, { settle: writer });
    await done;
    running = false;
    busy.push(performance.now() - t0 - pieces * unit);
  }

  Bun.gc(true);
  await Bun.sleep(200);
  const rss = process.memoryUsage().rss / 2 ** 20;
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const result = {
    workers,
    query: kind,
    writeMs: median(rows.map((r) => r.write)),
    stallMs: median(rows.map((r) => r.stall)),
    mainBusyMs: median(busy),
    allUpdatedMs: median(rows.map((r) => r.all)),
    rssMb: rss,
    workerRuns: runtime.queryWorkerRuns,
  };
  runtime.stop();
  await driver.close();
  rmSync(root, { recursive: true, force: true });
  return result;
}

const [workersArg, kindArg] = process.argv.slice(2);
if (workersArg !== undefined) {
  console.log(JSON.stringify(await one(Number(workersArg), (kindArg ?? "heavy") as keyof typeof QUERIES)));
} else {
  const fmt = (n: number) => n.toFixed(1).padStart(7);
  console.log(`${SUBSCRIBERS} per-user subscribers, one write that affects all of them (medians of ${WRITES} writes)\n`);
  console.log("query   workers   write ms   stall ms   main busy ms   all updated ms   RSS MB");
  for (const kind of Object.keys(QUERIES) as (keyof typeof QUERIES)[]) {
    for (const workers of [0, 1, 2, 4]) {
      const proc = Bun.spawnSync(["bun", import.meta.path, String(workers), kind], { stderr: "inherit" });
      const r = JSON.parse(proc.stdout.toString().trim().split("\n").at(-1)!);
      console.log(`${kind.padEnd(7)} ${String(workers).padStart(7)}   ${fmt(r.writeMs)}    ${fmt(r.stallMs)}       ${fmt(r.mainBusyMs)}     ${fmt(r.allUpdatedMs)}         ${fmt(r.rssMb)}`);
    }
  }
}
