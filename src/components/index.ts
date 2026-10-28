// Components: packages with their own tables and functions that an app mounts in
// onebase/components.ts and calls as ctx.components.<mount>.<function>(args). Imported as
// "onebase/components". The components that ship with onebase are written with this same API.

import type { FunctionHandle, FunctionReference, FunctionType } from "../api";
import { MOUNT_NAME } from "../engine/catalog";
import type { GenericDataModel, SchemaDefinition } from "../schema";
import { v } from "../values";
import {
  functionBuilder,
  isRegisteredFunction,
  type ActionCtx,
  type Auth,
  type FunctionBuilder,
  type HttpAction,
  type HttpMethod,
  type MutationCtx,
  type QueryCtx,
  type RegisteredFunction,
  type Scheduler,
} from "../server";

/** Options every component takes when mounted, next to its own configuration. */
export type MountOptions<Exposed extends string = string> = {
  /**
   * Let the component see who is calling: its functions get the caller's `ctx.auth`. Off by
   * default, so a component only knows what the app passes it (Convex components never see it).
   */
  auth?: boolean;
  /**
   * Public functions browser clients may call directly, as `api.components.<mount>.<fn>`
   * (nested ones as "lib.fn"). Without it, clients reach a component only through your functions.
   */
  expose?: readonly Exposed[];
  /** Where the component's HTTP routes are served (default "/<mount>"); false turns them off. */
  httpPrefix?: string | false;
};

const MOUNT_OPTIONS = ["auth", "expose", "httpPrefix"] as const;

/** A component function as the app calls it: `Call` is its exact signature. */
export type ComponentFn<Type extends FunctionType, Call> = { readonly __componentFn: Type; readonly __call: Call };

/** The functions a component's `functions` tree exposes to the app (internal ones are left out). */
export type ApiFromFunctions<Fns> = {
  [K in keyof Fns as Fns[K] extends RegisteredFunction<any, "internal", any, any> ? never : K]: Fns[K] extends RegisteredFunction<
    infer T,
    "public",
    infer A,
    infer R
  >
    ? ComponentFn<T, keyof A extends never ? (args?: A) => Promise<R> : (args: A) => Promise<R>>
    : ApiFromFunctions<Fns[K]>;
};

/** What every mount has at runtime. */
export interface MountBase {
  readonly __onebase: "componentMount";
  readonly definition: ComponentDefinition<any, any, any>;
  readonly config: unknown;
  readonly options: MountOptions;
}

/** A component mounted under a name: what `rateLimiter({...})` returns. */
export interface Mount<Api = any, Exposed extends string = never> extends MountBase {
  /** Type-only markers. */
  readonly __api?: Api;
  readonly __exposed?: Exposed;
}

/**
 * onebase/components.ts's default export. Mounts are constrained by MountBase, which has no type
 * markers, so TypeScript infers each mount's exposed names from its own call.
 */
export type ComponentsDefinition<M extends Record<string, MountBase> = Record<string, MountBase>> = {
  readonly __onebase: "components";
  readonly mounts: M;
};

type Allowed<K extends FunctionType> = K extends "query" ? "query" : K extends "mutation" ? "query" | "mutation" : FunctionType;

/** A component's API as one kind of function may call it: queries only see queries, mutations queries and mutations. */
export type CallableApi<Api, K extends FunctionType> = {
  [N in keyof Api as Api[N] extends ComponentFn<infer T, any> ? (T extends Allowed<K> ? N : never) : N]: Api[N] extends ComponentFn<
    any,
    infer Call
  >
    ? Call
    : CallableApi<Api[N], K>;
};

/** `ctx.components` for a function of kind `K`. */
export type ComponentsCtx<C, K extends FunctionType> =
  C extends ComponentsDefinition<infer M> ? { [N in keyof M]: M[N] extends Mount<infer Api, any> ? CallableApi<NonNullable<Api>, K> : never } : {};

type RefOf<T extends FunctionType, V extends "public" | "internal", Call> = Call extends (...args: infer P) => Promise<infer R>
  ? FunctionReference<T, V, P extends [] ? {} : NonNullable<P[0]>, R>
  : never;

/** References to the functions in a component's API whose dotted paths are in `E` (all of them for `string`). */
type RefsOf<Api, V extends "public" | "internal", E extends string> = {
  [N in keyof Api & string as Api[N] extends ComponentFn<any, any> ? (N extends E ? N : never) : E extends N | `${N}.${string}` ? N : never]: Api[N] extends ComponentFn<
    infer T,
    infer Call
  >
    ? RefOf<T, V, Call>
    : RefsOf<Api[N], V, string extends E ? string : E extends `${N}.${infer Rest}` ? Rest : never>;
};

/**
 * `api.components` (the functions each mount exposes to clients) and `internal.components` (all
 * their public functions, for the scheduler and crons): written into _generated/api.ts.
 */
export type ComponentsApi<C, V extends "public" | "internal"> =
  C extends ComponentsDefinition<infer M>
    ? { [N in keyof M]: M[N] extends Mount<infer Api, infer E> ? RefsOf<NonNullable<Api>, V, V extends "public" ? E : string> : never }
    : {};

/**
 * Mounts components: `export default defineComponents({ limiter: rateLimiter({...}) })` in
 * onebase/components.ts. Each mount gets its own tables, so the same component can be mounted
 * twice under different names.
 */
export function defineComponents<const M extends Record<string, MountBase>>(mounts: M): ComponentsDefinition<M> {
  for (const [name, mount] of Object.entries(mounts)) {
    if (!MOUNT_NAME.test(name)) {
      throw new Error(`Invalid component name "${name}": use letters, digits and _ (start with a letter, at most 32 characters).`);
    }
    if ((mount as any)?.__onebase !== "componentMount") {
      throw new Error(`components.ts: "${name}" must be a mounted component, e.g. ${name}: rateLimiter({ ... }).`);
    }
  }
  return { __onebase: "components", mounts };
}

// ---- Writing a component ----

/**
 * What a component's functions can call besides ctx.db: their own functions (pass the function
 * itself), and handles the app gave them (createFunctionHandle), which may be the app's.
 */
type OwnCall<T extends FunctionType> = <A, R>(fn: RegisteredFunction<T, any, A, R> | FunctionHandle<T, A, R>, args?: A) => Promise<R>;

type ComponentBase<Config> = {
  /** The configuration the app mounted this instance with. */
  config: Config;
  /** Which mount this call runs in (the name in components.ts). */
  component: { mount: string };
  /** The caller's identity if the app mounted the component with `auth: true`; otherwise always null. */
  auth: Auth;
  /** Where the component's table hooks stand. */
  hooks: { status(table?: string): Promise<HookStatus> };
};

/**
 * "ready": every document of the table has reached the hook. "backfilling": documents written
 * before the hook existed (or before its fingerprint changed) are still being fed to it.
 * "resetting": the component is clearing what it derived before a rebuild.
 */
export type HookStatus = { table: string; state: "ready" | "backfilling" | "resetting"; ready: boolean };

export type ComponentQueryCtx<DM, Config> = Pick<QueryCtx<DM>, "db"> & ComponentBase<Config> & { runQuery: OwnCall<"query"> };
export type ComponentMutationCtx<DM, Config> = Pick<MutationCtx<DM>, "db"> &
  ComponentBase<Config> & { runQuery: OwnCall<"query">; runMutation: OwnCall<"mutation">; scheduler: ComponentScheduler };
export type ComponentActionCtx<DM, Config> = Pick<ActionCtx<DM>, "vectorSearch"> &
  ComponentBase<Config> & {
    runQuery: OwnCall<"query">;
    runMutation: OwnCall<"mutation">;
    runAction: OwnCall<"action">;
    scheduler: ComponentScheduler;
  };

/** Schedules the component's own functions (pass the function itself) or handles it was given. */
export type ComponentScheduler = {
  runAfter<A>(delayMs: number, fn: RegisteredFunction<any, any, A, any> | FunctionHandle<any, A, any>, args?: A): Promise<string>;
  runAt<A>(timestamp: number | Date, fn: RegisteredFunction<any, any, A, any> | FunctionHandle<any, A, any>, args?: A): Promise<string>;
  /** Cancels one of the component's own scheduled jobs. */
  cancel: Scheduler["cancel"];
};

/**
 * Function builders for a component's code, typed with its own tables and configuration:
 * `const { query, mutation } = componentServer<DataModel, Config>()`.
 */
export function componentServer<DM extends GenericDataModel, Config = {}>() {
  return {
    query: functionBuilder("query", "public") as FunctionBuilder<"query", "public", ComponentQueryCtx<DM, Config>>,
    mutation: functionBuilder("mutation", "public") as FunctionBuilder<"mutation", "public", ComponentMutationCtx<DM, Config>>,
    action: functionBuilder("action", "public") as FunctionBuilder<"action", "public", ComponentActionCtx<DM, Config>>,
    internalQuery: functionBuilder("query", "internal") as FunctionBuilder<"query", "internal", ComponentQueryCtx<DM, Config>>,
    internalMutation: functionBuilder("mutation", "internal") as FunctionBuilder<"mutation", "internal", ComponentMutationCtx<DM, Config>>,
    internalAction: functionBuilder("action", "internal") as FunctionBuilder<"action", "internal", ComponentActionCtx<DM, Config>>,
    /** A handler for the component's HTTP routes; ctx is the component's action ctx. */
    httpAction: (handler: (ctx: ComponentActionCtx<DM, Config>, request: Request) => Promise<Response> | Response): HttpAction => ({
      __onebase: "httpAction",
      handler: handler as unknown as HttpAction["handler"],
    }),
  };
}

/** A cron job a component runs for every mount: named `components/<mount>/<name>` in the dashboard. */
export type ComponentCron = {
  name: string;
  /** An interval ({ minutes: 5 }, at least 1 second) or a cron expression ("0 9 * * mon-fri", UTC). */
  schedule: { seconds?: number; minutes?: number; hours?: number } | string;
  /** One of the component's own functions. */
  fn: RegisteredFunction;
  args?: Record<string, unknown>;
};

/** An HTTP route, served under the mount's httpPrefix: `{ path: "/hook" }` on mount "stripe" is /stripe/hook. */
export type ComponentRoute = { method: HttpMethod; handler: HttpAction } & ({ path: string; pathPrefix?: undefined } | { pathPrefix: string; path?: undefined });

// ---- Table hooks ----

/** One document's change, as a table hook receives it. Several writes to a document in one transaction arrive as one change. */
export type TableChange<Doc = Record<string, any> & { _id: string; _creationTime: number }> =
  | { op: "insert"; id: string; before: null; after: Doc }
  | { op: "update"; id: string; before: Doc; after: Doc }
  | { op: "delete"; id: string; before: Doc; after: null };

/** The args a table hook's onChange mutation takes: `internalMutation({ args: tableChangesValidator, ... })`. */
export const tableChangesValidator = {
  changes: v.array(v.object({ op: v.string(), id: v.string(), before: v.any(), after: v.any() })),
};

/**
 * Keeps a component in step with an app table: `onChange` gets every change to `table`, in the
 * writing transaction, before the component is next called and before commit. Documents that
 * existed before the hook are fed to it in batches (as inserts), after `reset` has cleared what
 * the component derived earlier. Changing `fingerprint` (say, when the configuration changes)
 * resets and rebuilds.
 */
export type TableHook = {
  /** An app table (from schema.ts). */
  table: string;
  /** An internal mutation of the component, taking tableChangesValidator. */
  onChange: RegisteredFunction<"mutation", "internal", any, any>;
  /** An internal mutation that deletes some of the derived data and returns { done: true } once nothing is left. */
  reset?: RegisteredFunction<"mutation", "internal", any, { done: boolean }>;
  fingerprint?: string;
};

/** A component's functions: `{ limit, check }`, or nested like `{ lib: { limit } }`. */
export type FunctionTree = { [name: string]: RegisteredFunction | FunctionTree };

export interface ComponentDefinition<S extends SchemaDefinition<any>, Config, Fns extends FunctionTree> {
  readonly __onebase: "component";
  /** A label for the dashboard and error messages, e.g. "rateLimiter". */
  readonly name: string;
  readonly schema: S;
  readonly functions: Fns;
  readonly checkConfig?: (config: Config) => void;
  /** Table hooks for a mount, from its configuration. */
  readonly hooks?: (config: Config) => TableHook[];
  readonly crons?: (config: Config) => ComponentCron[];
  readonly http?: (config: Config) => ComponentRoute[];
  /** Mounts this component with its configuration; components usually wrap this in a factory. */
  mount<const E extends string = never>(config: Config, options?: MountOptions<E>): Mount<ApiFromFunctions<Fns>, E>;
}

/**
 * Defines a component: its tables, its functions and (optionally) a check of its configuration.
 * Functions are written with the builders from componentServer().
 */
export function defineComponent<S extends SchemaDefinition<any>, Config = {}, const Fns extends FunctionTree = {}>(def: {
  name: string;
  schema: S;
  functions: Fns;
  checkConfig?: (config: Config) => void;
  hooks?: (config: Config) => TableHook[];
  crons?: (config: Config) => ComponentCron[];
  http?: (config: Config) => ComponentRoute[];
}): ComponentDefinition<S, Config, Fns> {
  if (typeof def?.name !== "string" || !def.name) throw new Error("defineComponent({ name }) needs a name.");
  if (!(def.schema as any)?.__isOnebaseSchema) throw new Error(`Component "${def.name}": schema must come from defineSchema({ ... }).`);
  checkTree(def.name, def.functions, "");
  const definition: ComponentDefinition<S, Config, Fns> = {
    __onebase: "component",
    name: def.name,
    schema: def.schema,
    functions: def.functions,
    checkConfig: def.checkConfig,
    hooks: def.hooks,
    crons: def.crons,
    http: def.http,
    mount(config, options = {}) {
      def.checkConfig?.(config);
      for (const key of Object.keys(options)) {
        if (!(MOUNT_OPTIONS as readonly string[]).includes(key)) throw new Error(`Component "${def.name}": unknown mount option "${key}".`);
      }
      for (const name of options.expose ?? []) {
        const fn = String(name).split(".").reduce<any>((tree, key) => (tree && !isRegisteredFunction(tree) ? tree[key] : undefined), def.functions);
        if (!isRegisteredFunction(fn)) throw new Error(`Component "${def.name}": can't expose "${name}": it has no such function.`);
        if (fn.visibility === "internal") throw new Error(`Component "${def.name}": can't expose "${name}": it's internal to the component.`);
      }
      const prefix = options.httpPrefix;
      if (prefix !== undefined && prefix !== false && (typeof prefix !== "string" || !/^\/[A-Za-z0-9_\-./]*[^/]$/.test(prefix))) {
        throw new Error(`Component "${def.name}": httpPrefix must be a path like "/stripe" (no trailing slash), or false.`);
      }
      return { __onebase: "componentMount", definition, config, options };
    },
  };
  return definition;
}

function checkTree(component: string, tree: unknown, path: string) {
  if (typeof tree !== "object" || tree === null) throw new Error(`Component "${component}": functions must be an object of functions.`);
  for (const [key, value] of Object.entries(tree)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Component "${component}": invalid function name "${path}${key}".`);
    if (!isRegisteredFunction(value)) checkTree(component, value, `${path}${key}.`);
  }
}

/** Splits a factory's argument into the component's configuration and the mount options. */
export function splitMountOptions<T extends MountOptions>(opts: T): { config: Omit<T, keyof MountOptions>; options: MountOptions } {
  const config: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts ?? {})) ((MOUNT_OPTIONS as readonly string[]).includes(k) ? options : config)[k] = v;
  return { config: config as Omit<T, keyof MountOptions>, options };
}
