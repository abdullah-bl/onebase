// A project's functions by name, and its HTTP routes: what both the main thread and an action
// worker (which loads its own copy of the code) need to find a function or route.

import type { ComponentDefinition, ComponentRoute, MountOptions } from "../components";
import { isRegisteredFunction, type HttpAction, type HttpRouter, type RegisteredFunction } from "../server";
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
