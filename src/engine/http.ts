import type { Server, ServerWebSocket } from "bun";
import type { UserIdentity } from "../server";
import { AuthError } from "./auth";
import { TokenRejected } from "./jwt";
import type { Runtime } from "./runtime";
import { stableStringify, SubscriptionManager } from "./sync";

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
  /**
   * Take the client IP from X-Forwarded-For (behind a reverse proxy). `true` or a number: how many
   * proxies in front of the server append to X-Forwarded-For (default 1). See forwardedClient.
   */
  trustProxy?: boolean | number;
  /** Handles /_admin requests (the dashboard). */
  admin?: ((req: Request, url: URL) => Promise<Response> | Response) | null;
  /** How often open connections re-check their auth token, in ms (default 60s; 0 disables). */
  sessionRecheckMs?: number;
  /** Largest request body, in bytes: uploads and everything else (default DEFAULT_MAX_BODY_BYTES, 1 GB). */
  maxBodyBytes?: number;
};

/**
 * The client address from an X-Forwarded-For value, given how many proxies in front of the server
 * append to it (`hops`). Proxies append the address they got the request from, so the entries a
 * client sent itself come first: the client is the `hops`-th entry from the right, never the
 * leftmost (which is whatever the client wrote). A header with fewer entries than hops gives the
 * leftmost one, as a proxy that overwrites the header leaves a single entry.
 */
export function forwardedClient(header: string | null | undefined, hops = 1): string | null {
  const entries = (header ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return null;
  return entries[Math.max(0, entries.length - Math.max(1, hops))]!;
}

/**
 * The key a client's address is counted under. An IPv6 user usually controls a whole /64 (and can
 * pick any address in it), so IPv6 addresses count per /64; IPv4-mapped IPv6 addresses count as the
 * IPv4 address. Anything that doesn't parse as IPv6 (IPv4, "unknown") is used as is.
 */
export function networkKey(address: string): string {
  let ip = address.trim().toLowerCase();
  if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]") > 0 ? ip.indexOf("]") : undefined);
  ip = ip.replace(/%.*$/, ""); // zone id
  if (!ip.includes(":")) return address.trim();
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return mapped[1]!;
  const halves = ip.split("::");
  if (halves.length > 2) return address.trim();
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // An embedded IPv4 tail takes two groups.
  if (tail.length && tail[tail.length - 1]!.includes(".")) tail.splice(tail.length - 1, 1, "0", "0");
  if (head.length && head[head.length - 1]!.includes(".")) head.splice(head.length - 1, 1, "0", "0");
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return address.trim();
  const groups = [...head, ...Array(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return address.trim();
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

/** The largest request body (and so upload) a server accepts unless told otherwise: 1 GB. */
export const DEFAULT_MAX_BODY_BYTES = 2 ** 30;

/** Parses a size like "1gb", "512mb", "100k" or a number of bytes. */
export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb|t|tb)?$/i.exec(text.trim().replace(/_/g, ""));
  const unit = { b: 1, k: 2 ** 10, m: 2 ** 20, g: 2 ** 30, t: 2 ** 40 }[(m?.[2]?.[0] ?? "b").toLowerCase() as "b"];
  const bytes = m ? Math.floor(Number(m[1]) * unit) : NaN;
  if (!(bytes >= 1) || !Number.isSafeInteger(bytes)) throw new Error(`Invalid size "${text}": use e.g. 1gb, 512mb or a number of bytes.`);
  return bytes;
}

/** Thrown while reading a request body that turned out bigger than the limit. */
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`Request body is larger than this server accepts (${describeSize(limit)}; set --max-upload or $ONEBASE_MAX_UPLOAD to change it).`);
  }
}

function describeSize(bytes: number): string {
  for (const [n, unit] of [[2 ** 40, "TB"], [2 ** 30, "GB"], [2 ** 20, "MB"], [2 ** 10, "KB"]] as const) {
    if (bytes >= n) return `${+(bytes / n).toFixed(2)} ${unit}`;
  }
  return `${bytes} bytes`;
}

/** A request whose body is counted as it streams: the one Bun handed over, and whether it went over. */
type Capped = { original: Request; over: boolean };
const cappedRequests = new WeakMap<Request, Capped>();

/**
 * `req` with a body that errors once more than `max` bytes went through, for a body sent without
 * a Content-Length (chunked). Whoever reads it sees a stream error, which `tooLarge` recognizes.
 */
function capBody(req: Request, max: number): Request {
  const state: Capped = { original: req, over: false };
  let size = 0;
  const body = req.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size <= max) return controller.enqueue(chunk);
        state.over = true;
        controller.error(new BodyTooLarge(max));
      },
    }),
  );
  const capped = new Request(req, { body, duplex: "half" } as RequestInit);
  cappedRequests.set(capped, state);
  return capped;
}

/** Whether `err` (from reading `req`'s body) is because the body went over the limit. */
const tooLarge = (req: Request, err: unknown) => err instanceof BodyTooLarge || cappedRequests.get(req)?.over === true;

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
  /** The token behind that identity, re-checked while the connection stays open. */
  token: string | null;
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
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

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

  const jsonText = (req: Request, text: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(text, { status, headers: { "Content-Type": "application/json", ...cors(req), ...headers } });

  const json = (req: Request, body: unknown, status = 200, headers: Record<string, string> = {}) =>
    jsonText(req, JSON.stringify(body), status, headers);

  const proxyHops = opts.trustProxy === true ? 1 : typeof opts.trustProxy === "number" && opts.trustProxy > 0 ? Math.floor(opts.trustProxy) : 0;

  /** The client's network, the key for rate limits and sign-in lockouts (an IPv6 /64, see networkKey). */
  const clientIp = (req: Request, server: Server<SocketData>) => {
    if (proxyHops) {
      // On Fly (which sets FLY_APP_NAME) the edge sets Fly-Client-IP itself. Anywhere else
      // Fly-Client-IP is just a header the client chose, so it's ignored.
      const fly = process.env.FLY_APP_NAME ? req.headers.get("Fly-Client-IP")?.trim() : undefined;
      // X-Real-IP only when there's no X-Forwarded-For: a proxy that sets it (nginx) overwrites it.
      const forwarded = fly || forwardedClient(req.headers.get("X-Forwarded-For"), proxyHops) || req.headers.get("X-Real-IP")?.trim();
      if (forwarded) return networkKey(forwarded);
    }
    return networkKey(server.requestIP(cappedRequests.get(req)?.original ?? req)?.address ?? "unknown");
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
      // Try again once a token is free, so the query starts on its own (the client keeps showing
      // the error until then). Unsubscribing, a new sub with this id, or closing cancels the retry.
      const entry = { path, args, unsubscribe: () => clearTimeout(retry), failed: true };
      const retry = setTimeout(() => {
        if (ws.readyState === 1 && ws.data.subs.get(id) === entry) subscribe(ws, id, path, args);
      }, limit.retryMs);
      ws.data.subs.set(id, entry);
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

  /** A connection whose identity is gone: signed out live, and its queries re-run anonymously. */
  const signOutSocket = (ws: ServerWebSocket<SocketData>, error: string) => {
    ws.data.identity = null;
    ws.data.token = null;
    send(ws, { type: "auth", ok: false, ended: true, error });
    for (const [id, sub] of ws.data.subs) subscribe(ws, id, sub.path, sub.args, false);
  };

  // A signed-out session stops working at once on every connection using it, here or (via the
  // commit broadcast) on another instance.
  runtime.onSessionsRevoked((ids) => {
    const ended = new Set(ids);
    for (const ws of sockets) {
      const sessionId = ws.data.identity?.sessionId;
      if (typeof sessionId !== "string" || !ended.has(sessionId)) continue;
      signOutSocket(ws, "You were signed out.");
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

  // A token checked when the connection opened can stop checking out later: sessions expire, and
  // accounts are deleted. While a connection is open, its identity is re-checked every
  // `sessionRecheckMs`; a still-valid session also has its expiry extended, like any other use.
  const recheckMs = opts.sessionRecheckMs ?? 60_000;
  /** A session or token that is over for good: a built-in session that ended, or a JWT that no longer verifies. */
  const endsSession = (err: unknown) => (err instanceof AuthError || err instanceof TokenRejected) && err.status === 401;
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  const recheckAll = async () => {
    for (const ws of sockets) {
      const { token, identity } = ws.data;
      if (!token || !identity) continue;
      try {
        const fresh = await runtime.identify(token);
        if (!fresh) {
          signOutSocket(ws, "You were signed out.");
        } else if (stableStringify(fresh) !== stableStringify(identity)) {
          // The identity changed (say, the email was verified or the account switched): re-run
          // the queries under the new one, exactly like a new auth message.
          ws.data.identity = fresh;
          for (const [id, sub] of ws.data.subs) subscribe(ws, id, sub.path, sub.args, false);
        } else {
          ws.data.identity = fresh;
        }
      } catch (err) {
        // `ended`: the session is gone for good. Anything else (say, the database timing out)
        // may pass, like on the auth message.
        if (endsSession(err)) signOutSocket(ws, (err as Error).message);
      }
    }
  };
  const startRechecks = () => {
    recheckTimer ??= setInterval(() => void recheckAll(), recheckMs);
  };
  const stopRechecksIfIdle = () => {
    if (sockets.size === 0 && recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  };

  const handleMessage = async (ws: ServerWebSocket<SocketData>, msg: ClientMessage) => {
    if (msg.type === "auth") {
      ws.data.token = msg.token ?? null;
      ws.data.ready = (async () => {
        try {
          ws.data.identity = await runtime.identify(msg.token);
          send(ws, { type: "auth", ok: true, identity: ws.data.identity ? { subject: ws.data.identity.subject } : null });
        } catch (err) {
          ws.data.identity = null;
          // `ended`: the session is gone for good. Anything else (say, the database timing out) may pass.
          const ended = endsSession(err);
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
        if (msg.kind === "query") {
          const value = await subscriptions.query(msg.path, msg.args, opts.identity, opts.source);
          if (ws.readyState === 1) ws.send(`{"type":"result","requestId":${JSON.stringify(msg.requestId)},"ok":true,"value":${value}}`);
          return;
        }
        const value =
          msg.kind === "mutation"
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
    } catch (err) {
      if (tooLarge(req, err)) return json(req, { status: "error", errorMessage: new BodyTooLarge(maxBody).message }, 413);
      return json(req, { status: "error", errorMessage: 'Body must be JSON: { "path": "messages:list", "args": {} }' }, 400);
    }
    try {
      const identity = await identityFromRequest(req);
      const opts = { identity, source: "http" as const };
      if (kind === "query") return jsonText(req, `{"status":"success","value":${await subscriptions.query(body.path, body.args, identity, opts.source)}}`);
      const value =
        kind === "mutation"
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
    // Bun's own limit answers 413 with an empty body before fetch runs; the limit is enforced
    // below instead, so the client gets a JSON error that says what the limit is.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.body) {
        const length = Number(req.headers.get("Content-Length") ?? NaN);
        if (length > maxBody) {
          const err = new BodyTooLarge(maxBody);
          return path.startsWith("/api/") ? json(req, { status: "error", errorMessage: err.message, error: err.message }, 413) : new Response(err.message, { status: 413 });
        }
        // No length up front (chunked): count while it streams.
        if (!(length >= 0)) req = capBody(req, maxBody);
      }

      if (path === "/api/sync") {
        if (!originAllowed(req)) return new Response("Origin not allowed", { status: 403 });
        const data: SocketData = {
          ip: clientIp(req, server),
          identity: null,
          token: null,
          ready: Promise.resolve(),
          subs: new Map(),
          committed: new Set(),
          held: { updates: [], results: new Map() },
        };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 400 });
      }
      if (runtime.mcp) {
        const res = await runtime.mcp.handle(req, url, () => limited(clientIp(req, server)));
        if (res) return res;
      }
      if (path.startsWith("/api/")) {
        if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });
        const kind = path.slice(5);
        const counted = req.method === "POST" && ["query", "mutation", "action", "run", "storage/upload", "auth/signin", "auth/device/start", "auth/device/approve"].includes(kind);
        const limit = counted ? limited(clientIp(req, server)) : null;
        if (limit) {
          return json(req, { status: "error", errorMessage: limit.message }, 429, { "Retry-After": String(Math.ceil(limit.retryMs / 1000)) });
        }
        if (path === "/api/storage/upload" && req.method === "POST") {
          try {
            const storageId = await runtime.upload(url.searchParams.get("token"), req, url.searchParams.get("id"));
            return json(req, { storageId });
          } catch (err) {
            if (tooLarge(req, err)) return json(req, { error: new BodyTooLarge(maxBody).message }, 413);
            return json(req, { error: runtime.toClientError(err).message }, 400);
          }
        }
        if (path.startsWith("/api/storage/") && req.method === "GET") {
          const res = await runtime.serveFile(path.slice("/api/storage/".length), req);
          if (!res) return new Response("File not found", { status: 404, headers: cors(req) });
          for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
          return res;
        }
        if (path.startsWith("/api/auth/device/")) {
          const res = (await runtime.device.handle(req, url))!;
          for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
          return res;
        }
        if (path.startsWith("/api/auth/")) {
          const res = runtime.auth ? await runtime.auth.handle(req, url, origins, clientIp(req, server)) : null;
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

      const route = runtime.lookupHttp(req.method, path);
      if (route) {
        try {
          const identity = await identityFromRequest(req);
          return await runtime.runHttpAction(route.handler.handler, req, identity, route.mount);
        } catch (err) {
          // A bad or expired session token is the caller's problem, not a server error.
          if (err instanceof AuthError) return new Response(err.message, { status: err.status });
          if (tooLarge(req, err)) return new Response(new BodyTooLarge(maxBody).message, { status: 413 });
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
        if (recheckMs > 0) startRechecks();
      },
      message(ws, raw) {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        // `null`, numbers and arrays are valid JSON but not messages.
        if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return;
        // Nothing a client sends may become an unhandled rejection in the shared process.
        handleMessage(ws, msg).catch((err) => runtime.log.error(`sync: ${err instanceof Error ? err.message : String(err)}`));
      },
      close(ws) {
        sockets.delete(ws);
        runtime.stats.connections--;
        for (const sub of ws.data.subs.values()) sub.unsubscribe();
        ws.data.subs.clear();
        stopRechecksIfIdle();
      },
    },
  });
}
