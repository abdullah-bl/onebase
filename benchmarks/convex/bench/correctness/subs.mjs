import { call, sleep, URL } from "./common.mjs";
const ws = new WebSocket(URL.replace("http", "ws") + "/api/sync");
const updates = []; const errors = []; let authed = false;
const onMsg = (m) => {
  if (m.type === "auth") authed = true;
  const items = m.type === "transition" ? m.updates : [m];
  for (const u of items) if (u.type === "update" && u.id === 1) (u.ok ? updates.push(u.value) : errors.push(u.error));
};
ws.onmessage = (ev) => onMsg(JSON.parse(ev.data));
await new Promise((r) => (ws.onopen = r));
ws.send(JSON.stringify({ type: "auth", token: null }));
while (!authed) await sleep(10);
ws.send(JSON.stringify({ type: "sub", id: 1, path: "bench:counterValue", args: {} }));
await sleep(300);
const start = updates.at(-1);
const N = 30;
for (let i = 0; i < N; i += 6) await Promise.all(Array.from({ length: 6 }, () => call("mutation", "bench:bump")));
await sleep(1500);
const final = updates.at(-1);
let backwards = 0;
for (let i = 1; i < updates.length; i++) if (updates[i] < updates[i - 1]) backwards++;
console.log(JSON.stringify({
  startValue: start, finalValue: final, expectedFinal: start + N,
  finalCorrect: final === start + N, updatesReceived: updates.length,
  outOfOrder: backwards, errors: errors.length, sample: updates.slice(0, 12),
}));
ws.close();
