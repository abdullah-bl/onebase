// The watchdog: a server whose one thread is stuck in a function that never awaits stops itself,
// saying which function it was, so that a supervisor can start a fresh one.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWatchdog } from "../src/engine/watchdog";

const root = mkdtempSync(join(tmpdir(), "onebase-watchdog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const SERVER = `
import { startApp } from ${JSON.stringify(join(import.meta.dir, "../src/app"))};
import { mutation, query } from ${JSON.stringify(join(import.meta.dir, "../src/server"))};
const modules = { notes: {
  ok: query({ args: {}, handler: async () => "fine" }),
  spin: mutation({ args: {}, handler: async () => { for (;;) {} } }),
} };
const app = await startApp({ schema: null, modules, dataDir: process.argv[2], port: 0, hostname: "127.0.0.1", dev: false, quiet: true, watchdogMs: Number(process.argv[3]) });
console.log("READY " + app.server.port);
`;

async function startServer(watchdogMs: number) {
  const script = join(root, "server.ts");
  writeFileSync(script, SERVER);
  const proc = Bun.spawn(["bun", script, mkdtempSync(join(root, "data-")), String(watchdogMs)], { stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("READY")) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`The server didn't start: ${await new Response(proc.stderr).text()}`);
    out += new TextDecoder().decode(value);
  }
  const base = `http://127.0.0.1:${/READY (\d+)/.exec(out)![1]}`;
  const call = (kind: string, path: string) =>
    fetch(`${base}/api/${kind}`, { method: "POST", body: JSON.stringify({ path, args: {} }), signal: AbortSignal.timeout(10_000) }).then(
      (r) => r.json() as Promise<any>,
      () => "no answer",
    );
  return { proc, call };
}

test("a function that never comes back gets the process stopped, and named", async () => {
  const { proc, call } = await startServer(1000);
  expect(await call("query", "notes:ok")).toEqual({ status: "success", value: "fine" });
  // Idle for longer than the limit: nothing is stuck, so nothing happens.
  await Bun.sleep(1500);
  expect(proc.exitCode).toBeNull();
  expect(await call("query", "notes:ok")).toEqual({ status: "success", value: "fine" });

  const began = performance.now();
  const stuck = call("mutation", "notes:spin");
  await proc.exited;
  const took = performance.now() - began;
  expect(await stuck).toBe("no answer");
  expect(proc.signalCode).toBe("SIGKILL");
  expect(took).toBeGreaterThanOrEqual(900);
  expect(took).toBeLessThan(5000);
  const said = await new Response(proc.stderr).text();
  expect(said).toContain("main thread has been stuck for 1s");
  expect(said).toContain("The last function to start was notes:spin.");
  expect(said).toContain("$ONEBASE_WATCHDOG");
}, 30_000);

test("with the watchdog off, a stuck server just stays stuck", async () => {
  const { proc, call } = await startServer(0);
  void call("mutation", "notes:spin");
  await Bun.sleep(1500);
  expect(proc.exitCode).toBeNull();
  proc.kill("SIGKILL");
  await proc.exited;
}, 30_000);

test("a stopped watchdog lets go of its thread", async () => {
  const watchdog = startWatchdog(200);
  watchdog.enter("notes:one");
  watchdog.enter("notes:two");
  watchdog.stop();
  // Blocking this thread now is nobody's business any more.
  const until = performance.now() + 600;
  while (performance.now() < until) {}
  expect(true).toBe(true);
});
