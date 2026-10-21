// Browser / Bun client (imported as "onebase/browser").
// One WebSocket carries live query subscriptions, mutations and actions.

import {
  getFunctionName,
  type FunctionArgs,
  type FunctionLike,
  type FunctionReference,
  type FunctionReturnType,
  type OptionalRestArgs,
} from "../api";

export { anyApi, getFunctionName } from "../api";
export type { FunctionArgs, FunctionReference, FunctionReturnType } from "../api";

export class ConvexError<Data = unknown> extends Error {
  constructor(
    message: string,
    readonly data: Data,
  ) {
    super(message);
    this.name = "ConvexError";
  }
}

export type QueryResult = { ok: true; value: unknown } | { ok: false; error: Error };
type Listener = (result: QueryResult) => void;
type Sub = { id: number; path: string; args: unknown; listeners: Set<Listener>; last: QueryResult | null };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; message: string; sent: boolean };
type TokenFetcher = () => Promise<string | null | undefined> | string | null | undefined;

export type ClientOptions = {
  /** Provide for environments without a global WebSocket. */
  webSocketConstructor?: typeof WebSocket;
};

export type ConnectionState = "connecting" | "open" | "closed";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function toError(msg: { error: string; data?: unknown }): Error {
  return msg.data !== undefined && msg.data !== null ? new ConvexError(msg.error, msg.data) : new Error(msg.error);
}

const browserLocation = (globalThis as { location?: { href: string; origin: string } }).location;

function syncUrl(address: string): string {
  const url = new URL(address, browserLocation?.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "") + "/api/sync";
  return url.toString();
}

export class OnebaseClient {
  private ws: WebSocket | null = null;
  private subs = new Map<string, Sub>();
  private subsById = new Map<number, Sub>();
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private retryMs = 100;
  private closed = false;
  private fetchToken: TokenFetcher | null = null;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private _state: ConnectionState = "connecting";
  private readonly url: string;
  private readonly WS: typeof WebSocket;

  constructor(address: string = browserLocation?.origin ?? "", opts: ClientOptions = {}) {
    this.url = syncUrl(address);
    this.WS = opts.webSocketConstructor ?? WebSocket;
    this.connect();
  }

  get connectionState(): ConnectionState {
    return this._state;
  }

  onConnectionChange(listener: (state: ConnectionState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: ConnectionState) {
    this._state = state;
    for (const l of this.stateListeners) l(state);
  }

  private connect() {
    if (this.closed) return;
    this.setState("connecting");
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = async () => {
      this.retryMs = 100;
      if (this.fetchToken) this.raw({ type: "auth", token: (await this.fetchToken()) ?? null });
      for (const sub of this.subs.values()) this.raw({ type: "sub", id: sub.id, path: sub.path, args: sub.args });
      for (const p of this.pending.values()) {
        if (!p.sent) {
          this.ws!.send(p.message);
          p.sent = true;
        }
      }
      this.setState("open");
    };
    ws.onmessage = (event) => this.handle(JSON.parse(String(event.data)));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // A call that was sent but not answered may or may not have run; don't silently retry it.
      for (const [requestId, p] of this.pending) {
        if (p.sent) {
          p.reject(new Error("Connection lost before the server replied; the call may or may not have run."));
          this.pending.delete(requestId);
        }
      }
      if (this.closed) return this.setState("closed");
      this.setState("connecting");
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 10_000);
    };
  }

  private raw(msg: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private handle(msg: any) {
    if (msg.type === "update") {
      const sub = this.subsById.get(msg.id);
      if (!sub) return;
      sub.last = msg.ok ? { ok: true, value: msg.value } : { ok: false, error: toError(msg) };
      for (const l of sub.listeners) l(sub.last);
    } else if (msg.type === "result") {
      const p = this.pending.get(msg.requestId);
      if (!p) return;
      this.pending.delete(msg.requestId);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(toError(msg));
    } else if (msg.type === "auth" && !msg.ok) {
      console.warn(`onebase auth failed: ${msg.error}`);
    }
  }

  /** Sets a token (or a function returning one) sent with every request; re-runs subscriptions as that user. */
  setAuth(token: string | TokenFetcher | null) {
    this.fetchToken = token === null ? null : typeof token === "function" ? token : () => token;
    void (async () => this.raw({ type: "auth", token: this.fetchToken ? ((await this.fetchToken()) ?? null) : null }))();
  }

  clearAuth() {
    this.setAuth(null);
  }

  /** Subscribes to a query; the callback runs with every new result. Returns an unsubscribe function. */
  onUpdate<Q extends FunctionReference<"query">>(
    query: Q | string,
    args: FunctionArgs<Q> | Record<string, unknown>,
    onResult: (value: FunctionReturnType<Q>) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const listener: Listener = (r) => (r.ok ? onResult(r.value as any) : onError ? onError(r.error) : console.error(r.error));
    return this.subscribe(query, args, listener);
  }

  /** Low-level subscription shared by identical (query, args) pairs. */
  subscribe(query: FunctionLike, args: unknown, listener: Listener): () => void {
    const path = getFunctionName(query);
    const key = `${path}|${stableStringify(args ?? {})}`;
    let sub = this.subs.get(key);
    if (!sub) {
      sub = { id: this.nextId++, path, args: args ?? {}, listeners: new Set(), last: null };
      this.subs.set(key, sub);
      this.subsById.set(sub.id, sub);
      this.raw({ type: "sub", id: sub.id, path, args: sub.args });
    }
    sub.listeners.add(listener);
    const s = sub;
    // Deliver a cached result asynchronously so callers can hold the unsubscribe function first.
    if (s.last) queueMicrotask(() => s.listeners.has(listener) && s.last && listener(s.last));
    return () => {
      s.listeners.delete(listener);
      if (s.listeners.size === 0) {
        this.subs.delete(key);
        this.subsById.delete(s.id);
        this.raw({ type: "unsub", id: s.id });
      }
    };
  }

  /** Latest known result for a subscribed query, if any. */
  localQueryResult(query: FunctionLike, args: unknown): QueryResult | null {
    return this.subs.get(`${getFunctionName(query)}|${stableStringify(args ?? {})}`)?.last ?? null;
  }

  private call(kind: "query" | "mutation" | "action", fn: FunctionLike, args: unknown): Promise<any> {
    const requestId = this.nextId++;
    const message = JSON.stringify({ type: "call", requestId, kind, path: getFunctionName(fn), args: args ?? {} });
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, message, sent: false };
      this.pending.set(requestId, p);
      if (this.ws?.readyState === 1) {
        this.ws.send(message);
        p.sent = true;
      }
    });
  }

  query<Q extends FunctionReference<"query">>(query: Q | string, ...args: OptionalRestArgs<Q>): Promise<FunctionReturnType<Q>> {
    return this.call("query", query, args[0]);
  }

  mutation<M extends FunctionReference<"mutation">>(mutation: M | string, ...args: OptionalRestArgs<M>): Promise<FunctionReturnType<M>> {
    return this.call("mutation", mutation, args[0]);
  }

  action<A extends FunctionReference<"action">>(action: A | string, ...args: OptionalRestArgs<A>): Promise<FunctionReturnType<A>> {
    return this.call("action", action, args[0]);
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/** Stateless client for scripts and server-side code: plain HTTP, no subscriptions. */
export class OnebaseHttpClient {
  private token: string | null = null;
  constructor(private readonly address: string) {}

  setAuth(token: string | null) {
    this.token = token;
  }

  private async call(kind: string, fn: FunctionLike, args: unknown) {
    const res = await fetch(`${this.address.replace(/\/$/, "")}/api/${kind}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ path: getFunctionName(fn), args: args ?? {} }),
    });
    const body = (await res.json()) as any;
    if (body.status === "success") return body.value;
    throw toError({ error: body.errorMessage, data: body.errorData });
  }

  query<Q extends FunctionReference<"query">>(query: Q | string, ...args: OptionalRestArgs<Q>): Promise<FunctionReturnType<Q>> {
    return this.call("query", query, args[0]);
  }
  mutation<M extends FunctionReference<"mutation">>(mutation: M | string, ...args: OptionalRestArgs<M>): Promise<FunctionReturnType<M>> {
    return this.call("mutation", mutation, args[0]);
  }
  action<A extends FunctionReference<"action">>(action: A | string, ...args: OptionalRestArgs<A>): Promise<FunctionReturnType<A>> {
    return this.call("action", action, args[0]);
  }
}

/** Aliases so code written for Convex ports by changing the import path. */
export { OnebaseClient as ConvexClient, OnebaseHttpClient as ConvexHttpClient };
