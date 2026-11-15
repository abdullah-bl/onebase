// A project's functions by name, and its HTTP routes: what both the main thread and an action
// worker (which loads its own copy of the code) need to find a function or route.

import type { ComponentDefinition, ComponentRoute, MountOptions } from "../components";
import type { FunctionType } from "../api";
import { isRegisteredFunction, type HttpAction, type HttpRouter, type RegisteredFunction } from "../server";
import { describeValue, isPlainObject, validate } from "../values";
import { storedTable } from "./catalog";
import { OnebaseError } from "./database";
import type { ProjectCode } from "./runtime";

/** A component mounted in components.ts: what's needed to name its functions and serve its routes. */
export type MountCode = {
  name: string;
  definition: ComponentDefinition<any, any, any>;
  config: unknown;
  options: MountOptions;
  /** The component's function objects → their names in this mount ("components/limiter:limit"). */
  names: Map<RegisteredFunction, string>;
  /** HTTP routes, served under `httpPrefix` (null: not served). */
  routes: ComponentRoute[];
  httpPrefix: string | null;
};

export type IndexedCode<M extends MountCode = MountCode> = {
  functions: Map<string, RegisteredFunction>;
  /** Component functions: which mount each belongs to, and whether it's internal to the component. */
  componentFunctions: Map<string, { mount: M; internal: boolean }>;
  mounts: Map<string, M>;
};

/**
 * Names every function: "<module>:<export>" for the app's, "components/<mount>/<path>:<name>" for
 * a component's. `extend` turns each mount into the caller's own richer type.
 */
export function indexCode<M extends MountCode>(code: ProjectCode, extend: (mount: MountCode) => M): IndexedCode<M> {
  const functions = new Map<string, RegisteredFunction>();
  const mounts = new Map<string, M>();
  const componentFunctions: IndexedCode<M>["componentFunctions"] = new Map();
  for (const [modulePath, exports] of Object.entries(code.modules)) {
    if (code.components && (modulePath === "components" || modulePath.startsWith("components/"))) {
      throw new OnebaseError(`${modulePath}: functions can't live in a components/ folder; that name is reserved for the components mounted in components.ts.`);
    }
    for (const [exportName, value] of Object.entries(exports)) {
      if (isRegisteredFunction(value)) functions.set(`${modulePath}:${exportName}`, value);
    }
  }
  for (const [name, m] of Object.entries(code.components?.mounts ?? {})) {
    const mount = extend({
      name,
      definition: m.definition,
      config: m.config,
      options: m.options ?? {},
      names: new Map(),
      routes: m.definition.http?.(m.config) ?? [],
      httpPrefix: m.options?.httpPrefix === false ? null : (m.options?.httpPrefix ?? `/${name}`),
    });
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
    mounts.set(name, mount);
  }
  return { functions, componentFunctions, mounts };
}

/**
 * The handler for an HTTP request: an http.ts route first, then a component's route under its
 * prefix (so the app can always override one).
 */
export function lookupRoute<M extends MountCode>(
  http: HttpRouter | null,
  mounts: Iterable<M>,
  method: string,
  pathname: string,
): { handler: HttpAction; mount: M | null } | null {
  const own = http?.lookup(method, pathname);
  if (own) return { handler: own, mount: null };
  for (const mount of mounts) {
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

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * The function called `name`, checked against how it's called: its type, whether it's internal,
 * and whether `caller` may reach it. The app reaches components' public functions, a component
 * reaches only its own, and the system (scheduler, crons, dashboard) reaches everything. A handle
 * is a capability the app handed out, so whoever holds one may call its function.
 */
export function lookupFunction<M extends MountCode>(
  functions: Map<string, RegisteredFunction>,
  componentFunctions: Map<string, { mount: M; internal: boolean }>,
  name: string,
  opts: { expected: FunctionType | null; allowInternal: boolean; caller: M | null | "system"; viaHandle: boolean },
): { fn: RegisteredFunction; mount: M | null } {
  const { expected, allowInternal, caller, viaHandle } = opts;
  const fn = functions.get(name);
  if (!fn) {
    const [mod] = name.split(":");
    const sameModule = [...functions.keys()].filter((k) => k.startsWith(`${mod}:`));
    const hint = sameModule.length ? ` Functions in "${mod}": ${sameModule.join(", ")}.` : ` Known functions: ${[...functions.keys()].join(", ") || "(none)"}.`;
    throw new OnebaseError(`Function "${name}" not found.${hint}`);
  }
  if (expected && fn.type !== expected) {
    throw new OnebaseError(`"${name}" is a ${fn.type}, not a ${expected}. Call it with use${cap(fn.type)} / run${cap(fn.type)}.`);
  }
  if (fn.visibility === "internal" && !allowInternal) {
    throw new OnebaseError(`"${name}" is internal and can only be called from other functions (ctx.run*, scheduler).`);
  }
  const info = componentFunctions.get(name);
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
  return { fn, mount: target };
}

/** A function's arguments, checked against its validator. `mount`: the component it belongs to, whose v.id("t") names its own table. */
export function checkArgs(name: string, fn: RegisteredFunction, args: unknown, mount: string | null): Record<string, unknown> {
  const value = args ?? {};
  if (!isPlainObject(value)) throw new OnebaseError(`Arguments to "${name}" must be an object, got ${describeValue(args)}.`);
  if (fn.args) {
    // A component's v.id("t") names its own table, stored as "<mount>.t".
    const errors = validate(fn.args, value, "args", { idTable: (table) => storedTable(mount, table) });
    if (errors.length) throw new OnebaseError(`Invalid arguments for "${name}":\n  - ${errors.join("\n  - ")}`);
  }
  return value;
}

/** A function's return value, checked against its `returns` validator; undefined becomes null. */
export function checkReturn(name: string, fn: RegisteredFunction, value: unknown): unknown {
  if (fn.returns) {
    const errors = validate(fn.returns, value === null ? null : value, "return value");
    if (errors.length) throw new OnebaseError(`"${name}" returned an invalid value:\n  - ${errors.join("\n  - ")}`);
  }
  return value === undefined ? null : value;
}
