// Runs live-query re-runs on worker threads, so that a write many people's queries depend on
// doesn't hold up the main thread while all of them run again. Only for SQLite on a file: each
// worker opens its own read-only connection to it (WAL lets any number of readers in alongside
// the writer). Shared databases (Postgres, MySQL, libSQL) always run queries on the main thread.
//
// Which runs come here is sync.ts's choice: background re-runs only, the ones nobody is waiting
// for, and only once a round of them has kept the main thread busy for a few milliseconds, so a
// small fan-out never pays for a thread. Everything else (a subscription's first run, the queries a write waits for, one-off reads)
// stays on the main thread.
//
// Snapshots: a re-run is sent only after the commit that caused it has finished, and the worker
// starts its read transaction after it gets the message, so it sees that commit. Commits that land
// while it runs are caught by sync.ts as for any run (`pending` / `dirty`).
//
// A worker runs one query at a time, in the order they were sent; a few are sent ahead so it never
// waits for the next. A query's time limit starts when the one before it on that worker has
// finished. One past its limit is stopped with its worker (worker.terminate() works even in the
// middle of `while (true) {}`); the queries sent behind it, which never started, go to another.

import { availableParallelism } from "node:os";
import { SHARE_ENV } from "node:worker_threads";
import type { UserIdentity } from "../server";
import { fromWire, type CodeSource } from "./action-wire";
import type { LogLine } from "./calllog";
import { OnebaseError, type ReadSet } from "./database";
import type { CallLimits } from "./limits";
import type { FromQueryThread, ToQueryThread } from "./query-wire";
import { formatMs, type Logger } from "./runtime";

/** Workers beyond the first are stopped after being idle this long. */
const IDLE_MS = 30_000;
/** Queries sent ahead to each worker, so it goes straight from one to the next. */
export const QUERIES_PER_WORKER = 4;

/** At most this many query workers: one core stays for the main thread. */
export const maxQueryWorkers = () => Math.max(1, availableParallelism() - 1);

/**
 * Query workers when nothing says how many: two, or fewer on a small machine, none on a single
 * core. One worker already takes most of the work off the main thread; the second mostly gets a
 * large fan-out to its subscribers sooner. They start only when a fan-out is large enough to need
 * them (see SubscriptionManager.pump), so a small app never starts one.
 */
export const defaultQueryWorkers = () => Math.min(2, availableParallelism() - 1);
/** A round of background re-runs works on the main thread this long before the rest goes to the workers. */
export const QUERY_WORKERS_AFTER_MS = 4;

export type QueryCall = { name: string; args: unknown; identity: UserIdentity | null };

/** How a query run on a worker ended. */
export type QueryOutcome =
  | { ok: true; json: string; readSet: ReadSet; lines: LogLine[] }
  | { ok: false; error: Error; readSet: ReadSet; lines: LogLine[] }
  /** It needs the main thread (a function handle, or the workers can't run this code): run it there. */
  | { ok: false; mainThread: string; lines: LogLine[] };

type Job = {
  id: number;
  call: QueryCall;
  /** Time limit in ms (0: none), counted from when the job before it on its worker finished. */
  limitMs: number;
  /** Posted to its worker. */
  sent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (outcome: QueryOutcome) => void;
};

let nextJob = 1;

class Thread {
  readonly worker: Worker;
  readonly ready: Promise<boolean>;
  /** Handed to this worker, in the order it runs them: the first is running (once sent). */
  readonly queue: Job[] = [];
  dead = false;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  failure: string | null = null;
  functions: string[] = [];
  /** It has loaded the code and takes queries. */
  loaded = false;

  constructor(entry: string | URL, init: ToQueryThread, onMessage: (thread: Thread, m: FromQueryThread) => void, onExit: (thread: Thread, reason: string) => void) {
    // SHARE_ENV: the code sees the environment variables set from the dashboard, as on the main thread.
    this.worker = new Worker(entry, { env: SHARE_ENV } as WorkerOptions);
    (this.worker as any).unref();
    let settle!: (ok: boolean) => void;
    this.ready = new Promise((resolve) => (settle = resolve));
    this.worker.onmessage = ({ data }: MessageEvent<FromQueryThread>) => {
      if (data.t === "ready") {
        this.functions = data.functions;
        this.loaded = true;
        return settle(true);
      }
      if (data.t === "failed") {
        this.failure = data.error;
        return settle(false);
      }
      onMessage(this, data);
    };
    this.worker.onerror = (event) => onExit(this, `the query's thread failed: ${event.message}`);
    this.worker.addEventListener("close", () => {
      settle(false);
      onExit(this, "the query's thread stopped (did a function call process.exit()?)");
    });
    this.worker.postMessage(init);
  }

  get load() {
    return this.queue.length;
  }
}

export class QueryPool {
  private readonly threads: Thread[] = [];
  /** Why every query runs on the main thread instead, once workers couldn't load the code. */
  private broken: string | null = null;
  /** Queries seen needing the main thread; they run there from then on (until the next deploy). */
  private readonly mainOnly = new Set<string>();
  /** Runs answered by a worker, for /api/metrics. */
  runs = 0;

  constructor(
    private readonly opts: {
      size: number;
      entry: string | URL;
      source: CodeSource;
      path: string;
      siteUrl: () => string;
      callLimits: CallLimits;
      log: Logger;
      /** The functions the main thread runs: a worker that finds others has different code. */
      functions: () => Iterable<string>;
    },
  ) {}

  /** Queries a re-run may keep in flight here before waiting for one to finish. */
  get slots() {
    return this.opts.size * QUERIES_PER_WORKER;
  }

  /** Whether `name` may run here. False sends it to the main thread, as without workers. */
  accepts(name: string): boolean {
    return !this.broken && !this.mainOnly.has(name);
  }

  /** Whether a worker has loaded the code, so a query sent now doesn't wait for that. */
  get warm(): boolean {
    return this.threads.some((t) => t.loaded && !t.dead);
  }

  /** Starts the first worker, if there is none, so it is ready by the time it is needed. */
  warmUp() {
    if (!this.broken && !this.threads.some((t) => !t.dead)) this.idle(this.spawn());
  }

  /** Runs a query on a worker. Never rejects: how it ended is in the outcome. */
  run(call: QueryCall, limitMs: number): Promise<QueryOutcome> {
    if (this.broken) return Promise.resolve({ ok: false, mainThread: this.broken, lines: [] });
    return new Promise((resolve) => {
      const job: Job = { id: nextJob++, call, limitMs, sent: false, timer: null, resolve };
      this.assign(job);
    });
  }

  /** Puts a job on the least busy worker, starting another while there are fewer than `size`. */
  private assign(job: Job) {
    const open = this.threads.filter((t) => !t.dead);
    let thread = open.find((t) => t.load === 0);
    if (!thread && open.length < this.opts.size) thread = this.spawn();
    thread ??= open.reduce((a, b) => (b.load < a.load ? b : a));
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    thread.idleTimer = null;
    (thread.worker as any).ref(); // work waiting keeps the process alive
    thread.queue.push(job);
    void thread.ready.then((ok) => (ok ? this.next(thread) : undefined));
  }

  private spawn(): Thread {
    const init: ToQueryThread = { t: "init-query", source: this.opts.source, path: this.opts.path, siteUrl: this.opts.siteUrl(), callLimits: this.opts.callLimits };
    const thread = new Thread(this.opts.entry, init, (t, m) => this.onMessage(t, m), (t, reason) => this.onExit(t, reason));
    void thread.ready.then((ok) => {
      if (!ok) return this.markBroken(thread.failure ?? "a worker stopped while loading the code");
      const main = new Set(this.opts.functions());
      const missing = [...main].filter((name) => !thread.functions.includes(name));
      const extra = thread.functions.filter((name) => !main.has(name));
      if (missing.length || extra.length) {
        this.markBroken(`a worker loaded different code (${[...missing.map((n) => `missing ${n}`), ...extra.map((n) => `extra ${n}`)].slice(0, 5).join(", ")})`);
      }
    });
    this.threads.push(thread);
    return thread;
  }

  /** Sends a ready worker the queries handed to it, and starts the time limit of the one it runs now. */
  private next(thread: Thread) {
    if (thread.dead || this.broken) return;
    for (const job of [...thread.queue]) {
      if (job.sent) continue;
      job.sent = true;
      try {
        thread.worker.postMessage({ t: "query", job: job.id, ...job.call } satisfies ToQueryThread);
      } catch (err) {
        // Never reached the worker: answered here, and the worker's order is unchanged.
        thread.queue.splice(thread.queue.indexOf(job), 1);
        const error = new OnebaseError(`The arguments of ${job.call.name} can't be copied to another thread: ${err instanceof Error ? err.message : String(err)}`);
        job.resolve({ ok: false, error, readSet: { ids: new Set(), ranges: [] }, lines: [] });
      }
    }
    const head = thread.queue[0];
    if (!head) return this.idle(thread);
    if (head.limitMs && !head.timer) head.timer = setTimeout(() => this.expire(thread, head), head.limitMs);
  }

  private finish(thread: Thread, job: Job, outcome: QueryOutcome) {
    if (job.timer) clearTimeout(job.timer);
    thread.queue.splice(thread.queue.indexOf(job), 1);
    if ("mainThread" in outcome) this.mainOnly.add(job.call.name);
    else this.runs++;
    job.resolve(outcome);
    this.next(thread);
  }

  private onMessage(thread: Thread, m: FromQueryThread) {
    if (m.t !== "done") return;
    // A worker answers in order: this is the one running.
    const job = thread.queue[0];
    if (!job || job.id !== m.job) return;
    if ("mainThread" in m) return this.finish(thread, job, { ok: false, mainThread: m.mainThread, lines: m.lines });
    if (m.ok) return this.finish(thread, job, { ok: true, json: m.json, readSet: m.readSet, lines: m.lines });
    return this.finish(thread, job, { ok: false, error: fromWire(m.error), readSet: m.readSet, lines: m.lines });
  }

  /** A query ran past its time limit: it fails as it would on the main thread, and its worker is replaced. */
  private expire(thread: Thread, job: Job) {
    if (thread.dead || thread.queue[0] !== job) return;
    job.timer = null;
    const error = new OnebaseError(`${job.call.name} didn't finish within the query time limit (${formatMs(job.limitMs)}).`);
    this.stopThread(thread);
    thread.queue.shift();
    // What it read is unknown, so the subscription watches everything until it runs again.
    job.resolve({ ok: false, error, readSet: { ids: new Set(), ranges: [] }, lines: [] });
    this.reassign(thread);
  }

  /** A worker stopped without being told to: the query it was running fails, the rest go to another. */
  private onExit(thread: Thread, reason: string) {
    if (thread.dead) return;
    this.opts.log.error(`Query worker: ${reason}`);
    this.stopThread(thread);
    const job = thread.queue[0]?.sent ? thread.queue.shift() : undefined;
    if (job) {
      if (job.timer) clearTimeout(job.timer);
      job.resolve({ ok: false, error: new OnebaseError(`The query failed: ${reason}.`), readSet: { ids: new Set(), ranges: [] }, lines: [] });
    }
    this.reassign(thread);
  }

  /** Queries that were waiting on a stopped worker. */
  private reassign(thread: Thread) {
    const waiting = thread.queue.splice(0);
    for (const job of waiting) {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
      job.sent = false; // it never started: queries only read, so running it elsewhere is safe
      if (this.broken) job.resolve({ ok: false, mainThread: this.broken, lines: [] });
      else this.assign(job);
    }
  }

  private stopThread(thread: Thread) {
    thread.dead = true;
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    thread.worker.terminate();
    const i = this.threads.indexOf(thread);
    if (i >= 0) this.threads.splice(i, 1);
  }

  /** Nothing left on a worker: it no longer keeps the process alive, and all but one stop after a while. */
  private idle(thread: Thread) {
    (thread.worker as any).unref();
    if (thread.idleTimer || this.threads.filter((t) => !t.dead).length <= 1) return;
    thread.idleTimer = setTimeout(() => {
      thread.idleTimer = null;
      if (thread.load === 0 && !thread.dead) this.stopThread(thread);
    }, IDLE_MS);
    (thread.idleTimer as any).unref?.();
  }

  /** Every query runs on the main thread from now on (workers can't load this code). */
  private markBroken(reason: string) {
    if (this.broken) return;
    this.broken = reason;
    this.opts.log.warn(`Live queries re-run on the main thread: ${reason}.`);
    this.shutdown(reason);
  }

  /**
   * Stops every worker. Queries still waiting or running are answered "run on the main thread";
   * after a deploy their caller sees that the code changed and runs them again on the new code.
   */
  stop(reason = "the server is stopping") {
    this.broken ??= reason;
    this.shutdown(reason);
  }

  private shutdown(reason: string) {
    for (const thread of [...this.threads]) {
      const jobs = thread.queue.splice(0);
      this.stopThread(thread);
      for (const job of jobs) {
        if (job.timer) clearTimeout(job.timer);
        job.resolve({ ok: false, mainThread: reason, lines: [] });
      }
    }
  }

  /** Workers running now (for tests and /api/metrics). */
  get size() {
    return this.threads.filter((t) => !t.dead).length;
  }
}
