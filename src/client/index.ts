// Browser / Bun client (imported as "onebase/browser").
// One WebSocket carries live query subscriptions, mutations and actions.

import {
  getFunctionName,
  type ArgsAndOptions,
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
/** Also told when a result goes back to loading (an optimistic update can do that). */
type Watcher = (result: QueryResult | null) => void;
type Sub = {
  id: number;
  path: string;
  args: unknown;
  listeners: Set<Watcher>;
  /** What the server last sent. */
  server: QueryResult | null;
  /** What callers see: the server result with pending optimistic updates applied. */
  last: QueryResult | null;
};

/** The client's local query results, as an optimistic update sees and changes them. */
export interface OptimisticLocalStore {
  /** The current result of a subscribed query, or undefined if it isn't subscribed or is loading. */
  getQuery<Q extends FunctionReference<"query">>(query: Q | string, ...args: OptionalRestArgs<Q>): FunctionReturnType<Q> | undefined;
  /** Every subscribed instance of a query (one per set of args). */
  getAllQueries<Q extends FunctionReference<"query">>(query: Q | string): { args: FunctionArgs<Q>; value: FunctionReturnType<Q> | undefined }[];
  /** Replaces a subscribed query's result until the mutation finishes; undefined shows it as loading. */
  setQuery<Q extends FunctionReference<"query">>(query: Q | string, args: FunctionArgs<Q>, value: FunctionReturnType<Q> | undefined): void;
}

/**
 * Runs as soon as the mutation is called, and again whenever new results arrive while it's in
 * flight. Treat results as immutable: build new arrays and objects instead of changing them.
 */
export type OptimisticUpdate<Args> = (localStore: OptimisticLocalStore, args: Args) => void;

export type MutationOptions<Args> = { optimisticUpdate?: OptimisticUpdate<Args> };

type Layer = { update: OptimisticUpdate<any>; args: unknown };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; message: string; sent: boolean; layer?: Layer };
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

const subKey = (path: string, args: unknown) => `${path}|${stableStringify(args ?? {})}`;

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
  /** Optimistic updates of mutations in flight, oldest first. */
  private layers: Layer[] = [];
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
      const lost: Pending[] = [];
      for (const [requestId, p] of this.pending) {
        if (p.sent) {
          lost.push(p);
          this.pending.delete(requestId);
        }
      }
      if (lost.some((p) => p.layer)) {
        this.layers = this.layers.filter((l) => !lost.some((p) => p.layer === l));
        this.applyLayers();
      }
      for (const p of lost) p.reject(new Error("Connection lost before the server replied; the call may or may not have run."));
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
    if (msg.type === "update") this.apply([msg], []);
    else if (msg.type === "result") this.apply([], [msg]);
    else if (msg.type === "transition") this.apply(msg.updates, msg.results);
    else if (msg.type === "auth" && !msg.ok) console.warn(`onebase auth failed: ${msg.error}`);
  }

  /**
   * Applies query updates and call results in one step. The server sends a mutation's result
   * together with the updates that reflect it, so its optimistic update is dropped exactly when
   * the real data arrives.
   */
  private apply(updates: any[], results: any[]) {
    const settled: [Pending, any][] = [];
    for (const r of results) {
      const p = this.pending.get(r.requestId);
      if (!p) continue;
      this.pending.delete(r.requestId);
      settled.push([p, r]);
    }
    const finished = settled.map(([p]) => p.layer).filter((l): l is Layer => Boolean(l));
    if (finished.length) this.layers = this.layers.filter((l) => !finished.includes(l));
    const changed = new Set<Sub>();
    for (const u of updates) {
      const sub = this.subsById.get(u.id);
      if (!sub) continue;
      sub.server = u.ok ? { ok: true, value: u.value } : { ok: false, error: toError(u) };
      changed.add(sub);
    }
    if (this.layers.length || finished.length) {
      this.applyLayers();
    } else {
      for (const sub of changed) {
        sub.last = sub.server;
        for (const l of sub.listeners) l(sub.last);
      }
    }
    for (const [p, r] of settled) {
      if (r.ok) p.resolve(r.value);
      else p.reject(toError(r));
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

  /** Recomputes what callers see: server results with every pending optimistic update applied, in order. */
  private applyLayers() {
    const overrides = new Map<Sub, QueryResult | null>();
    const current = (sub: Sub | undefined) => (sub ? (overrides.has(sub) ? overrides.get(sub)! : sub.server) : null);
    const find = (query: FunctionLike, args: unknown) => this.subs.get(subKey(getFunctionName(query), args));
    const store: OptimisticLocalStore = {
      getQuery: (query: FunctionLike, ...args: unknown[]) => {
        const r = current(find(query, args[0]));
        return r?.ok ? (r.value as any) : undefined;
      },
      getAllQueries: (query: FunctionLike) => {
        const path = getFunctionName(query);
        return [...this.subs.values()]
          .filter((s) => s.path === path)
          .map((s) => {
            const r = current(s);
            return { args: s.args as any, value: r?.ok ? (r.value as any) : undefined };
          });
      },
      setQuery: (query: FunctionLike, args: unknown, value: unknown) => {
        const sub = find(query, args);
        if (sub) overrides.set(sub, value === undefined ? null : { ok: true, value });
      },
    };
    for (const layer of this.layers) {
      try {
        layer.update(store, layer.args);
      } catch (err) {
        console.error("onebase: an optimistic update threw; ignoring it.", err);
      }
    }
    for (const sub of this.subs.values()) {
      const next = current(sub);
      if (next === sub.last) continue;
      // An optimistic value the server has confirmed: keep the object, skip the re-render.
      if (next?.ok && sub.last?.ok && stableStringify(next.value) === stableStringify(sub.last.value)) continue;
      sub.last = next;
      for (const l of sub.listeners) l(next);
    }
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
    return this.watch(query, args, (r) => r && listener(r));
  }

  /** Like subscribe(), but also called with null when an optimistic update shows the query as loading. */
  watch(query: FunctionLike, args: unknown, listener: Watcher): () => void {
    const path = getFunctionName(query);
    const key = subKey(path, args);
    let sub = this.subs.get(key);
    if (!sub) {
      sub = { id: this.nextId++, path, args: args ?? {}, listeners: new Set(), server: null, last: null };
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
    return this.subs.get(subKey(getFunctionName(query), args))?.last ?? null;
  }

  private call(kind: "query" | "mutation" | "action", fn: FunctionLike, args: unknown, layer?: Layer): Promise<any> {
    const requestId = this.nextId++;
    const message = JSON.stringify({ type: "call", requestId, kind, path: getFunctionName(fn), args: args ?? {} });
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, message, sent: false, layer };
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

  /** Runs a mutation. With `optimisticUpdate`, subscribed queries show its expected effect until it finishes. */
  mutation<M extends FunctionReference<"mutation">>(
    mutation: M | string,
    ...argsAndOptions: ArgsAndOptions<M, MutationOptions<FunctionArgs<M>>>
  ): Promise<FunctionReturnType<M>> {
    const [args, options] = argsAndOptions;
    if (!options?.optimisticUpdate) return this.call("mutation", mutation, args);
    const layer: Layer = { update: options.optimisticUpdate, args: args ?? {} };
    this.layers.push(layer);
    this.applyLayers();
    return this.call("mutation", mutation, args, layer);
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
