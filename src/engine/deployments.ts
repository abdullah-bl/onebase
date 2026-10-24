// Code pushed with `onebase deploy`. It's kept in the database, so a restart keeps running it,
// every instance sharing the database runs the same code, and backups include it.

import { extname } from "node:path";
import type { Exec } from "./driver";

/** Deployments kept for --rollback; older ones are deleted when a new one is pushed. */
export const KEEP_DEPLOYMENTS = 10;

export type StoredDeployment = {
  id: string;
  created: number;
  /** The bundle's source: one ES module (see bundleProject). */
  code: string;
  /** JSON of { "/path": base64 } for the static frontend, or null to serve the server's own --public. */
  assets: string | null;
};

export type Asset = { body: Uint8Array<ArrayBuffer>; type: string };

/** What a runtime is running from `onebase deploy`. */
export type Deployment = { id: string; created: number; assets: Map<string, Asset> | null };

const COLUMNS = "d.id, d.created, d.code, d.assets";

function toStored(row: Record<string, unknown> | null): StoredDeployment | null {
  if (!row) return null;
  return { id: String(row.id), created: Number(row.created), code: String(row.code), assets: (row.assets as string | null) ?? null };
}

export async function activeDeployment(tx: Exec): Promise<StoredDeployment | null> {
  return toStored(await tx.get(`SELECT ${COLUMNS} FROM _deployments d JOIN _meta m ON m.key = 'deployment' AND m.value = d.id`));
}

export async function getDeployment(tx: Exec, id: string): Promise<StoredDeployment | null> {
  return toStored(await tx.get(`SELECT ${COLUMNS} FROM _deployments d WHERE d.id = ?`, [id]));
}

/** The deployment pushed just before `current`, for --rollback. */
export async function previousDeployment(tx: Exec, current: StoredDeployment): Promise<StoredDeployment | null> {
  return toStored(await tx.get(`SELECT ${COLUMNS} FROM _deployments d WHERE d.created < ? ORDER BY d.created DESC LIMIT 1`, [current.created]));
}

/** Stores a new deployment, deleting all but the newest KEEP_DEPLOYMENTS. */
export async function saveDeployment(tx: Exec, d: StoredDeployment): Promise<void> {
  await tx.run("INSERT INTO _deployments (id, created, code, assets) VALUES (?, ?, ?, ?)", [d.id, d.created, d.code, d.assets]);
  const rows = await tx.all("SELECT id FROM _deployments ORDER BY created DESC");
  for (const row of rows.slice(KEEP_DEPLOYMENTS)) await tx.run("DELETE FROM _deployments WHERE id = ?", [row.id]);
}

export async function setActiveDeployment(tx: Exec, id: string): Promise<void> {
  await tx.run("INSERT INTO _meta (key, value) VALUES ('deployment', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [id]);
}

/** Decodes a stored deployment's static files for serving from memory. */
export function toDeployment(stored: StoredDeployment): Deployment {
  if (!stored.assets) return { id: stored.id, created: stored.created, assets: null };
  const assets = new Map<string, Asset>();
  for (const [path, base64] of Object.entries(JSON.parse(stored.assets) as Record<string, string>)) {
    assets.set(path, { body: new Uint8Array(Buffer.from(base64, "base64")), type: Bun.file(path).type });
  }
  return { id: stored.id, created: stored.created, assets };
}

/** Like a directory of files: /dir/ serves /dir/index.html, and unknown paths without an extension get /index.html. */
export function serveAsset(assets: Map<string, Asset>, pathname: string): Response | null {
  let path: string;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const asset =
    assets.get(path) ?? assets.get(path.replace(/\/?$/, "/index.html")) ?? (!extname(path) ? assets.get("/index.html") : undefined);
  return asset ? new Response(asset.body, { headers: { "Content-Type": asset.type } }) : null;
}
