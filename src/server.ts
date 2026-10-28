// Public API for writing backend functions (imported as "onebase/server").
// Builders here are pure: they only describe functions. The engine runs them.

import type {
  FunctionArgs,
  FunctionLike,
  FunctionReference,
  FunctionReturnType,
  FunctionType,
  FunctionVisibility,
} from "./api";
import { getFunctionName, type FunctionHandle } from "./api";
import { currentFunction } from "./engine/guard";
import { parseCron } from "./cron";
import type { ComponentsCtx } from "./components";
import type { AnyDataModel, GenericDataModel, GenericTableInfo, SearchIndexConfig, VectorIndexConfig } from "./schema";
import {
  asObjectValidator,
  type AnyValidator,
  type GenericId,
  type Infer,
  type ObjectType,
  type PropertyValidators,
} from "./values";

export { anyApi, getFunctionName, isFunctionHandle } from "./api";
export type { FunctionArgs, FunctionHandle, FunctionReference, FunctionReturnType } from "./api";
export { defineSchema, defineTable } from "./schema";
import { defineTable } from "./schema";
export type { DataModelFromSchema } from "./schema";
export { ConvexError, v } from "./values";
export type { GenericId, Infer } from "./values";
import { v } from "./values";

/** Use as `args: { paginationOpts: paginationOptsValidator }` and pass it to `.paginate()`. */
export const paginationOptsValidator = v.object({
  numItems: v.number(),
  cursor: v.union(v.string(), v.null()),
  endCursor: v.optional(v.union(v.string(), v.null())),
});

// ---- Database ----

type TableNames<DM> = keyof DM & string;
type DocOf<DM, T extends keyof DM> = DM[T] extends GenericTableInfo ? DM[T]["document"] : any;
type WithoutSystemFields<D> = { [K in keyof D as K extends "_id" | "_creationTime" ? never : K]: D[K] };
type IndexesOf<DM, T extends keyof DM> = DM[T] extends GenericTableInfo ? DM[T]["indexes"] : Record<string, string[]>;
type SearchIndexesOf<DM, T extends keyof DM> = DM[T] extends { searchIndexes: infer S extends Record<string, SearchIndexConfig> }
  ? S
  : Record<string, SearchIndexConfig>;
type VectorIndexesOf<DM, T extends keyof DM> = DM[T] extends { vectorIndexes: infer V extends Record<string, VectorIndexConfig> }
  ? V
  : Record<string, VectorIndexConfig>;

export type Expression<T = unknown> = { readonly __expr: true; readonly __t?: T };
type ExprOrValue<T> = Expression<T> | T;

export interface FilterBuilder<Doc> {
  field<P extends keyof Doc & string>(path: P): Expression<Doc[P]>;
  field(path: string): Expression<any>;
  eq<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  neq<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  lt<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  lte<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  gt<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  gte<T>(a: ExprOrValue<T>, b: ExprOrValue<T>): Expression<boolean>;
  and(...exprs: ExprOrValue<boolean>[]): Expression<boolean>;
  or(...exprs: ExprOrValue<boolean>[]): Expression<boolean>;
  not(expr: ExprOrValue<boolean>): Expression<boolean>;
  add(a: ExprOrValue<number>, b: ExprOrValue<number>): Expression<number>;
  sub(a: ExprOrValue<number>, b: ExprOrValue<number>): Expression<number>;
  mul(a: ExprOrValue<number>, b: ExprOrValue<number>): Expression<number>;
  div(a: ExprOrValue<number>, b: ExprOrValue<number>): Expression<number>;
  mod(a: ExprOrValue<number>, b: ExprOrValue<number>): Expression<number>;
  neg(a: ExprOrValue<number>): Expression<number>;
}

export interface IndexRangeBuilder<Doc, Fields extends string = string> {
  eq<F extends Fields>(field: F, value: F extends keyof Doc ? Doc[F] : any): IndexRangeBuilder<Doc, Fields>;
  gt<F extends Fields>(field: F, value: F extends keyof Doc ? Doc[F] : any): IndexRangeBuilder<Doc, Fields>;
  gte<F extends Fields>(field: F, value: F extends keyof Doc ? Doc[F] : any): IndexRangeBuilder<Doc, Fields>;
  lt<F extends Fields>(field: F, value: F extends keyof Doc ? Doc[F] : any): IndexRangeBuilder<Doc, Fields>;
  lte<F extends Fields>(field: F, value: F extends keyof Doc ? Doc[F] : any): IndexRangeBuilder<Doc, Fields>;
}

export type PaginationOptions = { numItems: number; cursor: string | null; endCursor?: string | null };
export type PaginationResult<T> = { page: T[]; isDone: boolean; continueCursor: string };

export interface OrderedQuery<Doc> extends AsyncIterable<Doc> {
  /** Convex style: `.filter(q => q.eq(q.field("done"), false))`, or shorthand `.filter({ done: false })`. */
  filter(predicate: ((q: FilterBuilder<Doc>) => Expression<boolean>) | Partial<Doc>): this;
  collect(): Promise<Doc[]>;
  take(n: number): Promise<Doc[]>;
  first(): Promise<Doc | null>;
  /** Returns the only match, null if none, and throws if there is more than one. */
  unique(): Promise<Doc | null>;
  paginate(options: PaginationOptions): Promise<PaginationResult<Doc>>;
}

export interface Query<Doc> extends OrderedQuery<Doc> {
  order(order: "asc" | "desc"): OrderedQuery<Doc>;
}

/** Marks a finished search expression; built by `q.search(...)`. */
export type SearchFilter = { readonly __searchFilter: true };

export interface SearchFilterBuilder<Doc, Index extends SearchIndexConfig> {
  /** Documents whose `field` contains any of the words in `text` (the last word also matches as a prefix), best matches first. */
  search(field: Index["searchField"], text: string): SearchFilterFinalizer<Doc, Index>;
}

export interface SearchFilterFinalizer<Doc, Index extends SearchIndexConfig> extends SearchFilter {
  /** Only documents where a `filterFields` field equals `value`. */
  eq<F extends Index["filterFields"]>(field: F, value: F extends keyof Doc ? Doc[F] : any): SearchFilterFinalizer<Doc, Index>;
}

export interface QueryInitializer<
  Doc,
  Indexes extends Record<string, string[]>,
  SearchIndexes extends Record<string, SearchIndexConfig> = Record<string, SearchIndexConfig>,
> extends Query<Doc> {
  withIndex<I extends keyof Indexes & string>(
    indexName: I,
    range?: (q: IndexRangeBuilder<Doc, Indexes[I][number]>) => IndexRangeBuilder<Doc, any>,
  ): Query<Doc>;
  /** Full-text search. Results come best match first (at most 1024), so `.order()` isn't available. */
  withSearchIndex<I extends keyof SearchIndexes & string>(
    indexName: I,
    search: (q: SearchFilterBuilder<Doc, SearchIndexes[I]>) => SearchFilter,
  ): OrderedQuery<Doc>;
  fullTableScan(): Query<Doc>;
}

export interface DatabaseReader<DM> {
  get<T extends TableNames<DM>>(id: GenericId<T>): Promise<DocOf<DM, T> | null>;
  /** Convex's table-first form: throws if `id` belongs to another table. */
  get<T extends TableNames<DM>>(table: T, id: GenericId<NoInfer<T>>): Promise<DocOf<DM, T> | null>;
  query<T extends TableNames<DM>>(table: T): QueryInitializer<DocOf<DM, T>, IndexesOf<DM, T>, SearchIndexesOf<DM, T>>;
  /** Returns the id if it is a valid id for `table`, otherwise null. */
  normalizeId<T extends TableNames<DM>>(table: T, id: string): GenericId<T> | null;
}

export interface DatabaseWriter<DM> extends DatabaseReader<DM> {
  insert<T extends TableNames<DM>>(table: T, value: WithoutSystemFields<DocOf<DM, T>>): Promise<GenericId<T>>;
  /** Shallow merge. Setting a field to undefined removes it. */
  patch<T extends TableNames<DM>>(id: GenericId<T>, value: Partial<WithoutSystemFields<DocOf<DM, T>>>): Promise<void>;
  patch<T extends TableNames<DM>>(table: T, id: GenericId<NoInfer<T>>, value: Partial<WithoutSystemFields<DocOf<DM, T>>>): Promise<void>;
  replace<T extends TableNames<DM>>(id: GenericId<T>, value: WithoutSystemFields<DocOf<DM, T>>): Promise<void>;
  replace<T extends TableNames<DM>>(table: T, id: GenericId<NoInfer<T>>, value: WithoutSystemFields<DocOf<DM, T>>): Promise<void>;
  delete(id: GenericId<string>): Promise<void>;
  delete<T extends TableNames<DM>>(table: T, id: GenericId<NoInfer<T>>): Promise<void>;
}

// ---- File storage ----

export type StorageId = GenericId<"_storage">;
export type FileMetadata = { _id: StorageId; _creationTime: number; sha256: string; size: number; contentType: string | null };

export interface StorageReader {
  /** A URL that serves the file, or null if it doesn't exist. */
  getUrl(id: StorageId | string): Promise<string | null>;
  getMetadata(id: StorageId | string): Promise<FileMetadata | null>;
}

export interface StorageWriter extends StorageReader {
  /** A one-time URL (valid 1 hour). The client POSTs the file to it and gets back `{ storageId }`. */
  generateUploadUrl(): Promise<string>;
  delete(id: StorageId | string): Promise<void>;
}

export interface StorageActionWriter extends StorageWriter {
  /** Saves a Blob (e.g. from `await fetch(url).then(r => r.blob())`) and returns its id. */
  store(blob: Blob): Promise<StorageId>;
  get(id: StorageId | string): Promise<Blob | null>;
}

export type { AuthConfig, AuthProvider } from "./engine/jwt";

// ---- Context ----

export type UserIdentity = {
  subject: string;
  tokenIdentifier: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
};

export interface Auth {
  getUserIdentity(): Promise<UserIdentity | null>;
}

/**
 * Tables for built-in auth: `defineSchema({ ...authTables, ... })`. To add your own user fields,
 * define `users` yourself and keep these fields (they must stay optional).
 */
export const authTables = {
  users: defineTable({
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
  }).index("email", ["email"]),
};

/** The signed-in user's id in the users table (built-in auth), or null if signed out or signed in another way. */
export async function getAuthUserId(ctx: { auth: Auth }): Promise<GenericId<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity?.tokenIdentifier.startsWith("onebase|") ? (identity.subject as GenericId<"users">) : null;
}

type Call<T extends FunctionType> = {
  <F extends FunctionReference<T, any>>(fn: F | string, args?: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  <A, R>(fn: FunctionHandle<T, A, R>, args?: A): Promise<R>;
};

type HandleOf<F> =
  F extends FunctionReference<infer T, any, infer A, infer R>
    ? FunctionHandle<T, A, R>
    : F extends RegisteredFunction<infer T, any, infer A, infer R>
      ? FunctionHandle<T, A, R>
      : FunctionHandle;

/**
 * A handle to a function, as a string you can store or pass to a component, which can then call it
 * (ctx.runMutation(handle, args)) or schedule it. Handles are signed: one can't be made up, and
 * it keeps working after restarts and on other instances. Like Convex, only inside functions.
 */
export async function createFunctionHandle<F extends FunctionReference | RegisteredFunction>(fn: F): Promise<HandleOf<F>> {
  const frame = currentFunction.getStore();
  if (!frame?.handle) throw new Error("createFunctionHandle() works inside a query, mutation or action.");
  return frame.handle(fn) as HandleOf<F>;
}

export interface Scheduler {
  runAfter(delayMs: number, fn: FunctionLike, args?: Record<string, unknown>): Promise<string>;
  runAt(timestamp: number | Date, fn: FunctionLike, args?: Record<string, unknown>): Promise<string>;
  cancel(id: string): Promise<void>;
}

export interface QueryCtx<DM = AnyDataModel, C = {}> {
  db: DatabaseReader<DM>;
  auth: Auth;
  storage: StorageReader;
  /** Runs another query in the same snapshot; what it reads makes this query re-run too. */
  runQuery: Call<"query">;
  /** The components mounted in components.ts (queries can call their queries). */
  components: ComponentsCtx<C, "query">;
}

export interface MutationCtx<DM = AnyDataModel, C = {}> {
  db: DatabaseWriter<DM>;
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
  runQuery: Call<"query">;
  runMutation: Call<"mutation">;
  /** The components mounted in components.ts, in this mutation's transaction. */
  components: ComponentsCtx<C, "mutation">;
}

export type VectorFilter = { readonly __vectorFilter: true };

export interface VectorFilterBuilder<Doc, Index extends VectorIndexConfig> {
  /** Only documents where a `filterFields` field equals `value`. */
  eq<F extends Index["filterFields"]>(field: F, value: F extends keyof Doc ? Doc[F] : any): VectorFilter;
  /** Documents that match any of the filters. */
  or(...filters: VectorFilter[]): VectorFilter;
}

export type VectorSearchQuery<Doc, Index extends VectorIndexConfig> = {
  /** The vector to compare against, with the index's number of dimensions. */
  vector: number[];
  /** How many results to return, from 1 to 256 (default 10). */
  limit?: number;
  filter?: (q: VectorFilterBuilder<Doc, Index>) => VectorFilter;
};

export interface ActionCtx<DM = AnyDataModel, C = {}> {
  auth: Auth;
  /** The components mounted in components.ts; each call is its own transaction. */
  components: ComponentsCtx<C, "action">;
  storage: StorageActionWriter;
  scheduler: Scheduler;
  runQuery: Call<"query">;
  runMutation: Call<"mutation">;
  runAction: Call<"action">;
  /**
   * The documents nearest to `query.vector` by cosine similarity, most similar first.
   * `_score` runs from -1 to 1; load the documents with ctx.runQuery().
   */
  vectorSearch<T extends TableNames<DM>, I extends keyof VectorIndexesOf<DM, T> & string>(
    table: T,
    index: I,
    query: VectorSearchQuery<DocOf<DM, T>, VectorIndexesOf<DM, T>[I]>,
  ): Promise<{ _id: GenericId<T>; _score: number }[]>;
}

// ---- Function builders ----

export type RegisteredFunction<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = FunctionVisibility,
  Args = any,
  Returns = any,
> = {
  readonly __onebase: "function";
  readonly type: Type;
  readonly visibility: Visibility;
  readonly args?: AnyValidator;
  readonly returns?: AnyValidator;
  readonly handler: (ctx: any, args: any) => any;
  /** Type-only markers. */
  readonly __args?: Args;
  readonly __returns?: Returns;
};

type InferArgs<A> = A extends AnyValidator ? Infer<A> : A extends PropertyValidators ? ObjectType<A> : never;

export interface FunctionBuilder<Type extends FunctionType, Visibility extends FunctionVisibility, Ctx> {
  <A extends PropertyValidators | AnyValidator, R>(def: {
    args: A;
    returns?: AnyValidator;
    handler: (ctx: Ctx, args: InferArgs<A>) => R;
  }): RegisteredFunction<Type, Visibility, InferArgs<A>, Awaited<R>>;
  <R>(
    def: { args?: undefined; returns?: AnyValidator; handler: (ctx: Ctx, args: {}) => R } | ((ctx: Ctx, args: {}) => R),
  ): RegisteredFunction<Type, Visibility, {}, Awaited<R>>;
}

export function functionBuilder(type: FunctionType, visibility: FunctionVisibility): any {
  return (def: any) => {
    const d = typeof def === "function" ? { handler: def } : def;
    if (typeof d?.handler !== "function") {
      throw new Error(
        `${visibility === "internal" ? "internal" + type[0]!.toUpperCase() + type.slice(1) : type}({...}) needs a handler: ` +
          `${type}({ args: { ... }, handler: async (ctx, args) => { ... } })`,
      );
    }
    return {
      __onebase: "function",
      type,
      visibility,
      args: d.args === undefined ? undefined : asObjectValidator(d.args),
      returns: d.returns,
      handler: d.handler,
    } satisfies RegisteredFunction;
  };
}

/**
 * Typed builders for a data model (and the components mounted in components.ts).
 * `_generated/server.ts` calls this with your schema's types.
 */
export function makeServer<DM extends GenericDataModel | AnyDataModel = AnyDataModel, C = {}>() {
  return {
    query: functionBuilder("query", "public") as FunctionBuilder<"query", "public", QueryCtx<DM, C>>,
    mutation: functionBuilder("mutation", "public") as FunctionBuilder<"mutation", "public", MutationCtx<DM, C>>,
    action: functionBuilder("action", "public") as FunctionBuilder<"action", "public", ActionCtx<DM, C>>,
    internalQuery: functionBuilder("query", "internal") as FunctionBuilder<"query", "internal", QueryCtx<DM, C>>,
    internalMutation: functionBuilder("mutation", "internal") as FunctionBuilder<"mutation", "internal", MutationCtx<DM, C>>,
    internalAction: functionBuilder("action", "internal") as FunctionBuilder<"action", "internal", ActionCtx<DM, C>>,
    httpAction: httpAction as (
      handler: (ctx: ActionCtx<DM, C>, request: Request) => Promise<Response> | Response,
    ) => HttpAction,
  };
}

export const { query, mutation, action, internalQuery, internalMutation, internalAction } = makeServer();

export function isRegisteredFunction(x: unknown): x is RegisteredFunction {
  return typeof x === "object" && x !== null && (x as any).__onebase === "function";
}

/** Maps a module's exports to typed references; used by `_generated/api.ts`. */
export type ApiFromModule<M, V extends FunctionVisibility> = {
  [K in keyof M as M[K] extends RegisteredFunction<any, V, any, any> ? K : never]: M[K] extends RegisteredFunction<
    infer T,
    V,
    infer A,
    infer R
  >
    ? FunctionReference<T, V, A, R>
    : never;
};

// ---- HTTP ----

export type HttpAction = {
  readonly __onebase: "httpAction";
  readonly handler: (ctx: ActionCtx<any>, request: Request) => Promise<Response> | Response;
};

export function httpAction(handler: HttpAction["handler"]): HttpAction {
  return { __onebase: "httpAction", handler };
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
export type RouteSpec = { method: HttpMethod; handler: HttpAction } & (
  | { path: string; pathPrefix?: undefined }
  | { pathPrefix: string; path?: undefined }
);

export class HttpRouter {
  readonly __onebase = "httpRouter";
  readonly routes: RouteSpec[] = [];

  route(spec: RouteSpec) {
    if (!spec.path && !spec.pathPrefix) throw new Error("http.route() needs `path` or `pathPrefix`.");
    if (spec.handler?.__onebase !== "httpAction") {
      throw new Error(`http.route({ handler }) must be wrapped in httpAction(async (ctx, request) => ...)`);
    }
    this.routes.push(spec);
  }

  lookup(method: string, pathname: string): HttpAction | null {
    const exact = this.routes.find((r) => r.method === method && r.path === pathname);
    if (exact) return exact.handler;
    const prefixed = this.routes
      .filter((r) => r.method === method && r.pathPrefix && pathname.startsWith(r.pathPrefix))
      .sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
    return prefixed?.handler ?? null;
  }
}

export function httpRouter(): HttpRouter {
  return new HttpRouter();
}

// ---- Cron jobs ----

export type CronSchedule = { type: "interval"; ms: number } | { type: "cron"; expression: string };
export type CronJob = { name: string; schedule: CronSchedule; fn: string; args: Record<string, unknown> };
type Weekday = "sunday" | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday";
const WEEKDAYS: Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Declared in crons.ts: `const crons = cronJobs(); crons.interval(...); export default crons;`. Times are UTC. */
export class Crons {
  readonly __onebase = "crons";
  readonly jobs: CronJob[] = [];

  private add(name: string, schedule: CronSchedule, fn: FunctionLike, args?: Record<string, unknown>) {
    if (this.jobs.some((j) => j.name === name)) throw new Error(`Cron job "${name}" is defined twice; names must be unique.`);
    if (schedule.type === "cron") parseCron(schedule.expression);
    this.jobs.push({ name, schedule, fn: getFunctionName(fn), args: args ?? {} });
  }

  interval(name: string, every: { seconds?: number; minutes?: number; hours?: number }, fn: FunctionLike, args?: Record<string, unknown>) {
    const ms = ((every.hours ?? 0) * 3600 + (every.minutes ?? 0) * 60 + (every.seconds ?? 0)) * 1000;
    if (!(ms >= 1000)) throw new Error(`crons.interval("${name}") needs at least 1 second, e.g. { minutes: 5 }.`);
    this.add(name, { type: "interval", ms }, fn, args);
  }

  /** Standard cron syntax, e.g. "0 9 * * mon-fri" (UTC). */
  cron(name: string, expression: string, fn: FunctionLike, args?: Record<string, unknown>) {
    this.add(name, { type: "cron", expression }, fn, args);
  }

  hourly(name: string, at: { minuteUTC: number }, fn: FunctionLike, args?: Record<string, unknown>) {
    this.cron(name, `${at.minuteUTC} * * * *`, fn, args);
  }

  daily(name: string, at: { hourUTC: number; minuteUTC: number }, fn: FunctionLike, args?: Record<string, unknown>) {
    this.cron(name, `${at.minuteUTC} ${at.hourUTC} * * *`, fn, args);
  }

  weekly(name: string, at: { dayOfWeek: Weekday; hourUTC: number; minuteUTC: number }, fn: FunctionLike, args?: Record<string, unknown>) {
    const day = WEEKDAYS.indexOf(at.dayOfWeek);
    if (day < 0) throw new Error(`crons.weekly("${name}"): dayOfWeek must be one of ${WEEKDAYS.join(", ")}.`);
    this.cron(name, `${at.minuteUTC} ${at.hourUTC} * * ${day}`, fn, args);
  }

  monthly(name: string, at: { day: number; hourUTC: number; minuteUTC: number }, fn: FunctionLike, args?: Record<string, unknown>) {
    this.cron(name, `${at.minuteUTC} ${at.hourUTC} ${at.day} * *`, fn, args);
  }
}

export function cronJobs(): Crons {
  return new Crons();
}
