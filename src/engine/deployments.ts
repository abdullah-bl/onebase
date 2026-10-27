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
  return toStored(await tx.get(`SELECT ${COLUMNS} FROM _deployments d JOIN _meta m ON m."key" = 'deployment' AND m.value = d.id`));
}

export async function getDeployment(tx: Exec, id: string): Promise<StoredDeployment | null> {
  return toStored(await tx.get(`SELECT ${COLUMNS} FROM _deployments d WHERE d.id = ?`, [id]));
}

export async function activeDeploymentId(tx: Exec): Promise<string | null> {
  return ((await tx.get("SELECT value FROM _meta WHERE \"key\" = 'deployment'"))?.value as string | undefined) ?? null;
}

/** Ids of the deployments that were made active, oldest first: a deploy adds one, a rollback goes back one. */
async function activations(tx: Exec): Promise<string[]> {
  const row = await tx.get("SELECT value FROM _meta WHERE \"key\" = 'deployments'");
  try {
    const ids = row ? JSON.parse(String(row.value)) : [];
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

/** The deployment that was active before `current`, for --rollback (not just the one pushed before it). */
export async function previousDeployment(tx: Exec, current: StoredDeployment): Promise<StoredDeployment | null> {
  const ids = await activations(tx);
  for (let i = ids.length - 1; i >= 0; i--) {
    if (ids[i] === current.id) continue;
    const found = await getDeployment(tx, ids[i]!);
    if (found) return found;
  }
  return null;
}

/** Stores a new deployment, deleting all but the newest KEEP_DEPLOYMENTS. */
export async function saveDeployment(tx: Exec, d: StoredDeployment): Promise<void> {
  await tx.run("INSERT INTO _deployments (id, created, code, assets) VALUES (?, ?, ?, ?)", [d.id, d.created, d.code, d.assets]);
  const rows = await tx.all("SELECT id FROM _deployments ORDER BY created DESC");
  for (const row of rows.slice(KEEP_DEPLOYMENTS)) await tx.run("DELETE FROM _deployments WHERE id = ?", [row.id]);
}

export async function setActiveDeployment(tx: Exec, id: string, how: "deploy" | "rollback"): Promise<void> {
  let ids = await activations(tx);
  const at = ids.lastIndexOf(id);
  // A rollback forgets what came after the deployment it goes back to, so the next one goes back further.
  ids = how === "rollback" && at >= 0 ? ids.slice(0, at + 1) : [...ids, id];
  const upsert = "INSERT INTO _meta (\"key\", value) VALUES (?, ?) ON CONFLICT(\"key\") DO UPDATE SET value = excluded.value";
  await tx.run(upsert, ["deployment", id]);
  await tx.run(upsert, ["deployments", JSON.stringify(ids.slice(-KEEP_DEPLOYMENTS * 2))]);
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

/** Deployments whose bundle module importBundle loaded here, as id → resolved module path. */
const loadedModules = new Map<string, string>();

/** Records a bundle module loaded through require(), so releaseModules can drop it once replaced. */
export function rememberModule(id: string, resolvedPath: string): void {
  loadedModules.set(id, resolvedPath);
}

/**
 * Drops replaced deployments' bundle modules from the module cache, so their memory can be freed
 * once no call is using them. (Bun's import() cache never releases a module; require()'s can be
 * emptied entry by entry, which is why importBundle prefers require().)
 */
export function releaseModules(exceptId: string | null): void {
  for (const [id, path] of loadedModules) {
    if (id === exceptId) continue;
    try {
      delete require.cache[path];
    } catch {}
    loadedModules.delete(id);
  }
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
