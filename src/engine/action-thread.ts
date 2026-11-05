// The worker side of action workers (see action-pool.ts): loads its own copy of the project's
// code, runs the actions it's given, and sends everything that needs the database (ctx.runQuery,
// ctx.scheduler, ctx.storage, ...) back to the main thread, which runs it as it would for an
// action on the main thread.

import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";
import { getFunctionName, isFunctionHandle } from "../api";
import { importBundle, loadProjectCode } from "../project";
import { isRegisteredFunction, type RegisteredFunction, type UserIdentity } from "../server";
import { encodeRefs, fromWire, toWire, type CodeSource, type FromThread, type ToThread, type WireFilter } from "./action-wire";
import { indexCode, lookupRoute, type IndexedCode, type MountCode } from "./code";
import { OnebaseError } from "./database";
import { currentFunction } from "./guard";
import type { HttpRouter } from "../server";
import type { ProjectCode } from "./runtime";

type Loaded = IndexedCode & { http: HttpRouter | null };
type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };
type Job = { name: string; pending: Map<number, Pending>; seq: number; body?: ReadableStreamDefaultReader<Uint8Array> };

const post = (message: FromThread, transfer?: Transferable[]) => (self as unknown as Worker).postMessage(message, transfer ?? []);

/**
 * Starts answering the main thread. `embedded` is the project built into this worker's entry,
 * for binaries from `onebase build`.
 */
export function serveActions(embedded?: () => ProjectCode | Promise<ProjectCode>) {
  const jobs = new Map<number, Job>();
  const running = new AsyncLocalStorage<number>();
  let code: Loaded | null = null;

  // A stray error (a promise nobody awaited, a throw in a timer) is logged rather than ending the
  // thread, and with it every other action running on it.
  process.on("unhandledRejection", (reason) => console.error(reason));
  process.on("uncaughtException", (err) => console.error(err));

  // A function's console output also goes to its call's record on the main thread.
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      const job = running.getStore();
      if (job !== undefined) post({ t: "log", job, level, text: format(...args) });
      original(...args);
    };
  }

  const load = async (source: CodeSource): Promise<ProjectCode> => {
    if ("embedded" in source) {
      if (!embedded) throw new Error("this worker has no code built in");
      return embedded();
    }
    return "dir" in source ? loadProjectCode(source.dir) : importBundle(source.bundle, source.id);
  };

  /** A ctx call, run on the main thread. */
  const request = (id: number, op: string[], args: unknown[]): Promise<unknown> => {
    const job = jobs.get(id);
    if (!job) {
      // As on Convex: an action's promises it didn't await don't outlive it.
      return Promise.reject(new OnebaseError(`ctx.${op.join(".")} was called after its action had returned. Await it before returning.`));
    }
    const seq = job.seq++;
    return new Promise((resolve, reject) => {
      job.pending.set(seq, { resolve, reject });
      try {
        post({ t: "call", job: id, seq, op, args });
      } catch (err) {
        job.pending.delete(seq);
        reject(new OnebaseError(`Arguments to ctx.${op.join(".")} must be values that can be copied to another thread: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
  };

  /** What names a function for the main thread: a reference, name or handle, or (for a component) one of its own functions. */
  const refName = (ref: unknown, mount: MountCode | null): string => {
    if (isFunctionHandle(ref)) return ref;
    if (!isRegisteredFunction(ref)) return getFunctionName(ref as any);
    const name = mount?.names.get(ref);
    if (!name) {
      throw new OnebaseError(
        mount
          ? `Component "${mount.name}" passed a function that isn't one of its own.`
          : `Pass a function reference (api.messages.list) or name ("messages:list"), not the function itself.`,
      );
    }
    return name;
  };

  /** The ctx an action gets, as on the main thread; everything that touches data goes there. */
  const actionCtx = (id: number, identity: UserIdentity | null, mount: MountCode | null): any => {
    const call = (...op: string[]) => (...args: unknown[]) => request(id, op, args);
    const named = (...op: string[]) => async (ref: unknown, args?: unknown) => request(id, op, [refName(ref, mount), encodeRefs(args)]);
    const runQuery = named("runQuery");
    const runMutation = named("runMutation");
    const runAction = named("runAction");
    const scheduler = {
      runAfter: async (delayMs: number, ref: unknown, args?: unknown) => request(id, ["scheduler", "runAfter"], [delayMs, refName(ref, mount), encodeRefs(args)]),
      runAt: async (ts: number | Date, ref: unknown, args?: unknown) => request(id, ["scheduler", "runAt"], [ts, refName(ref, mount), encodeRefs(args)]),
      cancel: call("scheduler", "cancel"),
    };
    const vectorSearch = async (table: string, index: string, query: { vector?: unknown; limit?: unknown; filter?: unknown }) => {
      const sent = query && typeof query === "object" ? { ...query, filter: typeof query.filter === "function" ? recordFilter(query.filter as any) : query.filter } : query;
      return request(id, ["vectorSearch"], [table, index, sent]);
    };
    const ctx: Record<string, unknown> = mount
      ? {
          auth: { getUserIdentity: async () => identity },
          config: mount.config,
          component: { mount: mount.name },
          hooks: { status: call("hooks", "status") },
          scheduler,
          runQuery,
          runMutation,
          runAction,
          vectorSearch,
        }
      : {
          auth: { getUserIdentity: async () => identity },
          storage: Object.fromEntries(["getUrl", "getMetadata", "generateUploadUrl", "delete", "store", "get"].map((k) => [k, call("storage", k)])),
          scheduler,
          runQuery,
          runMutation,
          runAction,
          vectorSearch,
          components: componentsProxy(id),
        };
    Object.defineProperty(ctx, "db", {
      get() {
        throw new OnebaseError("ctx.db isn't available in actions. Read with ctx.runQuery(internal.x.y, args) and write with ctx.runMutation(...).");
      },
    });
    return ctx;
  };

  /** ctx.components.<mount>.<fn>(args), checked here as on the main thread, which checks it again. */
  const componentsProxy = (id: number) => {
    const node = (mount: MountCode, tree: Record<string, unknown>, path: string[]): unknown =>
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
            return (args?: unknown) => request(id, ["components", mount.name, ...path, prop], [encodeRefs(args)]);
          },
        },
      );
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== "string" || prop === "then") return undefined;
          const mount = code!.mounts.get(prop);
          if (!mount) throw new OnebaseError(`No component "${prop}" in components.ts. Mounted: ${[...code!.mounts.keys()].join(", ") || "(none)"}.`);
          return node(mount, mount.definition.functions, []);
        },
      },
    );
  };

  /** Runs `body` as action `name` of job `id`, with console output and handles going to the main thread. */
  const asAction = <T>(id: number, name: string, mount: MountCode | null, body: () => Promise<T>) =>
    running.run(id, () =>
      currentFunction.run({ type: "action", name, handle: ((ref: unknown) => request(id, ["handle"], [refName(ref, mount)])) as any }, body),
    );

  /** An action has returned: ctx calls it didn't wait for get no answer, so they fail now. */
  const end = (id: number) => {
    const job = jobs.get(id);
    jobs.delete(id);
    for (const waiting of job?.pending.values() ?? []) {
      waiting.reject(new OnebaseError(`${job!.name} returned before this ctx call finished, so its result is lost (it may still have run). Await ctx calls before returning.`));
    }
  };

  const finish = (id: number, result: { ok: true; value: unknown } | { ok: false; error: unknown }) => {
    if (result.ok) {
      try {
        return post({ t: "done", job: id, ok: true, value: result.value });
      } catch (err) {
        result = { ok: false, error: new OnebaseError(`The action returned a value that can't be copied to another thread: ${err instanceof Error ? err.message : String(err)}`) };
      }
    }
    post({ t: "done", job: id, ok: false, error: toWire((result as { error: unknown }).error) });
  };

  const run = async (m: Extract<ToThread, { t: "run" }>) => {
    jobs.set(m.job, { name: m.name, pending: new Map(), seq: 0 });
    try {
      const fn = code!.functions.get(m.name);
      if (!fn || fn.type !== "action") throw new OnebaseError(`"${m.name}" isn't an action in this worker's copy of the code.`);
      const mount = code!.componentFunctions.get(m.name)?.mount ?? null;
      const value = await asAction(m.job, m.name, mount, async () => (fn as RegisteredFunction).handler(actionCtx(m.job, m.identity, mount), m.args));
      end(m.job);
      finish(m.job, { ok: true, value });
    } catch (error) {
      end(m.job);
      finish(m.job, { ok: false, error });
    }
  };

  const http = async (m: Extract<ToThread, { t: "http" }>) => {
    const url = new URL(m.url);
    const name = `${m.method} ${url.pathname}`;
    const job: Job = { name, pending: new Map(), seq: 0 };
    jobs.set(m.job, job);
    try {
      const route = lookupRoute(code!.http, code!.mounts.values(), m.method, url.pathname);
      const mount = m.mount === null ? null : (code!.mounts.get(m.mount) ?? null);
      if (!route || route.mount?.name !== mount?.name) throw new OnebaseError(`No route for ${m.method} ${url.pathname} in this worker's copy of the code.`);
      const request = new Request(m.url, { method: m.method, headers: m.headers, body: m.body });
      const response = await asAction(m.job, name, mount, async () => route.handler.handler(actionCtx(m.job, m.identity, mount), request));
      if (!(response instanceof Response)) throw new OnebaseError(`The HTTP action for ${name} must return a Response.`);
      job.body = response.body?.getReader();
      post({ t: "head", job: m.job, status: response.status, statusText: response.statusText, headers: [...response.headers], body: !!job.body });
      if (!job.body) end(m.job);
    } catch (error) {
      end(m.job);
      finish(m.job, { ok: false, error });
    }
  };

  /** The next piece of an HTTP action's response body. */
  const pull = async (id: number) => {
    const job = jobs.get(id);
    if (!job?.body) return;
    try {
      const { done, value } = await job.body.read();
      if (done) {
        end(id);
        return post({ t: "end", job: id });
      }
      // Copied, not transferred: the function may still hold (and reuse) the chunk it enqueued.
      post({ t: "chunk", job: id, data: value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer) });
    } catch (error) {
      end(id);
      finish(id, { ok: false, error });
    }
  };

  self.onmessage = async (event: MessageEvent<ToThread>) => {
    const m = event.data;
    switch (m.t) {
      case "init":
        try {
          const loaded = await load(m.source);
          code = { ...indexCode(loaded, (mount) => mount), http: loaded.http };
          post({ t: "ready", functions: [...code.functions.keys()] });
        } catch (err) {
          post({ t: "failed", error: err instanceof Error ? err.message : String(err) });
        }
        return;
      case "run":
        return run(m);
      case "http":
        return http(m);
      case "result": {
        const pending = jobs.get(m.job)?.pending;
        const waiting = pending?.get(m.seq);
        if (!waiting) return;
        pending!.delete(m.seq);
        if (m.ok) waiting.resolve(m.value);
        else waiting.reject(fromWire(m.error));
        return;
      }
      case "pull":
        return pull(m.job);
      case "cancel": {
        const body = jobs.get(m.job)?.body;
        end(m.job);
        await body?.cancel().catch(() => {});
        return;
      }
      case "ping":
        return post({ t: "pong", n: m.n });
    }
  };
}

/** A vector search filter callback, run against a builder that records what it asked for. */
function recordFilter(filter: (q: unknown) => unknown): WireFilter {
  const built = new WeakSet<object>();
  const mark = (f: WireFilter) => (built.add(f), f);
  const q = {
    eq: (field: string, value: unknown) => mark({ op: "eq", field, value }),
    or: (...args: WireFilter[]) => {
      if (!args.every((a) => typeof a === "object" && a !== null && built.has(a))) throw new OnebaseError(`q.or() takes q.eq(...) or q.or(...) filters.`);
      return mark({ op: "or", args });
    },
  };
  const result = filter(q);
  if (typeof result !== "object" || result === null || !built.has(result)) throw new OnebaseError(`vectorSearch() filter must return q.eq(...) or q.or(...).`);
  return result as WireFilter;
}
