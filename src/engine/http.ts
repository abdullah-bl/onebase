import type { Server, ServerWebSocket } from "bun";
import type { UserIdentity } from "../server";
import { AuthError } from "./auth";
import type { Runtime } from "./runtime";
import { SubscriptionManager } from "./sync";

export type AssetResolver = (pathname: string) => Promise<Response | null> | Response | null;

export type ServeOptions = {
  runtime: Runtime;
  port?: number;
  hostname?: string;
  /** Serves the frontend (static files). */
  assets?: AssetResolver | null;
  /** Browser client served at /_onebase/client.js. */
  clientBundle?: string;
  /** Origins allowed to call the API from a browser (default: any). */
  cors?: string[] | null;
  /** Per-IP limit on function calls, subscriptions and uploads. */
  rateLimit?: RateLimit | null;
  /** Take the client IP from X-Forwarded-For (behind a reverse proxy). */
  trustProxy?: boolean;
  /** Handles /_admin requests (the dashboard). */
  admin?: ((req: Request, url: URL) => Promise<Response> | Response) | null;
};

export type RateLimit = { max: number; windowMs: number };

/** Parses "100/10s", "600/m" or "5000/h". */
export function parseRateLimit(text: string): RateLimit {
  const m = /^(\d+)\/(\d*)(s|m|h)$/.exec(text.trim());
  if (!m || Number(m[1]) < 1) throw new Error(`Invalid rate limit "${text}": use requests/window, e.g. 100/10s or 600/m.`);
  return { max: Number(m[1]), windowMs: Number(m[2] || 1) * { s: 1000, m: 60_000, h: 3_600_000 }[m[3] as "s" | "m" | "h"] };
}

/** Token buckets per client: `max` requests per window, refilled continuously. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private lastSweep = Date.now();

  constructor(readonly limit: RateLimit) {}

  /** Takes one token; returns 0 if allowed, otherwise the milliseconds until a token is free. */
  take(key: string, now = Date.now()): number {
    const { max, windowMs } = this.limit;
    const rate = max / windowMs;
    if (now - this.lastSweep > windowMs * 2) {
      // Buckets that have refilled completely carry no state; drop them to bound memory.
      for (const [k, b] of this.buckets) if (b.tokens + (now - b.at) * rate >= max) this.buckets.delete(k);
      this.lastSweep = now;
    }
    const b = this.buckets.get(key) ?? { tokens: max, at: now };
    b.tokens = Math.min(max, b.tokens + (now - b.at) * rate);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / rate);
  }

  describe(): string {
    const { max, windowMs } = this.limit;
    for (const [ms, unit, short] of [[3_600_000, "hour", "h"], [60_000, "minute", "m"], [1000, "second", "s"]] as const) {
      if (windowMs === ms) return `${max} per ${unit}`;
      if (windowMs % ms === 0) return `${max} per ${windowMs / ms}${short}`;
    }
    return `${max} per ${windowMs}ms`;
  }
}

type ClientMessage =
  | { type: "auth"; token: string | null }
  | { type: "sub"; id: number; path: string; args?: unknown }
  | { type: "unsub"; id: number }
  | { type: "call"; requestId: number; kind: "query" | "mutation" | "action"; path: string; args?: unknown };

type SocketData = {
  ip: string;
  identity: UserIdentity | null;
  ready: Promise<void>;
  /** `failed`: the query couldn't start (unknown function, rate limit), so a deploy retries it. */
  subs: Map<number, { path: string; args: unknown; unsubscribe: () => void; failed?: boolean }>;
  /** This client's mutations that have committed but haven't been answered yet. */
  committed: Set<number>;
  /** Query updates and results held back meanwhile, then sent together as one transition. */
  held: { updates: unknown[]; results: Map<number, unknown> };
};

const CORS_BASE = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function serve(opts: ServeOptions): Server<SocketData> {
  const { runtime } = opts;
  const subscriptions = new SubscriptionManager(runtime);
  const sockets = new Set<ServerWebSocket<SocketData>>();
  const origins = opts.cors?.length && !opts.cors.includes("*") ? new Set(opts.cors.map((o) => o.replace(/\/$/, ""))) : null;
  const limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit) : null;

  const originAllowed = (req: Request) => {
    const origin = req.headers.get("Origin");
    return !origins || !origin || origins.has(origin);
  };

  /** CORS headers for this request: any origin, or the request's origin if it's on the list. */
  const cors = (req: Request): Record<string, string> => {
    if (!origins) return { "Access-Control-Allow-Origin": "*", ...CORS_BASE };
    const origin = req.headers.get("Origin");
    return origin && origins.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", ...CORS_BASE } : { Vary: "Origin" };
  };

  const json = (req: Request, body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...cors(req), ...headers } });

  const clientIp = (req: Request, server: Server<SocketData>) => {
    if (opts.trustProxy) {
      const forwarded = req.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() || req.headers.get("X-Real-IP");
      if (forwarded) return forwarded;
    }
    return server.requestIP(req)?.address ?? "unknown";
  };

  /** Null if allowed, otherwise the error to send. */
  const limited = (ip: string): { message: string; retryMs: number } | null => {
    const retryMs = limiter?.take(ip) ?? 0;
    if (!retryMs) return null;
    return { message: `Too many requests (limit: ${limiter!.describe()}). Try again in ${Math.ceil(retryMs / 1000)}s.`, retryMs };
  };

  const identityFromRequest = async (req: Request) => {
    const header = req.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    return runtime.identify(token);
  };

  const send = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  /**
   * Query updates wait while one of this client's mutations is between commit and reply. The
   * client then gets the updates and the result in one message and can drop the mutation's
   * optimistic update at exactly the moment the real data arrives.
   */
  const pushUpdate = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
    if (ws.data.committed.size) ws.data.held.updates.push(msg);
    else send(ws, msg);
  };

  const reply = (ws: ServerWebSocket<SocketData>, msg: { requestId: number }) => {
    const d = ws.data;
    if (!d.committed.has(msg.requestId)) return send(ws, msg);
    d.held.results.set(msg.requestId, msg);
    if (d.held.results.size < d.committed.size) return; // another mutation of theirs committed and is still finishing
    send(ws, { type: "transition", updates: d.held.updates, results: [...d.held.results.values()] });
    d.committed.clear();
    d.held = { updates: [], results: new Map() };
  };

  const subscribe = (ws: ServerWebSocket<SocketData>, id: number, path: string, args: unknown, counted = true) => {
    ws.data.subs.get(id)?.unsubscribe();
    const limit = counted ? limited(ws.data.ip) : null;
    if (limit) {
      ws.data.subs.set(id, { path, args, unsubscribe: () => {}, failed: true });
      return pushUpdate(ws, { type: "update", id, ok: false, error: limit.message });
    }
    try {
      const { name } = runtime.resolve(path, "query", false);
      const unsubscribe = subscriptions.subscribe(name, args, ws.data.identity, (update) => pushUpdate(ws, { type: "update", id, ...update }));
      ws.data.subs.set(id, { path, args, unsubscribe });
    } catch (err) {
      const e = runtime.toClientError(err);
      ws.data.subs.set(id, { path, args, unsubscribe: () => {}, failed: true });
      pushUpdate(ws, { type: "update", id, ok: false, error: e.message, data: e.data });
    }
  };

  // A signed-out session stops working at once on every connection using it, here or (via the
  // commit broadcast) on another instance.
  runtime.onSessionsRevoked((ids) => {
    const ended = new Set(ids);
    for (const ws of sockets) {
      const sessionId = ws.data.identity?.sessionId;
      if (typeof sessionId !== "string" || !ended.has(sessionId)) continue;
      ws.data.identity = null;
      send(ws, { type: "auth", ok: false, ended: true, error: "You were signed out." });
      for (const [id, sub] of ws.data.subs) subscribe(ws, id, sub.path, sub.args, false);
    }
  });

  // New code: re-run every live query, and retry the ones that couldn't start (say, a function
  // that only exists now). Clients stay connected.
  runtime.onDeploy(async () => {
    const rerun = subscriptions.rerunAll();
    for (const ws of sockets) {
      for (const [id, sub] of ws.data.subs) if (sub.failed) subscribe(ws, id, sub.path, sub.args, false);
    }
    await rerun;
  });

  const handleMessage = async (ws: ServerWebSocket<SocketData>, msg: ClientMessage) => {
    if (msg.type === "auth") {
      ws.data.ready = (async () => {
        try {
          ws.data.identity = await runtime.identify(msg.token);
          send(ws, { type: "auth", ok: true, identity: ws.data.identity ? { subject: ws.data.identity.subject } : null });
        } catch (err) {
          ws.data.identity = null;
          // `ended`: the session is gone for good. Anything else (say, the database timing out) may pass.
          const ended = err instanceof AuthError && err.status === 401;
          send(ws, { type: "auth", ok: false, ended, error: runtime.toClientError(err).message });
        }
        // Results depend on who is asking, so re-subscribe under the new identity.
        for (const [id, sub] of ws.data.subs) subscribe(ws, id, sub.path, sub.args, false);
      })();
      return;
    }
    await ws.data.ready;
    if (msg.type === "sub") return subscribe(ws, msg.id, msg.path, msg.args);
    if (msg.type === "unsub") {
      ws.data.subs.get(msg.id)?.unsubscribe();
      ws.data.subs.delete(msg.id);
      return;
    }
    if (msg.type === "call") {
      const limit = limited(ws.data.ip);
      if (limit) return send(ws, { type: "result", requestId: msg.requestId, ok: false, error: limit.message });
      try {
        const opts = { identity: ws.data.identity, source: "client" as const };
        const value =
          msg.kind === "query"
            ? (await runtime.runQuery(msg.path, msg.args, opts)).value
            : msg.kind === "mutation"
              ? await runtime.runMutation(msg.path, msg.args, { ...opts, beforeCommit: () => ws.data.committed.add(msg.requestId) })
              : await runtime.runAction(msg.path, msg.args, opts);
        reply(ws, { type: "result", requestId: msg.requestId, ok: true, value } as any);
      } catch (err) {
        runtime.log.error(`${msg.path}: ${err instanceof Error ? err.message : String(err)}`);
        const e = runtime.toClientError(err, msg.path);
        reply(ws, { type: "result", requestId: msg.requestId, ok: false, error: e.message, data: e.data } as any);
      }
    }
  };

  const handleHttpApi = async (req: Request, kind: string) => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json(req, { status: "error", errorMessage: 'Body must be JSON: { "path": "messages:list", "args": {} }' }, 400);
    }
    try {
      const identity = await identityFromRequest(req);
      const opts = { identity, source: "http" as const };
      const value =
        kind === "query"
          ? (await runtime.runQuery(body.path, body.args, opts)).value
          : kind === "mutation"
            ? await runtime.runMutation(body.path, body.args, opts)
            : kind === "action"
              ? await runtime.runAction(body.path, body.args, opts)
              : await runtime.call(body.path, body.args, opts);
      return json(req, { status: "success", value });
    } catch (err) {
      runtime.log.error(`${body?.path}: ${err instanceof Error ? err.message : String(err)}`);
      const e = runtime.toClientError(err, body?.path);
      return json(req, { status: "error", errorMessage: e.message, errorData: e.data }, 400);
    }
  };

  return Bun.serve<SocketData>({
    port: opts.port ?? 8090,
    hostname: opts.hostname ?? "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/sync") {
        if (!originAllowed(req)) return new Response("Origin not allowed", { status: 403 });
        const data: SocketData = {
          ip: clientIp(req, server),
          identity: null,
          ready: Promise.resolve(),
          subs: new Map(),
          committed: new Set(),
          held: { updates: [], results: new Map() },
        };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 400 });
      }
      if (path.startsWith("/api/")) {
        if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
        const kind = path.slice(5);
        const counted = req.method === "POST" && ["query", "mutation", "action", "run", "storage/upload", "auth/signin"].includes(kind);
        const limit = counted ? limited(clientIp(req, server)) : null;
        if (limit) {
          return json(req, { status: "error", errorMessage: limit.message }, 429, { "Retry-After": String(Math.ceil(limit.retryMs / 1000)) });
        }
        if (path === "/api/storage/upload" && req.method === "POST") {
          try {
            const storageId = await runtime.upload(url.searchParams.get("token"), req);
            return json(req, { storageId });
          } catch (err) {
            return json(req, { error: runtime.toClientError(err).message }, 400);
          }
        }
        if (path.startsWith("/api/storage/") && req.method === "GET") {
          const res = await runtime.serveFile(path.slice("/api/storage/".length), req);
          if (!res) return new Response("File not found", { status: 404, headers: cors(req) });
          for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
          return res;
        }
        if (path.startsWith("/api/auth/")) {
          const res = runtime.auth ? await runtime.auth.handle(req, url, origins) : null;
          if (!res) {
            const hint = runtime.auth ? "" : " Built-in auth is off: add methods: [password(), ...] to auth.config.ts.";
            return json(req, { error: `Unknown endpoint ${req.method} ${path}.${hint}` }, 404);
          }
          if (res.status < 300 || res.status >= 400) for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
          return res;
        }
        if (path === "/api/health") return json(req, { ok: true, functions: runtime.functions.size, subscriptions: subscriptions.size, deployment: runtime.deployment?.id ?? null });
        if (req.method === "POST" && ["query", "mutation", "action", "run"].includes(kind)) return handleHttpApi(req, kind);
        return json(req, { status: "error", errorMessage: `Unknown endpoint ${req.method} ${path}` }, 404);
      }
      if (path === "/_onebase/client.js" && opts.clientBundle) {
        return new Response(opts.clientBundle, { headers: { "Content-Type": "text/javascript; charset=utf-8", ...cors(req) } });
      }
      if (opts.admin && (path === "/_admin" || path.startsWith("/_admin/"))) return opts.admin(req, url);

      const httpAction = runtime.http?.lookup(req.method, path);
      if (httpAction) {
        try {
          const identity = await identityFromRequest(req);
          return await runtime.runHttpAction(httpAction.handler, req, identity);
        } catch (err) {
          runtime.log.error(`HTTP ${req.method} ${path}: ${err instanceof Error ? err.message : String(err)}`);
          return new Response(runtime.toClientError(err).message, { status: 500 });
        }
      }

      const asset = await opts.assets?.(path);
      if (asset) return asset;
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      idleTimeout: 120,
      open(ws) {
        sockets.add(ws);
        runtime.stats.connections++;
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        void handleMessage(ws, msg);
      },
      close(ws) {
        sockets.delete(ws);
        runtime.stats.connections--;
        for (const sub of ws.data.subs.values()) sub.unsubscribe();
        ws.data.subs.clear();
      },
    },
  });
}
