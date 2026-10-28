// Components: packages with their own tables and functions that an app mounts in
// onebase/components.ts and calls as ctx.components.<mount>.<function>(args). Imported as
// "onebase/components". The components that ship with onebase are written with this same API.

import type { FunctionType } from "../api";
import { MOUNT_NAME } from "../engine/catalog";
import type { GenericDataModel, SchemaDefinition } from "../schema";
import {
  functionBuilder,
  isRegisteredFunction,
  type ActionCtx,
  type Auth,
  type FunctionBuilder,
  type MutationCtx,
  type QueryCtx,
  type RegisteredFunction,
  type Scheduler,
} from "../server";

/** Options every component takes when mounted, next to its own configuration. */
export type MountOptions = {
  /**
   * Let the component see who is calling: its functions get the caller's `ctx.auth`. Off by
   * default, so a component only knows what the app passes it (Convex components never see it).
   */
  auth?: boolean;
};

const MOUNT_OPTIONS = ["auth"] as const;

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

/** A component mounted under a name: what `rateLimiter({...})` returns. */
export interface Mount<Api = any> {
  readonly __onebase: "componentMount";
  readonly definition: ComponentDefinition<any, any, any>;
  readonly config: unknown;
  readonly options: MountOptions;
  /** Type-only marker. */
  readonly __api?: Api;
}

/** onebase/components.ts's default export. */
export type ComponentsDefinition<M extends Record<string, Mount<any>> = Record<string, Mount<any>>> = {
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
  C extends ComponentsDefinition<infer M> ? { [N in keyof M]: CallableApi<NonNullable<M[N]["__api"]>, K> } : {};

/**
 * Mounts components: `export default defineComponents({ limiter: rateLimiter({...}) })` in
 * onebase/components.ts. Each mount gets its own tables, so the same component can be mounted
 * twice under different names.
 */
export function defineComponents<const M extends Record<string, Mount<any>>>(mounts: M): ComponentsDefinition<M> {
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

/** What a component's functions can call besides ctx.db: their own functions, by the function itself. */
type OwnCall<T extends FunctionType> = <A, R>(fn: RegisteredFunction<T, any, A, R>, args?: A) => Promise<R>;

type ComponentBase<Config> = {
  /** The configuration the app mounted this instance with. */
  config: Config;
  /** Which mount this call runs in (the name in components.ts). */
  component: { mount: string };
  /** The caller's identity if the app mounted the component with `auth: true`; otherwise always null. */
  auth: Auth;
};

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

/** Schedules the component's own functions (pass the function itself). */
export type ComponentScheduler = {
  runAfter<A>(delayMs: number, fn: RegisteredFunction<any, any, A, any>, args?: A): Promise<string>;
  runAt<A>(timestamp: number | Date, fn: RegisteredFunction<any, any, A, any>, args?: A): Promise<string>;
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
  };
}

/** A component's functions: `{ limit, check }`, or nested like `{ lib: { limit } }`. */
export type FunctionTree = { [name: string]: RegisteredFunction | FunctionTree };

export interface ComponentDefinition<S extends SchemaDefinition<any>, Config, Fns extends FunctionTree> {
  readonly __onebase: "component";
  /** A label for the dashboard and error messages, e.g. "rateLimiter". */
  readonly name: string;
  readonly schema: S;
  readonly functions: Fns;
  readonly checkConfig?: (config: Config) => void;
  /** Mounts this component with its configuration; components usually wrap this in a factory. */
  mount(config: Config, options?: MountOptions): Mount<ApiFromFunctions<Fns>>;
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
    mount(config, options = {}) {
      def.checkConfig?.(config);
      for (const key of Object.keys(options)) {
        if (!(MOUNT_OPTIONS as readonly string[]).includes(key)) throw new Error(`Component "${def.name}": unknown mount option "${key}".`);
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
