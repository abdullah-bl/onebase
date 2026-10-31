#!/usr/bin/env node
// stress.mjs — sustained load generator: CPU/RAM shoot-out.
// usage: node stress.mjs <convex|onebase> <ping|write|scan|bigdoc|mixed|vector> <seconds> <concurrency>
// All modes are self-cleaning (addOne inserts+deletes one doc).

const TARGETS = {
  convex: { url: process.env.CONVEX_URL || "http://127.0.0.1:3210", scheme: "Convex", key: process.env.CONVEX_ADMIN_KEY || "" },
  onebase: { url: process.env.ONEBASE_URL || "http://127.0.0.1:8190", key: "" },
};

const [platform, mode, secs = "60", conc = "50"] = process.argv.slice(2);
const t = TARGETS[platform];
if (!t || !mode) {
  console.error("usage: node stress.mjs <convex|onebase> <ping|write|scan|bigdoc|mixed|vector> <seconds> <concurrency>");
  process.exit(1);
}

async function call(kind, fn, args = {}) {
  const headers = { "Content-Type": "application/json" };
  if (t.key) headers.Authorization = `${t.scheme} ${t.key}`;
  try {
    const res = await fetch(`${t.url}/api/${kind}`, {
      method: "POST", headers, body: JSON.stringify({ path: fn, args }),
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => ({ status: "error", errorMessage: "bad json" }));
    return json.status === "success"
      ? { ok: true }
      : { ok: false, err: (json.errorMessage || "unknown").split("\n").find((l) => l.trim()) || "?" };
  } catch (e) { return { ok: false, err: String(e).slice(0, 90) }; }
}

const OPS = {
  ping: () => call("query", "bench:ping"),
  write: () => call("mutation", "bench:addOne", { size: 1000 }),
  scan: () => call("query", "bench:scanDocs", { tag: "nomatch" }),
  bigdoc: () => call("mutation", "bench:addOne", { size: 512 * 1024 }),
  mixed: () => Math.random() < 0.5 ? call("query", "bench:ping") : call("mutation", "bench:addOne", { size: 1000 }),
  // vector search over the 10k×1536 corpus seeded by `bench.mjs vector-seed`
  vector: () => call("action", "vectors:vectorSearchRun", { seed: Math.floor(Math.random() * 2 ** 31), limit: 10 }),
};
const op = OPS[mode];

const lat = []; let ok = 0; const errs = new Map();
const end = Date.now() + secs * 1000;

async function worker() {
  while (Date.now() < end) {
    const t0 = performance.now();
    const r = await op();
    if (r.ok) { ok++; lat.push(Math.round(performance.now() - t0)); }
    else errs.set(r.err, (errs.get(r.err) || 0) + 1);
  }
}

await Promise.all(Array.from({ length: +conc }, worker));
lat.sort((a, b) => a - b);
const p = (q) => lat.length ? lat[Math.min(lat.length - 1, Math.floor((q / 100) * lat.length))] : -1;
console.log("RESULT " + JSON.stringify({
  platform, mode, dur: +secs, conc: +conc, ok,
  fail: [...errs.values()].reduce((a, b) => a + b, 0),
  qps: +(ok / +secs).toFixed(1), p50: p(50), p95: p(95),
  top_err: [...errs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2),
}));
