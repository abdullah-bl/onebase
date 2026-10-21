import type { UserIdentity } from "../server";
import { writeAffects, type ReadSet } from "./database";
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
};

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

  constructor(private readonly runtime: Runtime) {
    runtime.onCommit((event) => this.invalidate(event));
  }

  get size() {
    return this.entries.size;
  }

  subscribe(name: string, args: unknown, identity: UserIdentity | null, listener: Listener): () => void {
    const key = `${name}|${stableStringify(args ?? {})}|${identity?.tokenIdentifier ?? ""}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, name, args, identity, listeners: new Set(), readSet: null, last: null, lastJson: null, running: null, dirty: false };
      this.entries.set(key, entry);
      void this.refresh(entry);
    } else if (entry.last) {
      listener(entry.last);
    }
    entry.listeners.add(listener);
    const e = entry;
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0) this.entries.delete(e.key);
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
      const { value, readSet } = await this.runtime.runQuery(entry.name, entry.args, { identity: entry.identity });
      entry.readSet = readSet;
      update = { ok: true, value };
    } catch (err) {
      const e = this.runtime.toClientError(err, entry.name);
      this.runtime.log.error(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      update = { ok: false, error: e.message, data: e.data };
      // Keep watching everything the query might depend on so it recovers once data is fixed.
      entry.readSet ??= { ids: new Set(), ranges: [] };
    }
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
    const affected = [...this.entries.values()].filter((e) => this.affected(e, event));
    await Promise.all(affected.map((e) => this.refresh(e)));
  }
}
