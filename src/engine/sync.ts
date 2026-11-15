import type { FunctionLike } from "../api";
import type { UserIdentity } from "../server";
import type { CallSource } from "./calllog";
import { getPath, writeAffects, type ReadSet } from "./database";
import { envNumber } from "./driver";
import type { CommitEvent, Runtime } from "./runtime";

export type QueryUpdate = { ok: true; value: unknown } | { ok: false; error: string; data?: unknown };
/** `json` is a successful update's value as JSON, already made, so each connection needn't make it again. */
type Listener = (update: QueryUpdate, json?: string) => void;
/** One subscription: who asked, on whose behalf (a connection, say), and the entry serving it now. */
type Sub = { identity: UserIdentity | null; owner: object | undefined; entry: Entry };

/**
 * Live queries re-run in the background this many at a time (or, with query workers, as many as
 * they take), giving way to other work every few milliseconds.
 */
const BACKGROUND_BATCH = 8;
const BACKGROUND_SLICE_MS = 8;

const QUERY_CACHE_MB = 64;
/** Rough memory for a cached entry's bookkeeping (measured as process RSS), and each read it files, on top of its key and result. */
const ENTRY_OVERHEAD_BYTES = 4096;
const READ_OVERHEAD_BYTES = 128;

/** One execution of a query, with its value as JSON, and the code generation it ran (see Runtime.codeGeneration). */
type Run = { update: QueryUpdate; readSet: ReadSet; json: string; generation: number };

/** A successful update from a query worker: its value is parsed from the JSON only if something asks for it. */
function workerUpdate(json: string): QueryUpdate {
  let parsed = false;
  let value: unknown;
  return {
    ok: true,
    get value() {
      if (!parsed) {
        value = JSON.parse(json);
        parsed = true;
      }
      return value;
    },
  };
}

/** A value as it goes to a client. Queries return null for undefined; anything else JSON leaves out is sent the same way. */
const valueJson = (value: unknown) => JSON.stringify(value) ?? "null";

type Entry = {
  key: string;
  name: string;
  args: unknown;
  /** The identity it runs as. A shared entry serves every identity, and runs as whoever asked first. */
  identity: UserIdentity | null;
  /** Keyed without the identity: the function hasn't been seen reading it, so everyone gets the same result. */
  shared: boolean;
  source: CallSource;
  listeners: Map<Listener, Sub>;
  /** How many listeners each owner has here, to find the entries a mutation's caller is waiting on. */
  owners: Map<object, number>;
  /** A commit affected it and it hasn't re-run yet: its result must not answer anyone new. */
  stale: boolean;
  readSet: ReadSet | null;
  /** The latest result. A cached entry keeps only `lastJson`, which is smaller and can't be mutated. */
  last: QueryUpdate | null;
  /** The latest value as JSON, or the error as JSON when the latest run failed. */
  lastJson: string | null;
  /** Whether the latest run succeeded. */
  ok: boolean;
  running: Promise<void> | null;
  dirty: boolean;
  /** Someone waits for the run in progress (or the next): it runs on the main thread, not behind a query worker's queue. */
  urgent: boolean;
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
 * A function that never looks at who is asking is shared between users too.
 *
 * A commit waits only for the queries its own caller is subscribed to (so that client gets its
 * result and its updates together). Everyone else's re-run in the background.
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
  /** Queries whose runs so far never read the caller's identity, and ones seen reading it. Reset by a deploy. */
  private anonymous = new Set<string>();
  private personal = new Set<string>();
  private subscribed = 0;
  /** Entries waiting for a background re-run. */
  private backlog = new Set<Entry>();
  private pumping = false;
  /** Counters for /api/metrics. */
  readonly counts = { runs: 0, background: 0, shared: 0, split: 0 };

  constructor(
    private readonly runtime: Runtime,
    opts: { cacheBytes?: number } = {},
  ) {
    // Another instance's commits arrive late, so a cached read could miss a write that was already
    // acknowledged. A single SQLite server sees every commit before the writer gets its answer.
    this.cacheBytes = runtime.driver.shared ? 0 : (opts.cacheBytes ?? (envNumber("ONEBASE_QUERY_CACHE_MB") ?? QUERY_CACHE_MB) * 2 ** 20);
    runtime.onCommit((event) => this.invalidate(event));
    runtime.stats.subscriptions = () => this.size;
    runtime.stats.sync = () => ({ ...this.counts, waiting: this.backlog.size });
  }

  get size() {
    return this.subscribed;
  }

  get cached() {
    return { entries: this.cache.size, bytes: this.cacheUsed };
  }

  /**
   * A function that hasn't been seen reading the identity gets one entry for everyone. Otherwise the
   * key holds the whole identity: a function can read any of its claims, not just who the user is.
   */
  private key(name: string, args: unknown, identity: UserIdentity | null) {
    return `${name}|${stableStringify(args ?? {})}|${this.anonymous.has(name) ? "*" : stableStringify(identity)}`;
  }

  private create(key: string, name: string, args: unknown, identity: UserIdentity | null, source: CallSource) {
    const entry: Entry = {
      key, name, args, identity, shared: this.anonymous.has(name), source, listeners: new Map(), owners: new Map(), stale: false,
      readSet: null, last: null, lastJson: null, ok: false, running: null, dirty: false, urgent: false, execution: null, pending: [], keys: [], bytes: 0,
    };
    this.entries.set(key, entry);
    this.index.add(entry);
    void this.refresh(entry);
    return entry;
  }

  /** `owner` groups a caller's subscriptions (a connection, say), so its mutations can wait for just those. */
  subscribe(name: string, args: unknown, identity: UserIdentity | null, listener: Listener, owner?: object): () => void {
    const sub: Sub = { identity, owner, entry: undefined as unknown as Entry };
    this.join(name, args, listener, sub);
    return () => {
      const e = sub.entry;
      if (!this.detach(listener, sub) || e.listeners.size > 0) return;
      // Still executing: the run decides what happens to the entry when it finishes.
      if (this.entries.get(e.key) === e && !e.running) this.park(e);
    };
  }

  /** Puts a subscription on the entry for its query, creating it if needed, and sends what is known so far. */
  private join(name: string, args: unknown, listener: Listener, sub: Sub): Entry {
    const key = this.key(name, args, sub.identity);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = this.create(key, name, args, sub.identity, "subscription");
    } else {
      this.uncache(entry);
      entry.source = "subscription";
      if (!entry.last && entry.ok) entry.last = { ok: true, value: JSON.parse(entry.lastJson!) };
      if (entry.last) listener(entry.last, entry.last.ok ? (entry.lastJson ?? undefined) : undefined);
    }
    if (entry.listeners.size === 0) this.subscribed++;
    entry.listeners.set(listener, sub);
    if (sub.owner) entry.owners.set(sub.owner, (entry.owners.get(sub.owner) ?? 0) + 1);
    sub.entry = entry;
    return entry;
  }

  private detach(listener: Listener, sub: Sub): boolean {
    const e = sub.entry;
    if (!e.listeners.delete(listener)) return false;
    if (sub.owner) {
      const n = (e.owners.get(sub.owner) ?? 1) - 1;
      if (n <= 0) e.owners.delete(sub.owner);
      else e.owners.set(sub.owner, n);
    }
    if (e.listeners.size === 0) this.subscribed--;
    return true;
  }

  /** Takes every subscription off an entry and drops it; each one joins the entry its key now names. */
  private rehome(entry: Entry): Entry | null {
    const subs = [...entry.listeners];
    for (const [listener, sub] of subs) this.detach(listener, sub);
    this.discard(entry);
    let last: Entry | null = null;
    for (const [listener, sub] of subs) last = this.join(entry.name, entry.args, listener, sub);
    return last;
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
    if (!entry) {
      const first = await this.create(key, name, args, identity, source).execution!;
      // The code was replaced while it ran.
      return first.generation === this.runtime.codeGeneration ? first.json : run();
    }
    if (entry.execution) {
      // Its snapshot may predate a commit this caller already knows about.
      if (entry.pending.length) return run();
      const shared = await entry.execution;
      if (shared.generation !== this.runtime.codeGeneration) return run();
      // A run that read the identity answers only the one it ran as.
      if (shared.readSet.impure || (entry.shared && shared.readSet.identity)) return run();
      this.runtime.calls.record(name, "query", source);
      return shared.json;
    }
    if (!entry.ok || entry.stale) return run();
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
    if (!entry.ok || entry.dirty || entry.stale || this.impure.has(entry.name) || bytes > this.cacheBytes / 4) return this.discard(entry);
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

  /** `background`: nobody waits for this run, so it may go to a query worker. */
  private refresh(entry: Entry, background = false): Promise<void> {
    if (!background) entry.urgent = true;
    if (entry.running) {
      entry.dirty = true;
      return entry.running;
    }
    entry.running = (async () => {
      do {
        entry.dirty = false;
        await this.execute(entry, !entry.urgent);
      } while (entry.dirty && entry.listeners.size > 0);
    })().finally(() => {
      entry.running = null;
      entry.urgent = false;
      if (entry.listeners.size === 0 && this.entries.get(entry.key) === entry) this.park(entry);
    });
    return entry.running;
  }

  /**
   * `reads` is filled in as the query runs, so what it read is known even when it throws. A
   * background run goes to a query worker when there is one.
   */
  private async run(entry: Entry, reads: ReadSet, background: boolean): Promise<Run> {
    const generation = this.runtime.codeGeneration;
    const opts = { identity: entry.identity, source: entry.source, readSet: reads };
    const onWorker = background ? this.runtime.runQueryOnWorker(entry.name, entry.args, opts) : null;
    if (onWorker) {
      const { json, readSet } = await onWorker;
      return { update: workerUpdate(json), readSet, json, generation };
    }
    const { value, readSet } = await this.runtime.runQuery(entry.name, entry.args, opts);
    return { update: { ok: true, value }, readSet, json: valueJson(value), generation };
  }

  private async execute(entry: Entry, background = false) {
    entry.pending = [];
    entry.stale = false;
    this.executing.add(entry);
    this.counts.runs++;
    const reads: ReadSet = { ids: new Set(), ranges: [] };
    const generation = this.runtime.codeGeneration;
    const execution = (entry.execution = this.run(entry, reads, background));
    let update: QueryUpdate;
    let json: string;
    try {
      await execution;
    } catch {}
    if (this.runtime.codeGeneration !== generation) {
      // The code was replaced while it ran, so its result (or error) is the old code's. Nobody gets
      // it: the entry runs again, on the new code.
      this.executing.delete(entry);
      entry.execution = null;
      entry.pending = [];
      entry.dirty = true;
      return;
    }
    if (reads.identity) {
      this.personal.add(entry.name);
      this.anonymous.delete(entry.name);
      if (entry.shared) {
        // It looked at who was asking after all, so this result (or error) belongs to one identity
        // only. Nobody gets it: every subscriber moves to an entry of their own.
        this.executing.delete(entry);
        entry.execution = null;
        this.counts.split++;
        this.rehome(entry);
        return;
      }
    } else if (!this.personal.has(entry.name)) {
      this.anonymous.add(entry.name);
      // This entry becomes the one for everyone, unless there is one already (then its
      // subscribers move over the next time a commit affects it).
      const shared = this.key(entry.name, entry.args, entry.identity);
      if (!entry.shared && this.entries.get(entry.key) === entry && !this.entries.has(shared)) {
        this.entries.delete(entry.key);
        entry.key = shared;
        entry.shared = true;
        this.entries.set(shared, entry);
      }
    }
    try {
      const run = await execution;
      entry.readSet = run.readSet;
      if (run.readSet.impure) this.impure.add(entry.name);
      update = run.update;
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
    for (const listener of entry.listeners.keys()) listener(update, update.ok ? json : undefined);
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
    this.anonymous.clear();
    this.personal.clear();
    const all = [...this.entries.values()];
    for (const e of all) if (e.listeners.size === 0) this.discard(e);
    await Promise.all(all.filter((e) => e.listeners.size > 0).map((e) => this.refresh(e)));
  }

  /**
   * Re-runs affected queries. Resolves once the ones `event.settle` asks for have delivered their
   * new results: a caller's own, all of them, or (by default) none. The rest re-run in the background.
   */
  async invalidate(event: CommitEvent): Promise<void> {
    for (const e of this.executing) e.pending.push(event);
    // Large commits from another instance only name tables: check everything, as before.
    const pool = event.tables ? [...this.entries.values()] : this.index.candidates(event.writes);
    const settle = event.settle;
    const waiting: Promise<void>[] = [];
    for (const e of pool) {
      if (e.listeners.size === 0) {
        // Dropped without the exact check, so a commit costs no more than the entries it removes.
        if (!e.running) this.discard(e);
        continue;
      }
      if (this.entries.get(e.key) !== e || !this.affected(e, event)) continue;
      let target = e;
      let started: Promise<void> | null = null;
      if (!e.shared && this.anonymous.has(e.name)) {
        // Learned since it was created: this query is the same for everyone. Its subscribers move to
        // the shared entry, which a run started now (or one that saw this commit) brings up to date.
        target = this.rehome(e)!;
        this.counts.shared++;
        started = target.running;
      }
      if (settle === "all" || (settle && target.owners.has(settle))) waiting.push(started ?? this.refresh(target));
      else if (!started) this.later(target);
    }
    await Promise.all(waiting);
  }

  /** Marks an entry out of date and queues its re-run. */
  private later(entry: Entry) {
    if (entry.running) return void this.refresh(entry, true); // re-runs as soon as the run in progress ends
    entry.stale = true;
    this.backlog.add(entry);
    if (!this.pumping) void this.pump();
  }

  /**
   * Works through the backlog a few entries at a time (as many as the query workers take, when
   * there are some), letting requests and timers run in between.
   */
  private async pump() {
    this.pumping = true;
    try {
      let since = performance.now();
      const inFlight = new Set<Promise<void>>();
      while (this.backlog.size || inFlight.size) {
        const limit = this.runtime.queryWorkerSlots || BACKGROUND_BATCH;
        for (const e of this.backlog) {
          if (inFlight.size >= limit) break;
          this.backlog.delete(e);
          // Unsubscribed or replaced meanwhile: there is nobody to tell.
          if (e.listeners.size === 0 || this.entries.get(e.key) !== e) continue;
          this.counts.background++;
          const run: Promise<void> = this.refresh(e, true).finally(() => inFlight.delete(run));
          inFlight.add(run);
        }
        if (inFlight.size) await Promise.race(inFlight);
        if (performance.now() - since >= BACKGROUND_SLICE_MS) {
          await new Promise((resolve) => setImmediate(resolve));
          since = performance.now();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Subscriptions waiting for a background re-run. */
  get waiting() {
    return this.backlog.size;
  }
}
