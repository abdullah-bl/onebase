// Function references shared by the server and the browser client.
// Kept free of server-only imports so it bundles into the browser.

export type FunctionType = "query" | "mutation" | "action";
export type FunctionVisibility = "public" | "internal";

export const functionPathSymbol = Symbol.for("onebase.functionPath");

export type FunctionReference<
  Type extends FunctionType = FunctionType,
  Visibility extends FunctionVisibility = FunctionVisibility,
  Args = any,
  Returns = any,
> = {
  readonly [functionPathSymbol]: string;
  /** Type-only markers. */
  readonly __type?: Type;
  readonly __visibility?: Visibility;
  readonly __args?: Args;
  readonly __returns?: Returns;
};

export type FunctionArgs<F> = F extends FunctionReference<any, any, infer A, any> ? A : never;
export type FunctionReturnType<F> = F extends FunctionReference<any, any, any, infer R> ? R : never;

/** `{}` args become optional at call sites. */
export type OptionalRestArgs<F> = keyof FunctionArgs<F> extends never
  ? [args?: FunctionArgs<F>]
  : [args: FunctionArgs<F>];

/** Arguments followed by an options object; `{}` args stay optional. */
export type ArgsAndOptions<F, Options> = keyof FunctionArgs<F> extends never
  ? [args?: FunctionArgs<F>, options?: Options]
  : [args: FunctionArgs<F>, options?: Options];

/**
 * A signed, storable reference to a function, from `createFunctionHandle()`: "function://…".
 * Pass it to a component (or keep it in a document) and call it later, even after a restart.
 */
export type FunctionHandle<Type extends FunctionType = FunctionType, Args = any, Returns = any> = string & {
  readonly __handle?: [Type, Args, Returns];
};

export const isFunctionHandle = (x: unknown): x is FunctionHandle => typeof x === "string" && x.startsWith("function://");

/** Anything that names a function: a reference from `api`, a "module:export" string or a handle. */
export type FunctionLike = FunctionReference | string;

/** Turns `api.messages.list` (or "messages:list") into "messages:list". */
export function getFunctionName(ref: FunctionLike): string {
  if (typeof ref === "string") return normalizeFunctionName(ref);
  const path = (ref as any)?.[functionPathSymbol];
  if (typeof path !== "string") {
    throw new Error(
      `Expected a function reference like api.messages.list or a string like "messages:list", got ${String(ref)}`,
    );
  }
  return path;
}

/** Accepts "messages:list", "messages.list", "messages/list" or "dir/file:fn". */
export function normalizeFunctionName(name: string): string {
  const cleaned = name.replace(/\.(ts|js)(?=:|$)/, "");
  if (cleaned.includes(":")) return cleaned;
  const sep = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf("/"));
  if (sep === -1) return `${cleaned}:default`;
  return `${cleaned.slice(0, sep).replace(/\./g, "/")}:${cleaned.slice(sep + 1)}`;
}

function makeProxy(segments: string[]): any {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === functionPathSymbol) {
          if (segments.length < 2) {
            throw new Error(`"${segments.join(".")}" is a module, not a function. Use api.<module>.<function>.`);
          }
          return `${segments.slice(0, -1).join("/")}:${segments[segments.length - 1]}`;
        }
        if (typeof prop === "symbol" || prop === "then") return undefined;
        return makeProxy([...segments, prop]);
      },
    },
  );
}

/** Untyped API object: `anyApi.messages.list` works for any module/function. */
export const anyApi: any = makeProxy([]);
