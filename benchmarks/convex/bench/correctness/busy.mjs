import { call, sleep } from "./common.mjs";
// Pings until 500 ms after a fixed CPU-bound mutation returns. The default takes
// about 3 s on the machine in docs/benchmarks.md; set BUSY_ITERATIONS for others.
const iterations = Number(process.env.BUSY_ITERATIONS || 4e9);
const t0 = performance.now();
let doneAt = null;
const busyP = call("mutation", "bench:busy", { iterations }).then((r) => {
  doneAt = performance.now();
  return { r, ms: doneAt - t0 };
});
const lats = [];
while (doneAt === null || performance.now() - doneAt < 500) {
  const s = performance.now();
  const r = await call("query", "bench:ping");
  lats.push({ at: Math.round(s - t0), lat: Math.round(performance.now() - s), ok: r.status === "success" });
  await sleep(20);
}
const b = await busyP;
const sorted = lats.map((x) => x.lat).sort((a, b) => a - b);
console.log(JSON.stringify({
  busyStatus: b.r.status, busyWallMs: Math.round(b.ms),
  busyIterations: b.r.value?.iterations ?? null, busyChecksum: b.r.value?.checksum ?? null,
  busyError: b.r.errorMessage?.split("\n")[0] ?? null,
  pings: lats.length, pingErrors: lats.filter((x) => !x.ok).length,
  pingP50: sorted[Math.floor(sorted.length / 2)], pingMax: sorted.at(-1),
  pingsOver100ms: lats.filter((x) => x.lat > 100).length,
  firstStalled: lats.find((x) => x.lat > 100) ?? null,
}));
