import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { call, sleep } from "./common.mjs";
const acked = new Set(); let seq = 0; let stop = false; let workerErrs = 0;
const worker = async () => {
  while (!stop) {
    const s = ++seq;
    const r = await call("mutation", "bench:logAck", { seq: s });
    if (r.status === "success") acked.add(s); else { workerErrs++; await sleep(50); }
  }
};
const workers = Array.from({ length: 20 }, worker);
await sleep(5000);
const ackedAtKill = acked.size;
execSync("docker kill -s KILL onebase-bench");
writeFileSync('acked.json', JSON.stringify([...acked]));
await sleep(3000);
execSync("docker start onebase-bench");
const tUp = Date.now();
let up = false;
while (!up && Date.now() - tUp < 120000) {
  const r = await call("query", "bench:ping");
  if (r.status === "success") up = true; else await sleep(300);
}
const recoveryMs = Date.now() - tUp;
stop = true;
await Promise.all(workers);
const db = (await call("query", "bench:listAcks")).value;
const dbSet = new Set(db);
const lost = [...acked].filter((s) => !dbSet.has(s));
console.log(JSON.stringify({
  ackedBeforeKill: ackedAtKill, totalAcked: acked.size, workerErrors: workerErrs,
  rowsInDb: db.length, duplicateRows: db.length - dbSet.size,
  lostAcknowledged: lost.length, sampleLost: lost.slice(0, 5),
  committedButNoReply: db.filter((s) => !acked.has(s)).length, recoveryMs,
}));
