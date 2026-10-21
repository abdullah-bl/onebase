import type { Server, ServerWebSocket } from "bun";
import type { UserIdentity } from "../server";
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
};

type ClientMessage =
  | { type: "auth"; token: string | null }
  | { type: "sub"; id: number; path: string; args?: unknown }
  | { type: "unsub"; id: number }
  | { type: "call"; requestId: number; kind: "query" | "mutation" | "action"; path: string; args?: unknown };

type SocketData = {
  identity: UserIdentity | null;
  ready: Promise<void>;
  subs: Map<number, { path: string; args: unknown; unsubscribe: () => void }>;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
}

export function serve(opts: ServeOptions): Server<SocketData> {
  const { runtime } = opts;
  const subscriptions = new SubscriptionManager(runtime);

  const identityFromRequest = async (req: Request) => {
    const header = req.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    return runtime.identify(token);
  };

  const send = (ws: ServerWebSocket<SocketData>, msg: unknown) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  };

  const subscribe = (ws: ServerWebSocket<SocketData>, id: number, path: string, args: unknown) => {
    ws.data.subs.get(id)?.unsubscribe();
    try {
      const { name } = runtime.resolve(path, "query", false);
      const unsubscribe = subscriptions.subscribe(name, args, ws.data.identity, (update) => send(ws, { type: "update", id, ...update }));
      ws.data.subs.set(id, { path, args, unsubscribe });
    } catch (err) {
      const e = runtime.toClientError(err);
      ws.data.subs.set(id, { path, args, unsubscribe: () => {} });
      send(ws, { type: "update", id, ok: false, error: e.message, data: e.data });
    }
  };

  const handleMessage = async (ws: ServerWebSocket<SocketData>, msg: ClientMessage) => {
    if (msg.type === "auth") {
      ws.data.ready = (async () => {
        try {
          ws.data.identity = await runtime.identify(msg.token);
          send(ws, { type: "auth", ok: true, identity: ws.data.identity ? { subject: ws.data.identity.subject } : null });
        } catch (err) {
          ws.data.identity = null;
          send(ws, { type: "auth", ok: false, error: runtime.toClientError(err).message });
        }
        // Results depend on who is asking, so re-subscribe under the new identity.
        for (const [id, sub] of ws.data.subs) subscribe(ws, id, sub.path, sub.args);
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
      try {
        const opts = { identity: ws.data.identity };
        const value =
          msg.kind === "query"
            ? (await runtime.runQuery(msg.path, msg.args, opts)).value
            : msg.kind === "mutation"
              ? await runtime.runMutation(msg.path, msg.args, opts)
              : await runtime.runAction(msg.path, msg.args, opts);
        send(ws, { type: "result", requestId: msg.requestId, ok: true, value });
      } catch (err) {
        runtime.log.error(`${msg.path}: ${err instanceof Error ? err.message : String(err)}`);
        const e = runtime.toClientError(err, msg.path);
        send(ws, { type: "result", requestId: msg.requestId, ok: false, error: e.message, data: e.data });
      }
    }
  };

  const handleHttpApi = async (req: Request, kind: string) => {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ status: "error", errorMessage: 'Body must be JSON: { "path": "messages:list", "args": {} }' }, 400);
    }
    try {
      const identity = await identityFromRequest(req);
      const opts = { identity };
      const value =
        kind === "query"
          ? (await runtime.runQuery(body.path, body.args, opts)).value
          : kind === "mutation"
            ? await runtime.runMutation(body.path, body.args, opts)
            : kind === "action"
              ? await runtime.runAction(body.path, body.args, opts)
              : await runtime.call(body.path, body.args, opts);
      return json({ status: "success", value });
    } catch (err) {
      runtime.log.error(`${body?.path}: ${err instanceof Error ? err.message : String(err)}`);
      const e = runtime.toClientError(err, body?.path);
      return json({ status: "error", errorMessage: e.message, errorData: e.data }, 400);
    }
  };

  return Bun.serve<SocketData>({
    port: opts.port ?? 8090,
    hostname: opts.hostname ?? "0.0.0.0",
    async fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/api/sync") {
        const data: SocketData = { identity: null, ready: Promise.resolve(), subs: new Map() };
        if (server.upgrade(req, { data })) return undefined;
        return new Response("Expected a WebSocket upgrade", { status: 400 });
      }
      if (path.startsWith("/api/")) {
        if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
        if (path === "/api/storage/upload" && req.method === "POST") {
          try {
            const storageId = await runtime.upload(url.searchParams.get("token"), req);
            return json({ storageId });
          } catch (err) {
            return json({ error: runtime.toClientError(err).message }, 400);
          }
        }
        if (path.startsWith("/api/storage/") && req.method === "GET") {
          const res = await runtime.serveFile(path.slice("/api/storage/".length), req);
          if (!res) return new Response("File not found", { status: 404, headers: CORS });
          for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
          return res;
        }
        if (path === "/api/health") return json({ ok: true, functions: runtime.functions.size, subscriptions: subscriptions.size });
        const kind = path.slice(5);
        if (req.method === "POST" && ["query", "mutation", "action", "run"].includes(kind)) return handleHttpApi(req, kind);
        return json({ status: "error", errorMessage: `Unknown endpoint ${req.method} ${path}` }, 404);
      }
      if (path === "/_onebase/client.js" && opts.clientBundle) {
        return new Response(opts.clientBundle, { headers: { "Content-Type": "text/javascript; charset=utf-8", ...CORS } });
      }

      const httpAction = runtime.http?.lookup(req.method, path);
      if (httpAction) {
        try {
          const identity = await identityFromRequest(req);
          return await httpAction.handler(runtime.actionCtx(identity) as any, req);
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
        for (const sub of ws.data.subs.values()) sub.unsubscribe();
        ws.data.subs.clear();
      },
    },
  });
}
