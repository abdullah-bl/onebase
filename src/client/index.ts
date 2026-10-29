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
  /** Subscription key (path + args), also the offline cache key. */
  key: string;
  path: string;
  args: unknown;
  /** Sent on the current connection. */
  sent: boolean;
  listeners: Set<Watcher>;
  /** What the server last sent. */
  server: QueryResult | null;
  /** What callers see: the server result with pending optimistic updates applied. */
  last: QueryResult | null;
  /** Offline cache for this query, held until the server confirms who is asking. */
  pendingHydration?: { value: unknown; subject: string | null };
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
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  message: string;
  sent: boolean;
  layer?: Layer;
  /** Present while this call is persisted as a queued mutation (offline). */
  outbox?: object;
  /** True when restored from a previous session's outbox: no caller is waiting for it. */
  restored?: boolean;
};
type TokenFetcher = () => Promise<string | null | undefined> | string | null | undefined;
/** `subject` is who made the call; absent while unknown (made before the server confirmed who is asking). */
type OutboxEntry = { path: string; args: unknown; subject?: string | null; ref?: object };

export type ClientOptions = {
  /** Provide for environments without a global WebSocket. */
  webSocketConstructor?: typeof WebSocket;
  /**
   * Where built-in auth keeps the session token: localStorage in browsers by default. Pass null
   * to keep it in memory only, or any object with getItem / setItem / removeItem.
   */
  authStorage?: AuthStorage | null;
  /**
   * Offline support (default off): the newest query results are cached and served stale while
   * disconnected (and after a reload), and mutations made while disconnected are queued and sent
   * in order once the connection returns. Set to true for localStorage, or pass options.
   */
  offline?: boolean | OfflineOptions;
};

/** Tunes offline support; `offline: true` uses the defaults. */
export type OfflineOptions = {
  /** Where the query cache and queued mutations persist (localStorage in browsers by default). */
  storage?: AuthStorage | null;
  /** How many of the newest query results to keep (default 100). */
  maxCachedQueries?: number;
};

export type AuthStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export type AuthState = {
  /** True until the server has confirmed (or rejected) the current token. */
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Why the last sign-in failed, e.g. when an OAuth provider sends the browser back with an error. */
  error: string | null;
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

function httpUrl(address: string): string {
  const url = new URL(address, browserLocation?.href);
  return url.origin + url.pathname.replace(/\/$/, "");
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (text: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));

function defaultStorage(): AuthStorage | null {
  try {
    return (globalThis as { localStorage?: AuthStorage }).localStorage ?? null;
  } catch {
    return null; // e.g. blocked by the browser
  }
}

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
  /**
   * False while connecting or fetching a token. Calls and new subscriptions wait meanwhile, so
   * nothing reaches the server ahead of the auth message and runs as a signed-out user.
   */
  private ready = false;
  /** The current connection has an auth token set on the server. */
  private authSent = false;
  private authRun = 0;
  /** Built-in auth: the session token, and the fetcher setAuth() gets while it's in use. */
  private sessionToken: string | null = null;
  private readonly sessionFetcher: TokenFetcher = () => this.sessionToken;
  private readonly httpUrl: string;
  private readonly storage: AuthStorage | null;
  private readonly storageKey: string;
  private _authState: AuthState = { isLoading: false, isAuthenticated: false, error: null };
  private authListeners = new Set<(state: AuthState) => void>();
  /** Auth messages sent but not yet answered; only the answer to the latest one counts. */
  private authAcks = 0;
  /** An OAuth redirect's code is being exchanged for a session. */
  private exchanging = false;
  /** Offline support, when enabled: the persisted query cache and the queued mutations. */
  private readonly offline: { storage: AuthStorage; maxCached: number } | null = null;
  private readonly cacheKey: string;
  private readonly outboxKey: string;
  private cache = new Map<string, { value: unknown; at: number }>();
  private cacheSubject: string | null | undefined = undefined;
  private authSubject: string | null | undefined = undefined;
  /** The server has answered the current connection's auth message: queued mutations may be sent. */
  private authConfirmed = false;
  private outbox: OutboxEntry[] = [];
  private cacheTimer: ReturnType<typeof setTimeout> | null = null;
  private stateListeners = new Set<(s: ConnectionState) => void>();
  private _state: ConnectionState = "connecting";
  private readonly url: string;
  private readonly WS: typeof WebSocket;

  constructor(address: string = browserLocation?.origin ?? "", opts: ClientOptions = {}) {
    this.url = syncUrl(address);
    this.httpUrl = httpUrl(address);
    this.WS = opts.webSocketConstructor ?? WebSocket;
    this.storage = opts.authStorage !== undefined ? opts.authStorage : defaultStorage();
    this.storageKey = `onebase:auth:${this.httpUrl}`;
    if (opts.offline) {
      const o = opts.offline === true ? {} : opts.offline;
      const storage = o.storage !== undefined ? o.storage : defaultStorage();
      if (storage) this.offline = { storage, maxCached: o.maxCachedQueries ?? 100 };
    }
    this.cacheKey = `onebase:cache:${this.httpUrl}`;
    this.outboxKey = `onebase:outbox:${this.httpUrl}`;
    this.loadOfflineState();
    const saved = this.readStorage(this.storageKey);
    if (saved) {
      this.sessionToken = saved;
      this.fetchToken = this.sessionFetcher;
      this._authState = { isLoading: true, isAuthenticated: false, error: null };
    }
    void this.completeRedirect();
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
    ws.onopen = () => {
      this.retryMs = 100;
      this.authSent = false;
      for (const sub of this.subs.values()) sub.sent = false;
      void this.authenticate();
    };
    ws.onmessage = (event) => this.handle(JSON.parse(String(event.data)));
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      this.authConfirmed = false;
      // A call that was sent but not answered may or may not have run; don't silently retry it.
      const lost: Pending[] = [];
      for (const [requestId, p] of this.pending) {
        if (p.sent) {
          if (p.outbox) this.outboxDone(p.outbox); // sent but never answered: not resent, like any other call
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

  /**
   * Sends the current token, then the subscriptions and calls that were waiting for it. Runs on
   * every (re)connect and on setAuth(); if setAuth() is called again meanwhile, the newer run wins.
   */
  private async authenticate() {
    const run = ++this.authRun;
    this.ready = false;
    this.authConfirmed = false;
    let token: string | null = null;
    if (this.fetchToken) {
      try {
        token = (await this.fetchToken()) ?? null;
      } catch (err) {
        console.warn("onebase: fetching the auth token failed; continuing signed out.", err);
      }
    }
    if (run !== this.authRun || this.ws?.readyState !== 1) return;
    // Offline support always sends it: the answer says who is asking, which decides whose cached
    // results may be shown and whose queued mutations may be sent.
    if (token !== null || this.authSent || this.offline) {
      this.authAcks++;
      this.raw({ type: "auth", token });
    }
    this.authSent = token !== null;
    // Signed out right away; a new token is "loading" until the server confirms it (unless
    // already signed in, e.g. a refreshed token on reconnect, so the UI doesn't flash).
    if (token === null) this.updateAuth({ isLoading: this.exchanging, isAuthenticated: false });
    else if (!this._authState.isAuthenticated) this.updateAuth({ isLoading: true });
    for (const sub of this.subs.values()) {
      if (!sub.sent) {
        this.raw({ type: "sub", id: sub.id, path: sub.path, args: sub.args });
        sub.sent = true;
      }
    }
    for (const p of this.pending.values()) {
      if (!p.sent && !p.outbox) {
        this.ws.send(p.message);
        p.sent = true;
      }
    }
    this.ready = true;
    if (this._state !== "open") this.setState("open");
  }

  private handle(msg: any) {
    if (msg.type === "update") this.apply([msg], []);
    else if (msg.type === "result") this.apply([], [msg]);
    else if (msg.type === "transition") this.apply(msg.updates, msg.results);
    else if (msg.type === "auth") this.onAuthAnswer(msg);
  }

  private onAuthAnswer(msg: { ok: boolean; ended?: boolean; identity?: unknown; error?: string }) {
    if (this.authAcks > 0) this.authAcks--;
    if (this.authAcks > 0) return; // a newer token is on the way
    if (msg.ok) {
      const subject = ((msg.identity as { subject?: string } | null)?.subject as string | null) ?? null;
      this.authAnswered(subject);
      this.releaseHydrations(subject);
      this.releaseOutbox(subject);
      return this.updateAuth({ isLoading: !this.fetchToken && this.exchanging, isAuthenticated: Boolean(msg.identity), error: null });
    }
    this.dropHydrations();
    if (this.fetchToken === this.sessionFetcher && !msg.ended) {
      // The server couldn't check the session (say, its database was busy): keep it and try again.
      console.warn(`onebase auth failed: ${msg.error}`);
      setTimeout(() => {
        if (this.fetchToken === this.sessionFetcher) void this.authenticate();
      }, 1000);
      return this.updateAuth({ isLoading: true, isAuthenticated: false });
    }
    // Rejected, or signed out from elsewhere. A built-in session that ended is forgotten.
    if (this.fetchToken === this.sessionFetcher) {
      this.forgetSession();
      this.fetchToken = null;
      this.authSent = false;
    } else {
      console.warn(`onebase auth failed: ${msg.error}`);
    }
    this.updateAuth({ isLoading: false, isAuthenticated: false });
  }

  // ---- Built-in auth ----

  /** Signed in or not, and whether that's still being checked. */
  get authState(): AuthState {
    return this._authState;
  }

  onAuthChange(listener: (state: AuthState) => void): () => void {
    this.authListeners.add(listener);
    return () => this.authListeners.delete(listener);
  }

  private updateAuth(change: Partial<AuthState>) {
    const next = { ...this._authState, ...change };
    const prev = this._authState;
    if (next.isLoading === prev.isLoading && next.isAuthenticated === prev.isAuthenticated && next.error === prev.error) return;
    this._authState = next;
    for (const l of this.authListeners) l(next);
  }

  /**
   * Signs in with a built-in method. Resolves `{ signingIn: true }` once signed in, or
   * `{ signingIn: false }` when the next step happens elsewhere (an emailed code, an OAuth page).
   * - Password: `signIn("password", { flow: "signUp" | "signIn", email, password })`.
   * - Codes: `flow: "reset"` with `email`, then `"reset-verification"` with `email, code, newPassword`;
   *   `"email-verification"` with `email, code, password` (the one signed up with) after signing up with verifyEmail.
   * - OAuth: `signIn("github")` sends the browser to the provider and back to this page
   *   (or `redirectTo`); the client then finishes signing in on its own.
   */
  async signIn(provider: string, params: Record<string, unknown> = {}): Promise<{ signingIn: boolean; redirect?: string }> {
    const { redirectTo, ...rest } = params;
    const verifier = randomString();
    // OAuth binds the sign-in to this browser with a verifier; WebCrypto needs a secure context.
    const challenge = globalThis.crypto?.subtle ? await sha256(verifier) : undefined;
    const res = await this.authRequest("signin", { provider, params: rest, redirectTo: redirectTo ?? browserLocation?.href, challenge });
    if (res.redirect) {
      this.writeStorage(`${this.storageKey}:verifier`, verifier);
      (globalThis as { location?: { assign(url: string): void } }).location?.assign(res.redirect);
      return { signingIn: false, redirect: res.redirect };
    }
    if (!res.token) return { signingIn: false }; // a code was emailed
    this.useSession(res.token);
    return { signingIn: true };
  }

  /** Ends the built-in session on the server and signs this client out. */
  async signOut(): Promise<void> {
    const token = this.sessionToken;
    this.forgetSession();
    this.setAuth(null);
    this.updateAuth({ isLoading: false, isAuthenticated: false, error: null });
    if (token) await this.authRequest("signout", {}, token).catch(() => {});
  }

  private useSession(token: string) {
    this.sessionToken = token;
    this.writeStorage(this.storageKey, token);
    if (!this._authState.isAuthenticated) this.updateAuth({ isLoading: true, error: null });
    this.setAuth(this.sessionFetcher);
  }

  private forgetSession() {
    this.sessionToken = null;
    this.removeStorage(this.storageKey);
  }

  /** Finishes an OAuth sign-in when the provider sends the browser back with ?onebase_code=… */
  private async completeRedirect() {
    if (!browserLocation) return;
    const url = new URL(browserLocation.href);
    const code = url.searchParams.get("onebase_code");
    const error = url.searchParams.get("auth_error");
    if (!code && !error) return;
    url.searchParams.delete("onebase_code");
    url.searchParams.delete("auth_error");
    (globalThis as { history?: { replaceState(data: unknown, unused: string, url: string): void } }).history?.replaceState(null, "", url.toString());
    if (!code) return this.updateAuth({ error });
    this.exchanging = true;
    this.updateAuth({ isLoading: true, error: null });
    try {
      const verifier = this.readStorage(`${this.storageKey}:verifier`);
      this.removeStorage(`${this.storageKey}:verifier`);
      this.useSession((await this.authRequest("signin", { code, verifier })).token);
    } catch (err) {
      this.updateAuth({ isLoading: false, isAuthenticated: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      this.exchanging = false;
    }
  }

  private async authRequest(path: string, body: unknown, token?: string): Promise<any> {
    const res = await fetch(`${this.httpUrl}/api/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; errorMessage?: string };
    if (!res.ok) throw new Error(data.error ?? data.errorMessage ?? `Sign-in failed (HTTP ${res.status}).`);
    return data;
  }

  private readStorage(key: string): string | null {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  private writeStorage(key: string, value: string) {
    try {
      this.storage?.setItem(key, value);
    } catch {}
  }

  private removeStorage(key: string) {
    try {
      this.storage?.removeItem(key);
    } catch {}
  }

  // ---- Offline: cached query results and queued mutations ----

  /** Restores the cache and queued mutations written by an earlier session, if any. */
  private loadOfflineState() {
    if (!this.offline) return;
    try {
      const saved = JSON.parse(this.offline.storage.getItem(this.cacheKey) ?? "{}") as {
        subject?: string | null;
        entries?: Record<string, { value: unknown; at: number }>;
      };
      this.cacheSubject = saved.subject ?? null;
      this.cache = new Map(Object.entries(saved.entries ?? {}));
    } catch {}
    try {
      const queued = JSON.parse(this.offline.storage.getItem(this.outboxKey) ?? "[]") as OutboxEntry[];
      for (const entry of queued) {
        // Nobody is waiting for these (the caller's page is gone): results are reported, not returned.
        entry.ref = {};
        const requestId = this.nextId++;
        this.pending.set(requestId, {
          resolve: () => {},
          reject: (e) => console.warn(`onebase: a queued ${entry.path} mutation failed: ${e.message}`),
          message: JSON.stringify({ type: "call", requestId, kind: "mutation", path: entry.path, args: entry.args ?? {} }),
          sent: false,
          outbox: entry.ref,
          restored: true,
        });
        this.outbox.push(entry);
      }
    } catch {}
  }

  /** The newest results are cached (debounced) so a later session can show them while offline. */
  private cacheResult(key: string, value: unknown) {
    if (!this.offline) return;
    this.cache.set(key, { value, at: Date.now() });
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => {
      this.cacheTimer = null;
      this.flushCache();
    }, 300);
  }

  /** Writes the cache to storage, keeping only the newest results. */
  private flushCache() {
    if (!this.offline) return;
    const newest = [...this.cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, this.offline.maxCached);
    this.cache = new Map(newest);
    this.writeOfflineStorage(this.cacheKey, {
      subject: this.authSubject ?? this.cacheSubject ?? null,
      entries: Object.fromEntries(newest.map(([k, v]) => [k, v])),
    });
  }

  /** The cache belongs to whoever is signed in; a different user starts empty. */
  private authAnswered(subject: string | null) {
    this.authSubject = subject;
    this.authConfirmed = true;
    if (!this.offline) return;
    if (this.cacheSubject === undefined) this.cacheSubject = subject;
    else if (this.cacheSubject !== subject) {
      this.cache.clear();
      this.cacheSubject = subject;
      this.writeOfflineStorage(this.cacheKey, { subject, entries: {} });
    }
  }

  /** Cached results held for the auth answer: shown if it's the same user, dropped otherwise. */
  private releaseHydrations(subject: string | null) {
    for (const sub of this.subs.values()) {
      const held = sub.pendingHydration;
      if (!held) continue;
      sub.pendingHydration = undefined;
      if (held.subject !== subject) continue;
      sub.server = { ok: true, value: held.value };
      sub.last = sub.server;
      for (const l of sub.listeners) l(sub.last!);
    }
  }

  /**
   * The server confirmed who is asking: queued mutations made by that user (or by nobody known
   * yet) are sent in order; ones made by someone else are dropped, never sent as this user.
   */
  private releaseOutbox(subject: string | null) {
    if (!this.offline) return;
    let changed = false;
    for (const [requestId, p] of [...this.pending]) {
      const entry = p.outbox ? this.outbox.find((e) => e.ref === p.outbox) : undefined;
      if (!entry || p.sent) continue;
      if (entry.subject === undefined) {
        entry.subject = subject;
        changed = true;
      } else if (entry.subject !== subject) {
        this.pending.delete(requestId);
        this.outbox.splice(this.outbox.indexOf(entry), 1);
        changed = true;
        const error = new Error("Dropped: queued by a different user than the one now signed in.");
        if (p.restored) console.warn(`onebase: a queued ${entry.path} mutation was dropped: ${error.message}`);
        else p.reject(error);
        continue;
      }
      if (this.ws?.readyState === 1) {
        this.ws.send(p.message);
        p.sent = true;
      }
    }
    if (changed) this.writeOfflineStorage(this.outboxKey, this.outbox);
  }

  private dropHydrations() {
    for (const sub of this.subs.values()) sub.pendingHydration = undefined;
  }

  /** Mutations still queued (made while disconnected, not yet answered by the server). */
  get queuedMutations(): number {
    return this.outbox.length;
  }

  /** Drops every queued mutation, rejecting the promises returned when they were made. */
  clearQueuedMutations() {
    for (const entry of this.outbox) {
      for (const [requestId, p] of this.pending) {
        if (p.outbox !== entry.ref) continue;
        this.pending.delete(requestId);
        if (!p.restored) p.reject(new Error("Dropped: cleared while queued."));
      }
    }
    this.outbox = [];
    this.writeOfflineStorage(this.outboxKey, this.outbox);
  }

  /** A queued mutation is settled (answered, or lost with the connection): forget it. */
  private outboxDone(ref: object, error?: Error) {
    const at = this.outbox.findIndex((e) => e.ref === ref);
    if (at < 0) return;
    this.outbox.splice(at, 1);
    this.writeOfflineStorage(this.outboxKey, this.outbox);
    if (error) console.warn(`onebase: a queued mutation was lost with the connection; it may or may not have run.`);
  }

  private writeOfflineStorage(key: string, value: unknown) {
    if (!this.offline) return;
    try {
      this.offline.storage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn("onebase: writing offline state failed; continuing without it.", err);
    }
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
      if (u.ok) this.cacheResult(sub.key, u.value);
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
      if (p.outbox) this.outboxDone(p.outbox);
      if (r.ok) p.resolve(r.value);
      else p.reject(toError(r));
    }
  }

  /** Sets a token (or a function returning one) sent with every request; re-runs subscriptions as that user. */
  setAuth(token: string | TokenFetcher | null) {
    this.fetchToken = token === null ? null : typeof token === "function" ? token : () => token;
    this.authSubject = undefined; // unknown until the server answers for this token
    // Not connected yet: the next connection authenticates first anyway.
    if (this.ws?.readyState === 1) void this.authenticate();
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
      sub = { id: this.nextId++, key, path, args: args ?? {}, sent: false, listeners: new Set(), server: null, last: null };
      this.subs.set(key, sub);
      this.subsById.set(sub.id, sub);
      // Offline: the newest cached result shows immediately, then the server's answer replaces it.
      // With a token configured it's held back until the server confirms the same user is asking.
      const cached = this.cache.get(key);
      if (cached) {
        // A cache that belongs to a user is never shown to anyone else, signed out included.
        if (this.fetchToken || this.cacheSubject != null) sub.pendingHydration = { value: cached.value, subject: this.cacheSubject ?? null };
        else {
          sub.server = { ok: true, value: cached.value };
          sub.last = sub.server;
        }
      }
      if (this.ready) {
        this.raw({ type: "sub", id: sub.id, path, args: sub.args });
        sub.sent = true;
      }
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
        if (s.sent) this.raw({ type: "unsub", id: s.id });
      }
    };
  }

  /** Latest known result for a subscribed query, if any. */
  localQueryResult(query: FunctionLike, args: unknown): QueryResult | null {
    return this.subs.get(subKey(getFunctionName(query), args))?.last ?? null;
  }

  private call(kind: "query" | "mutation" | "action", fn: FunctionLike, args: unknown, layer?: Layer): Promise<any> {
    const requestId = this.nextId++;
    const path = getFunctionName(fn);
    const message = JSON.stringify({ type: "call", requestId, kind, path, args: args ?? {} });
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject, message, sent: false, layer };
      // Offline: mutations persist until the server answers, so a disconnect (or a reload while
      // disconnected) doesn't lose them. They're sent in the order they were made.
      if (kind === "mutation" && this.offline) {
        const entry: OutboxEntry = { path, args: args ?? {}, subject: this.authSubject, ref: {} };
        p.outbox = entry.ref;
        this.outbox.push(entry);
        this.writeOfflineStorage(this.outboxKey, this.outbox);
      }
      this.pending.set(requestId, p);
      if (this.ready && this.ws?.readyState === 1 && (!p.outbox || this.authConfirmed)) {
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
    if (this.cacheTimer) {
      clearTimeout(this.cacheTimer);
      this.cacheTimer = null;
    }
    this.flushCache();
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
