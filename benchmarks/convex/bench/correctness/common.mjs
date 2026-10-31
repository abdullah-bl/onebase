// These tests target onebase. Only busy.mjs can also run on Convex, with
// `node correctness/busy.mjs convex`: the others use functions or a sync
// protocol that only the onebase app has.
const convex = process.argv[2] === "convex";
export const URL = convex
  ? process.env.CONVEX_URL || "http://127.0.0.1:3210"
  : process.env.ONEBASE_URL || "http://127.0.0.1:8190";
const headers = { "Content-Type": "application/json" };
if (convex && process.env.CONVEX_ADMIN_KEY) headers.Authorization = `Convex ${process.env.CONVEX_ADMIN_KEY}`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function call(kind, path, args = {}) {
  try {
    const r = await fetch(`${URL}/api/${kind}`, {
      method: "POST", headers,
      body: JSON.stringify({ path, args }), signal: AbortSignal.timeout(20000),
    });
    return await r.json();
  } catch (e) { return { status: "error", errorMessage: String(e) }; }
}
