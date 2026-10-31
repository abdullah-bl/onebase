// Knows which function is running, so process-wide APIs can behave per function type.
// Queries and mutations must not call fetch(): queries re-run whenever their data changes,
// and mutations hold the write lock and may be retried on conflicts.
// Queries may read the clock or a random source, but their results then can't be reused.

import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionType } from "../api";
import { OnebaseError, type ReadSet } from "./database";

export type FunctionFrame = {
  type: FunctionType;
  name: string;
  /** Signs a handle to a function the running one may call (see createFunctionHandle). */
  handle?: (ref: unknown) => string;
  /** A query's read set, also marked when the query reads the clock or a random source. */
  reads?: ReadSet;
};

export const currentFunction = new AsyncLocalStorage<FunctionFrame>();

/** The real fetch, for onebase's own network calls made inside a mutation (e.g. the libSQL driver). */
export const unguardedFetch: typeof fetch = globalThis.fetch.bind(globalThis);

let installed = false;

function markImpure() {
  const reads = currentFunction.getStore()?.reads;
  if (reads) reads.impure = true;
}

function observe<T extends object>(target: T, method: keyof T) {
  const original = target[method] as (...args: unknown[]) => unknown;
  target[method] = function (this: unknown, ...args: unknown[]) {
    markImpure();
    return original.apply(this, args);
  } as T[keyof T];
}

export function installGuards() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  const guarded = function fetch(this: unknown, ...args: Parameters<typeof original>) {
    const frame = currentFunction.getStore();
    if (frame && frame.type !== "action") {
      return Promise.reject(
        new OnebaseError(
          `fetch() isn't allowed in ${frame.type} "${frame.name}". ` +
            (frame.type === "query"
              ? "Queries re-run whenever their data changes, so they can't depend on outside services. "
              : "Mutations hold the write lock and may be retried, so a request could run twice. ") +
            "Call it from an action, then save the result with ctx.runMutation(...).",
        ),
      );
    }
    return original.apply(this, args);
  };
  globalThis.fetch = Object.assign(guarded, original) as typeof fetch;

  observe(Date, "now");
  observe(Math, "random");
  observe(performance, "now");
  observe(crypto, "randomUUID");
  observe(crypto, "getRandomValues");
  // new Date() and Date() read the clock; new Date(value) doesn't.
  globalThis.Date = new Proxy(Date, {
    construct(target, args, newTarget) {
      if (!args.length) markImpure();
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      markImpure();
      return Reflect.apply(target, thisArg, args);
    },
  });
}
