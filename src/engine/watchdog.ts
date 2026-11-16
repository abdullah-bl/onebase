// Queries and mutations run on the server's one thread, and a time limit is a timer on that same
// thread: a function that loops without awaiting (`while (true) {}`) stops the timer along with
// everything else, and the server sits there, accepting connections and answering none.
//
// The watchdog is a second thread that only watches whether the first is still turning. When it
// hasn't for `limitMs`, it says which function started last and kills the process, so whatever
// supervises it (systemd, Docker, Fly) starts a fresh one. A stuck server can't shut down
// politely, so this is SIGKILL; SQLite and the other databases are safe against that.

/** How often the main thread reports in. */
const BEAT_MS = 250;

// Shared between the threads: [0] a counter the main thread keeps raising, [1] the id of the
// function that started last, [2] set when the watchdog should stop.
const BEAT = 0;
const LAST = 1;
const STOP = 2;

export type Watchdog = {
  /** Call as a function starts running: it is the one named if the thread never comes back. */
  enter(name: string): void;
  stop(): void;
};

/**
 * The watchdog thread's program. A blob, not a file, so that it's in the compiled binary without
 * further ado. It can't use anything from this module: it is turned into text and run on its own.
 */
function watchdogMain() {
  const scope = globalThis as any;
  const names = new Map<number, string>();
  let view: Int32Array;
  let limitMs = 0;
  let checkMs = 0;
  let seen = -1;
  let stalledChecks = 0;

  const check = () => {
    if (Atomics.load(view, 2)) return scope.close();
    const beat = Atomics.load(view, 0);
    if (beat !== seen) {
      seen = beat;
      stalledChecks = 0;
      return;
    }
    // Counted in this thread's own checks, not by the clock: after the machine sleeps, the clock
    // has jumped but only one check has gone by, and the main thread gets its turn to report in.
    stalledChecks++;
    if (stalledChecks * checkMs < limitMs) return;
    const name = names.get(Atomics.load(view, 1));
    const seconds = limitMs / 1000;
    const message =
      `\nonebase: the server's main thread has been stuck for ${seconds}s, so this process is stopping for its supervisor to restart it.\n` +
      (name ? `  The last function to start was ${name}.\n` : "") +
      `  A query or mutation that loops without awaiting does this: time limits can't interrupt it. Find the loop, or move heavy work to an action.\n` +
      `  $ONEBASE_WATCHDOG sets how long to wait (e.g. 2m), and "off" turns this off.\n`;
    try {
      // Straight to the file descriptor: nothing that needs the main thread. Loaded this way and
      // not with require() or import, which a bundler rewrites into helpers this text doesn't have.
      scope.process.getBuiltinModule("node:fs").writeSync(2, message);
    } catch {}
    scope.process.kill(scope.process.pid, "SIGKILL");
  };

  scope.onmessage = ({ data }: { data: any }) => {
    if (data.name !== undefined) return void names.set(data.id, data.name);
    view = new Int32Array(data.buffer);
    limitMs = data.limitMs;
    checkMs = data.checkMs;
    setInterval(check, checkMs);
  };
}

let workerUrl: string | undefined;

/** Starts watching the calling thread. It must stay unblocked for less than `limitMs` at a time. */
export function startWatchdog(limitMs: number): Watchdog {
  const buffer = new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buffer);
  workerUrl ??= URL.createObjectURL(new Blob([`(${watchdogMain})()`], { type: "text/javascript" }));
  const worker = new Worker(workerUrl);
  (worker as any).unref(); // watching mustn't keep the process alive
  // Several checks per limit, so the stop comes within a quarter of it past the limit.
  worker.postMessage({ buffer, limitMs, checkMs: Math.max(10, Math.min(1000, Math.floor(limitMs / 4))) });

  const beat = setInterval(() => void Atomics.add(view, BEAT, 1), Math.min(BEAT_MS, Math.max(5, Math.floor(limitMs / 8))));
  beat.unref?.();

  const ids = new Map<string, number>();
  return {
    enter(name) {
      let id = ids.get(name);
      if (id === undefined) {
        id = ids.size + 1;
        ids.set(name, id);
        // Sent before the function runs: the message is on its way even if the thread never returns.
        worker.postMessage({ id, name });
      }
      Atomics.store(view, LAST, id);
    },
    stop() {
      clearInterval(beat);
      Atomics.store(view, STOP, 1);
    },
  };
}
