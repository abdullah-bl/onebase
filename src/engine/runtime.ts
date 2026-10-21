import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFunctionName, type FunctionLike, type FunctionType } from "../api";
import type { SchemaDefinition } from "../schema";
import { isRegisteredFunction, type CronJob, type HttpRouter, type RegisteredFunction, type UserIdentity } from "../server";
import { ConvexError, describeValue, isPlainObject, validate } from "../values";
import { CronRunner } from "./crons";
import { applySchema, DatabaseImpl, OnebaseError, readerView, writerView, type ReadSet, type Write } from "./database";
import { newId } from "./dialect";
import { savepoint, SerialQueue, type Driver, type Exec } from "./driver";
import { FileStore, LocalBlobs, type BlobBackend } from "./files";

export type Modules = Record<string, Record<string, unknown>>;
export type Authenticate = (token: string) => Promise<UserIdentity | null> | UserIdentity | null;
export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

export type RuntimeOptions = {
  driver: Driver;
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  /** Where file bytes go (default: a temporary local directory). */
  blobs?: BlobBackend;
  http?: HttpRouter | null;
  authenticate?: Authenticate | null;
  crons?: CronJob[];
  /** Public base URL used for file URLs, e.g. https://api.example.com. */
  siteUrl?: string;
  /** Dev mode: full error messages to clients and index warnings. */
  dev?: boolean;
  log?: Logger;
};

export type CallOptions = { identity?: UserIdentity | null; allowInternal?: boolean };

/** What changed in a commit: exact writes, or (when too large to broadcast) just the tables. */
export type CommitEvent = { writes: Write[]; tables?: undefined } | { tables: string[]; writes?: undefined };

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(`\x1b[33mwarn\x1b[0m ${m}`),
  error: (m) => console.error(`\x1b[31merror\x1b[0m ${m}`),
};

/** Errors whose message is safe and useful to show to callers. */
function isUserFacing(err: unknown): boolean {
  return err instanceof ConvexError || err instanceof OnebaseError;
}

export class FunctionError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type TxState = { tx: Exec; db: DatabaseImpl; writes: Write[]; scheduled: boolean; afterCommit: (() => Promise<void> | void)[] };

/** Commit broadcasts above this size only list the tables (Postgres NOTIFY caps payloads at 8000 bytes). */
const MAX_BROADCAST = 7000;

export class Runtime {
  readonly driver: Driver;
  readonly schema: SchemaDefinition<any> | null;
  readonly functions = new Map<string, RegisteredFunction>();
  readonly http: HttpRouter | null;
  readonly dev: boolean;
  readonly log: Logger;
  readonly files: FileStore;
  readonly instanceId = newId();
  siteUrl: string;
  private readonly authenticate: Authenticate | null;
  private readonly crons: CronJob[];
  private cronRunner: CronRunner | null = null;
  /** Mutations from this process run one at a time; other instances are handled by the driver. */
  private readonly mutations = new SerialQueue();
  private commitListeners: ((event: CommitEvent) => Promise<void>)[] = [];
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastCreationTime = 0;
  private readonly warnedQueries = new Set<string>();
  private stopped = false;

  constructor(opts: RuntimeOptions) {
    this.driver = opts.driver;
    this.schema = opts.schema;
    this.http = opts.http ?? null;
    this.authenticate = opts.authenticate ?? null;
    this.dev = opts.dev ?? false;
    this.log = opts.log ?? consoleLogger;
    this.files = new FileStore(opts.blobs ?? new LocalBlobs(mkdtempSync(join(tmpdir(), "onebase-files-"))), () => this.nextCreationTime());
    this.siteUrl = (opts.siteUrl ?? "http://localhost:8090").replace(/\/$/, "");
    this.crons = opts.crons ?? [];
    for (const [modulePath, exports] of Object.entries(opts.modules)) {
      for (const [exportName, value] of Object.entries(exports)) {
        if (isRegisteredFunction(value)) this.functions.set(`${modulePath}:${exportName}`, value);
      }
    }
  }

  /** Creates system tables and schema indexes, and starts listening to other instances. */
  async init(): Promise<{ created: string[]; dropped: string[] }> {
    await this.driver.init();
    const result = await this.driver.write((tx) => applySchema(tx, this.driver.dialect, this.schema));
    const row = await this.driver.read((tx) => tx.get("SELECT MAX(ct) AS ct FROM documents"));
    this.lastCreationTime = Math.max(this.lastCreationTime, Number(row?.ct ?? 0));
    if (this.driver.shared && this.driver.subscribe) {
      await this.driver.subscribe((message) => void this.onRemoteCommit(message));
    }
    return result;
  }

  /** Strictly increasing creation times keep ordering and cursors unambiguous. */
  nextCreationTime(): number {
    const now = Date.now();
    this.lastCreationTime = now > this.lastCreationTime ? now : this.lastCreationTime + 0.001;
    return this.lastCreationTime;
  }

  /** Runs `fn` in a write transaction, queued behind this process's mutations. */
  withWriter<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.mutations.run(() => this.driver.write(fn));
  }

  withReader<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.driver.read(fn);
  }

  onCommit(listener: (event: CommitEvent) => Promise<void>) {
    this.commitListeners.push(listener);
  }

  private async notifyCommit(event: CommitEvent) {
    await Promise.all(this.commitListeners.map((l) => l(event)));
  }

  private async onRemoteCommit(message: string) {
    let parsed: { o: string; w?: Write[]; t?: string[]; s?: boolean };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.o === this.instanceId) return;
    if (parsed.s) this.pokeScheduler();
    await this.notifyCommit(parsed.w ? { writes: parsed.w } : { tables: parsed.t ?? [] });
  }

  async identify(token: string | null | undefined): Promise<UserIdentity | null> {
    if (!token) return null;
    if (!this.authenticate) {
      throw new OnebaseError("A client sent an auth token but there's no auth.config.ts exporting authenticate(token).");
    }
    return (await this.authenticate(token)) ?? null;
  }

  // ---- Lookup & validation ----

  resolve(ref: FunctionLike, expected: FunctionType | null, allowInternal: boolean): { name: string; fn: RegisteredFunction } {
    const name = getFunctionName(ref);
    const fn = this.functions.get(name);
    if (!fn) {
      const [mod] = name.split(":");
      const sameModule = [...this.functions.keys()].filter((k) => k.startsWith(`${mod}:`));
      const hint = sameModule.length
        ? ` Functions in "${mod}": ${sameModule.join(", ")}.`
        : ` Known functions: ${[...this.functions.keys()].join(", ") || "(none)"}.`;
      throw new OnebaseError(`Function "${name}" not found.${hint}`);
    }
    if (expected && fn.type !== expected) {
      throw new OnebaseError(`"${name}" is a ${fn.type}, not a ${expected}. Call it with use${cap(fn.type)} / run${cap(fn.type)}.`);
    }
    if (fn.visibility === "internal" && !allowInternal) {
      throw new OnebaseError(`"${name}" is internal and can only be called from other functions (ctx.run*, scheduler).`);
    }
    return { name, fn };
  }

  private checkArgs(name: string, fn: RegisteredFunction, args: unknown): Record<string, unknown> {
    const value = args ?? {};
    if (!isPlainObject(value)) throw new OnebaseError(`Arguments to "${name}" must be an object, got ${describeValue(args)}.`);
    if (fn.args) {
      const errors = validate(fn.args, value, "args");
      if (errors.length) throw new OnebaseError(`Invalid arguments for "${name}":\n  - ${errors.join("\n  - ")}`);
    }
    return value;
  }

  private checkReturn(name: string, fn: RegisteredFunction, value: unknown): unknown {
    if (fn.returns) {
      const errors = validate(fn.returns, value === null ? null : value, "return value");
      if (errors.length) throw new OnebaseError(`"${name}" returned an invalid value:\n  - ${errors.join("\n  - ")}`);
    }
    return value === undefined ? null : value;
  }

  /** Converts any thrown error into what a client may see. */
  toClientError(err: unknown, name?: string): FunctionError {
    if (err instanceof ConvexError) return new FunctionError(err.message, err.data);
    const message = err instanceof Error ? err.message : String(err);
    if (isUserFacing(err) || this.dev) return new FunctionError(message);
    return new FunctionError(`Server Error${name ? ` in ${name}` : ""}`);
  }

  // ---- Contexts ----

  private auth(identity: UserIdentity | null) {
    return { getUserIdentity: async () => identity };
  }

  private warn = (message: string) => this.log.warn(message);

  private newDb(tx: Exec, extra: { readSet?: ReadSet; writes?: Write[] }) {
    return new DatabaseImpl({
      tx,
      dialect: this.driver.dialect,
      schema: this.schema,
      nextCreationTime: () => this.nextCreationTime(),
      onWarning: this.dev ? this.warn : undefined,
      explain: this.driver.explain?.bind(this.driver),
      warned: this.warnedQueries,
      ...extra,
    });
  }

  private schedulerFor(state: TxState | null) {
    const schedule = async (runAt: number, ref: FunctionLike, args: unknown) => {
      const { name } = this.resolve(ref, null, true);
      const id = newId();
      const insert = (tx: Exec) =>
        tx.run("INSERT INTO _scheduled (id, fn, args, run_at, state) VALUES (?, ?, ?, ?, 'pending')", [id, name, JSON.stringify(args ?? {}), runAt]);
      if (state) {
        await insert(state.tx);
        state.scheduled = true;
      } else {
        await this.withWriter(insert);
        this.pokeScheduler();
      }
      return id;
    };
    return {
      runAfter: (delayMs: number, ref: FunctionLike, args?: unknown) => schedule(Date.now() + Math.max(0, delayMs), ref, args),
      runAt: (ts: number | Date, ref: FunctionLike, args?: unknown) => schedule(ts instanceof Date ? ts.getTime() : ts, ref, args),
      cancel: async (id: string) => {
        const cancel = (tx: Exec) => tx.run("UPDATE _scheduled SET state = 'canceled' WHERE id = ? AND state = 'pending'", [id]);
        if (state) await cancel(state.tx);
        else await this.withWriter(cancel);
      },
    };
  }

  private fileUrl(id: string) {
    return `${this.siteUrl}/api/storage/${id}`;
  }

  private storageReader(tx: Exec) {
    return {
      getUrl: async (id: string) => ((await this.files.metadata(tx, id)) ? this.fileUrl(id) : null),
      getMetadata: (id: string) => this.files.metadata(tx, id),
    };
  }

  private storageWriter(state: TxState) {
    return {
      ...this.storageReader(state.tx),
      generateUploadUrl: async () => `${this.siteUrl}/api/storage/upload?token=${await this.files.createUploadToken(state.tx)}`,
      delete: async (id: string) => {
        await this.files.deleteMetadata(state.tx, id);
        state.afterCommit.push(() => this.files.backend.remove(id));
      },
    };
  }

  private storageForActions() {
    const read = <T>(fn: (tx: Exec) => Promise<T>) => this.withReader(fn);
    return {
      getUrl: async (id: string) => ((await read((tx) => this.files.metadata(tx, id))) ? this.fileUrl(id) : null),
      getMetadata: (id: string) => read((tx) => this.files.metadata(tx, id)),
      generateUploadUrl: async () => `${this.siteUrl}/api/storage/upload?token=${await this.withWriter((tx) => this.files.createUploadToken(tx))}`,
      delete: async (id: string) => {
        await this.withWriter((tx) => this.files.deleteMetadata(tx, id));
        await this.files.backend.remove(id);
      },
      /** Saves a Blob (e.g. from fetch) and returns its storage id. */
      store: async (blob: Blob) => {
        const meta = await this.files.write(blob.stream(), blob.type);
        await this.withWriter((tx) => this.files.insert(tx, meta));
        return meta._id;
      },
      /** Returns the file as a Blob, or null. */
      get: async (id: string) => ((await read((tx) => this.files.metadata(tx, id))) ? this.files.backend.get(id) : null),
    };
  }

  /** Handles POST /api/storage/upload?token=... */
  async upload(token: string | null, request: Request): Promise<string> {
    if (!token || !(await this.withWriter((tx) => this.files.consumeToken(tx, token)))) {
      throw new OnebaseError("Upload URL is invalid or expired. Get a fresh one from ctx.storage.generateUploadUrl() (each works once, for 1 hour).");
    }
    if (!request.body) throw new OnebaseError("Upload body is empty. POST the file as the request body.");
    const meta = await this.files.write(request.body, request.headers.get("Content-Type"));
    await this.withWriter((tx) => this.files.insert(tx, meta));
    return meta._id;
  }

  /** Handles GET /api/storage/<id>. */
  async serveFile(id: string, request: Request): Promise<Response | null> {
    if (!/^[0-9a-z]+$/.test(id)) return null;
    const meta = await this.withReader((tx) => this.files.metadata(tx, id));
    if (!meta) return null;
    if (request.headers.get("If-None-Match") === `"${meta.sha256}"`) return new Response(null, { status: 304 });
    return this.files.backend.serve(id, meta);
  }

  private queryCtx(db: DatabaseImpl, identity: UserIdentity | null) {
    return { db: readerView(db), auth: this.auth(identity), storage: this.storageReader(db.tx) };
  }

  private mutationCtx(state: TxState, identity: UserIdentity | null) {
    return {
      db: writerView(state.db),
      auth: this.auth(identity),
      storage: this.storageWriter(state),
      scheduler: this.schedulerFor(state),
      runQuery: (ref: FunctionLike, args?: unknown) => {
        const { name, fn } = this.resolve(ref, "query", true);
        return this.invoke(name, fn, this.queryCtx(state.db, identity), args);
      },
      runMutation: async (ref: FunctionLike, args?: unknown) => {
        const { name, fn } = this.resolve(ref, "mutation", true);
        // Nested mutations share the transaction; a savepoint rolls back just this call on error.
        const mark = state.writes.length;
        const commitMark = state.afterCommit.length;
        try {
          return await savepoint(state.tx, () => this.invoke(name, fn, this.mutationCtx(state, identity), args));
        } catch (err) {
          state.writes.length = mark;
          state.afterCommit.length = commitMark;
          throw err;
        }
      },
    };
  }

  actionCtx(identity: UserIdentity | null) {
    const ctx = {
      auth: this.auth(identity),
      storage: this.storageForActions(),
      scheduler: this.schedulerFor(null),
      runQuery: (ref: FunctionLike, args?: unknown) => this.runQuery(ref, args, { identity, allowInternal: true }).then((r) => r.value),
      runMutation: (ref: FunctionLike, args?: unknown) => this.runMutation(ref, args, { identity, allowInternal: true }),
      runAction: (ref: FunctionLike, args?: unknown) => this.runAction(ref, args, { identity, allowInternal: true }),
    };
    Object.defineProperty(ctx, "db", {
      get() {
        throw new OnebaseError(
          "ctx.db isn't available in actions. Read with ctx.runQuery(internal.x.y, args) and write with ctx.runMutation(...).",
        );
      },
    });
    return ctx;
  }

  private async invoke(name: string, fn: RegisteredFunction, ctx: unknown, args: unknown) {
    const checked = this.checkArgs(name, fn, args);
    const result = await fn.handler(ctx, checked);
    return this.checkReturn(name, fn, result);
  }

  // ---- Entry points ----

  /** Runs a query against a committed snapshot and reports what it read. */
  async runQuery(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<{ value: unknown; readSet: ReadSet }> {
    const { name, fn } = this.resolve(ref, "query", opts.allowInternal ?? false);
    return this.driver.read(async (tx) => {
      const readSet: ReadSet = { ids: new Set(), ranges: [] };
      const db = this.newDb(tx, { readSet });
      const value = await this.invoke(name, fn, this.queryCtx(db, opts.identity ?? null), args);
      return { value, readSet };
    });
  }

  async runMutation(
    ref: FunctionLike,
    args: unknown,
    opts: CallOptions & { inTransaction?: (tx: Exec) => Promise<unknown> } = {},
  ): Promise<unknown> {
    const { name, fn } = this.resolve(ref, "mutation", opts.allowInternal ?? false);
    const { value, writes, scheduled, afterCommit } = await this.mutations.run(() =>
      // The driver may run this more than once if another instance conflicts; each attempt starts fresh.
      this.driver.write(async (tx) => {
        const state: TxState = { tx, db: undefined as any, writes: [], scheduled: false, afterCommit: [] };
        state.db = this.newDb(tx, { writes: state.writes });
        const value = await this.invoke(name, fn, this.mutationCtx(state, opts.identity ?? null), args);
        await opts.inTransaction?.(tx);
        if (this.driver.shared && this.driver.publish && (state.writes.length || state.scheduled)) {
          await this.driver.publish(tx, this.broadcastMessage(state));
        }
        return { value, writes: state.writes, scheduled: state.scheduled, afterCommit: state.afterCommit };
      }),
    );
    for (const fn of afterCommit) await fn();
    if (scheduled) this.pokeScheduler();
    if (writes.length) await this.notifyCommit({ writes });
    return value;
  }

  private broadcastMessage(state: TxState): string {
    const full = JSON.stringify({ o: this.instanceId, w: state.writes, s: state.scheduled || undefined });
    if (full.length <= MAX_BROADCAST) return full;
    return JSON.stringify({ o: this.instanceId, t: [...new Set(state.writes.map((w) => w.table))], s: state.scheduled || undefined });
  }

  async runAction(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    const { name, fn } = this.resolve(ref, "action", opts.allowInternal ?? false);
    return this.invoke(name, fn, this.actionCtx(opts.identity ?? null), args);
  }

  /** Runs any function by name, whatever its type. */
  async call(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    const { fn } = this.resolve(ref, null, opts.allowInternal ?? false);
    if (fn.type === "query") return (await this.runQuery(ref, args, opts)).value;
    if (fn.type === "mutation") return this.runMutation(ref, args, opts);
    return this.runAction(ref, args, opts);
  }

  // ---- Scheduler ----

  async startScheduler() {
    await this.withWriter((tx) => tx.run("DELETE FROM _scheduled WHERE state <> 'pending' AND run_at < ?", [Date.now() - 7 * 86400_000]));
    this.pokeScheduler();
    // With a shared database, pick up jobs left by instances that went away.
    if (this.driver.shared) this.heartbeat = setInterval(() => this.pokeScheduler(), 30_000);
    if (this.crons.length) {
      this.cronRunner = new CronRunner(this, this.crons);
      await this.cronRunner.start().catch((err) => this.log.error(`Crons: ${err instanceof Error ? err.message : String(err)}`));
    }
  }

  pokeScheduler() {
    if (this.stopped) return;
    void this.withReader((tx) => tx.get("SELECT MIN(run_at) AS at FROM _scheduled WHERE state = 'pending'"))
      .then((next) => {
        if (this.stopped) return;
        if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
        this.schedulerTimer = null;
        if (next?.at === null || next?.at === undefined) return;
        const delay = Math.min(Math.max(0, Number(next.at) - Date.now()), 2 ** 31 - 1);
        this.schedulerTimer = setTimeout(() => void this.runDueJobs(), delay);
      })
      .catch((err) => this.log.error(`Scheduler: ${err instanceof Error ? err.message : String(err)}`));
  }

  private async runDueJobs() {
    // Claim each job with a conditional update so that no two runs (or instances) take the same one.
    const due = await this.withWriter(async (tx) => {
      const jobs = (await tx.all(
        "SELECT id, fn, args FROM _scheduled WHERE state = 'pending' AND run_at <= ? ORDER BY run_at LIMIT 20",
        [Date.now()],
      )) as { id: string; fn: string; args: string }[];
      const claimed = [];
      for (const job of jobs) {
        const { changes } = await tx.run("UPDATE _scheduled SET state = 'running' WHERE id = ? AND state = 'pending'", [job.id]);
        if (changes === 1) claimed.push(job);
      }
      return claimed;
    }).catch((err) => {
      this.log.error(`Scheduler: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    });
    await Promise.all(due.map((job) => this.runJob(job)));
    this.pokeScheduler();
  }

  private async runJob(job: { id: string; fn: string; args: string }) {
    const setState = (tx: Exec, state: string, error: string | null = null) =>
      tx.run("UPDATE _scheduled SET state = ?, error = ? WHERE id = ?", [state, error, job.id]);
    const args = JSON.parse(job.args);
    try {
      const fn = this.functions.get(job.fn);
      if (fn?.type === "mutation") {
        // Exactly once: the job is marked done in the mutation's own transaction.
        await this.runMutation(job.fn, args, { allowInternal: true, inTransaction: (tx) => setState(tx, "done") });
      } else {
        await this.call(job.fn, args, { allowInternal: true });
        await this.withWriter((tx) => setState(tx, "done"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`Scheduled ${job.fn} failed: ${message}`);
      await this.withWriter((tx) => setState(tx, "failed", message)).catch(() => {});
    }
  }

  stop() {
    this.stopped = true;
    this.cronRunner?.stop();
    if (this.schedulerTimer) clearTimeout(this.schedulerTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
  }
}

function cap(s: string) {
  return s[0]!.toUpperCase() + s.slice(1);
}
