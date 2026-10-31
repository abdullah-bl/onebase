// Records recent function calls (duration, result, console output) for the dashboard.
// Kept in memory only: a ring buffer, so it costs nothing on disk and has a fixed size.

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

export type CallSource = "client" | "http" | "subscription" | "scheduler" | "cron" | "function" | "dashboard" | "auth";
export type LogLine = { level: "log" | "info" | "warn" | "error" | "debug"; text: string };
export type CallRecord = {
  id: number;
  at: number;
  name: string;
  type: "query" | "mutation" | "action" | "http";
  source: CallSource;
  ms: number;
  ok: boolean;
  error?: string;
  lines: LogLine[];
};

const MAX_LINES = 50;
const MAX_LINE_CHARS = 2000;
const capture = new AsyncLocalStorage<LogLine[]>();
let patched = false;

/** console.* inside a function also goes to that call's record (and still to stdout). */
function patchConsole() {
  if (patched) return;
  patched = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const lines = capture.getStore();
      if (lines && lines.length < MAX_LINES) lines.push({ level, text: format(...args).slice(0, MAX_LINE_CHARS) });
      original(...args);
    };
  }
}

export class CallLog {
  private records: CallRecord[] = [];
  private nextId = 1;
  private listeners = new Set<(record: CallRecord) => void>();
  readonly totals = { calls: 0, errors: 0 };

  constructor(private readonly max = 1000) {
    patchConsole();
  }

  async track<T>(name: string, type: CallRecord["type"], source: CallSource, fn: () => Promise<T>): Promise<T> {
    const lines: LogLine[] = [];
    const at = Date.now();
    const start = performance.now();
    try {
      const value = await capture.run(lines, fn);
      this.add({ id: this.nextId++, at, name, type, source, ms: performance.now() - start, ok: true, lines });
      return value;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.add({ id: this.nextId++, at, name, type, source, ms: performance.now() - start, ok: false, error, lines });
      throw err;
    }
  }

  /** A call answered without running the function: a cached query result. */
  record(name: string, type: CallRecord["type"], source: CallSource) {
    this.add({ id: this.nextId++, at: Date.now(), name, type, source, ms: 0, ok: true, lines: [] });
  }

  private add(record: CallRecord) {
    this.totals.calls++;
    if (!record.ok) this.totals.errors++;
    this.records.push(record);
    if (this.records.length > this.max) this.records.splice(0, this.records.length - this.max);
    for (const listener of this.listeners) listener(record);
  }

  recent(limit = this.max): CallRecord[] {
    return this.records.slice(-limit);
  }

  listen(listener: (record: CallRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
