#!/usr/bin/env node
// bench.mjs — Convex (self-hosted) vs onebase limit-hitter CLI.
// Usage: node bench.mjs <convex|onebase> [scenario ...]
// Scenarios: ping arg-size doc-size docs-per-txn scan read-volume exec-time
//            throughput concurrency vector-clear vector-seed vector-search
//            vector-scale ws-connections docs-clear all (default)
// Env: CONVEX_URL (default http://127.0.0.1:3210), CONVEX_ADMIN_KEY,
//      ONEBASE_URL (default http://127.0.0.1:8190)

import { appendFileSync } from "node:fs";

const TARGETS = {
  convex: {
    url: process.env.CONVEX_URL || "http://127.0.0.1:3210",
    key: process.env.CONVEX_ADMIN_KEY || "",
    scheme: "Convex",
    sep: ":",
    auth: true,
  },
  onebase: {
    url: process.env.ONEBASE_URL || "http://127.0.0.1:8190",
    key: "",
    sep: ":",
    auth: false,
  },
};

const out = [];
const log = (s = "") => { console.log(s); out.push(s); };

async function call(t, kind, fn, args = {}, timeoutMs = 240000) {
  const path = fn.replaceAll(":", t.sep);
  const body = JSON.stringify({ path, args });
  const headers = { "Content-Type": "application/json" };
  if (t.auth && t.key) headers.Authorization = `${t.scheme} ${t.key}`;
  const t0 = performance.now();
  try {
    const res = await fetch(`${t.url}/api/${kind}`, {
      method: "POST", headers, body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.round(performance.now() - t0);
    const json = await res.json().catch(() => ({}));
    if (json.status === "success") return { ok: true, value: json.value, ms };
    return {
      ok: false, ms,
      error: (json.errorMessage || json.error || JSON.stringify(json)).slice(0, 220),
    };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e).slice(0, 220) };
  }
}

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];
const human = (n) => n >= 2 ** 20 ? (n / 2 ** 20).toFixed(1) + " MiB"
  : n >= 1024 ? Math.round(n / 1024) + " KiB" : `${n} B`;

// find max OK value on a ladder; returns {okValue, failValue, failErr}
async function ladder(t, name, values, run, describe = human) {
  let okValue = null, failValue = null, failErr = null;
  for (const v of values) {
    const r = await run(v);
    if (r.ok) { okValue = v; log(`  ${name}=${describe(v)} → OK (${r.ms}ms)`); }
    else {
      failValue = v; failErr = r.error;
      log(`  ${name}=${describe(v)} → FAIL: ${r.error.split("\n")[0]}`);
      break;
    }
  }
  return { okValue, failValue, failErr };
}

// Convex self-hosted rejects writes over 4 MiB/s (TooManyWrites), so its vector
// batches are paced under that; onebase has no such cap.
const vecPace = (t) => t.auth
  ? { batch: 250, pauseMs: 900 } // 250 × 12.3KB ≈ 3.1MB per ~1s
  : { batch: 500, pauseMs: 0 };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const pacedCall = async (t, kind, fn, args) => {
  for (let i = 0; i < 8; i++) {
    const r = await call(t, kind, fn, args, 240000);
    if (r.ok || !/TooManyWrites/.test(r.error || "")) return r;
    await sleep(1500 * (i + 1));
  }
  return { ok: false, error: "TooManyWrites: gave up after 8 retries" };
};

const SCENARIOS = {

  ping: async (t) => {
    log("\n── ping / latency (20 sequential + 200 concurrent queries) ──");
    const seq = [];
    for (let i = 0; i < 20; i++) { const r = await call(t, "query", "bench:ping"); if (r.ok) seq.push(r.ms); }
    seq.sort((a, b) => a - b);
    log(`  sequential: p50=${pct(seq, 50)}ms p95=${pct(seq, 95)}ms (n=${seq.length})`);
    const t0 = performance.now();
    const conc = await Promise.allSettled(Array.from({ length: 200 }, () => call(t, "query", "bench:ping")));
    const wall = Math.round(performance.now() - t0);
    const okc = conc.filter((r) => r.value?.ok).length;
    log(`  200 concurrent: ${okc}/200 OK in ${wall}ms (${Math.round(200 / (wall / 1000))} req/s)`);
    return { p50: pct(seq, 50), p95: pct(seq, 95), concurrent_ok: okc, concurrent_ms: wall };
  },

  "arg-size": async (t) => {
    log("\n── function argument size (bench/echo) ──");
    const sizes = [1024, 64 * 1024, 512 * 1024, 1048576, 8 * 1048576, 16 * 1048576, 32 * 1048576];
    const r = await ladder(t, "arg", sizes, (size) =>
      call(t, "mutation", "bench:echo", { blob: "x".repeat(size) }));
    log(`  ⇒ max arg: ${r.okValue ? human(r.okValue) : "none"}`);
    return r;
  },

  "doc-size": async (t) => {
    log("\n── single document size (bench/addOne) ──");
    const sizes = [1024, 64 * 1024, 512 * 1024, 1048576, 1048577, 2 * 1048576, 8 * 1048576, 32 * 1048576];
    const r = await ladder(t, "doc", sizes, (size) =>
      call(t, "mutation", "bench:addOne", { size }));
    log(`  ⇒ max doc: ${r.okValue ? human(r.okValue) : "none"}`);
    return r;
  },

  "docs-per-txn": async (t) => {
    log("\n── documents written per mutation (bench/writeDocs, size=10B) ──");
    const counts = [1000, 8000, 16000, 16001, 32000, 64000, 128000];
    const r = await ladder(t, "n", counts, async (n) => {
      const res = await call(t, "mutation", "bench:writeDocs", { n, size: 10 });
      if (res.ok) await drain(t); // cleanup between runs
      return res;
    });
    log(`  ⇒ max docs/txn: ${r.okValue ?? "none"}`);
    return r;
  },

  scan: async (t) => {
    log("\n── documents scanned per query (seed 100k docs, filter on non-indexed field) ──");
    await drain(t);
    const BATCH = 5000, TOTAL = 100000;
    for (let done = 0; done < TOTAL; done += BATCH) {
      const r = await call(t, "mutation", "bench:writeDocs", { n: BATCH, size: 10 });
      if (!r.ok) { log(`  seeding failed: ${r.error}`); return { seeded: done }; }
    }
    log(`  seeded ${TOTAL} docs`);
    const r = await call(t, "query", "bench:scanDocs", { tag: "nomatch" });
    if (r.ok) log(`  scan of 100k docs → OK in ${r.ms}ms (matched ${r.value})`);
    else log(`  scan of 100k docs → FAIL: ${r.error.split("\n")[0]}`);
    await drain(t);
    return { scan_ok: r.ok, ms: r.ms, error: r.ok ? null : r.error };
  },

  "read-volume": async (t) => {
    log("\n── data read per query (seed 1000×64KiB=64MiB, then read n docs) ──");
    await drain(t);
    const seed = await call(t, "mutation", "bench:writeDocs", { n: 1000, size: 65536 });
    if (!seed.ok) { log(`  seeding failed: ${seed.error}`); return { seeded: false }; }
    log("  seeded 1000 docs × 64 KiB");
    const counts = [128, 256, 384, 512, 1000];
    const r = await ladder(t, "n", counts, (n) =>
      call(t, "query", "bench:readVolume", { n }));
    log(`  ⇒ max read: ${r.okValue ? human(r.okValue * 65536) : "none"} (${r.okValue ?? 0} docs)`);
    await drain(t);
    return r;
  },

  "exec-time": async (t) => {
    log("\n── CPU-bound function (bench/busy, fixed work) ──");
    // About 40 ms, 400 ms, 800 ms and 3 s on the machine in docs/benchmarks.md.
    const runs = [];
    for (const iterations of [5e7, 5e8, 1e9, 4e9]) {
      const r = await call(t, "mutation", "bench:busy", { iterations });
      runs.push({ iterations, ok: r.ok, ms: r.ms, checksum: r.value?.checksum, error: r.error });
      if (r.ok) log(`  busy(${iterations}) → OK, wall ${r.ms}ms, did ${r.value.iterations}, checksum ${r.value.checksum}`);
      else { log(`  busy(${iterations}) → FAIL after ${r.ms}ms: ${r.error.split("\n")[0]}`); break; }
    }
    return { runs };
  },

  throughput: async (t) => {
    log("\n── write throughput (300 sequential small mutations) ──");
    await drain(t);
    const N = 300;
    const t0 = performance.now();
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const r = await call(t, "mutation", "bench:writeDocs", { n: 1, size: 10 });
      if (r.ok) ok++;
    }
    const sec = (performance.now() - t0) / 1000;
    log(`  sequential: ${ok}/${N} OK in ${sec.toFixed(1)}s → ${Math.round(ok / sec)} writes/s`);
    await drain(t);
    return { writes_per_s: Math.round(ok / sec), ok, of: N };
  },

  concurrency: async (t) => {
    log("\n── 50 concurrent mutations (each writes 1 doc) ──");
    const t0 = performance.now();
    const res = await Promise.allSettled(Array.from({ length: 50 }, () =>
      call(t, "mutation", "bench:writeDocs", { n: 1, size: 10 })));
    const wall = Math.round(performance.now() - t0);
    const ok = res.filter((r) => r.value?.ok).length;
    log(`  ${ok}/50 OK in ${wall}ms → ${Math.round(ok / (wall / 1000))} writes/s effective`);
    const errs = res.filter((r) => !r.value?.ok).map((r) => r.value.error).slice(0, 2);
    for (const e of errs) log(`  err: ${e.split("\n")[0]}`);
    await drain(t);
    return { ok, wall_ms: wall };
  },

  // ---------- vector search (vectors.ts) ----------
  "vector-clear": async (t) => {
    log("\n── vectors: clear embeddings table ──");
    const pace = vecPace(t);
    const t0 = performance.now();
    let total = 0;
    for (let i = 0; i < 200; i++) {
      const r = await pacedCall(t, "mutation", "vectors:vectorClear", { limit: pace.batch });
      if (!r.ok) { log(`  clear failed: ${r.error.split("\n")[0]}`); return { cleared: total, error: r.error }; }
      total += r.value;
      if (r.value < pace.batch) break;
      if (pace.pauseMs) await sleep(pace.pauseMs);
    }
    log(`  cleared ${total} docs in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
    return { cleared: total };
  },

  "vector-seed": async (t) => {
    const pace = vecPace(t);
    log(`\n── vectors: seed 10,000 docs × 1536 dims (batches of ${pace.batch}${pace.pauseMs ? `, ${pace.pauseMs}ms pause — Convex 4MiB/s write cap` : ""}) ──`);
    await SCENARIOS["vector-clear"](t);
    const N = 10000, BATCH = pace.batch;
    const batchMs = [];
    let firstBatchLag = -1, lastBatchLag = -1;
    const t0 = performance.now();
    for (let done = 0; done < N; done += BATCH) {
      const b0 = performance.now();
      const r = await pacedCall(t, "mutation", "vectors:vectorSeed", { start: done, n: BATCH });
      if (!r.ok) { log(`  seeding failed @${done}: ${r.error.split("\n")[0]}`); return { seeded: done, error: r.error }; }
      batchMs.push(Math.round(performance.now() - b0));
      // visibility lag of the last doc of this batch in the vector index
      const poll0 = performance.now();
      for (let tries = 0; tries < 120; tries++) {
        const e = await call(t, "action", "vectors:vectorExact", { seed: done + BATCH - 1 });
        if (e.ok && e.value.top >= 0.999) {
          const lag = Math.round(performance.now() - poll0);
          if (done === 0) firstBatchLag = lag;
          lastBatchLag = lag;
          break;
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      if (pace.pauseMs) await sleep(pace.pauseMs);
    }
    const sec = (performance.now() - t0) / 1000;
    log(`  seeded ${N} docs in ${sec.toFixed(1)}s → ${Math.round(N / sec)} docs/s`);
    log(`  batch ms: first=${batchMs[0]} median=${pct([...batchMs].sort((a, b) => a - b), 50)} last=${batchMs[batchMs.length - 1]}`);
    log(`  vector-index visibility lag: first batch=${firstBatchLag}ms, last batch=${lastBatchLag}ms (0ms = visible immediately)`);
    return { docs_per_s: Math.round(N / sec), first_batch_lag_ms: firstBatchLag, last_batch_lag_ms: lastBatchLag };
  },

  "vector-search": async (t) => {
    log("\n── vectors: search latency + throughput (corpus left by vector-seed) ──");
    const cnt = await call(t, "query", "vectors:vectorCount");
    log(`  corpus: ${cnt.ok ? cnt.value : "?"} docs`);
    if (!cnt.ok || cnt.value === 0) { log("  run vector-seed first"); return { corpus: 0 }; }

    // exact-match sanity: seeded doc must be its own top hit
    const ex = await call(t, "action", "vectors:vectorExact", { seed: 42 });
    log(`  exact match (seed 42): top score=${ex.ok ? ex.value.top.toFixed(6) : "?"} (expect ~1.0)`);

    const rnd = () => Math.floor(Math.random() * 2 ** 31);
    const seq = [];
    for (let i = 0; i < 100; i++) {
      const r = await call(t, "action", "vectors:vectorSearchRun", { seed: rnd(), limit: 10 });
      if (r.ok) seq.push(r.ms);
    }
    seq.sort((a, b) => a - b);
    log(`  sequential search p50=${pct(seq, 50)}ms p95=${pct(seq, 95)}ms (n=${seq.length})`);

    const t0 = performance.now();
    const conc = await Promise.allSettled(Array.from({ length: 200 }, () =>
      call(t, "action", "vectors:vectorSearchRun", { seed: rnd(), limit: 10 })));
    const wall = Math.round(performance.now() - t0);
    const okc = conc.filter((r) => r.value?.ok).length;
    log(`  200 concurrent: ${okc}/200 OK in ${wall}ms (${Math.round(okc / (wall / 1000))} searches/s)`);

    const fil = [];
    for (let i = 0; i < 50; i++) {
      const r = await call(t, "action", "vectors:vectorSearchRun", { seed: rnd(), limit: 10, kind: "even" });
      if (r.ok) fil.push(r.ms);
    }
    fil.sort((a, b) => a - b);
    log(`  filtered (kind="even") p50=${pct(fil, 50)}ms p95=${pct(fil, 95)}ms (n=${fil.length})`);

    return {
      corpus: cnt.value, exact_top: ex.ok ? ex.value.top : null,
      p50: pct(seq, 50), p95: pct(seq, 95),
      concurrent_ok: okc, concurrent_ms: wall,
      filtered_p50: pct(fil, 50),
    };
  },

  "vector-scale": async (t) => {
    log("\n── vectors: search latency vs corpus size (1k / 5k / 10k) ──");
    await SCENARIOS["vector-clear"](t);
    const pace = vecPace(t);
    const SIZES = [1000, 5000, 10000];
    const out = {};
    for (const size of SIZES) {
      for (let done = out.seeded ?? 0; done < size; done += pace.batch) {
        const r = await pacedCall(t, "mutation", "vectors:vectorSeed", { start: done, n: pace.batch });
        if (!r.ok) { log(`  seeding failed @${done}: ${r.error.split("\n")[0]}`); return out; }
        out.seeded = done + pace.batch;
        if (pace.pauseMs) await sleep(pace.pauseMs);
      }
      // let a background vector index settle, then sanity-check the last doc is visible
      for (let tries = 0; tries < 120; tries++) {
        const e = await call(t, "action", "vectors:vectorExact", { seed: size - 1 });
        if (e.ok && e.value.top >= 0.999) break;
        await new Promise((res) => setTimeout(res, 250));
      }
      const rnd = () => Math.floor(Math.random() * 2 ** 31);
      const seq = [];
      for (let i = 0; i < 50; i++) {
        const r = await call(t, "action", "vectors:vectorSearchRun", { seed: rnd(), limit: 10 });
        if (r.ok) seq.push(r.ms);
      }
      seq.sort((a, b) => a - b);
      out[size] = { p50: pct(seq, 50), p95: pct(seq, 95) };
      log(`  ${size} docs: p50=${out[size].p50}ms p95=${out[size].p95}ms`);
    }
    return out;
  },

  "ws-connections": async (t) => {
    log("\n── concurrent WebSocket subscriptions (/api/sync) ──");
    const steps = [50, 200, 500, 1000, 2000];
    let maxOk = 0;
    for (const n of steps) {
      const socks = [];
      let open = 0;
      try {
        for (let i = 0; i < n; i++) {
          const ws = new WebSocket(`${t.url.replace("http", "ws")}/api/sync`);
          ws.onopen = () => open++;
          ws.onclose = () => open--;
          socks.push(ws);
        }
        await new Promise((r) => setTimeout(r, 4000));
        if (open >= n * 0.95) { maxOk = n; log(`  ${n} sockets → OK (${open} open)`); }
        else { log(`  ${n} sockets → only ${open} stayed open`); break; }
      } catch (e) { log(`  ${n} sockets → error: ${String(e).slice(0, 120)}`); break; }
      finally { for (const ws of socks) try { ws.close(); } catch {} }
      await new Promise((r) => setTimeout(r, 1000));
    }
    log(`  ⇒ max concurrent ws: ${maxOk}`);
    return { max_ws: maxOk };
  },

  "docs-clear": async (t) => {
    log("\n── docs: clear table ──");
    const r = await drain(t);
    if (r.error) log(`  clear failed after ${r.cleared} docs: ${r.error.split("\n")[0]}`);
    else log(`  cleared ${r.cleared} docs`);
    return r;
  },
};

// Convex rejects a batch of 10,000 (and large documents need smaller ones still),
// so batches shrink on failure. Its write limit counts deletes too, hence pacedCall.
async function drain(t) {
  let limit = t.auth ? 2000 : 10000, cleared = 0;
  for (let i = 0; i < 2000; i++) {
    const r = await pacedCall(t, "mutation", "bench:clearDocs", { limit });
    if (r.ok) {
      cleared += r.value;
      if (r.value < limit) return { cleared };
    } else if (limit <= 50) return { cleared, error: r.error };
    else limit = Math.floor(limit / 2);
  }
  return { cleared, error: "gave up after 2000 batches" };
}

const platform = process.argv[2];
if (!TARGETS[platform]) {
  console.error("usage: node bench.mjs <convex|onebase> [scenario ...]");
  console.error("scenarios:", Object.keys(SCENARIOS).join(" "));
  process.exit(1);
}
const t = TARGETS[platform];
const wanted = process.argv.slice(3).filter((a) => a !== "all");
const list = wanted.length ? wanted : Object.keys(SCENARIOS);

const health = await call(t, "query", "bench:ping", {}, 10000);
if (!health.ok) {
  console.error(`backend not reachable at ${t.url}: ${health.error}`);
  process.exit(2);
}
log(`# bench ${platform} @ ${t.url} — ${new Date().toISOString()}`);
const results = {};
for (const name of list) {
  if (!SCENARIOS[name]) { console.error(`unknown scenario: ${name}`); continue; }
  try { results[name] = await SCENARIOS[name](t); }
  catch (e) { results[name] = { crash: String(e).slice(0, 200) }; }
}
appendFileSync(new URL("./results.json", import.meta.url),
  JSON.stringify({ platform, ts: new Date().toISOString(), results }, null, 1) + "\n");
log(`\nresults appended to results.json`);
