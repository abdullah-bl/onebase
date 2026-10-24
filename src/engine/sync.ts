import type { UserIdentity } from "../server";
import { getPath, writeAffects, type ReadSet } from "./database";
import type { CommitEvent, Runtime } from "./runtime";

export type QueryUpdate = { ok: true; value: unknown } | { ok: false; error: string; data?: unknown };
type Listener = (update: QueryUpdate) => void;

type Entry = {
  key: string;
  name: string;
  args: unknown;
  identity: UserIdentity | null;
  listeners: Set<Listener>;
  readSet: ReadSet | null;
  last: QueryUpdate | null;
  lastJson: string | null;
  running: Promise<void> | null;
  dirty: boolean;
  /** Index keys this entry is filed under (see SubscriptionIndex). */
  keys: string[];
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
 */
export class SubscriptionManager {
  private entries = new Map<string, Entry>();
  private index = new SubscriptionIndex();

  constructor(private readonly runtime: Runtime) {
    runtime.onCommit((event) => this.invalidate(event));
    runtime.stats.subscriptions = () => this.size;
  }

  get size() {
    return this.entries.size;
  }

  subscribe(name: string, args: unknown, identity: UserIdentity | null, listener: Listener): () => void {
    const key = `${name}|${stableStringify(args ?? {})}|${identity?.tokenIdentifier ?? ""}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, name, args, identity, listeners: new Set(), readSet: null, last: null, lastJson: null, running: null, dirty: false, keys: [] };
      this.entries.set(key, entry);
      this.index.add(entry);
      void this.refresh(entry);
    } else if (entry.last) {
      listener(entry.last);
    }
    entry.listeners.add(listener);
    const e = entry;
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0 && this.entries.get(e.key) === e) {
        this.entries.delete(e.key);
        this.index.remove(e);
      }
    };
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
      } while (entry.dirty);
    })().finally(() => {
      entry.running = null;
    });
    return entry.running;
  }

  private async execute(entry: Entry) {
    let update: QueryUpdate;
    try {
      const { value, readSet } = await this.runtime.runQuery(entry.name, entry.args, { identity: entry.identity, source: "subscription" });
      entry.readSet = readSet;
      update = { ok: true, value };
    } catch (err) {
      const e = this.runtime.toClientError(err, entry.name);
      this.runtime.log.error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      update = { ok: false, error: e.message, data: e.data };
      // Keep watching everything the query might depend on so it recovers once data is fixed.
      entry.readSet ??= { ids: new Set(), ranges: [] };
    }
    if (this.entries.get(entry.key) === entry) this.index.add(entry);
    const json = JSON.stringify(update);
    if (json === entry.lastJson) return;
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

  /** Re-runs affected queries; resolves once their new results have been delivered. */
  async invalidate(event: CommitEvent): Promise<void> {
    // Large commits from another instance only name tables: check everything, as before.
    const pool = event.tables ? this.entries.values() : this.index.candidates(event.writes);
    const affected = [...pool].filter((e) => this.affected(e, event));
    await Promise.all(affected.map((e) => this.refresh(e)));
  }
}
