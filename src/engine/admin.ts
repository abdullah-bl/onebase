// The dashboard: served at /_admin, with a JSON API at /_admin/api/* (which `onebase deploy` also
// uses) and a live event stream at /_admin/api/events. Every API call needs
// `Authorization: Bearer <admin key>`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../values";
import type { CallRecord } from "./calllog";
import { tableMount } from "./catalog";
import { OnebaseError } from "./database";
import type { Runtime } from "./runtime";

export type DashboardAssets = { js: string; css: string };

/** $ONEBASE_ADMIN_KEY, or a random key kept in <data>/admin.key (created on first run). */
export function loadAdminKey(dataDir: string): { key: string; source: string } {
  const fromEnv = process.env.ONEBASE_ADMIN_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "$ONEBASE_ADMIN_KEY" };
  const path = join(dataDir, "admin.key");
  if (existsSync(path)) return { key: readFileSync(path, "utf8").trim(), source: path };
  mkdirSync(dataDir, { recursive: true });
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  writeFileSync(path, key + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return { key, source: path };
}

// Bun's built-in hasher: importing node:crypto would add ~5 MB of memory.
const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest();

/** Compares two equal-length digests in constant time. */
function sameDigest(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

const HTML = (version: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>onebase dashboard</title><meta name="robots" content="noindex">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='5' fill='%2314b886'/%3E%3Ccircle cx='16' cy='16' r='10.5' fill='none' stroke='%2314b886' stroke-width='2.4' opacity='.6'/%3E%3C/svg%3E">
<link rel="stylesheet" href="/_admin/app.css?v=${version}">
<script>try{var t=localStorage.getItem("ob-theme");if(t)document.documentElement.dataset.theme=t}catch(e){}</script>
</head><body><div id="app"></div><script type="module" src="/_admin/app.js?v=${version}"></script></body></html>`;

type Handler = (body: any) => Promise<unknown> | unknown;

export function createAdmin(opts: { runtime: Runtime; key: string; assets: DashboardAssets; version: string }) {
  const { runtime } = opts;
  const keyDigest = digest(opts.key);
  const authorized = (req: Request) => {
    const header = req.headers.get("Authorization") ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    return given.length > 0 && sameDigest(digest(given), keyDigest);
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

  const tableCounts = () =>
    runtime.adminRead(async (_db, tx) => {
      const rows = await tx.all("SELECT tbl, COUNT(*) AS n FROM documents GROUP BY tbl");
      return new Map(rows.map((r) => [r.tbl as string, Number(r.n)]));
    });

  const tables = async () => {
    const counts = await tableCounts();
    const schemaTables = runtime.catalog?.tables ?? {};
    const names = [...new Set([...Object.keys(schemaTables), ...counts.keys()])].sort();
    return names.map((name) => {
      const def = (schemaTables as any)[name];
      return {
        name,
        /** The component that owns the table ("limiter" for "limiter.rateLimits"), or null for the app's. */
        component: tableMount(name),
        count: counts.get(name) ?? 0,
        inSchema: Boolean(def),
        fields: def?.validator?.kind === "object" ? Object.keys(def.validator.fields) : [],
        validator: def?.validator ?? null,
        indexes: [{ name: "by_creation_time", fields: ["_creationTime"] }, ...(def?.indexes ?? [])],
        searchIndexes: def?.searchIndexes ?? [],
      };
    });
  };

  const api: Record<string, Handler> = {
    overview: async () => {
      const mem = process.memoryUsage();
      const t = await tables();
      const files = await runtime.adminRead(async (_db, tx) => tx.get("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM _storage"));
      const jobs = await runtime.adminRead(async (_db, tx) => tx.all("SELECT state, COUNT(*) AS n FROM _scheduled GROUP BY state"));
      return {
        version: opts.version,
        instanceId: runtime.instanceId,
        uptimeMs: Date.now() - runtime.startedAt,
        memory: { rss: mem.rss, heapUsed: mem.heapUsed },
        driver: { kind: runtime.driver.kind, description: runtime.driver.description },
        files: { backend: runtime.files.backend.description, count: Number(files?.n ?? 0), bytes: Number(files?.bytes ?? 0) },
        functions: [...runtime.functions.values()].reduce<Record<string, number>>((acc, f) => ((acc[f.type] = (acc[f.type] ?? 0) + 1), acc), {}),
        crons: runtime.cronJobs.length,
        jobs: Object.fromEntries(jobs.map((j) => [j.state, Number(j.n)])),
        connections: runtime.stats.connections,
        subscriptions: runtime.stats.subscriptions(),
        totals: runtime.calls.totals,
        tables: t.map(({ name, count, inSchema }) => ({ name, count, inSchema })),
        schema: Boolean(runtime.schema),
        signIn: runtime.auth?.ids ?? [],
        deployment: runtime.deployment ? { id: runtime.deployment.id, created: runtime.deployment.created } : null,
      };
    },

    tables,

    documents: async ({ table, cursor = null, numItems = 50, order = "desc", filter, id }) => {
      if (typeof table !== "string") throw new OnebaseError("table is required.");
      return runtime.adminRead(async (db) => {
        if (id) {
          const doc = await db.get(String(id));
          return { page: doc ? [doc] : [], isDone: true, continueCursor: "" };
        }
        let q = db.query(table).order(order === "asc" ? "asc" : "desc");
        if (filter !== undefined && filter !== null) {
          if (!isPlainObject(filter)) throw new OnebaseError('Filter must be a JSON object, e.g. {"author": "ali"}.');
          q = q.filter(filter);
        }
        return q.paginate({ numItems: Math.min(Math.max(1, Number(numItems) || 50), 500), cursor });
      });
    },

    insert: ({ table, doc }) => runtime.adminWrite((db) => db.insert(table, doc)),
    patch: ({ id, fields }) => runtime.adminWrite((db) => db.patch(id, fields)),
    replace: ({ id, doc }) => runtime.adminWrite((db) => db.replace(id, doc)),
    delete: ({ ids }) =>
      runtime.adminWrite(async (db) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) await db.delete(id);
        return null;
      }),

    /** Deletes every document of a table that's no longer in any schema (say, of a component that was unmounted). */
    clearTable: async ({ table }) => {
      if (typeof table !== "string") throw new OnebaseError("table is required.");
      if (runtime.catalog?.tables[table]) throw new OnebaseError(`"${table}" is in use; only tables no schema declares can be cleared.`);
      let deleted = 0;
      for (;;) {
        const n = await runtime.adminWrite(async (db) => {
          const docs = await db.query(table).take(500);
          for (const doc of docs) await db.delete(doc._id);
          return docs.length;
        });
        deleted += n;
        if (n < 500) return { deleted };
      }
    },

    functions: () =>
      [...runtime.functions.entries()]
        .map(([name, fn]) => ({
          name,
          component: name.startsWith("components/") ? name.slice(11).split(/[/:]/)[0]! : null,
          type: fn.type,
          visibility: fn.visibility,
          args: fn.args ?? null,
          returns: fn.returns ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),

    run: async ({ name, args, identity }) => {
      const start = performance.now();
      try {
        const who =
          identity && typeof identity.subject === "string"
            ? { tokenIdentifier: `dashboard|${identity.subject}`, ...identity }
            : null;
        const value = await runtime.call(name, args ?? {}, { allowInternal: true, source: "dashboard", identity: who });
        return { ok: true, value: value ?? null, ms: performance.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), ms: performance.now() - start };
      }
    },

    calls: ({ limit = 500 }) => runtime.calls.recent(Math.min(Number(limit) || 500, 1000)),

    jobs: ({ state }) =>
      runtime.adminRead(async (_db, tx) => {
        const rows = state
          ? await tx.all("SELECT id, fn, args, run_at, state, error FROM _scheduled WHERE state = ? ORDER BY run_at DESC LIMIT 200", [state])
          : await tx.all("SELECT id, fn, args, run_at, state, error FROM _scheduled ORDER BY run_at DESC LIMIT 200");
        return rows.map((r) => ({ id: r.id, fn: r.fn, args: JSON.parse(r.args), runAt: Number(r.run_at), state: r.state, error: r.error }));
      }),

    cancelJob: async ({ id }) => {
      await runtime.withWriter((tx) => tx.run("UPDATE _scheduled SET state = 'canceled' WHERE id = ? AND state = 'pending'", [id]));
      return null;
    },

    runJobNow: async ({ id }) => {
      await runtime.withWriter((tx) => tx.run("UPDATE _scheduled SET run_at = ? WHERE id = ? AND state = 'pending'", [Date.now(), id]));
      runtime.pokeScheduler();
      return null;
    },

    crons: () =>
      runtime.adminRead(async (_db, tx) => {
        const rows = new Map((await tx.all("SELECT name, next_run, last_run, last_error FROM _crons")).map((r) => [r.name as string, r]));
        return runtime.cronJobs.map((job) => {
          const row = rows.get(job.name);
          const s = job.schedule;
          return {
            name: job.name,
            fn: job.fn,
            args: job.args,
            schedule: s.type === "cron" ? s.expression : `every ${humanMs(s.ms)}`,
            nextRun: row ? Number(row.next_run) : null,
            lastRun: row?.last_run ? Number(row.last_run) : null,
            lastError: row?.last_error ?? null,
          };
        });
      }),

    files: ({ before = null, limit = 60 }) =>
      runtime.adminRead(async (_db, tx) => {
        const n = Math.min(Number(limit) || 60, 200);
        const rows = before
          ? await tx.all(`SELECT id, ct, sha256, size, content_type FROM _storage WHERE ct < ? ORDER BY ct DESC LIMIT ${n}`, [before])
          : await tx.all(`SELECT id, ct, sha256, size, content_type FROM _storage ORDER BY ct DESC LIMIT ${n}`);
        return rows.map((r) => ({ id: r.id, createdAt: Number(r.ct), size: Number(r.size), contentType: r.content_type, sha256: r.sha256 }));
      }),

    // `onebase deploy`: the bundle's code, the frontend as { "/path": base64 } (or null), dryRun,
    // and for a dry run the schema and function count as data (so the pushed code is never run).
    deploy: ({ code, assets = null, dryRun = false, schema = null, functions }) => {
      if (assets !== null && !isPlainObject(assets)) throw new OnebaseError("assets must be an object of { \"/path\": base64 }.");
      return runtime.deploy({ code, assets, dryRun: dryRun === true, schema, functions });
    },

    rollback: () => runtime.rollback(),

    deleteFile: ({ id }) =>
      runtime.adminWrite(async (_db, state) => {
        await state.deleteFile(id);
        return null;
      }),
  };

  /** Server-sent events: each call, each commit (tables touched) and stats every few seconds. */
  const events = (req: Request) => {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, data: unknown) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            cleanup();
          }
        };
        const stats = () =>
          send("stats", {
            connections: runtime.stats.connections,
            subscriptions: runtime.stats.subscriptions(),
            totals: runtime.calls.totals,
            memory: process.memoryUsage().rss,
            uptimeMs: Date.now() - runtime.startedAt,
          });
        const offCall = runtime.calls.listen((record: CallRecord) => send("call", record));
        const offCommit = runtime.onCommit(async (event) => {
          send("commit", { tables: event.tables ?? [...new Set(event.writes.map((w) => w.table))] });
        });
        const timer = setInterval(stats, 3000);
        const ping = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            cleanup();
          }
        }, 5000);
        cleanup = () => {
          offCall();
          offCommit();
          clearInterval(timer);
          clearInterval(ping);
        };
        req.signal.addEventListener("abort", () => {
          cleanup();
          try {
            controller.close();
          } catch {}
        });
        stats();
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" },
    });
  };

  return async (req: Request, url: URL): Promise<Response> => {
    const path = url.pathname;
    if (path === "/_admin" || path === "/_admin/") return new Response(HTML(opts.version), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (path === "/_admin/app.js") return new Response(opts.assets.js, { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    if (path === "/_admin/app.css") return new Response(opts.assets.css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
    if (!path.startsWith("/_admin/api/")) return new Response("Not found", { status: 404 });
    if (!authorized(req)) return json({ error: "Invalid or missing admin key." }, 401);

    const name = path.slice("/_admin/api/".length);
    if (name === "events" && req.method === "GET") return events(req);
    const handler = api[name];
    if (!handler || req.method !== "POST") return json({ error: `Unknown admin endpoint ${req.method} ${path}` }, 404);
    let body: unknown = {};
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      return json({ error: "Body must be JSON." }, 400);
    }
    try {
      return json({ ok: true, value: (await handler(body ?? {})) ?? null });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  };
}

function humanMs(ms: number): string {
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}
