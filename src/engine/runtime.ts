import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { functionPathSymbol, getFunctionName, isFunctionHandle, type FunctionLike, type FunctionType } from "../api";
import type { ComponentDefinition, ComponentRoute, ComponentsDefinition, MountOptions } from "../components";
import { parseCron } from "../cron";
import type { SchemaDefinition } from "../schema";
import { isRegisteredFunction, type CronJob, type HttpAction, type HttpRouter, type RegisteredFunction, type UserIdentity } from "../server";
import { ConvexError, describeValue, isPlainObject, validate, type AnyValidator } from "../values";
import { buildCatalog, storedTable, TableScope, tableMount, validatesTable, type Catalog } from "./catalog";
import { CronRunner } from "./crons";
import { BACKFILL_BATCH, backfilled, coalesce, hookState, readProgress, writeProgress, type HookProgress, type ResolvedHook } from "./hooks";
import { applySchema, DatabaseImpl, OnebaseError, readerView, writerView, type ReadSet, type VectorSearchQuery, type Write } from "./database";
import { isIdForTable, newId } from "./dialect";
import { savepoint, SerialQueue, type Driver, type Exec } from "./driver";
import { FileStore, LocalBlobs, type BlobBackend } from "./files";
import { CallLog, type CallSource } from "./calllog";
import { currentFunction, installGuards } from "./guard";
import { AuthService, SESSION_PREFIX } from "./auth";
import { createAuthenticate, type AuthConfig, type AuthenticateCtx } from "./jwt";
import {
  activeDeployment,
  activeDeploymentId,
  getDeployment,
  previousDeployment,
  releaseModules,
  saveDeployment,
  setActiveDeployment,
  toDeployment,
  type Deployment,
  type StoredDeployment,
} from "./deployments";

export type Modules = Record<string, Record<string, unknown>>;
export type Authenticate = (token: string, ctx: AuthenticateCtx) => Promise<UserIdentity | null> | UserIdentity | null;
export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void };

/** A project's code: everything `onebase deploy` replaces in a running server. */
export type ProjectCode = {
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  http: HttpRouter | null;
  auth: AuthConfig | null;
  crons: CronJob[];
  /** components.ts's default export. */
  components: ComponentsDefinition | null;
};

export type DeployResult = {
  id: string;
  created: number;
  functions: number;
  indexes: { created: string[]; dropped: string[] };
  /** Static files in the deployment (0: the server keeps serving its own --public). */
  files: number;
  warnings: string[];
  dryRun: boolean;
};

/** A component mounted in components.ts, as the runtime runs it. */
export type MountRuntime = {
  name: string;
  definition: ComponentDefinition<any, any, any>;
  config: unknown;
  options: MountOptions;
  scope: TableScope;
  /** The component's function objects → their names in this mount ("components/limiter:limit"). */
  names: Map<RegisteredFunction, string>;
  /** App tables this mount follows. */
  hooks: ResolvedHook[];
  /** HTTP routes, served under `httpPrefix` (null: not served). */
  routes: ComponentRoute[];
  httpPrefix: string | null;
};

/** Who is calling: the app (null), a component, or the system (scheduler, crons, dashboard), which may call anything. */
type Caller = MountRuntime | null | "system";

const SYSTEM_SOURCES = new Set<CallSource>(["scheduler", "cron", "dashboard"]);

/** Code checked and ready to install. */
type PreparedCode = {
  code: ProjectCode;
  functions: Map<string, RegisteredFunction>;
  /** Component functions: which mount each belongs to, and whether it's internal to the component. */
  componentFunctions: Map<string, { mount: MountRuntime; internal: boolean }>;
  mounts: Map<string, MountRuntime>;
  catalog: Catalog | null;
  /** crons.ts's jobs and every mount's. */
  crons: CronJob[];
  auth: AuthService | null;
  authenticate: Authenticate | null;
};

export type RuntimeOptions = {
  driver: Driver;
  schema: SchemaDefinition<any> | null;
  modules: Modules;
  /** Where file bytes go (default: a temporary local directory). */
  blobs?: BlobBackend;
  http?: HttpRouter | null;
  /** auth.config.ts: built-in sign-in methods, external JWT providers and/or authenticate(). */
  auth?: AuthConfig | null;
  /** A token verifier to use instead of the one built from `auth`. */
  authenticate?: Authenticate | null;
  crons?: CronJob[];
  /** components.ts's default export. */
  components?: ComponentsDefinition | null;
  /** Public base URL used for file URLs, e.g. https://api.example.com. */
  siteUrl?: string;
  /** Dev mode: full error messages to clients and index warnings. */
  dev?: boolean;
  log?: Logger;
  /**
   * Imports the source of a bundle pushed with `onebase deploy`. Without it the runtime ignores
   * deployments and refuses new ones; dev mode always does.
   */
  loadCode?: ((source: string, id: string) => Promise<ProjectCode>) | null;
  /** A bundle that takes longer than this to load is refused (default 30s). */
  loadTimeoutMs?: number;
  /** How long a query, mutation or action may run (default: DEFAULT_TIME_LIMITS). */
  timeLimits?: Partial<TimeLimits>;
};

/** How long one call may run, in ms; 0 means no limit. */
export type TimeLimits = { queryMs: number; mutationMs: number; actionMs: number };
export const DEFAULT_TIME_LIMITS: TimeLimits = { queryMs: 10_000, mutationMs: 10_000, actionMs: 10 * 60_000 };

/**
 * A call's time limit. A function can't be stopped mid-await, so once the limit passes the call
 * is answered with an error, and whatever the function still tries afterwards fails here instead
 * of reaching the database (by then, another call's transaction).
 */
class Deadline {
  expired: OnebaseError | null = null;

  check() {
    if (this.expired) throw this.expired;
  }

  /** `fn`, refused once the deadline has passed. */
  guard<A extends unknown[], R>(fn: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
    return async (...args) => {
      this.check();
      return fn(...args);
    };
  }

  /** `tx`, refused once the deadline has passed. */
  exec(tx: Exec): Exec {
    return { all: this.guard(tx.all.bind(tx)), get: this.guard(tx.get.bind(tx)), run: this.guard(tx.run.bind(tx)) };
  }
}

export function formatMs(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}m` : ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

export type CallOptions = {
  identity?: UserIdentity | null;
  allowInternal?: boolean;
  /** The component making the call (null: the app); by default the system for the scheduler, crons and dashboard. */
  caller?: Caller;
  /** Where the call came from, for the dashboard's call log (default: "function"). */
  source?: CallSource;
};

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

type TxState = {
  tx: Exec;
  db: DatabaseImpl;
  writes: Write[];
  scheduled: boolean;
  afterCommit: (() => Promise<void> | void)[];
  /** Auth sessions ended in this transaction; connections using them are signed out after commit. */
  revoked: string[];
  /** Per table hook: how many of `writes` it has been given. */
  hookCursors: Map<string, number>;
};

/** Scheduled jobs one instance runs at the same time. */
const MAX_RUNNING_JOBS = 20;
/** Commit broadcasts above this size only list the tables (Postgres NOTIFY caps payloads at 8000 bytes). */
const MAX_BROADCAST = 7000;
/** Ended sessions per broadcast message; more go in extra messages, so the cap above holds. */
const REVOKED_PER_MESSAGE = 100;

export class Runtime {
  readonly driver: Driver;
  // The project's code. A deploy replaces it; calls already running finish with the old code.
  schema: SchemaDefinition<any> | null = null;
  /** The app's tables and every mounted component's. */
  catalog: Catalog | null = null;
  readonly functions = new Map<string, RegisteredFunction>();
  readonly mounts = new Map<string, MountRuntime>();
  private readonly componentFunctions = new Map<string, { mount: MountRuntime; internal: boolean }>();
  http: HttpRouter | null = null;
  /** Built-in sign-in, when auth.config.ts lists methods. */
  auth: AuthService | null = null;
  private authenticate: Authenticate | null = null;
  private crons: CronJob[] = [];
  /** The `onebase deploy` push being run, if any. */
  deployment: Deployment | null = null;
  readonly dev: boolean;
  readonly log: Logger;
  readonly files: FileStore;
  readonly instanceId = newId();
  readonly calls = new CallLog();
  readonly startedAt = Date.now();
  /** Live counts reported by the HTTP layer, for the dashboard. */
  readonly stats = { connections: 0, subscriptions: () => 0 };
  siteUrl: string;
  private readonly customAuthenticate: Authenticate | null;
  private readonly loadCode: RuntimeOptions["loadCode"];
  private readonly loadTimeoutMs: number;
  readonly timeLimits: TimeLimits;
  private revokeListeners: ((sessionIds: string[]) => void)[] = [];
  private deployListeners: (() => Promise<void> | void)[] = [];
  private cronRunner: CronRunner | null = null;
  private schedulerStarted = false;
  /** Mutations from this process run one at a time; other instances are handled by the driver. */
  private readonly mutations = new SerialQueue();
  /** Deploys and rollbacks, one at a time, so the code running is always the one recorded. */
  private readonly deploys = new SerialQueue();
  private commitListeners: ((event: CommitEvent) => Promise<void>)[] = [];
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private runningJobs = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastCreationTime = 0;
  private readonly warnedQueries = new Set<string>();
  /** Signs function handles; loaded from the database by init(). */
  private handleKey: Buffer | null = null;
  private stopped = false;

  constructor(opts: RuntimeOptions) {
    installGuards();
    this.driver = opts.driver;
    this.customAuthenticate = opts.authenticate ?? null;
    this.dev = opts.dev ?? false;
    this.log = opts.log ?? consoleLogger;
    this.loadCode = this.dev ? null : opts.loadCode;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? 30_000;
    this.timeLimits = { ...DEFAULT_TIME_LIMITS };
    for (const [key, ms] of Object.entries(opts.timeLimits ?? {}) as [keyof TimeLimits, number | undefined][]) {
      if (ms === undefined) continue; // unset: keep the default
      if (!(ms >= 0)) throw new Error(`timeLimits.${key} must be a number of ms (0 for no limit), got ${ms}.`);
      this.timeLimits[key] = ms;
    }
    this.files = new FileStore(opts.blobs ?? new LocalBlobs(mkdtempSync(join(tmpdir(), "onebase-files-"))), () => this.nextCreationTime());
    this.siteUrl = (opts.siteUrl ?? "http://localhost:8090").replace(/\/$/, "");
    const code = {
      schema: opts.schema,
      modules: opts.modules,
      http: opts.http ?? null,
      auth: opts.auth ?? null,
      crons: opts.crons ?? [],
      components: opts.components ?? null,
    };
    this.setCode(this.prepare(code), null);
  }

  /**
   * Creates system tables and schema indexes, checks existing data, and starts listening to other
   * instances. A deployment pushed with `onebase deploy` replaces the code given to the constructor.
   */
  async init(): Promise<{ created: string[]; dropped: string[] }> {
    await this.driver.init();
    this.handleKey = await this.loadHandleKey();
    let applied: { result: { created: string[]; dropped: string[] }; warnings: string[] } | null = null;
    while (!applied) {
      const stored = this.loadCode ? await this.driver.read((tx) => activeDeployment(tx)) : null;
      if (stored) {
        try {
          this.setCode(await this.load(stored), toDeployment(stored));
          releaseModules(stored.id); // anything left from an earlier deployment is replaced
        } catch (err) {
          throw new OnebaseError(
            `Couldn't load deployment ${stored.id} (pushed ${new Date(stored.created).toISOString()}): ${err instanceof Error ? err.message : String(err)}\n` +
              `Fix what it needs (often an environment variable) and restart, or start with --no-deploy to run the local code instead.`,
          );
        }
      }
      this.auth?.check();
      // Null when another instance deployed in the meantime: start again with its code.
      applied = await this.applyStartupSchema(stored?.id ?? null);
    }
    for (const w of applied.warnings) this.log.warn(w);
    const row = await this.driver.read((tx) => tx.get("SELECT MAX(ct) AS ct FROM documents"));
    this.lastCreationTime = Math.max(this.lastCreationTime, Number(row?.ct ?? 0));
    if (this.driver.shared && this.driver.subscribe) {
      await this.driver.subscribe((message) => void this.onRemoteCommit(message));
      // A deploy that committed before we were listening was never announced to us.
      await this.syncDeployment();
    }
    this.startBackfills();
    return applied.result;
  }

  /** The key function handles are signed with: one per database, so handles work on every instance and after restarts. */
  private async loadHandleKey(): Promise<Buffer> {
    const value = await this.driver.write(async (tx) => {
      // Keeps the stored key if there is one (another instance may have just written it).
      await tx.run(`INSERT INTO _meta ("key", value) VALUES ('handles', ?) ON CONFLICT("key") DO UPDATE SET value = _meta.value`, [
        randomBytes(32).toString("base64"),
      ]);
      return (await tx.get(`SELECT value FROM _meta WHERE "key" = 'handles'`))!.value as string;
    });
    return Buffer.from(value, "base64");
  }

  /** Startup's index update and document check, unless the active deployment is no longer `expected`. */
  private async applyStartupSchema(expected: string | null) {
    const applied = await this.driver.write(async (tx) => {
      // Applying this schema after another instance deployed would drop that deployment's indexes.
      if (this.loadCode && (await activeDeploymentId(tx)) !== expected) return null;
      const result = await applySchema(tx, this.driver.dialect, this.catalog);
      return { result, warnings: await this.checkDocuments(tx, this.catalog) };
    });
    if (applied?.result.created.length) await this.driver.optimize?.(); // new indexes need statistics too
    return applied;
  }

  /**
   * When schema.ts (or a component's schema) changes, every stored document is checked against
   * it, like a Convex deploy. The schema's fingerprint is saved once the data matches (unless
   * `record` is false, for a dry run), so unchanged schemas cost nothing. Returns warnings about
   * data the schema ignores.
   */
  private async checkDocuments(tx: Exec, catalog: Catalog | null, record = true): Promise<string[]> {
    if (!catalog) {
      if (record) await tx.run("DELETE FROM _meta WHERE \"key\" = 'schema'");
      return [];
    }
    // With schemaValidation off only component tables are checked; turning it back on changes
    // the fingerprint, so everything is checked again then.
    const tables = Object.entries(catalog.tables).filter(([t]) => validatesTable(catalog, t)) as [string, { validator: AnyValidator }][];
    const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify(tables.map(([t, d]) => [t, d.validator]))).digest("hex");
    const stored = await tx.get("SELECT value FROM _meta WHERE \"key\" = 'schema'");
    if (stored?.value === fingerprint) return [];

    const d = this.driver.dialect;
    const examples: string[] = [];
    let invalid = 0;
    for (const [table, def] of tables) {
      let after: [number, string] = [-1, ""];
      for (;;) {
        const rows = await tx.all(
          `SELECT id, ct, doc FROM documents WHERE tbl = ? AND (ct, id) > (${d.placeholder("ct")}, ${d.placeholder("id")}) ORDER BY ct, id LIMIT 500`,
          [table, ...after],
        );
        for (const row of rows) {
          const errors = validate(def.validator, d.parseDoc(row.doc), "document");
          if (!errors.length) continue;
          invalid++;
          if (examples.length < 5) examples.push(`${table} ${row.id}: ${errors.slice(0, 3).join("; ")}`);
        }
        if (rows.length < 500) break;
        after = [Number(rows[rows.length - 1]!.ct), rows[rows.length - 1]!.id];
      }
    }
    if (invalid) {
      throw new OnebaseError(
        `schema.ts doesn't match ${invalid} existing document${invalid === 1 ? "" : "s"}:\n  - ${examples.join("\n  - ")}` +
          (invalid > examples.length ? `\n  - … and ${invalid - examples.length} more` : "") +
          `\nMake the schema accept the data (v.optional(...), v.union(...)), or fix the data: start with ` +
          `defineSchema({ ... }, { schemaValidation: false }), update the documents in a mutation (or the dashboard), then turn validation back on.`,
      );
    }
    const known = new Set(Object.keys(catalog.tables));
    const orphans = (await tx.all("SELECT DISTINCT tbl FROM documents"))
      .map((r) => r.tbl as string)
      .filter((t) => !known.has(t) && !(catalog.open && tableMount(t) === null));
    if (record) {
      await tx.run("INSERT INTO _meta (\"key\", value) VALUES ('schema', ?) ON CONFLICT(\"key\") DO UPDATE SET value = excluded.value", [fingerprint]);
    }
    const unmounted = new Map<string, string[]>();
    for (const t of orphans) {
      const mount = tableMount(t);
      if (mount) unmounted.set(mount, [...(unmounted.get(mount) ?? []), t]);
    }
    return [
      ...orphans
        .filter((t) => tableMount(t) === null)
        .map((t) => `Table "${t}" has documents but isn't in schema.ts, so functions can't read them. Add it back to keep using them.`),
      ...[...unmounted].map(
        ([mount, ts]) =>
          `Component "${mount}" isn't mounted in components.ts anymore, but its tables (${ts.join(", ")}) keep their documents. ` +
          `Mount it again under the same name to use them, or delete them from the dashboard.`,
      ),
    ];
  }

  // ---- Code & deploys ----

  /** Collects a project's functions and components and builds its sign-in, without installing anything yet. */
  private prepare(code: ProjectCode): PreparedCode {
    const functions = new Map<string, RegisteredFunction>();
    const mounts = new Map<string, MountRuntime>();
    const componentFunctions: PreparedCode["componentFunctions"] = new Map();
    for (const [modulePath, exports] of Object.entries(code.modules)) {
      if (code.components && (modulePath === "components" || modulePath.startsWith("components/"))) {
        throw new OnebaseError(`${modulePath}: functions can't live in a components/ folder; that name is reserved for the components mounted in components.ts.`);
      }
      for (const [exportName, value] of Object.entries(exports)) {
        if (isRegisteredFunction(value)) functions.set(`${modulePath}:${exportName}`, value);
      }
    }
    for (const [name, m] of Object.entries(code.components?.mounts ?? {})) {
      const mount: MountRuntime = {
        name,
        definition: m.definition,
        config: m.config,
        options: m.options ?? {},
        scope: TableScope.component(name),
        names: new Map(),
        hooks: [],
        routes: m.definition.http?.(m.config) ?? [],
        httpPrefix: m.options?.httpPrefix === false ? null : (m.options?.httpPrefix ?? `/${name}`),
      };
      const exposed = new Set((m.options?.expose ?? []).map(String));
      const walk = (tree: Record<string, unknown>, path: string[]) => {
        for (const [key, value] of Object.entries(tree)) {
          if (!isRegisteredFunction(value)) {
            walk(value as Record<string, unknown>, [...path, key]);
            continue;
          }
          const fullName = `components/${[name, ...path].join("/")}:${key}`;
          // Clients reach only what the app exposed; everything else goes through the app's functions.
          functions.set(fullName, { ...value, visibility: exposed.has([...path, key].join(".")) ? "public" : "internal" });
          componentFunctions.set(fullName, { mount, internal: value.visibility === "internal" });
          mount.names.set(value, fullName);
        }
      };
      walk(m.definition.functions, []);
      mount.hooks = this.resolveHooks(mount, code.schema, functions);
      if (mount.httpPrefix && /^\/(api|_admin|_onebase)(\/|$)/.test(mount.httpPrefix)) {
        throw new OnebaseError(`Component "${name}": httpPrefix "${mount.httpPrefix}" is taken by onebase itself; pick another.`);
      }
      mounts.set(name, mount);
    }
    const crons = [...code.crons, ...[...mounts.values()].flatMap((mount) => this.componentCrons(mount))];
    const catalog = buildCatalog(code.schema, [...mounts.values()].map((m) => ({ mount: m.name, schema: m.definition.schema })));
    return {
      code,
      functions,
      componentFunctions,
      mounts,
      catalog,
      crons,
      auth: code.auth?.methods?.length ? new AuthService(this, code.auth) : null,
      authenticate: this.customAuthenticate ?? (code.auth ? createAuthenticate(code.auth) : null),
    };
  }

  /** A mount's cron jobs, named "components/<mount>/<name>" so they can't clash with the app's. */
  private componentCrons(mount: MountRuntime): CronJob[] {
    const where = `Component "${mount.name}" (${mount.definition.name})`;
    return (mount.definition.crons?.(mount.config) ?? []).map((cron) => {
      if (typeof cron?.name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(cron.name)) throw new OnebaseError(`${where}: cron jobs need a name (letters, digits, _ . -).`);
      const fn = mount.names.get(cron.fn);
      if (!fn) throw new OnebaseError(`${where}: cron "${cron.name}" must run one of the component's own functions.`);
      let schedule: CronJob["schedule"];
      if (typeof cron.schedule === "string") {
        parseCron(cron.schedule);
        schedule = { type: "cron", expression: cron.schedule };
      } else {
        const ms = ((cron.schedule?.hours ?? 0) * 3600 + (cron.schedule?.minutes ?? 0) * 60 + (cron.schedule?.seconds ?? 0)) * 1000;
        if (!(ms >= 1000)) throw new OnebaseError(`${where}: cron "${cron.name}" needs an interval of at least 1 second, e.g. { minutes: 5 }.`);
        schedule = { type: "interval", ms };
      }
      return { name: `components/${mount.name}/${cron.name}`, schedule, fn, args: cron.args ?? {} };
    });
  }

  /**
   * The handler for an HTTP request: an http.ts route first, then a component's route under its
   * prefix (so the app can always override one).
   */
  lookupHttp(method: string, pathname: string): { handler: HttpAction; mount: MountRuntime | null } | null {
    const own = this.http?.lookup(method, pathname);
    if (own) return { handler: own, mount: null };
    for (const mount of this.mounts.values()) {
      const prefix = mount.httpPrefix;
      if (!prefix || !mount.routes.length || (pathname !== prefix && !pathname.startsWith(prefix + "/"))) continue;
      const rest = pathname.slice(prefix.length) || "/";
      const exact = mount.routes.find((r) => r.method === method && r.path === rest);
      const prefixed = mount.routes
        .filter((r) => r.method === method && r.pathPrefix && rest.startsWith(r.pathPrefix))
        .sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
      const route = exact ?? prefixed;
      if (route) return { handler: route.handler, mount };
    }
    return null;
  }

  /** A mount's table hooks, checked: they follow app tables and run the component's own functions. */
  private resolveHooks(mount: MountRuntime, schema: SchemaDefinition<any> | null, functions: Map<string, RegisteredFunction>): ResolvedHook[] {
    const where = `Component "${mount.name}" (${mount.definition.name})`;
    const own = (fn: RegisteredFunction | undefined, what: string) => {
      const name = fn && mount.names.get(fn);
      if (!name || fn!.type !== "mutation") throw new OnebaseError(`${where}: a table hook's ${what} must be one of its own mutations, listed in its functions.`);
      return { name, fn: functions.get(name)! };
    };
    const hooks: ResolvedHook[] = [];
    for (const hook of mount.definition.hooks?.(mount.config) ?? []) {
      if (typeof hook?.table !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(hook.table)) {
        throw new OnebaseError(`${where}: a table hook needs the name of an app table.`);
      }
      if (schema && !(hook.table in schema.tables)) {
        throw new OnebaseError(`${where} follows table "${hook.table}", which isn't in schema.ts. Known tables: ${Object.keys(schema.tables).join(", ") || "(none)"}.`);
      }
      if (hooks.some((h) => h.table === hook.table)) throw new OnebaseError(`${where} has two hooks on "${hook.table}".`);
      hooks.push({
        mount: mount.name,
        table: hook.table,
        key: `hook:${mount.name}:${hook.table}`,
        onChange: own(hook.onChange, "onChange"),
        reset: hook.reset ? own(hook.reset, "reset") : null,
        fingerprint: hook.fingerprint ?? "",
      });
    }
    return hooks;
  }

  private setCode(prepared: PreparedCode, deployment: Deployment | null) {
    this.schema = prepared.code.schema;
    this.catalog = prepared.catalog;
    this.mounts.clear();
    for (const [name, mount] of prepared.mounts) this.mounts.set(name, mount);
    this.componentFunctions.clear();
    for (const [name, info] of prepared.componentFunctions) this.componentFunctions.set(name, info);
    this.http = prepared.code.http;
    this.auth = prepared.auth;
    this.authenticate = prepared.authenticate;
    this.crons = prepared.crons;
    this.functions.clear();
    for (const [name, fn] of prepared.functions) this.functions.set(name, fn);
    this.deployment = deployment;
  }

  /** Swaps in new code, restarts crons, and lets the HTTP layer re-run live queries. */
  private async install(prepared: PreparedCode, deployment: Deployment) {
    this.setCode(prepared, deployment);
    // The replaced deployment's module is dropped from the module cache, so its memory can be
    // freed once the calls already running with it finish.
    releaseModules(deployment.id);
    if (this.schedulerStarted) {
      this.cronRunner?.stop();
      this.cronRunner = null;
      await this.startCrons();
      this.pokeScheduler();
    }
    this.startBackfills();
    await Promise.all(this.deployListeners.map((l) => l()));
  }

  /** Calls `listener` after a deploy or rollback has replaced the code (here or on another instance). */
  onDeploy(listener: () => Promise<void> | void): () => void {
    this.deployListeners.push(listener);
    return () => {
      this.deployListeners = this.deployListeners.filter((l) => l !== listener);
    };
  }

  private codeLoader() {
    if (this.loadCode) return this.loadCode;
    throw new OnebaseError(
      this.dev
        ? "This server runs in dev mode, which runs ./onebase from disk. Deploy to a server started with onebase serve."
        : "Deploys are turned off on this server (--no-deploy or ONEBASE_DEPLOY=off).",
    );
  }

  /**
   * Loads a stored deployment's code, refusing one that doesn't finish loading in time: a bundle
   * whose top level never settles (an awaited promise that never resolves) would otherwise block
   * this queue — and every later deploy — forever.
   */
  private loadStored(stored: StoredDeployment): Promise<ProjectCode> {
    const loader = this.codeLoader();
    return new Promise<ProjectCode>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new OnebaseError(
              `The deployed code didn't finish loading within ${Math.max(1, Math.round(this.loadTimeoutMs / 1000))}s. ` +
                `A module whose top level never settles (an import or awaited promise that never resolves) does this.`,
            ),
          ),
        this.loadTimeoutMs,
      );
      loader(stored.code, stored.id).then(
        (code) => {
          clearTimeout(timer);
          resolve(code);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** The checks startup would do, so a deploy that can't start is refused while the old code keeps running. */
  private async load(stored: StoredDeployment): Promise<PreparedCode> {
    let code: ProjectCode;
    try {
      code = await this.loadStored(stored);
    } catch (err) {
      if (err instanceof OnebaseError) throw err;
      throw new OnebaseError(`The deployed code failed to load: ${err instanceof Error ? err.message : String(err)}`);
    }
    const prepared = this.prepare(code);
    prepared.auth?.check(code.schema);
    for (const job of code.crons) {
      if (!prepared.functions.has(getFunctionName(job.fn))) throw new OnebaseError(`crons.ts: "${job.name}" runs ${job.fn}, which doesn't exist.`);
    }
    return prepared;
  }

  /**
   * Replaces the running code with a bundle from `onebase deploy`, without a restart. Like a
   * Convex push, the new schema is checked against every document first, in the same transaction
   * that updates indexes, and nothing changes if anything fails. Live queries re-run on the new code.
   *
   * A dry run only checks: it ships the schema as data (with the function count) and never runs
   * the pushed code, so checking a bundle is safe even when its top level has side effects.
   */
  async deploy(input: { code: string; assets?: Record<string, string> | null; dryRun?: boolean; schema?: unknown; functions?: unknown }): Promise<DeployResult> {
    if (typeof input.code !== "string" || !input.code) throw new OnebaseError("A deploy needs the bundle's code.");
    if (input.assets && Object.values(input.assets).some((v) => typeof v !== "string")) {
      throw new OnebaseError('assets must map paths to base64 strings: { "/index.html": "PCFkb2N0eXBl..." }.');
    }
    if (input.dryRun && (typeof input.schema !== "string" || typeof input.functions !== "number" || input.functions < 0)) {
      throw new OnebaseError(
        "A dry run needs the schema (as JSON) and the function count alongside the bundle, so the code is never run just to check it. Update the onebase CLI and try again.",
      );
    }
    const stored: StoredDeployment = {
      id: newId(),
      created: Date.now(),
      code: input.code,
      assets: input.assets && Object.keys(input.assets).length ? JSON.stringify(input.assets) : null,
    };
    return this.deploys.run(() =>
      this.activate(stored, { save: true, dryRun: input.dryRun === true, schema: input.schema as string | null, functions: Number(input.functions) }),
    );
  }

  /** Goes back to the deployment pushed before the current one. */
  async rollback(): Promise<DeployResult> {
    this.codeLoader();
    return this.deploys.run(async () => {
      const { current, previous } = await this.driver.read(async (tx) => {
        const current = await activeDeployment(tx);
        return { current, previous: current ? await previousDeployment(tx, current) : null };
      });
      if (!current) throw new OnebaseError("Nothing to roll back: this server isn't running a deployment.");
      if (!previous) throw new OnebaseError(`Nothing to roll back to: no deployment that was live before ${current.id} is kept.`);
      return this.activate(previous, { save: false, dryRun: false, schema: null, functions: 0 });
    });
  }

  /** The tables a dry run ships as JSON (app and components), checked against the data without running the bundle. */
  private dryRunSchema(input: string | null): Catalog | null {
    if (input === null || input === "") return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      throw new OnebaseError("A dry run's schema must be JSON (as the onebase CLI sends it).");
    }
    const tables = (parsed as { tables?: unknown })?.tables;
    if (!parsed || typeof parsed !== "object" || !tables || typeof tables !== "object") {
      throw new OnebaseError("A dry run's schema must be { schemaValidation, tables: { name: { validator } } }.");
    }
    return { schemaValidation: true, open: false, ...(parsed as object), __isOnebaseSchema: true } as Catalog;
  }

  private async activate(
    stored: StoredDeployment,
    opts: { save: boolean; dryRun: boolean; schema: string | null; functions: number },
  ): Promise<DeployResult> {
    const prepared = opts.dryRun ? null : await this.load(stored);
    const schema = opts.dryRun ? this.dryRunSchema(opts.schema) : prepared!.catalog;
    const apply = async (tx: Exec) => {
      const warnings = await this.checkDocuments(tx, schema, !opts.dryRun);
      if (opts.dryRun) return { indexes: { created: [], dropped: [] }, warnings };
      const indexes = await applySchema(tx, this.driver.dialect, schema);
      if (opts.save) await saveDeployment(tx, stored);
      await setActiveDeployment(tx, stored.id, opts.save ? "deploy" : "rollback");
      if (this.driver.shared && this.driver.publish) await this.driver.publish(tx, JSON.stringify({ o: this.instanceId, d: stored.id }));
      return { indexes, warnings };
    };
    // Queued with this process's mutations, so none of them runs between the check and the swap.
    const { indexes, warnings } = opts.dryRun ? await this.driver.read(apply) : await this.withWriter(apply);
    const deployment = toDeployment(stored);
    if (!opts.dryRun) {
      await this.install(prepared!, deployment);
      this.log.info(`Deployment ${stored.id} is live: ${prepared!.functions.size} function(s).`);
    }
    if (!opts.dryRun && indexes.created.length) await this.driver.optimize?.();
    for (const w of warnings) this.log.warn(w);
    return {
      id: stored.id,
      created: stored.created,
      functions: opts.dryRun ? opts.functions : prepared!.functions.size,
      indexes,
      files: deployment.assets?.size ?? 0,
      warnings,
      dryRun: opts.dryRun,
    };
  }

  /** Another instance pushed a deployment: it already checked and stored it, so just run it. */
  private async onRemoteDeploy(id: string) {
    if (!this.loadCode) {
      this.log.warn(`Another instance deployed ${id}, but this one has deploys turned off and keeps its own code.`);
      return;
    }
    await this.syncDeployment();
  }

  /**
   * Runs the deployment the database says is active, if it isn't already running here. Not the
   * one a broadcast named: two instances deploying at once must both end up on the one that won.
   */
  private async syncDeployment() {
    if (!this.loadCode) return;
    let id: string | null = null;
    try {
      await this.deploys.run(async () => {
        id = await this.driver.read((tx) => activeDeploymentId(tx));
        if (!id || id === this.deployment?.id) return;
        const stored = await this.driver.read((tx) => getDeployment(tx, id!));
        if (!stored) return;
        await this.install(await this.load(stored), toDeployment(stored));
        this.log.info(`Deployment ${id} is live (pushed to another instance).`);
      });
    } catch (err) {
      this.log.error(`Couldn't load deployment ${id} from another instance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Strictly increasing creation times keep ordering and cursors unambiguous. */
  nextCreationTime(): number {
    const now = Date.now();
    this.lastCreationTime = now > this.lastCreationTime ? now : this.lastCreationTime + 0.001;
    return this.lastCreationTime;
  }

  /** Runs `fn` in a write transaction, queued behind this process's mutations. */
  withWriter<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    // A pipelined driver keeps the order itself, and lets queued writes share a commit.
    if (this.driver.pipelined) return this.driver.write(fn);
    return this.mutations.run(() => this.driver.write(fn));
  }

  withReader<T>(fn: (tx: Exec) => Promise<T>): Promise<T> {
    return this.driver.read(fn);
  }

  /** Calls `listener` after every commit (local or from another instance); returns an unsubscribe function. */
  onCommit(listener: (event: CommitEvent) => Promise<void>): () => void {
    this.commitListeners.push(listener);
    return () => {
      this.commitListeners = this.commitListeners.filter((l) => l !== listener);
    };
  }

  get cronJobs(): readonly CronJob[] {
    return this.crons;
  }

  private async notifyCommit(event: CommitEvent) {
    await Promise.all(this.commitListeners.map((l) => l(event)));
  }

  private async onRemoteCommit(message: string) {
    let parsed: { o: string; w?: Write[]; t?: string[]; s?: boolean; r?: string[]; d?: string };
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.o === this.instanceId) return;
    if (parsed.d) return this.onRemoteDeploy(parsed.d);
    if (parsed.s) this.pokeScheduler();
    if (parsed.r?.length) this.notifyRevoked(parsed.r);
    if (parsed.w || parsed.t) await this.notifyCommit(parsed.w ? { writes: parsed.w } : { tables: parsed.t ?? [] });
  }

  /** Calls `listener` with the ids of auth sessions that end (sign-out here or on another instance). */
  onSessionsRevoked(listener: (sessionIds: string[]) => void): () => void {
    this.revokeListeners.push(listener);
    return () => {
      this.revokeListeners = this.revokeListeners.filter((l) => l !== listener);
    };
  }

  private notifyRevoked(sessionIds: string[]) {
    for (const l of this.revokeListeners) l(sessionIds);
  }

  async identify(token: string | null | undefined): Promise<UserIdentity | null> {
    if (!token) return null;
    if (this.auth && token.startsWith(SESSION_PREFIX)) return this.auth.identifySession(token);
    if (!this.authenticate) {
      throw new OnebaseError(
        "A client sent an auth token, but auth.config.ts has no sign-in methods, providers or authenticate(token, ctx) to check it.",
      );
    }
    return (await this.authenticate(token, this.authCtx)) ?? null;
  }

  /**
   * ctx for a custom authenticate(token, ctx): read-only database access. Each read runs in its
   * own snapshot, so no transaction stays open while authenticate() waits on anything else.
   */
  private readonly authCtx: AuthenticateCtx = (() => {
    const read = <T>(fn: (db: ReturnType<typeof readerView>) => Promise<T>) => this.withReader((tx) => fn(readerView(this.newDb(tx, {}))));
    const terminal = new Set(["collect", "take", "first", "unique", "paginate"]);
    const query = (table: string) => {
      const steps: [string, unknown[]][] = [];
      const replay = (db: any) => steps.reduce((q, [method, args]) => q[method](...args), db.query(table));
      const builder: any = new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (prop === Symbol.asyncIterator) return async function* () { yield* (await read((db) => replay(db).collect())) as unknown[]; };
            if (typeof prop !== "string" || prop === "then") return undefined;
            if (terminal.has(prop)) return (...args: unknown[]) => read((db) => replay(db)[prop](...args));
            return (...args: unknown[]) => {
              steps.push([prop, args]);
              return builder;
            };
          },
        },
      );
      return builder;
    };
    return {
      db: {
        get: (...args: unknown[]) => read((db) => db.get(...args)),
        query,
        normalizeId: (table: string, id: string) => (isIdForTable(id, table) ? id : null),
      } as any,
    };
  })();

  // ---- Lookup & validation ----

  /**
   * Finds a function and checks that `caller` may call it: the app reaches components' public
   * functions, a component reaches only its own (passed as the function itself), and the system
   * (scheduler, crons, dashboard) reaches everything.
   */
  resolve(
    ref: FunctionLike | RegisteredFunction,
    expected: FunctionType | null,
    allowInternal: boolean,
    caller: Caller = null,
  ): { name: string; fn: RegisteredFunction; mount: MountRuntime | null } {
    const name = this.functionName(ref, caller);
    // A handle is a capability the app handed out: whoever holds it may call that function, but only
    // from server code (a client never calls through one).
    const viaHandle = isFunctionHandle(ref);
    if (viaHandle && !allowInternal) throw new OnebaseError("Function handles can only be called from other functions.");
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
    const info = this.componentFunctions.get(name);
    const target = info?.mount ?? null;
    if (!viaHandle && caller !== "system" && caller !== target) {
      if (caller) {
        throw new OnebaseError(
          target
            ? `Component "${caller.name}" can't call component "${target.name}"'s "${name}"; only the app can.`
            : `Component "${caller.name}" can't call the app's "${name}"; components only run their own functions.`,
        );
      }
      if (info?.internal) throw new OnebaseError(`"${name}" is internal to component "${target!.name}"; call its public functions instead.`);
    }
    return { name, fn, mount: target };
  }

  private handleSignature(name: string): string {
    if (!this.handleKey) throw new OnebaseError("Function handles work once the runtime has started (init()).");
    return createHmac("sha256", this.handleKey).update(name).digest("base64url").slice(0, 22);
  }

  /** A signed handle to a function `caller` may call: anyone holding it can then call that function. */
  createHandle(ref: unknown, caller: Caller): string {
    const { name } = this.resolve(ref as FunctionLike, null, true, caller);
    return `function://${name}#${this.handleSignature(name)}`;
  }

  /** The function a handle names, if its signature is right. */
  private handleName(handle: string): string {
    const [name, signature] = handle.slice("function://".length).split("#");
    const expected = name ? Buffer.from(this.handleSignature(name)) : null;
    if (!expected || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), expected)) {
      throw new OnebaseError("Invalid function handle: make handles with createFunctionHandle() rather than by hand.");
    }
    return name!;
  }

  /** A component names its own functions by passing the function itself. */
  private functionName(ref: FunctionLike | RegisteredFunction, caller: Caller): string {
    if (isFunctionHandle(ref)) return this.handleName(ref);
    if (!isRegisteredFunction(ref)) return getFunctionName(ref);
    const name = caller && caller !== "system" ? caller.names.get(ref) : undefined;
    if (!name) {
      throw new OnebaseError(
        caller && caller !== "system"
          ? `Component "${caller.name}" passed a function that isn't one of its own.`
          : `Pass a function reference (api.messages.list) or name ("messages:list"), not the function itself.`,
      );
    }
    return name;
  }

  private callerOf(opts: CallOptions): Caller {
    if (opts.caller !== undefined) return opts.caller;
    return opts.source && SYSTEM_SOURCES.has(opts.source) ? "system" : null;
  }

  private checkArgs(name: string, fn: RegisteredFunction, args: unknown): Record<string, unknown> {
    const value = args ?? {};
    if (!isPlainObject(value)) throw new OnebaseError(`Arguments to "${name}" must be an object, got ${describeValue(args)}.`);
    if (fn.args) {
      // A component's v.id("t") names its own table, stored as "<mount>.t".
      const mount = this.componentFunctions.get(name)?.mount.name ?? null;
      const errors = validate(fn.args, value, "args", { idTable: (table) => storedTable(mount, table) });
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

  private authFor(identity: UserIdentity | null) {
    return { getUserIdentity: async () => identity };
  }

  private warn = (message: string) => this.log.warn(message);

  private newDb(tx: Exec, extra: { readSet?: ReadSet; writes?: Write[] }, scope = TableScope.app) {
    return new DatabaseImpl({
      tx,
      dialect: this.driver.dialect,
      catalog: this.catalog,
      scope,
      nextCreationTime: () => this.nextCreationTime(),
      onWarning: this.dev ? this.warn : undefined,
      explain: this.driver.explain?.bind(this.driver),
      warned: this.warnedQueries,
      ...extra,
    });
  }

  private schedulerFor(state: TxState | null, caller: MountRuntime | null = null) {
    const schedule = async (runAt: number, ref: FunctionLike, args: unknown) => {
      const { name } = this.resolve(ref, null, true, caller);
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
        const cancel = async (tx: Exec) => {
          // A component cancels only its own jobs.
          if (caller) {
            const job = await tx.get("SELECT fn FROM _scheduled WHERE id = ?", [id]);
            const own = `components/${caller.name}`;
            if (!job || !(job.fn.startsWith(own + ":") || job.fn.startsWith(own + "/"))) return;
          }
          await tx.run("UPDATE _scheduled SET state = 'canceled' WHERE id = ? AND state = 'pending'", [id]);
        };
        if (state) await cancel(state.tx);
        else await this.withWriter(cancel);
      },
    };
  }

  private fileUrl(id: string) {
    return `${this.siteUrl}/api/storage/${id}`;
  }

  private storageReader(tx: Exec, readSet?: ReadSet) {
    const metadata = (id: string) => {
      readSet?.ids.add(id);
      return this.files.metadata(tx, id);
    };
    return {
      getUrl: async (id: string) => ((await metadata(id)) ? this.fileUrl(id) : null),
      getMetadata: metadata,
    };
  }

  /** Deletes a file's metadata as a write, so queries that read the file see it go; the bytes go once it commits. */
  private async removeFile(state: TxState, id: string) {
    await this.files.deleteMetadata(state.tx, id);
    state.writes.push({ table: "_storage", id, before: null, after: null });
    state.afterCommit.push(() => this.files.backend.remove(id));
  }

  private storageWriter(state: TxState) {
    return {
      ...this.storageReader(state.tx),
      generateUploadUrl: async () => `${this.siteUrl}/api/storage/upload?token=${await this.files.createUploadToken(state.tx)}`,
      delete: (id: string) => this.removeFile(state, id),
    };
  }

  private storageForActions() {
    const read = <T>(fn: (tx: Exec) => Promise<T>) => this.withReader(fn);
    return {
      getUrl: async (id: string) => ((await read((tx) => this.files.metadata(tx, id))) ? this.fileUrl(id) : null),
      getMetadata: (id: string) => read((tx) => this.files.metadata(tx, id)),
      generateUploadUrl: async () => `${this.siteUrl}/api/storage/upload?token=${await this.withWriter((tx) => this.files.createUploadToken(tx))}`,
      delete: (id: string) => this.transact((state) => this.removeFile(state, id)),
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

  /** A component sees the caller's identity only when mounted with `auth: true`. */
  private identityFor(mount: MountRuntime | null, identity: UserIdentity | null) {
    return mount && !mount.options.auth ? null : identity;
  }

  /** What a component's functions get besides their database. */
  private componentBase(mount: MountRuntime, identity: UserIdentity | null, tx: Exec | null) {
    const status = async (table?: string) => {
      const hook = table === undefined ? mount.hooks[0] : mount.hooks.find((h) => h.table === table);
      if (!hook) throw new OnebaseError(`Component "${mount.name}" has no table hook${table === undefined ? "" : ` on "${table}"`}.`);
      const progress = tx ? await readProgress(tx, hook.key) : await this.withReader((t) => readProgress(t, hook.key));
      const state = hookState(progress, hook.fingerprint);
      return { table: hook.table, state, ready: state === "ready" };
    };
    return { auth: this.authFor(identity), config: mount.config, component: { mount: mount.name }, hooks: { status } };
  }

  /**
   * `state` is set for a query run inside a mutation: before the app calls into a component, the
   * component's table hooks get the mutation's writes so far, so it reads its own data up to date.
   */
  private queryCtx(db: DatabaseImpl, identity: UserIdentity | null, mount: MountRuntime | null = null, state: TxState | null = null): any {
    const id = this.identityFor(mount, identity);
    // Nested queries read in the same snapshot and into the same read set, so they stay reactive.
    const runQuery = async (ref: FunctionLike, args?: unknown) => {
      const { name, fn, mount: target } = this.resolve(ref, "query", true, mount);
      if (state && target && target !== mount) await this.flushHooks(state, target);
      return this.invoke(name, fn, this.queryCtx(db, id, target, state), args, db.readSet);
    };
    const scoped = readerView(db.withScope(mount?.scope ?? TableScope.app));
    if (mount) return { db: scoped, ...this.componentBase(mount, id, db.tx), runQuery };
    return { db: scoped, auth: this.authFor(id), storage: this.storageReader(db.tx, db.readSet), runQuery, components: this.componentsProxy("query", { runQuery }) };
  }

  private mutationCtx(state: TxState, identity: UserIdentity | null, mount: MountRuntime | null = null): any {
    const id = this.identityFor(mount, identity);
    const runQuery = async (ref: FunctionLike, args?: unknown) => {
      const { name, fn, mount: target } = this.resolve(ref, "query", true, mount);
      if (target && target !== mount) await this.flushHooks(state, target);
      return this.invoke(name, fn, this.queryCtx(state.db, id, target, state), args);
    };
    const runMutation = async (ref: FunctionLike, args?: unknown) => {
      const { name, fn, mount: target } = this.resolve(ref, "mutation", true, mount);
      if (target && target !== mount) await this.flushHooks(state, target);
      return this.nestedMutation(state, name, fn, id, target, args);
    };
    const db = writerView(state.db.withScope(mount?.scope ?? TableScope.app));
    const scheduler = this.schedulerFor(state, mount);
    if (mount) return { db, ...this.componentBase(mount, id, state.tx), scheduler, runQuery, runMutation };
    return {
      db,
      auth: this.authFor(id),
      storage: this.storageWriter(state),
      scheduler,
      runQuery,
      runMutation,
      components: this.componentsProxy("mutation", { runQuery, runMutation }),
    };
  }

  /** Nested mutations share the transaction; a savepoint rolls back just this call on error. */
  private async nestedMutation(state: TxState, name: string, fn: RegisteredFunction, identity: UserIdentity | null, mount: MountRuntime | null, args: unknown) {
    const mark = state.writes.length;
    const commitMark = state.afterCommit.length;
    try {
      return await savepoint(state.tx, () => this.invoke(name, fn, this.mutationCtx(state, identity, mount), args));
    } catch (err) {
      state.writes.length = mark;
      state.afterCommit.length = commitMark;
      // Hooks that saw writes now rolled back saw them inside this savepoint, so their own writes went too.
      for (const [key, cursor] of state.hookCursors) if (cursor > mark) state.hookCursors.set(key, mark);
      throw err;
    }
  }

  /**
   * Gives table hooks the writes they haven't seen, coalesced per document, in a savepoint of the
   * writing transaction (`only`: just one mount's). Documents the backfill hasn't reached yet are
   * left out: it will read their current state. A hook that throws fails the call.
   */
  private async flushHooks(state: TxState, only?: MountRuntime) {
    for (const mount of only ? [only] : this.mounts.values()) {
      for (const hook of mount.hooks) {
        const from = state.hookCursors.get(hook.key) ?? 0;
        const to = state.writes.length;
        if (from >= to) continue;
        state.hookCursors.set(hook.key, to);
        const writes = state.writes.slice(from, to).filter((w) => w.table === hook.table);
        if (!writes.length) continue;
        const progress = await readProgress(state.tx, hook.key);
        const changes = coalesce(writes).filter((c) => backfilled(progress, hook.fingerprint, c));
        if (!changes.length) continue;
        try {
          await this.nestedMutation(state, hook.onChange.name, hook.onChange.fn, null, mount, { changes });
        } catch (err) {
          state.hookCursors.set(hook.key, from);
          throw err;
        }
      }
    }
  }

  /** `deadline`: once the action's time limit passes, what it still tries to do is refused. */
  actionCtx(identity: UserIdentity | null, mount: MountRuntime | null = null, deadline = new Deadline()): any {
    const id = this.identityFor(mount, identity);
    const opts: CallOptions = { identity: id, allowInternal: true, caller: mount };
    const guardAll = <T extends Record<string, any>>(obj: T): T =>
      Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "function" ? deadline.guard(v) : v])) as T;
    const runQuery = deadline.guard((ref: FunctionLike, args?: unknown) => this.runQuery(ref, args, opts).then((r) => r.value));
    const runMutation = deadline.guard((ref: FunctionLike, args?: unknown) => this.runMutation(ref, args, opts));
    const runAction = deadline.guard((ref: FunctionLike, args?: unknown) => this.runAction(ref, args, opts));
    const vectorSearch = deadline.guard(async (table: string, index: string, query: VectorSearchQuery) => {
      const { results } = await this.driver.read((tx) => this.newDb(tx, {}, mount?.scope).vectorSearch(table, index, query));
      return results;
    });
    const ctx: Record<string, unknown> = mount
      ? { ...this.componentBase(mount, id, null), scheduler: guardAll(this.schedulerFor(null, mount)), runQuery, runMutation, runAction, vectorSearch }
      : {
          auth: this.authFor(id),
          storage: guardAll(this.storageForActions()),
          scheduler: guardAll(this.schedulerFor(null)),
          runQuery,
          runMutation,
          runAction,
          vectorSearch,
          components: this.componentsProxy("action", { runQuery, runMutation, runAction }),
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

  /**
   * Function references in a component call's arguments (`{ fn: internal.emails.send }`, however
   * deeply nested) become signed handles, so the component can call them back or schedule them.
   */
  private referencesToHandles(args: unknown, depth = 0): unknown {
    if (depth > 8 || (typeof args !== "object" && !Array.isArray(args))) return args;
    if (Array.isArray(args)) return args.map((value) => this.referencesToHandles(value, depth + 1));
    if (!isPlainObject(args)) return args;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      let path: unknown;
      try {
        path = typeof value === "object" && value !== null ? (value as any)[functionPathSymbol] : undefined;
      } catch {}
      out[key] = typeof path === "string" ? this.createHandle(value, null) : this.referencesToHandles(value, depth + 1);
    }
    return out;
  }

  /**
   * `ctx.components.<mount>.<fn>(args)`: calls a component's public function through the
   * context's own runQuery / runMutation / runAction, so it shares their transaction rules.
   */
  private componentsProxy(kind: FunctionType, run: Partial<Record<"runQuery" | "runMutation" | "runAction", (ref: FunctionLike, args?: unknown) => Promise<unknown>>>) {
    const mounts = this.mounts;
    const node = (mount: MountRuntime, tree: Record<string, unknown>, path: string[]): unknown =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== "string" || prop === "then") return undefined;
            const value = tree[prop];
            const where = `ctx.components.${[mount.name, ...path, prop].join(".")}`;
            if (value === undefined) {
              throw new OnebaseError(`${where} doesn't exist. Component "${mount.name}" has: ${Object.keys(tree).join(", ") || "(nothing)"}.`);
            }
            if (!isRegisteredFunction(value)) return node(mount, value as Record<string, unknown>, [...path, prop]);
            if (value.visibility === "internal") throw new OnebaseError(`${where} is internal to the component.`);
            const call = run[`run${cap(value.type)}` as "runQuery"];
            if (!call) {
              throw new OnebaseError(
                `${where} is a ${value.type}; a ${kind} can only call component ${kind === "query" ? "queries" : "queries and mutations"}.`,
              );
            }
            const name = mount.names.get(value)!;
            return (args?: unknown) => call(name, this.referencesToHandles(args));
          },
        },
      );
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string" || prop === "then") return undefined;
          const mount = mounts.get(prop);
          if (!mount) throw new OnebaseError(`No component "${prop}" in components.ts. Mounted: ${[...mounts.keys()].join(", ") || "(none)"}.`);
          return node(mount, mount.definition.functions, []);
        },
      },
    );
  }

  private async invoke(name: string, fn: RegisteredFunction, ctx: unknown, args: unknown, reads?: ReadSet) {
    const checked = this.checkArgs(name, fn, args);
    const caller = this.componentFunctions.get(name)?.mount ?? null;
    const handle = (ref: unknown) => this.createHandle(ref, caller);
    const result = await currentFunction.run({ type: fn.type, name, handle, reads }, () => fn.handler(ctx, checked));
    return this.checkReturn(name, fn, result);
  }

  /**
   * Runs `body` under the time limit for `kind`. It gets the call's deadline, to fence the
   * transaction and context it hands the function.
   */
  private async withinLimit<T>(kind: FunctionType, name: string, body: (deadline: Deadline) => Promise<T>): Promise<T> {
    const deadline = new Deadline();
    const ms = this.timeLimits[`${kind}Ms`];
    if (!ms) return body(deadline);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        deadline.expired = new OnebaseError(`${name} didn't finish within the ${kind} time limit (${formatMs(ms)}).`);
        reject(deadline.expired);
      }, ms);
    });
    try {
      return await Promise.race([body(deadline), expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs an http.ts route handler. */
  async runHttpAction(
    handler: (ctx: any, request: Request) => Promise<Response> | Response,
    request: Request,
    identity: UserIdentity | null,
    mount: MountRuntime | null = null,
  ) {
    const name = `${request.method} ${new URL(request.url).pathname}`;
    const handle = (ref: unknown) => this.createHandle(ref, mount);
    return this.calls.track(name, "http", "http", () =>
      this.withinLimit("action", name, (deadline) =>
        currentFunction.run({ type: "action", name, handle }, async () => handler(this.actionCtx(identity, mount, deadline), request)),
      ),
    );
  }

  // ---- Entry points ----

  /** Runs a query against a committed snapshot and reports what it read. */
  async runQuery(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<{ value: unknown; readSet: ReadSet }> {
    const { name, fn, mount } = this.resolve(ref, "query", opts.allowInternal ?? false, this.callerOf(opts));
    return this.calls.track(name, "query", opts.source ?? "function", () =>
      // The limit starts once the query has a snapshot: time spent waiting for one isn't its fault.
      this.driver.read((tx) =>
        this.withinLimit("query", name, async (deadline) => {
          const readSet: ReadSet = { ids: new Set(), ranges: [] };
          const db = this.newDb(deadline.exec(tx), { readSet });
          const value = await this.invoke(name, fn, this.queryCtx(db, opts.identity ?? null, mount), args, readSet);
          return { value, readSet };
        }),
      ),
    );
  }

  async runMutation(
    ref: FunctionLike,
    args: unknown,
    opts: CallOptions & {
      inTransaction?: (tx: Exec) => Promise<unknown>;
      /** Called just before the transaction commits (again if it's retried). */
      beforeCommit?: () => void;
    } = {},
  ): Promise<unknown> {
    const { name, fn, mount } = this.resolve(ref, "mutation", opts.allowInternal ?? false, this.callerOf(opts));
    return this.calls.track(name, "mutation", opts.source ?? "function", () =>
      this.transact(
        async (state) => {
          const value = await this.invoke(name, fn, this.mutationCtx(state, opts.identity ?? null, mount), args);
          await opts.inTransaction?.(state.tx);
          return value;
        },
        { beforeCommit: opts.beforeCommit, limit: name },
      ),
    );
  }

  /**
   * Runs `body` in a write transaction with everything a mutation gets: commit broadcast,
   * post-commit hooks, scheduler wake-up and live-query invalidation.
   */
  private async transact<T>(
    body: (state: TxState) => Promise<T>,
    opts: {
      beforeCommit?: () => void;
      scope?: TableScope;
      /** The function this runs, under the mutation time limit; none for the system's own writes. */
      limit?: string;
    } = {},
  ): Promise<T> {
    const { beforeCommit, scope = TableScope.app, limit } = opts;
    // The driver may run this more than once if another instance conflicts; each attempt starts fresh.
    const attempt = async (tx: Exec) => {
      const state: TxState = { tx, db: undefined as any, writes: [], scheduled: false, afterCommit: [], revoked: [], hookCursors: new Map() };
      state.db = this.newDb(tx, { writes: state.writes }, scope);
      const value = await body(state);
      // Nothing commits before every table hook has seen every write.
      await this.flushHooks(state);
      if (this.driver.shared && this.driver.publish && (state.writes.length || state.scheduled || state.revoked.length)) {
        for (const message of this.broadcastMessages(state)) await this.driver.publish(tx, message);
      }
      beforeCommit?.();
      return { value, writes: state.writes, scheduled: state.scheduled, afterCommit: state.afterCommit, revoked: state.revoked };
    };
    const { value, writes, scheduled, afterCommit, revoked } = await this.withWriter((tx) =>
      // Each attempt gets the whole time limit, counted from when it has the write lock.
      limit ? this.withinLimit("mutation", limit, (deadline) => attempt(deadline.exec(tx))) : attempt(tx),
    );
    if (revoked.length) this.notifyRevoked(revoked);
    for (const fn of afterCommit) await fn();
    if (scheduled) this.pokeScheduler();
    if (writes.length) await this.notifyCommit({ writes });
    return value;
  }

  /**
   * Dashboard edits: a schema-validated write that live queries see like any mutation.
   * `db` can read and write any table (components' too), including ones no longer in schema.ts.
   */
  adminWrite<T>(body: (db: DatabaseImpl, state: { tx: Exec; deleteFile(id: string): Promise<void> }) => Promise<T>): Promise<T> {
    return this.calls.track("dashboard edit", "mutation", "dashboard", () =>
      this.transact(
        (state) => body(state.db, { tx: state.tx, deleteFile: (id) => this.removeFile(state, id) }),
        { scope: TableScope.admin },
      ),
    );
  }

  /**
   * Built-in auth: one transaction over the system tables and the users table, which live
   * queries see like any mutation. `revoke` signs out connections using those sessions.
   */
  authWrite<T>(body: (ctx: { db: DatabaseImpl; tx: Exec; revoke(sessionIds: string[]): void }) => Promise<T>): Promise<T> {
    return this.calls.track("auth", "mutation", "auth", () =>
      this.transact((state) => body({ db: state.db, tx: state.tx, revoke: (ids) => state.revoked.push(...ids) })),
    );
  }

  /** Dashboard reads: a snapshot `db` that can read any table, including ones no longer in schema.ts. */
  adminRead<T>(body: (db: DatabaseImpl, tx: Exec) => Promise<T>): Promise<T> {
    return this.driver.read((tx) => body(this.newDb(tx, {}, TableScope.admin), tx));
  }

  private broadcastMessages(state: TxState): string[] {
    const revoked: string[][] = [];
    for (let i = 0; i < state.revoked.length; i += REVOKED_PER_MESSAGE) revoked.push(state.revoked.slice(i, i + REVOKED_PER_MESSAGE));
    const extra = { s: state.scheduled || undefined, r: revoked[0] };
    const full = JSON.stringify({ o: this.instanceId, w: state.writes, ...extra });
    const first = full.length <= MAX_BROADCAST ? full : JSON.stringify({ o: this.instanceId, t: [...new Set(state.writes.map((w) => w.table))], ...extra });
    // Signing out a user with many sessions ends them all; the rest of the ids follow on their own.
    return [first, ...revoked.slice(1).map((r) => JSON.stringify({ o: this.instanceId, r }))];
  }

  async runAction(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    const { name, fn, mount } = this.resolve(ref, "action", opts.allowInternal ?? false, this.callerOf(opts));
    return this.calls.track(name, "action", opts.source ?? "function", () =>
      this.withinLimit("action", name, (deadline) => this.invoke(name, fn, this.actionCtx(opts.identity ?? null, mount, deadline), args)),
    );
  }

  /** Runs any function by name, whatever its type. */
  async call(ref: FunctionLike, args: unknown, opts: CallOptions = {}): Promise<unknown> {
    const { fn } = this.resolve(ref, null, opts.allowInternal ?? false, this.callerOf(opts));
    if (fn.type === "query") return (await this.runQuery(ref, args, opts)).value;
    if (fn.type === "mutation") return this.runMutation(ref, args, opts);
    return this.runAction(ref, args, opts);
  }

  // ---- Table hook backfills ----

  private backfills: Promise<void> = Promise.resolve();

  /** Resolves once every table hook has caught up with the documents written before it existed. */
  hooksReady(): Promise<void> {
    return this.backfills;
  }

  /** Feeds existing documents to new (or changed) table hooks, in batches queued with mutations. */
  private startBackfills() {
    const hooks = [...this.mounts.values()].flatMap((mount) => mount.hooks.map((hook) => ({ mount, hook })));
    this.backfills = this.backfills.then(async () => {
      if (this.stopped) return;
      await this.withWriter(async (tx) => {
        const keep = new Set(hooks.map((h) => h.hook.key));
        for (const row of await tx.all(`SELECT "key" FROM _meta WHERE "key" LIKE 'hook:%'`)) {
          if (!keep.has(row.key as string)) await tx.run(`DELETE FROM _meta WHERE "key" = ?`, [row.key]);
        }
      });
      for (const { mount, hook } of hooks) {
        try {
          while (!this.stopped && !(await this.transact((state) => this.backfillStep(state, mount, hook), { limit: hook.onChange.name }))) {}
        } catch (err) {
          this.log.error(`Component "${mount.name}" couldn't catch up with table "${hook.table}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }).catch((err) => this.log.error(`Table hooks: ${err instanceof Error ? err.message : String(err)}`));
  }

  /** One batch of a hook's backfill; true once it has caught up. */
  private async backfillStep(state: TxState, mount: MountRuntime, hook: ResolvedHook): Promise<boolean> {
    let progress = await readProgress(state.tx, hook.key);
    if (progress?.fingerprint === hook.fingerprint && progress.state === "ready") return true;
    if (!progress || progress.fingerprint !== hook.fingerprint) {
      progress = { fingerprint: hook.fingerprint, state: hook.reset ? "resetting" : "backfilling", cursor: null };
    }
    if (progress.state === "resetting") {
      const result = (await this.nestedMutation(state, hook.reset!.name, hook.reset!.fn, null, mount, {})) as { done?: boolean } | null;
      if (result?.done) progress = { ...progress, state: "backfilling" };
      await writeProgress(state.tx, hook.key, progress);
      return false;
    }
    const d = this.driver.dialect;
    const rows = await state.tx.all(
      `SELECT id, ct, doc FROM documents WHERE tbl = ? AND (ct, id) > (${d.placeholder("ct")}, ${d.placeholder("id")}) ORDER BY ct, id LIMIT ${BACKFILL_BATCH}`,
      [hook.table, ...(progress.cursor ?? [-1, ""])],
    );
    const changes = rows.map((row) => ({
      op: "insert",
      id: row.id,
      before: null,
      after: { _id: row.id, _creationTime: Number(row.ct), ...d.parseDoc(row.doc) },
    }));
    if (changes.length) await this.nestedMutation(state, hook.onChange.name, hook.onChange.fn, null, mount, { changes });
    const last = rows[rows.length - 1];
    const next: HookProgress = {
      fingerprint: hook.fingerprint,
      state: rows.length < BACKFILL_BATCH ? "ready" : "backfilling",
      cursor: last ? [Number(last.ct), last.id as string] : progress.cursor,
    };
    await writeProgress(state.tx, hook.key, next);
    return next.state === "ready";
  }

  // ---- Scheduler ----

  async startScheduler() {
    await this.withWriter((tx) => tx.run("DELETE FROM _scheduled WHERE state <> 'pending' AND run_at < ?", [Date.now() - 7 * 86400_000]));
    this.pokeScheduler();
    // With a shared database, pick up jobs left by instances that went away.
    // Also catch up on a deploy whose broadcast was missed (say, while reconnecting).
    if (this.driver.shared) {
      this.heartbeat = setInterval(() => {
        this.pokeScheduler();
        void this.syncDeployment();
      }, 30_000);
    }
    this.schedulerStarted = true;
    await this.startCrons();
  }

  private async startCrons() {
    if (!this.crons.length || this.stopped) return;
    this.cronRunner = new CronRunner(this, this.crons);
    await this.cronRunner.start().catch((err) => this.log.error(`Crons: ${err instanceof Error ? err.message : String(err)}`));
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
    // Every slot is taken: a finishing job pokes the scheduler again.
    const free = MAX_RUNNING_JOBS - this.runningJobs;
    if (free <= 0) return;
    // Claim each job with a conditional update so that no two runs (or instances) take the same one.
    const due = await this.withWriter(async (tx) => {
      const jobs = (await tx.all(
        "SELECT id, fn, args FROM _scheduled WHERE state = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?",
        [Date.now(), free],
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
    // Jobs run on their own, so a slow or stuck one never holds up the jobs due after it.
    for (const job of due) {
      this.runningJobs++;
      void this.runJob(job).finally(() => {
        this.runningJobs--;
        this.pokeScheduler();
      });
    }
    this.pokeScheduler();
  }

  private async runJob(job: { id: string; fn: string; args: string }) {
    const setState = (tx: Exec, state: string, error: string | null = null) =>
      tx.run("UPDATE _scheduled SET state = ?, error = ? WHERE id = ?", [state, error, job.id]);
    try {
      const args = JSON.parse(job.args);
      const fn = this.functions.get(job.fn);
      if (fn?.type === "mutation") {
        // Exactly once: the job is marked done in the mutation's own transaction.
        await this.runMutation(job.fn, args, { allowInternal: true, source: "scheduler", inTransaction: (tx) => setState(tx, "done") });
      } else {
        await this.call(job.fn, args, { allowInternal: true, source: "scheduler" });
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
