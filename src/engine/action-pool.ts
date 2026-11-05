// Runs actions on worker threads, so that CPU-heavy code in one doesn't hold up every other
// request, and an action past its time limit can be stopped (worker.terminate()), even in the
// middle of `while (true) {}`.
//
// Each worker loads its own copy of the project's code (see CodeSource). Actions reach data only
// through ctx, so every ctx call is a message back to the main thread, which runs it with the
// same ctx an action on the main thread gets.
//
// A worker runs several actions at once (most wait on fetch() most of the time), but a new action
// goes to an idle worker while there are fewer than `size`. A worker whose action ran out of time
// takes no more work and is stopped: at once if nothing else runs on it or it's stuck (it didn't
// answer a ping), otherwise when the others finish.

import { availableParallelism } from "node:os";
import type { UserIdentity } from "../server";
import { addLine, callLines, type LogLine } from "./calllog";
import { decodeRefs, fromWire, toWire, type CodeSource, type FromThread, type ToThread, type WireFilter } from "./action-wire";
import { OnebaseError } from "./database";
import type { Logger } from "./runtime";

/** Up to this many workers unless ONEBASE_ACTION_WORKERS says otherwise. */
const MAX_DEFAULT_WORKERS = 8;
/** A worker with other actions to finish gets this long to answer a ping before it's stopped too. */
const STALL_MS = 250;
/** Workers beyond the first are stopped after being idle this long. */
const IDLE_MS = 30_000;

export const defaultActionWorkers = () => Math.max(1, Math.min(MAX_DEFAULT_WORKERS, availableParallelism()));

/** The action worker's program, as a path Worker takes: in a compiled binary, an extra entry point of the build. */
export function defaultWorkerEntry(): string | URL {
  const compiled = import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN"); // as cli.ts tells (Windows has ~BUN)
  return compiled ? "./engine/action-worker.ts" : new URL("./action-worker.ts", import.meta.url);
}

/** What one call needs on the main thread: the ctx its worker's calls go to. */
export type ActionTarget = {
  /** The action's ctx on the main thread (Runtime.actionCtx), with its time limit. */
  ctx: Record<string, any>;
  /** Signs a function handle for the running function (createFunctionHandle). */
  handle: (ref: string) => string;
};

type Job = ActionTarget & {
  id: number;
  lines: LogLine[] | undefined;
  /** Answered with a time-limit error already: whatever it does now doesn't count. */
  expired: boolean;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  /** An HTTP action's response body, once its head has arrived. */
  body?: ReadableStreamDefaultController<Uint8Array>;
  /** Resolves the body's pending pull, when the next chunk (or the end) arrives. */
  pulled?: () => void;
};

/** ctx members a worker may call. */
const CTX_CALLS = new Set(["runQuery", "runMutation", "runAction", "vectorSearch", "scheduler", "storage", "hooks", "components"]);

let nextJob = 1;
let nextPing = 1;

class Thread {
  readonly worker: Worker;
  readonly ready: Promise<boolean>;
  readonly jobs = new Map<number, Job>();
  /** Calls handed this thread that haven't started yet. */
  reserved = 0;
  /** Takes no new work; stops once what's left is done. */
  draining = false;
  dead = false;
  idleTimer: ReturnType<typeof setTimeout> | null = null;
  readonly pings = new Map<number, () => void>();

  constructor(
    entry: string | URL,
    source: CodeSource,
    onMessage: (thread: Thread, message: FromThread) => void,
    onExit: (thread: Thread, reason: string) => void,
  ) {
    this.worker = new Worker(entry);
    (this.worker as any).unref(); // an idle worker mustn't keep the process alive
    let settle!: (ok: boolean) => void;
    this.ready = new Promise((resolve) => (settle = resolve));
    this.worker.onmessage = ({ data }: MessageEvent<FromThread>) => {
      if (data.t === "ready") {
        this.functions = data.functions;
        return settle(true);
      }
      if (data.t === "failed") {
        this.failure = data.error;
        return settle(false);
      }
      onMessage(this, data);
    };
    this.worker.onerror = (event) => onExit(this, `the action's thread failed: ${event.message}`);
    this.worker.addEventListener("close", () => {
      settle(false);
      onExit(this, "the action's thread stopped (did a function call process.exit()?)");
    });
    this.worker.postMessage({ t: "init", source } satisfies ToThread);
  }

  /** Why the code didn't load, if it didn't. */
  failure: string | null = null;
  /** The functions the worker found, to compare with the main thread's. */
  functions: string[] = [];

  get load() {
    return this.jobs.size + this.reserved;
  }

  /** Calls that still count: not those already answered with a time-limit error. */
  get live() {
    let n = this.reserved;
    for (const job of this.jobs.values()) if (!job.expired) n++;
    return n;
  }

  post(message: ToThread, transfer: Transferable[] = []) {
    if (!this.dead) this.worker.postMessage(message, transfer);
  }

  /** Keeps the process alive while there's work. */
  busy(on: boolean) {
    if (on) (this.worker as any).ref();
    else (this.worker as any).unref();
  }
}

export class ActionPool {
  private readonly threads: Thread[] = [];
  /** Why actions run on the main thread instead, once workers couldn't load the code. */
  private broken: string | null = null;
  private retired = false;

  constructor(
    private readonly opts: {
      size: number;
      entry: string | URL;
      source: CodeSource;
      log: Logger;
      /** The functions the main thread runs: a worker that finds others has different code. */
      functions: () => Iterable<string>;
    },
  ) {}

  /**
   * A worker to run one call on, started if need be. Null when workers can't run this code: the
   * call runs on the main thread instead.
   */
  async acquire(): Promise<Thread | null> {
    if (this.broken) return null;
    const open = this.threads.filter((t) => !t.draining && !t.dead);
    let thread = open.find((t) => t.load === 0);
    if (!thread && open.length < this.opts.size) thread = this.spawn();
    thread ??= open.reduce((a, b) => (b.load < a.load ? b : a));
    thread.reserved++;
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    thread.idleTimer = null;
    thread.busy(true);
    const ok = await thread.ready;
    // Not ready, or (checked as it became ready) running different code from the main thread.
    if (!ok || thread.dead || this.broken) {
      thread.reserved--;
      if (!ok && !this.broken) this.markBroken(thread.failure ?? "its worker stopped while loading the code");
      this.settled(thread);
      if (this.broken) return null;
      return this.acquire();
    }
    return thread;
  }

  private spawn(): Thread {
    const thread = new Thread(this.opts.entry, this.opts.source, (t, m) => this.onMessage(t, m), (t, reason) => this.onExit(t, reason));
    thread.draining = this.retired;
    void thread.ready.then((ok) => {
      if (!ok) return;
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

  private markBroken(reason: string) {
    if (this.broken) return;
    this.broken = reason;
    this.opts.log.warn(`Actions run on the main thread: ${reason}.`);
    for (const thread of [...this.threads]) {
      thread.draining = true;
      this.reap(thread);
    }
  }

  /** Runs action `name` on `thread` (from acquire()). `deadline` stops it once its time limit passes. */
  runAction(thread: Thread, call: { name: string; args: unknown; identity: UserIdentity | null; mount: string | null }, target: ActionTarget, deadline: { onExpire(fn: () => void): void }): Promise<unknown> {
    return this.start(thread, target, deadline, (job) => ({ t: "run", job, ...call }));
  }

  /** Runs an HTTP action on `thread`: resolves with its Response, whose body streams from the worker. */
  async runHttp(thread: Thread, request: Request, call: { identity: UserIdentity | null; mount: string | null }, target: ActionTarget, deadline: { onExpire(fn: () => void): void }): Promise<Response> {
    let body: ArrayBuffer | null = null;
    try {
      body = request.body && request.method !== "GET" && request.method !== "HEAD" ? await request.arrayBuffer() : null;
    } catch (err) {
      thread.reserved--;
      this.settled(thread);
      throw err;
    }
    const message = (job: number): ToThread => ({
      t: "http",
      job,
      method: request.method,
      url: request.url,
      headers: [...request.headers],
      body,
      ...call,
    });
    return this.start(thread, target, deadline, message, body ? [body] : []);
  }

  private start<T>(thread: Thread, target: ActionTarget, deadline: { onExpire(fn: () => void): void }, message: (job: number) => ToThread, transfer: Transferable[] = []): Promise<T> {
    thread.reserved--;
    if (thread.dead) {
      this.settled(thread);
      return Promise.reject(new OnebaseError("The action's thread stopped before the action could start."));
    }
    const id = nextJob++;
    return new Promise<T>((resolve, reject) => {
      const job: Job = { ...target, id, lines: callLines(), expired: false, resolve, reject };
      thread.jobs.set(id, job);
      deadline.onExpire(() => this.expire(thread, job));
      thread.post(message(id), transfer);
    });
  }

  /** `job` ran out of time (and was answered with that error): its thread takes no more work, and is stopped. */
  private expire(thread: Thread, job: Job) {
    if (thread.dead || !thread.jobs.has(job.id)) return;
    job.expired = true;
    thread.draining = true;
    if (this.reap(thread)) return;
    // Other actions share the thread. If it's stuck, they are too: stop it now.
    const n = nextPing++;
    const timer = setTimeout(() => {
      thread.pings.delete(n);
      this.kill(thread, `The action's thread was stopped: another action on it ran past its time limit and didn't yield.`);
    }, STALL_MS);
    thread.pings.set(n, () => clearTimeout(timer));
    thread.post({ t: "ping", n });
  }

  /** Stops a draining thread once only expired calls are left on it; true if it did. */
  private reap(thread: Thread): boolean {
    if (thread.dead || !thread.draining || thread.live > 0) return false;
    this.kill(thread, "The action's thread was stopped.");
    return true;
  }

  private kill(thread: Thread, reason: string) {
    if (thread.dead) return;
    thread.dead = true;
    thread.worker.terminate();
    this.remove(thread, reason);
  }

  /** A worker stopped (or failed, which stops it) without being told to. */
  private onExit(thread: Thread, reason: string) {
    if (thread.dead) return;
    this.opts.log.error(`Action worker: ${reason}`);
    thread.dead = true;
    thread.worker.terminate();
    this.remove(thread, `The action failed: ${reason}.`);
  }

  private remove(thread: Thread, reason: string) {
    if (thread.idleTimer) clearTimeout(thread.idleTimer);
    for (const pong of thread.pings.values()) pong();
    thread.pings.clear();
    const i = this.threads.indexOf(thread);
    if (i >= 0) this.threads.splice(i, 1);
    for (const job of thread.jobs.values()) {
      if (job.expired) continue;
      const err = new OnebaseError(reason);
      if (job.body) job.body.error(err);
      else job.reject(err);
    }
    thread.jobs.clear();
  }

  /** A call on `thread` finished (or never started). */
  private settled(thread: Thread) {
    if (this.reap(thread)) return;
    if (thread.load > 0 || thread.dead) return;
    thread.busy(false);
    if (thread.draining || this.threads.filter((t) => !t.draining && !t.dead).length <= 1) return;
    thread.idleTimer = setTimeout(() => {
      if (thread.load === 0) this.kill(thread, "idle");
    }, IDLE_MS);
    (thread.idleTimer as any).unref?.();
  }

  private done(thread: Thread, job: Job) {
    thread.jobs.delete(job.id);
    this.settled(thread);
  }

  private onMessage(thread: Thread, m: FromThread) {
    if (m.t === "pong") {
      thread.pings.get(m.n)?.();
      thread.pings.delete(m.n);
      return;
    }
    if (m.t === "ready" || m.t === "failed") return;
    const job = thread.jobs.get(m.job);
    if (!job) return;
    switch (m.t) {
      case "call":
        return void this.onCall(thread, job, m);
      case "log":
        if (job.lines) addLine(job.lines, m.level, m.text);
        return;
      case "done":
        this.done(thread, job);
        if (job.body) {
          // The body was streaming: it failed partway.
          if (!m.ok) job.body.error(fromWire(m.error));
          return;
        }
        if (m.ok) job.resolve(m.value);
        else job.reject(fromWire(m.error));
        return;
      case "head": {
        if (!m.body) {
          this.done(thread, job);
          return job.resolve(new Response(null, { status: m.status, statusText: m.statusText, headers: m.headers }));
        }
        const pull = () => thread.post({ t: "pull", job: job.id });
        const body = new ReadableStream<Uint8Array>({
          start: (controller) => {
            job.body = controller;
          },
          pull: () =>
            new Promise<void>((resolve) => {
              // Resolved by the next chunk (or the end).
              job.pulled = resolve;
              pull();
            }),
          cancel: () => {
            thread.post({ t: "cancel", job: job.id });
            this.done(thread, job);
          },
        });
        job.resolve(new Response(body, { status: m.status, statusText: m.statusText, headers: m.headers }));
        return;
      }
      case "chunk":
        job.body?.enqueue(m.data);
        job.pulled?.();
        return;
      case "end":
        job.body?.close();
        job.pulled?.();
        this.done(thread, job);
        return;
    }
  }

  /** Runs a worker's ctx call with the action's ctx here, and sends the answer back. */
  private async onCall(thread: Thread, job: Job, m: Extract<FromThread, { t: "call" }>) {
    let answer: ToThread;
    try {
      const value = await this.dispatch(job, m.op, m.args);
      answer = { t: "result", job: m.job, seq: m.seq, ok: true, value };
    } catch (err) {
      answer = { t: "result", job: m.job, seq: m.seq, ok: false, error: toWire(err) };
    }
    try {
      thread.post(answer);
    } catch (err) {
      thread.post({ t: "result", job: m.job, seq: m.seq, ok: false, error: toWire(new OnebaseError(`ctx.${m.op.join(".")} returned a value that can't be copied to another thread: ${err instanceof Error ? err.message : String(err)}`)) });
    }
  }

  private dispatch(job: Job, op: string[], rawArgs: unknown[]): Promise<unknown> | unknown {
    const [head, ...path] = op;
    if (head === "handle") return job.handle(rawArgs[0] as string);
    if (!head || !CTX_CALLS.has(head) || !(head in job.ctx)) throw new OnebaseError(`ctx.${op.join(".")} isn't available here.`);
    const args = rawArgs.map((a) => decodeRefs(a));
    if (head === "vectorSearch" && args[2] && typeof args[2] === "object") {
      const query = args[2] as { filter?: unknown };
      if (query.filter) args[2] = { ...query, filter: replayFilter(query.filter as WireFilter) };
    }
    let self: any = job.ctx;
    let fn: any = job.ctx[head];
    for (const key of path) {
      // Components are proxies; everything else is ctx's own plain objects.
      if (head !== "components" && !Object.hasOwn(fn, key)) throw new OnebaseError(`ctx.${op.join(".")} isn't available here.`);
      self = fn;
      fn = fn[key];
    }
    if (typeof fn !== "function") throw new OnebaseError(`ctx.${op.join(".")} isn't a function.`);
    return fn.apply(self, args);
  }

  /** New calls go elsewhere; the workers stop once what they're running finishes (after a deploy). */
  retire() {
    this.retired = true;
    for (const thread of [...this.threads]) {
      thread.draining = true;
      this.reap(thread);
    }
  }

  /** Stops every worker; calls still running fail. */
  stop() {
    this.retired = true;
    this.broken ??= "stopped";
    for (const thread of [...this.threads]) this.kill(thread, "The server is stopping.");
  }

  /** Workers it may run at once. */
  get maxThreads() {
    return this.opts.size;
  }

  /** Workers running now (for tests and the dashboard). */
  get size() {
    return this.threads.filter((t) => !t.dead).length;
  }
}

/** A filter tree from the worker as the callback vectorSearch() takes. */
function replayFilter(tree: WireFilter): (q: any) => unknown {
  const build = (f: WireFilter, q: any): unknown => (f.op === "eq" ? q.eq(f.field, f.value) : q.or(...f.args.map((a) => build(a, q))));
  return (q) => build(tree, q);
}
