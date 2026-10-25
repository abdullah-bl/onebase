/**
 * SQLite-only performance benchmark for onebase's reactive engine.
 *
 *   bun scripts/bench.ts
 *
 * Everything runs in-process (SqliteDriver + Runtime + SubscriptionManager) — no
 * server, no sockets. Each scenario targets a CPU path that sits between the native
 * layers (SQLite, WS, JSON) — exactly the parts a native/Rust rewrite would target:
 *
 *   - write throughput with live subscriptions (invalidation matching + re-runs)
 *   - rejected candidates (pure writeAffects/inRange matching, zero re-runs)
 *   - unchanged results (re-run + stringify-compare discard)
 *   - shared-subscription fan-out (per-listener send cost)
 *   - query throughput (per-row doc JSON.parse + read-set recording)
 *   - canonical-JSON kernels (stableStringify, clone-by-roundtrip, sameValue compare)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { cpus } from "node:os";
import { join } from "node:path";
import { SqliteDriver } from "../src/engine/driver";
import { Runtime } from "../src/engine/runtime";
import { SubscriptionManager, stableStringify } from "../src/engine/sync";
import { defineSchema, defineTable, mutation, query } from "../src/server";
import { v } from "../src/values";

// ---------- knobs ----------

const SEED_DOCS = 10_000;
const AUTHORS = Array.from({ length: 40 }, (_, i) => `author-${String(i).padStart(2, "0")}`);
const BODIES = Array.from({ length: 8 }, (_, i) => `body-${i}-` + "x".repeat(1010)); // ~1 KB docs

/** Deterministic PRNG so runs are comparable. */
function makeRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = makeRng(0x6f6e6562);

// ---------- schema and functions under test ----------

const schema = defineSchema({
  posts: defineTable({ author: v.string(), score: v.number(), title: v.string(), body: v.string() })
    .index("by_score", ["score"])
    .index("by_author", ["author"]),
  /** Scratch table nothing subscribes to: writes here measure the cold path. */
  events: defineTable({ kind: v.string(), payload: v.string() }),
});

const titles = (docs: { title: string }[]) => docs.map((d) => d.title);

const modules = {
  posts: {
    seed: mutation({
      args: { count: v.number() },
      handler: async (ctx, { count }) => {
        const ids: string[] = [];
        for (let i = 0; i < count; i++) {
          // 99% of docs in a hot score band [0,100]; 1% in cold bands [5000,6000).
          const score = rand() < 0.99 ? Math.floor(rand() * 100) : 5000 + Math.floor(rand() * 1000);
          ids.push(
            await ctx.db.insert("posts", {
              author: AUTHORS[i % AUTHORS.length]!,
              score,
              title: `post-${i}`,
              body: BODIES[i % BODIES.length]!,
            }),
          );
        }
        return ids;
      },
    }),
    add: mutation({
      args: { author: v.string(), score: v.number(), title: v.string() },
      handler: (ctx, a) => ctx.db.insert("posts", { ...a, body: BODIES[Math.floor(rand() * BODIES.length)]! }),
    }),
    editBody: mutation({
      args: { id: v.string(), body: v.string() },
      handler: (ctx, { id, body }) => ctx.db.patch(id as any, { body }),
    }),
    setScore: mutation({
      args: { id: v.string(), score: v.number() },
      handler: (ctx, { id, score }) => ctx.db.patch(id as any, { score }),
    }),
    // Subscribed queries all project titles only, so body patches change nothing they return.
    byAuthor: query({
      args: { author: v.string(), since: v.number() },
      handler: async (ctx, { author, since }) =>
        titles(await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author).gt("_creationTime", since)).take(10)),
    }),
    top: query({
      args: { min: v.number() },
      handler: async (ctx, { min }) => titles(await ctx.db.query("posts").withIndex("by_score", (q) => q.gt("score", min)).take(10)),
    }),
    // The queries below read the newest end of their index, so every storm insert lands inside
    // their window and changes the result (the asc queries above never see new rows).
    newestByAuthor: query({
      args: { author: v.string(), since: v.number() },
      handler: async (ctx, { author, since }) =>
        titles(await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author).gt("_creationTime", since)).order("desc").take(10)),
    }),
    highest: query({
      args: { min: v.number() },
      handler: async (ctx, { min }) => titles(await ctx.db.query("posts").withIndex("by_score", (q) => q.gt("score", min)).order("desc").take(10)),
    }),
    recent: query({
      args: { author: v.string(), k: v.number() },
      handler: async (ctx, { author, k }) =>
        titles(await ctx.db.query("posts").withIndex("by_author", (q) => q.eq("author", author)).order("desc").take(k)),
    }),
    scan: query({ args: {}, handler: async (ctx) => (await ctx.db.query("posts").collect()).length }),
  },
  events: {
    add: mutation({
      args: { kind: v.string(), payload: v.string() },
      handler: (ctx, a) => ctx.db.insert("events", a),
    }),
  },
};

// ---------- output helpers ----------

const nf = new Intl.NumberFormat("en-US");
const fmtMs = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2));

function pct(durations: number[], p: number): number {
  const s = [...durations].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!;
}

/** Times n awaited ops; durations include everything runMutation/runQuery awaits. */
async function benchLoop(n: number, op: (i: number) => Promise<unknown>): Promise<number[]> {
  const d: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await op(i);
    d.push(performance.now() - t0);
  }
  return d;
}

function rowRun(name: string, d: number[], note = "") {
  const total = d.reduce((a, b) => a + b, 0);
  const line =
    `${name.padEnd(44)}${nf.format(Math.round((d.length / total) * 1000)).padStart(11)} op/s` +
    `  p50 ${fmtMs(pct(d, 0.5)).padStart(7)} ms  p99 ${fmtMs(pct(d, 0.99)).padStart(7)} ms`;
  console.log(note ? `${line}  ${note}` : line);
}

function rowOps(name: string, ops: number, note = "") {
  const line = `${name.padEnd(44)}${nf.format(Math.round(ops)).padStart(11)} op/s`;
  console.log(note ? `${line}  ${note}` : line);
}

function micro(name: string, n: number, fn: () => unknown) {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  rowOps(name, (n / (performance.now() - t0)) * 1000);
}

// ---------- main ----------

type Spec = { name: string; args: Record<string, unknown> };

/** Subscribes all specs; listeners model the ws.send path (stringify each update). */
async function subscribeAll(subs: SubscriptionManager, specs: Spec[]) {
  const unsubs: (() => void)[] = [];
  const fired = { n: 0 };
  const firsts: Promise<void>[] = [];
  for (const s of specs) {
    let resolve: () => void = () => {};
    firsts.push(new Promise<void>((r) => (resolve = r)));
    let done = false;
    unsubs.push(
      subs.subscribe(s.name, s.args, null, (u) => {
        JSON.stringify(u); // models pushUpdate's ws.send(JSON.stringify(msg))
        fired.n++;
        if (!done) {
          done = true;
          resolve();
        }
      }),
    );
  }
  await Promise.all(firsts);
  return { unsubs, fired };
}

/**
 * Subscription mix for the write-storm scenario: eq-filed, range-filed, window reads. All read
 * the newest end of their index, and storm writes (stormScore) insert above every existing score,
 * so each write re-runs and changes: every `recent`/`newestByAuthor` sub for the writer's author,
 * and every `highest` sub whose threshold the new score clears.
 */
function stormSpecs(n: number): Spec[] {
  const specs: Spec[] = [];
  for (let i = 0; i < n; i++) {
    const kind = i % 10;
    if (kind < 4) specs.push({ name: "posts:newestByAuthor", args: { author: AUTHORS[i % 40], since: Math.floor(i / 40) } });
    else if (kind < 8) specs.push({ name: "posts:highest", args: { min: (i * 97) % 12_000 } });
    else specs.push({ name: "posts:recent", args: { author: AUTHORS[i % 40], k: 10 + (i % 5) } });
  }
  return specs;
}

/** Above the cold band's top (5999) and rising, so a storm write is always the new highest score. */
let stormSeq = 0;
const stormScore = () => 6000 + ++stormSeq;

async function main() {
  console.log(`onebase bench — sqlite | bun ${Bun.version} | ${process.platform} ${process.arch} | ${cpus().length} cpus`);
  console.log(`docs: ~${(BODIES[0]!.length / 1000).toFixed(1)} KB each; 99% of seed scores in [0,100]\n`);

  const dir = mkdtempSync(join(tmpdir(), "onebase-bench-"));
  const driver = new SqliteDriver(join(dir, "db.sqlite"));
  const runtime = new Runtime({ driver, log: { info() {}, warn() {}, error() {} }, schema, modules });
  await runtime.init();
  const subs = new SubscriptionManager(runtime);

  let queryRuns = 0;
  const originalRunQuery = runtime.runQuery.bind(runtime);
  runtime.runQuery = ((name: any, args: any, opts: any) => {
    queryRuns++;
    return originalRunQuery(name, args, opts);
  }) as typeof runtime.runQuery;

  const started = performance.now();
  try {
    console.log(`seeding ${nf.format(SEED_DOCS)} documents…`);
    const ids = (await runtime.runMutation("posts:seed", { count: SEED_DOCS })) as string[];
    await driver.optimize(); // the seed was one transaction; a long-running server does this on its own
    const pick = () => ids[Math.floor(rand() * ids.length)]!;

    // --- 1. mutation throughput with nobody watching -------------------------
    console.log("\n— mutations, no subscribers —");
    Bun.gc(true);
    rowRun(
      "insert",
      await benchLoop(2000, (i) =>
        runtime.runMutation("posts:add", { author: AUTHORS[i % 40], score: Math.floor(rand() * 100), title: `ins-${i}` }),
      ),
    );
    rowRun("patch", await benchLoop(1000, () => runtime.runMutation("posts:setScore", { id: pick(), score: Math.floor(rand() * 100) })));

    // --- 2. write storm against live subscriptions ---------------------------
    for (const N of [50, 200, 1000]) {
      console.log(`\n— write storm, ${N} subscriptions (eq / range / window mix) —`);
      Bun.gc(true);
      const t0 = performance.now();
      const { unsubs, fired } = await subscribeAll(subs, stormSpecs(N));
      const initialMs = performance.now() - t0;
      const writes = Math.max(50, Math.round(100_000 / N)); // ≈ equal total re-runs across N
      queryRuns = 0;
      fired.n = 0;
      const d = await benchLoop(writes, (i) =>
        runtime.runMutation("posts:add", { author: AUTHORS[i % 40], score: stormScore(), title: `storm-${N}-${i}` }),
      );
      rowRun(`storm writes (${writes})`, d, `entries=${subs.size} re-runs=${nf.format(queryRuns)} fires=${nf.format(fired.n)} initial-sub=${fmtMs(initialMs)}ms`);
      for (const u of unsubs) u();
    }

    // --- 3. rejected candidates: candidates() finds them, writeAffects says no
    console.log("\n— invalidation matching, 1000 subs —");
    Bun.gc(true);
    {
      const { unsubs } = await subscribeAll(
        subs,
        Array.from({ length: 1000 }, (_, i) => ({ name: "posts:top", args: { min: 5000 + i } })), // cold bands
      );
      queryRuns = 0;
      rowRun(
        "rejected candidates (hot writes)",
        await benchLoop(500, (i) =>
          runtime.runMutation("posts:add", { author: AUTHORS[i % 40], score: Math.floor(rand() * 100), title: `rej-${i}` }),
        ),
        `re-runs=${nf.format(queryRuns)} (expect 0)`,
      );
      queryRuns = 0;
      rowRun(
        "cold-table writes (no candidates)",
        await benchLoop(500, (i) => runtime.runMutation("events:add", { kind: "tick", payload: `p-${i}` })),
        `re-runs=${nf.format(queryRuns)} (expect 0)`,
      );
      for (const u of unsubs) u();
    }

    // --- 4. unchanged results: re-run happens, stringify-compare discards ----
    Bun.gc(true);
    {
      const { unsubs, fired } = await subscribeAll(
        subs,
        Array.from({ length: 1000 }, (_, i) => ({ name: "posts:byAuthor", args: { author: AUTHORS[i % 40], since: Math.floor(i / 40) } })),
      );
      queryRuns = 0;
      fired.n = 0;
      rowRun(
        "unchanged results (body patches)",
        await benchLoop(200, (i) => runtime.runMutation("posts:editBody", { id: pick(), body: BODIES[i % BODIES.length]! })),
        `re-runs=${nf.format(queryRuns)} fires=${nf.format(fired.n)} (expect 0 fires)`,
      );
      for (const u of unsubs) u();
    }

    // --- 5. one shared subscription, 1000 listeners ---------------------------
    Bun.gc(true);
    {
      const { unsubs, fired } = await subscribeAll(subs, Array.from({ length: 1000 }, () => ({ name: "posts:recent", args: { author: AUTHORS[0], k: 10 } })));
      queryRuns = 0;
      fired.n = 0;
      rowRun(
        "shared fan-out (1 entry, 1000 listeners)",
        await benchLoop(50, (i) => runtime.runMutation("posts:add", { author: AUTHORS[0], score: 90 + (i % 10), title: `fan-${i}` })),
        `re-runs=${nf.format(queryRuns)} fires=${nf.format(fired.n)}`,
      );
      for (const u of unsubs) u();
    }

    // --- 6. query throughput --------------------------------------------------
    console.log("\n— queries (no subscriptions live) —");
    Bun.gc(true);
    const docs = (await runtime.runQuery("posts:scan", {})).value as number;
    rowRun(
      "indexed eq+range, take 10",
      await benchLoop(500, (i) => runtime.runQuery("posts:byAuthor", { author: AUTHORS[i % 40], since: 0 })),
      `~${nf.format(Math.round(docs / 40))} rows scanned`,
    );
    rowRun(
      "indexed range, take 10",
      await benchLoop(500, () => runtime.runQuery("posts:top", { min: 50 })),
    );
    rowRun("full table scan", await benchLoop(30, () => runtime.runQuery("posts:scan", {})), `${nf.format(docs)} rows parsed/run`);

    // --- 7. kernel micro-benchmarks -------------------------------------------
    console.log("\n— kernel micro-benches (pure JS, the Rust-rewrite targets) —");
    const doc = { author: "author-01", score: 42, title: "post-1", body: BODIES[0] };
    const bigArgs: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) bigArgs[`field-${i}`] = i % 3 === 0 ? { nested: [1, 2, "three", null], flag: true } : `value-${i}`;
    const clone = JSON.parse(JSON.stringify(doc)) as typeof doc;
    const other = { ...doc, title: "different" };
    micro("stableStringify(large args)", 20_000, () => stableStringify(bigArgs));
    micro("clone: JSON.parse(JSON.stringify)", 20_000, () => JSON.parse(JSON.stringify(doc)));
    micro("sameValue compare (equal docs)", 20_000, () => JSON.stringify(doc) === JSON.stringify(clone));
    micro("sameValue compare (different docs)", 20_000, () => JSON.stringify(doc) === JSON.stringify(other));

    console.log(`\ndone in ${fmtMs(performance.now() - started)} ms | rss ${(process.memoryUsage().rss / 1e6).toFixed(0)} MB`);
  } finally {
    runtime.stop();
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
