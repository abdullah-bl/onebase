import type { FunctionLike } from "../api";
import type { UserIdentity } from "../server";
import type { CallSource } from "./calllog";
import { getPath, writeAffects, type ReadSet } from "./database";
import { envNumber } from "./driver";
import type { CommitEvent, Runtime } from "./runtime";

export type QueryUpdate = { ok: true; value: unknown } | { ok: false; error: string; data?: unknown };
type Listener = (update: QueryUpdate) => void;

const QUERY_CACHE_MB = 64;
/** Rough memory for a cached entry's bookkeeping (measured as process RSS), and each read it files, on top of its key and result. */
const ENTRY_OVERHEAD_BYTES = 4096;
const READ_OVERHEAD_BYTES = 128;

/** One execution of a query, with its value as JSON. */
type Run = { value: unknown; readSet: ReadSet; json: string };

/** A value as it goes to a client. Queries return null for undefined; anything else JSON leaves out is sent the same way. */
const valueJson = (value: unknown) => JSON.stringify(value) ?? "null";

type Entry = {
  key: string;
  name: string;
  args: unknown;
  identity: UserIdentity | null;
  source: CallSource;
  listeners: Set<Listener>;
  readSet: ReadSet | null;
  /** The latest result. A cached entry keeps only `lastJson`, which is smaller and can't be mutated. */
  last: QueryUpdate | null;
  /** The latest value as JSON, or the error as JSON when the latest run failed. */
  lastJson: string | null;
  /** Whether the latest run succeeded. */
  ok: boolean;
  running: Promise<void> | null;
  dirty: boolean;
  /** The execution in progress, and the commits made since it started. */
  execution: Promise<Run> | null;
  pending: CommitEvent[];
  /** Index keys this entry is filed under (see SubscriptionIndex). */
  keys: string[];
  /** What this entry counts for in the cache. */
  bytes: number;
};

/** Hash key for an equality value, matching database.ts sameValue(): null and undefined are equal, objects compare as JSON. */
function valueKey(v: unknown): string {
  if (v === null || v === undefined) return "null";
  return typeof v === "object" ? `o:${JSON.stringify(v)}` : `${typeof v}:${String(v)}`;
}

/**
 * Finds the subscriptions a commit could affect without scanning all of them. Each entry is filed
 * under the ids it read and, per range, under its first equality condition (or the whole table when
 * a range has none). A commit looks up only those keys; affected() still makes the exact decision.
 */
class SubscriptionIndex {
  private byKey = new Map<string, Set<Entry>>();
  /** Equality paths in use per table, with reference counts. */
  private paths = new Map<string, Map<string, number>>();
  /** Entries that must be checked on every commit (no read set yet, or one that reads nothing). */
  readonly always = new Set<Entry>();

  add(entry: Entry) {
    this.remove(entry);
    const rs = entry.readSet;
    if (!rs || (rs.ranges.length === 0 && rs.ids.size === 0)) {
      this.always.add(entry);
      return;
    }
    const keys = new Set<string>();
    for (const id of rs.ids) keys.add(`id|${id}`);
    for (const r of rs.ranges) {
      const first = r.eq[0];
      if (!first) {
        keys.add(`tbl|${r.table}`);
        continue;
      }
      const key = `eq|${r.table}|${first[0]}|${valueKey(first[1])}`;
      // Count each key once, as remove() does: a query can read the same range twice.
      if (keys.has(key)) continue;
      keys.add(key);
      const paths = this.paths.get(r.table) ?? this.paths.set(r.table, new Map()).get(r.table)!;
      paths.set(first[0], (paths.get(first[0]) ?? 0) + 1);
    }
    entry.keys = [...keys];
    for (const k of entry.keys) (this.byKey.get(k) ?? this.byKey.set(k, new Set()).get(k)!).add(entry);
  }

  remove(entry: Entry) {
    this.always.delete(entry);
    for (const k of entry.keys) {
      const set = this.byKey.get(k);
      set?.delete(entry);
      if (set?.size === 0) this.byKey.delete(k);
      if (k.startsWith("eq|")) {
        const [, table, path] = k.split("|");
        const paths = this.paths.get(table!);
        const n = (paths?.get(path!) ?? 1) - 1;
        if (n <= 0) paths?.delete(path!);
        else paths!.set(path!, n);
      }
    }
    entry.keys = [];
  }

  candidates(writes: { table: string; id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[]) {
    const out = new Set<Entry>(this.always);
    const take = (k: string) => this.byKey.get(k)?.forEach((e) => out.add(e));
    for (const w of writes) {
      take(`id|${w.id}`);
      take(`tbl|${w.table}`);
      for (const path of this.paths.get(w.table)?.keys() ?? []) {
        for (const doc of [w.before, w.after]) if (doc) take(`eq|${w.table}|${path}|${valueKey(getPath(doc, path))}`);
      }
    }
    return out;
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Shared, reactive query results. Identical subscriptions (same function, args and user)
 * share one execution; after each commit only queries whose reads overlap the writes re-run.
 *
 * One-off reads share these results too. An entry nobody subscribes to stays as a cache entry until
 * a commit could affect it or room runs out; it's dropped rather than re-run, so nothing is
 * executed for a result nobody may ask for again.
 */
export class SubscriptionManager {
  private entries = new Map<string, Entry>();
  private index = new SubscriptionIndex();
  /** Cached entries, least recently used first. */
  private cache = new Map<string, Entry>();
  private cacheUsed = 0;
  private readonly cacheBytes: number;
  /** Entries executing right now, which see every commit whatever their index keys say. */
  private executing = new Set<Entry>();
  /** Queries seen reading the clock or a random source: every read of them runs. */
  private impure = new Set<string>();
  private subscribed = 0;

  constructor(
    private readonly runtime: Runtime,
    opts: { cacheBytes?: number } = {},
  ) {
    // Another instance's commits arrive late, so a cached read could miss a write that was already
    // acknowledged. A single SQLite server sees every commit before the writer gets its answer.
    this.cacheBytes = runtime.driver.shared ? 0 : (opts.cacheBytes ?? (envNumber("ONEBASE_QUERY_CACHE_MB") ?? QUERY_CACHE_MB) * 2 ** 20);
    runtime.onCommit((event) => this.invalidate(event));
    runtime.stats.subscriptions = () => this.size;
  }

  get size() {
    return this.subscribed;
  }

  get cached() {
    return { entries: this.cache.size, bytes: this.cacheUsed };
  }

  private key(name: string, args: unknown, identity: UserIdentity | null) {
    // The whole identity: a function can read any of its claims, not just who the user is.
    return `${name}|${stableStringify(args ?? {})}|${stableStringify(identity)}`;
  }

  private create(key: string, name: string, args: unknown, identity: UserIdentity | null, source: CallSource) {
    const entry: Entry = {
      key, name, args, identity, source, listeners: new Set(), readSet: null, last: null, lastJson: null, ok: false,
      running: null, dirty: false, execution: null, pending: [], keys: [], bytes: 0,
    };
    this.entries.set(key, entry);
    this.index.add(entry);
    void this.refresh(entry);
    return entry;
  }

  subscribe(name: string, args: unknown, identity: UserIdentity | null, listener: Listener): () => void {
    const key = this.key(name, args, identity);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.create(key, name, args, identity, "subscription");
    } else {
      this.uncache(entry);
      entry.source = "subscription";
      if (!entry.last && entry.ok) entry.last = { ok: true, value: JSON.parse(entry.lastJson!) };
      if (entry.last) listener(entry.last);
    }
    if (entry.listeners.size === 0) this.subscribed++;
    entry.listeners.add(listener);
    const e = entry;
    return () => {
      if (!e.listeners.delete(listener) || e.listeners.size > 0) return;
      this.subscribed--;
      // Still executing: the run decides what happens to the entry when it finishes.
      if (this.entries.get(e.key) === e && !e.running) this.park(e);
    };
  }

  /**
   * Answers a one-off read with its value as JSON: from a current result when there is one,
   * otherwise by running the query. Errors are thrown as runQuery() throws them.
   */
  async query(ref: FunctionLike, args: unknown, identity: UserIdentity | null, source: CallSource): Promise<string> {
    const { name } = this.runtime.resolve(ref, "query", false);
    const run = async () => valueJson((await this.runtime.runQuery(name, args, { identity, source })).value);
    if (!this.cacheBytes || this.impure.has(name)) return run();
    const key = this.key(name, args, identity);
    const entry = this.entries.get(key);
    if (!entry) return (await this.create(key, name, args, identity, source).execution!).json;
    if (entry.execution) {
      // Its snapshot may predate a commit this caller already knows about.
      if (entry.pending.length) return run();
      const shared = await entry.execution;
      if (shared.readSet.impure) return run();
      this.runtime.calls.record(name, "query", source);
      return shared.json;
    }
    if (!entry.ok) return run();
    if (this.cache.delete(key)) this.cache.set(key, entry);
    this.runtime.calls.record(name, "query", source);
    return entry.lastJson!;
  }

  /** An entry nobody subscribes to any more: keeps its result if it can be reused, otherwise drops it. */
  private park(entry: Entry) {
    const rs = entry.readSet;
    const reads = (rs?.ids.size ?? 0) + (rs?.ranges.length ?? 0);
    // Strings take up to 2 bytes per character (only Latin-1 text fits in 1), so this is a real upper bound.
    const bytes = ENTRY_OVERHEAD_BYTES + reads * READ_OVERHEAD_BYTES + 2 * (entry.key.length + (entry.lastJson?.length ?? 0));
    // Too big means pushing out most of the cache for one result.
    if (!entry.ok || entry.dirty || this.impure.has(entry.name) || bytes > this.cacheBytes / 4) return this.discard(entry);
    entry.last = null;
    entry.bytes = bytes;
    this.cache.set(entry.key, entry);
    this.cacheUsed += bytes;
    for (const oldest of this.cache.values()) {
      if (this.cacheUsed <= this.cacheBytes) break;
      this.discard(oldest);
    }
  }

  private uncache(entry: Entry) {
    if (this.cache.delete(entry.key)) this.cacheUsed -= entry.bytes;
  }

  private discard(entry: Entry) {
    this.uncache(entry);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.index.remove(entry);
  }

  private refresh(entry: Entry): Promise<void> {
    if (entry.running) {
      entry.dirty = true;
      return entry.running;
    }
    entry.running = (async () => {
      do {
        entry.dirty = false;
        await this.execute(entry);
      } while (entry.dirty && entry.listeners.size > 0);
    })().finally(() => {
      entry.running = null;
      if (entry.listeners.size === 0 && this.entries.get(entry.key) === entry) this.park(entry);
    });
    return entry.running;
  }

  private async run(entry: Entry): Promise<Run> {
    const { value, readSet } = await this.runtime.runQuery(entry.name, entry.args, { identity: entry.identity, source: entry.source });
    return { value, readSet, json: valueJson(value) };
  }

  private async execute(entry: Entry) {
    entry.pending = [];
    this.executing.add(entry);
    const execution = (entry.execution = this.run(entry));
    let update: QueryUpdate;
    let json: string;
    try {
      const run = await execution;
      entry.readSet = run.readSet;
      if (run.readSet.impure) this.impure.add(entry.name);
      update = { ok: true, value: run.value };
      json = run.json;
    } catch (err) {
      const e = this.runtime.toClientError(err, entry.name);
      // A one-off read's caller gets the error and logs it.
      if (entry.listeners.size) this.runtime.log.error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      update = { ok: false, error: e.message, data: e.data };
      json = JSON.stringify(update);
      // Keep watching everything the query might depend on so it recovers once data is fixed.
      entry.readSet ??= { ids: new Set(), ranges: [] };
    }
    this.executing.delete(entry);
    entry.execution = null;
    // A commit during the run may have missed the index, which still held the previous run's reads.
    if (entry.pending.some((event) => this.affected(entry, event))) entry.dirty = true;
    entry.pending = [];
    entry.ok = update.ok;
    if (this.entries.get(entry.key) === entry) this.index.add(entry);
    if (json === entry.lastJson && update.ok === entry.last?.ok) return;
    entry.last = update;
    entry.lastJson = json;
    for (const listener of entry.listeners) listener(update);
  }

  private affected(entry: Entry, event: CommitEvent): boolean {
    const rs = entry.readSet;
    if (!rs) return true;
    if (rs.ranges.length === 0 && rs.ids.size === 0) return true;
    // Only table names are known (a large commit from another instance): re-run anything that read them.
    if (event.tables) return rs.ids.size > 0 || rs.ranges.some((r) => event.tables.includes(r.table));
    const dialect = this.runtime.driver.dialect;
    return event.writes.some((w) => rs.ids.has(w.id) || rs.ranges.some((r) => writeAffects(r, w, dialect)));
  }

  /** Re-runs every query (after a deploy replaced the code); resolves once results are delivered. */
  async rerunAll(): Promise<void> {
    this.impure.clear();
    const all = [...this.entries.values()];
    for (const e of all) if (e.listeners.size === 0) this.discard(e);
    await Promise.all(all.filter((e) => e.listeners.size > 0).map((e) => this.refresh(e)));
  }

  /** Re-runs affected queries; resolves once their new results have been delivered. */
  async invalidate(event: CommitEvent): Promise<void> {
    for (const e of this.executing) e.pending.push(event);
    // Large commits from another instance only name tables: check everything, as before.
    const pool = event.tables ? this.entries.values() : this.index.candidates(event.writes);
    const refreshes: Promise<void>[] = [];
    for (const e of pool) {
      if (e.listeners.size > 0) {
        if (this.affected(e, event)) refreshes.push(this.refresh(e));
      } else if (!e.running) {
        // Dropped without the exact check, so a commit costs no more than the entries it removes.
        this.discard(e);
      }
    }
    await Promise.all(refreshes);
  }
}
