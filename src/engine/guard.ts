// Knows which function is running, so process-wide APIs can behave per function type.
// Queries and mutations must not call fetch(): queries re-run whenever their data changes,
// and mutations hold the write lock and may be retried on conflicts.

import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionType } from "../api";
import { OnebaseError } from "./database";

export type FunctionFrame = { type: FunctionType; name: string };

export const currentFunction = new AsyncLocalStorage<FunctionFrame>();

/** The real fetch, for onebase's own network calls made inside a mutation (e.g. the libSQL driver). */
export const unguardedFetch: typeof fetch = globalThis.fetch.bind(globalThis);

let installed = false;

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
}
