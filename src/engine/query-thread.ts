// The worker side of query workers (see query-pool.ts): loads its own copy of the project's code,
// opens its own read-only connection to the SQLite file, and runs the queries it's given there,
// one at a time, each in a snapshot of its own. What a query can touch through ctx (the database,
// the caller's identity, file metadata, other queries, components) is all reads, so all of it
// runs here. A query that uses a function handle is sent back to the main thread, which holds the
// key handles are signed with.

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import type { Database } from "bun:sqlite";
import { functionPathSymbol, getFunctionName, isFunctionHandle, type FunctionLike } from "../api";
import { isRegisteredFunction, type RegisteredFunction, type UserIdentity } from "../server";
import { toWire } from "./action-wire";
import { addLine, type LogLine } from "./calllog";
import { buildCatalog, TableScope, type Catalog } from "./catalog";
import { checkArgs, checkReturn, indexCode, lookupFunction, type IndexedCode, type MountCode } from "./code";
import { DatabaseImpl, OnebaseError, readerView, type ReadSet } from "./database";
import { sqliteDialect } from "./dialect";
import { openSqliteReader, type Exec, type Row } from "./driver";
import { fileMetadata } from "./files";
import { currentFunction, installGuards } from "./guard";
import { hookState, readProgress } from "./hooks";
import { CallBudget } from "./limits";
import type { FromQueryThread, ToQueryThread } from "./query-wire";
import type { ProjectCode } from "./runtime";

type Mount = MountCode & { scope: TableScope };
type Loaded = IndexedCode<Mount> & { catalog: Catalog | null };
type Init = Extract<ToQueryThread, { t: "init-query" }>;
type Job = Extract<ToQueryThread, { t: "query" }>;

/** Thrown when a query needs the main thread; remembered on the run too, in case the function catches it. */
class MainThreadOnly extends Error {}

const post = (message: FromQueryThread) => (self as unknown as Worker).postMessage(message);

/** A query's value as it goes to a client (as sync.ts makes it): undefined becomes null. */
const valueJson = (value: unknown) => JSON.stringify(value) ?? "null";

/**
 * Starts serving queries, once the main thread's first message (`init`) has said so. `load` gets
 * the project's code the way an action worker does.
 */
export async function serveQueries(init: Init, load: (source: Init["source"]) => Promise<ProjectCode>) {
  installGuards();
  const lines = new AsyncLocalStorage<LogLine[]>();
  // console output inside a query goes to its call's record on the main thread (and to stdout).
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const store = lines.getStore();
      if (store) addLine(store, level, format(...args));
      original(...args);
    };
  }

  let code: Loaded;
  let sqlite: Database;
  try {
    const project = await load(init.source);
    const indexed = indexCode(project, (mount): Mount => ({ ...mount, scope: TableScope.component(mount.name) }));
    const catalog = buildCatalog(project.schema, [...indexed.mounts.values()].map((m) => ({ mount: m.name, schema: m.definition.schema })));
    code = { ...indexed, catalog };
    sqlite = openSqliteReader(init.path);
  } catch (err) {
    return post({ t: "failed", error: err instanceof Error ? err.message : String(err) });
  }

  const tx: Exec = {
    all: async (sql, params = []) => sqlite.query(sql).all(...(params as any[])) as Row[],
    get: async (sql, params = []) => (sqlite.query(sql).get(...(params as any[])) as Row | null) ?? null,
    run: async () => {
      throw new OnebaseError("Queries are read-only.");
    },
  };

  /** One query run: everything its ctx needs to report back. */
  type Run = { readSet: ReadSet; mainThread: string | null };

  const needsMainThread = (run: Run, what: string): never => {
    run.mainThread = what;
    throw new MainThreadOnly(`${what} runs on the main thread.`);
  };

  /** The function `ref` names, as Runtime.resolve() finds it for a nested call. */
  const resolve = (run: Run, ref: unknown, caller: Mount | null) => {
    if (isFunctionHandle(ref)) needsMainThread(run, "calling a function handle");
    let name: string;
    if (isRegisteredFunction(ref)) {
      const own = caller?.names.get(ref);
      if (!own) {
        throw new OnebaseError(
          caller
            ? `Component "${caller.name}" passed a function that isn't one of its own.`
            : `Pass a function reference (api.messages.list) or name ("messages:list"), not the function itself.`,
        );
      }
      name = own;
    } else {
      name = getFunctionName(ref as FunctionLike);
    }
    const { fn, mount } = lookupFunction(code.functions, code.componentFunctions, name, { expected: "query", allowInternal: true, caller, viaHandle: false });
    return { name, fn, mount };
  };

  const invoke = async (run: Run, name: string, fn: RegisteredFunction, ctx: unknown, args: unknown) => {
    const checked = checkArgs(name, fn, args, code.componentFunctions.get(name)?.mount.name ?? null);
    const handle = () => needsMainThread(run, "createFunctionHandle()");
    const result = await currentFunction.run({ type: "query", name, handle, reads: run.readSet }, () => fn.handler(ctx, checked));
    return checkReturn(name, fn, result);
  };

  const authFor = (identity: UserIdentity | null, reads: ReadSet) => ({
    getUserIdentity: async () => {
      reads.identity = true;
      return identity;
    },
  });

  /** A function reference in a component call's arguments becomes a handle on the main thread. */
  const hasReference = (value: unknown, depth = 0): boolean => {
    if (depth > 8 || typeof value !== "object" || value === null) return false;
    try {
      if (typeof (value as any)[functionPathSymbol] === "string") return true;
    } catch {}
    return Object.values(value).some((v) => hasReference(v, depth + 1));
  };

  /** ctx.components.<mount>.<fn>(args) for a query: only component queries. */
  const componentsProxy = (run: Run, runQuery: (ref: FunctionLike, args?: unknown) => Promise<unknown>) => {
    const node = (mount: Mount, tree: Record<string, unknown>, path: string[]): unknown =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            if (typeof prop !== "string" || prop === "then") return undefined;
            const value = tree[prop];
            const where = `ctx.components.${[mount.name, ...path, prop].join(".")}`;
            if (value === undefined) throw new OnebaseError(`${where} doesn't exist. Component "${mount.name}" has: ${Object.keys(tree).join(", ") || "(nothing)"}.`);
            if (!isRegisteredFunction(value)) return node(mount, value as Record<string, unknown>, [...path, prop]);
            if (value.visibility === "internal") throw new OnebaseError(`${where} is internal to the component.`);
            if (value.type !== "query") throw new OnebaseError(`${where} is a ${value.type}; a query can only call component queries.`);
            const name = mount.names.get(value)!;
            return (args?: unknown) => {
              if (hasReference(args)) needsMainThread(run, "passing a function reference to a component");
              return runQuery(name, args);
            };
          },
        },
      );
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string" || prop === "then") return undefined;
          const mount = code.mounts.get(prop);
          if (!mount) throw new OnebaseError(`No component "${prop}" in components.ts. Mounted: ${[...code.mounts.keys()].join(", ") || "(none)"}.`);
          return node(mount, mount.definition.functions, []);
        },
      },
    );
  };

  /** A component's ctx.hooks.status(), from its hook declarations (the main thread checked them when it loaded the code). */
  const hookStatus = (mount: Mount) => async (table?: string) => {
    const hooks = (mount.definition.hooks?.(mount.config) ?? []) as { table: string; fingerprint?: string }[];
    const hook = table === undefined ? hooks[0] : hooks.find((h) => h.table === table);
    if (!hook) throw new OnebaseError(`Component "${mount.name}" has no table hook${table === undefined ? "" : ` on "${table}"`}.`);
    const state = hookState(await readProgress(tx, `hook:${mount.name}:${hook.table}`), hook.fingerprint ?? "");
    return { table: hook.table, state, ready: state === "ready" };
  };

  /** What Runtime.queryCtx() gives a query, built on this thread's connection. */
  const queryCtx = (run: Run, db: DatabaseImpl, identity: UserIdentity | null, mount: Mount | null): any => {
    // A component sees the caller's identity only when mounted with `auth: true`.
    const id = mount && !mount.options.auth ? null : identity;
    const runQuery = async (ref: FunctionLike, args?: unknown) => {
      const { name, fn, mount: target } = resolve(run, ref, mount);
      return invoke(run, name, fn, queryCtx(run, db, id, target), args);
    };
    const scoped = readerView(db.withScope(mount?.scope ?? TableScope.app));
    if (mount) {
      return { db: scoped, auth: authFor(id, run.readSet), config: mount.config, component: { mount: mount.name }, hooks: { status: hookStatus(mount) }, runQuery };
    }
    const metadata = (fileId: string) => {
      run.readSet.ids.add(fileId);
      return fileMetadata(tx, fileId);
    };
    const storage = {
      getUrl: async (fileId: string) => ((await metadata(fileId)) ? `${init.siteUrl}/api/storage/${fileId}` : null),
      getMetadata: metadata,
    };
    return { db: scoped, auth: authFor(id, run.readSet), storage, runQuery, components: componentsProxy(run, runQuery) };
  };

  const execute = async (job: Job) => {
    const run: Run = { readSet: { ids: new Set(), ranges: [] }, mainThread: null };
    const output: LogLine[] = [];
    sqlite.run("BEGIN");
    try {
      const fn = code.functions.get(job.name);
      if (!fn || fn.type !== "query") throw new OnebaseError(`"${job.name}" isn't a query in this worker's copy of the code.`);
      const mount = code.componentFunctions.get(job.name)?.mount ?? null;
      const budget = new CallBudget(job.name, "query", init.callLimits);
      const db = new DatabaseImpl({
        tx,
        dialect: sqliteDialect,
        catalog: code.catalog,
        nextCreationTime: () => {
          throw new OnebaseError("Queries are read-only.");
        },
        readSet: run.readSet,
        budget,
      });
      const value = await lines.run(output, () => invoke(run, job.name, fn, queryCtx(run, db, job.identity, mount), job.args));
      budget.check(); // a limit error the function caught still fails the query
      if (run.mainThread) throw new MainThreadOnly(run.mainThread);
      post({ t: "done", job: job.job, ok: true, json: valueJson(value), readSet: run.readSet, lines: output });
    } catch (err) {
      if (run.mainThread) post({ t: "done", job: job.job, ok: false, mainThread: run.mainThread, lines: output });
      else post({ t: "done", job: job.job, ok: false, error: toWire(err), readSet: run.readSet, lines: output });
    } finally {
      sqlite.run("COMMIT");
    }
  };

  // One query at a time: the connection holds one snapshot. The main thread sends one at a time too.
  let queue: Promise<void> = Promise.resolve();
  self.onmessage = (event: MessageEvent<ToQueryThread>) => {
    const m = event.data;
    if (m.t === "query") queue = queue.then(() => execute(m));
  };
  post({ t: "ready", functions: [...code.functions.keys()] });
}
