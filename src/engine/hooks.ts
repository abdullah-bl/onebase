// Table hooks: components that follow an app table get its changes in the writing transaction.
// The runtime decides when to deliver them; this file holds what doesn't need the runtime.

import type { RegisteredFunction } from "../server";
import type { Doc, Write } from "./database";
import type { Exec } from "./driver";

export type ResolvedHook = {
  mount: string;
  /** The app table followed. */
  table: string;
  /** _meta key holding the backfill progress. */
  key: string;
  onChange: { name: string; fn: RegisteredFunction };
  reset: { name: string; fn: RegisteredFunction } | null;
  fingerprint: string;
};

export type HookChange = { op: "insert" | "update" | "delete"; id: string; before: Doc | null; after: Doc | null };

/** Where a hook's backfill stands: documents up to `cursor` (creation time, id) have been fed to it. */
export type HookProgress = { fingerprint: string; state: "resetting" | "backfilling" | "ready"; cursor: [number, string] | null };

/** Rows per backfill transaction. */
export const BACKFILL_BATCH = 200;

/**
 * One change per document, in the order documents were first written: the state before the
 * first write and after the last. A document inserted and deleted in the same transaction is left out.
 */
export function coalesce(writes: Write[]): HookChange[] {
  const byId = new Map<string, { before: Doc | null; after: Doc | null }>();
  for (const w of writes) {
    const seen = byId.get(w.id);
    if (seen) seen.after = w.after;
    else byId.set(w.id, { before: w.before, after: w.after });
  }
  const changes: HookChange[] = [];
  for (const [id, { before, after }] of byId) {
    if (!before && !after) continue;
    changes.push({ op: !before ? "insert" : !after ? "delete" : "update", id, before, after });
  }
  return changes;
}

/** Has the backfill already fed this document to the hook (so live changes to it must be delivered)? */
export function backfilled(progress: HookProgress | null, fingerprint: string, change: HookChange): boolean {
  if (!progress || progress.fingerprint !== fingerprint) return false;
  if (progress.state === "ready") return true;
  if (progress.state === "resetting" || !progress.cursor) return false;
  const doc = (change.before ?? change.after)!;
  const [ct, id] = progress.cursor;
  return doc._creationTime < ct || (doc._creationTime === ct && doc._id <= id);
}

export async function readProgress(tx: Exec, key: string): Promise<HookProgress | null> {
  const row = await tx.get(`SELECT value FROM _meta WHERE "key" = ?`, [key]);
  return row ? (JSON.parse(row.value as string) as HookProgress) : null;
}

export async function writeProgress(tx: Exec, key: string, progress: HookProgress) {
  await tx.run(`INSERT INTO _meta ("key", value) VALUES (?, ?) ON CONFLICT("key") DO UPDATE SET value = excluded.value`, [key, JSON.stringify(progress)]);
}

/** The state a component sees through ctx.hooks.status(). */
export function hookState(progress: HookProgress | null, fingerprint: string): HookProgress["state"] {
  if (!progress || progress.fingerprint !== fingerprint) return "backfilling";
  return progress.state;
}
