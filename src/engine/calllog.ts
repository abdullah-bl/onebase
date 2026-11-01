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

// Latency histograms: half-octave buckets from 0.1 ms to about 74 s, so a percentile is within ~20%.
const HIST_BUCKETS = 40;
const bucketOf = (ms: number) => (ms <= 0.1 ? 0 : Math.min(HIST_BUCKETS - 1, Math.ceil(2 * Math.log2(ms / 0.1))));
const bucketTop = (i: number) => 0.1 * 2 ** (i / 2);

// Function stats live in six 10-minute slots, so "the last hour" forgets old failures as it rolls.
const FN_SLOT_MS = 600_000;
const FN_SLOTS = 6;
// HTTP calls are named after their path, which clients choose: past this, new names share one row.
const MAX_FN_NAMES = 500;
const OTHER = "(other)";
const MAX_ERROR_CHARS = 500;

function percentile(hist: Uint32Array, count: number, p: number): number | null {
  if (count === 0) return null;
  const rank = Math.ceil(count * p);
  let seen = 0;
  for (let i = 0; i < HIST_BUCKETS; i++) {
    seen += hist[i]!;
    if (seen >= rank) return bucketTop(i);
  }
  return bucketTop(HIST_BUCKETS - 1);
}

type Bucket = { at: number; ok: number; err: number; runs: number; hist: Uint32Array };

/** A fixed row of time buckets, reused as time passes. */
class TimeRing {
  private readonly buckets: Bucket[];

  constructor(
    private readonly size: number,
    private readonly widthMs: number,
  ) {
    this.buckets = Array.from({ length: size }, () => ({ at: -1, ok: 0, err: 0, runs: 0, hist: new Uint32Array(HIST_BUCKETS) }));
  }

  add(now: number, ok: boolean, ms: number | null) {
    const at = Math.floor(now / this.widthMs);
    const b = this.buckets[at % this.size]!;
    if (b.at > at) return;
    if (b.at < at) {
      b.at = at;
      b.ok = b.err = b.runs = 0;
      b.hist.fill(0);
    }
    if (ok) b.ok++;
    else b.err++;
    if (ms !== null) {
      b.runs++;
      b.hist[bucketOf(ms)]!++;
    }
  }

  /** The last `count` buckets, oldest first, with gaps filled in. */
  series(now: number, count = this.size) {
    const last = Math.floor(now / this.widthMs);
    return Array.from({ length: count }, (_, i) => {
      const at = last - count + 1 + i;
      const b = this.buckets[at % this.size]!;
      return b.at === at ? { at: at * this.widthMs, bucket: b } : { at: at * this.widthMs, bucket: null };
    });
  }

  summary(now: number, count = this.size): CallSummary {
    const hist = new Uint32Array(HIST_BUCKETS);
    let calls = 0;
    let errors = 0;
    let runs = 0;
    for (const { bucket } of this.series(now, count)) {
      if (!bucket) continue;
      calls += bucket.ok + bucket.err;
      errors += bucket.err;
      runs += bucket.runs;
      for (let i = 0; i < HIST_BUCKETS; i++) hist[i]! += bucket.hist[i]!;
    }
    return { calls, errors, p50: percentile(hist, runs, 0.5), p95: percentile(hist, runs, 0.95) };
  }
}

export type CallSummary = { calls: number; errors: number; p50: number | null; p95: number | null };
export type CallPoint = { at: number; ok: number; err: number; p95: number | null };
export type FunctionMetrics = CallSummary & {
  name: string;
  type: CallRecord["type"];
  cached: number;
  maxMs: number;
  lastAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
};
export type CallMetrics = {
  seconds: CallPoint[];
  minutes: CallPoint[];
  ranges: { "1m": CallSummary; "15m": CallSummary; "1h": CallSummary };
  functions: FunctionMetrics[];
};

type FnSlot = {
  type: CallRecord["type"];
  calls: number;
  errors: number;
  cached: number;
  runs: number;
  maxMs: number;
  lastAt: number;
  lastError: string | null;
  lastErrorAt: number | null;
  hist: Uint32Array;
};
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
  private readonly records: CallRecord[];
  private head = 0; // Where the next record goes; once full, also the oldest record.
  private count = 0;
  private nextId = 1;
  private listeners = new Set<(record: CallRecord) => void>();
  private seconds = new TimeRing(60, 1000);
  private minutes = new TimeRing(60, 60_000);
  private fnSlots: { at: number; fns: Map<string, FnSlot> }[] = [];
  readonly totals = { calls: 0, errors: 0 };

  constructor(private readonly max = 1000) {
    this.records = new Array(max);
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
    this.add({ id: this.nextId++, at: Date.now(), name, type, source, ms: 0, ok: true, lines: [] }, true);
  }

  private add(record: CallRecord, cached = false) {
    this.totals.calls++;
    if (!record.ok) this.totals.errors++;
    this.measure(record, cached);
    if (this.max > 0) {
      this.records[this.head] = record;
      this.head = (this.head + 1) % this.max;
      if (this.count < this.max) this.count++;
    }
    for (const listener of this.listeners) listener(record);
  }

  /** Counts a finished call. Cached answers count as calls, but say nothing about how long functions take. */
  private measure(record: CallRecord, cached: boolean) {
    const now = record.at + record.ms;
    const ms = cached ? null : record.ms;
    this.seconds.add(now, record.ok, ms);
    this.minutes.add(now, record.ok, ms);

    const at = Math.floor(now / FN_SLOT_MS);
    let current = this.fnSlots.at(-1);
    if (!current || current.at < at) {
      current = { at, fns: new Map() };
      this.fnSlots.push(current);
      if (this.fnSlots.length > FN_SLOTS) this.fnSlots.shift();
    }
    const name = current.fns.has(record.name) || current.fns.size < MAX_FN_NAMES ? record.name : OTHER;
    let stat = current.fns.get(name);
    if (!stat) {
      stat = { type: record.type, calls: 0, errors: 0, cached: 0, runs: 0, maxMs: 0, lastAt: 0, lastError: null, lastErrorAt: null, hist: new Uint32Array(HIST_BUCKETS) };
      current.fns.set(name, stat);
    }
    stat.calls++;
    stat.lastAt = now;
    if (cached) stat.cached++;
    else {
      stat.runs++;
      stat.hist[bucketOf(record.ms)]!++;
      if (record.ms > stat.maxMs) stat.maxMs = record.ms;
    }
    if (!record.ok) {
      stat.errors++;
      stat.lastError = (record.error ?? "").slice(0, MAX_ERROR_CHARS);
      stat.lastErrorAt = now;
    }
  }

  /** Traffic and latency over the last hour, from fixed-size counters (not the ring of recent records). */
  metrics(now = Date.now()): CallMetrics {
    const points = (ring: TimeRing): CallPoint[] =>
      ring.series(now).map(({ at, bucket }) => ({
        at,
        ok: bucket?.ok ?? 0,
        err: bucket?.err ?? 0,
        p95: bucket ? percentile(bucket.hist, bucket.runs, 0.95) : null,
      }));
    return {
      seconds: points(this.seconds),
      minutes: points(this.minutes),
      ranges: { "1m": this.seconds.summary(now), "15m": this.minutes.summary(now, 15), "1h": this.minutes.summary(now) },
      functions: this.functionMetrics(now),
    };
  }

  private functionMetrics(now: number): FunctionMetrics[] {
    const oldest = Math.floor(now / FN_SLOT_MS) - FN_SLOTS + 1;
    const merged = new Map<string, FnSlot>();
    for (const slot of this.fnSlots) {
      if (slot.at < oldest) continue;
      for (const [name, s] of slot.fns) {
        const m = merged.get(name);
        if (!m) {
          merged.set(name, { ...s, hist: s.hist.slice() });
          continue;
        }
        m.calls += s.calls;
        m.errors += s.errors;
        m.cached += s.cached;
        m.runs += s.runs;
        m.maxMs = Math.max(m.maxMs, s.maxMs);
        m.lastAt = Math.max(m.lastAt, s.lastAt);
        if (s.lastErrorAt !== null && s.lastErrorAt >= (m.lastErrorAt ?? 0)) {
          m.lastError = s.lastError;
          m.lastErrorAt = s.lastErrorAt;
        }
        for (let i = 0; i < HIST_BUCKETS; i++) m.hist[i]! += s.hist[i]!;
      }
    }
    // A percentile is its bucket's top edge, which can be above anything actually seen.
    const capped = (value: number | null, max: number) => (value === null ? null : Math.min(value, max));
    return [...merged].map(([name, m]) => ({
      name,
      type: m.type,
      calls: m.calls,
      errors: m.errors,
      cached: m.cached,
      p50: capped(percentile(m.hist, m.runs, 0.5), m.maxMs),
      p95: capped(percentile(m.hist, m.runs, 0.95), m.maxMs),
      maxMs: m.maxMs,
      lastAt: m.lastAt,
      lastError: m.lastError,
      lastErrorAt: m.lastErrorAt,
    }));
  }

  recent(limit = this.max): CallRecord[] {
    const n = limit > 0 ? Math.min(Math.trunc(limit), this.count) : 0;
    const start = this.head - n;
    if (start >= 0) return this.records.slice(start, this.head);
    return [...this.records.slice(start), ...this.records.slice(0, this.head)];
  }

  listen(listener: (record: CallRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
