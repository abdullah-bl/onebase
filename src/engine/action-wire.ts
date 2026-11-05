// What the main thread and an action worker say to each other (see action-pool.ts and
// action-thread.ts). Everything here crosses postMessage, so it's plain data.

import { functionPathSymbol } from "../api";
import type { UserIdentity } from "../server";
import { ConvexError } from "../values";
import { OnebaseError } from "./database";

/** Where a worker gets the code it runs: the same code the main thread runs. */
export type CodeSource =
  /** A functions directory on disk (`onebase serve` and `onebase dev`). */
  | { dir: string }
  /** A bundle pushed with `onebase deploy`. */
  | { bundle: string; id: string }
  /** Built into the worker entry itself (a binary from `onebase build`). */
  | { embedded: true };

export type WireError = { kind: "convex" | "onebase" | "error"; message: string; data?: unknown; stack?: string };

/** A vector search filter, as the tree its callback built. */
export type WireFilter = { op: "eq"; field: string; value: unknown } | { op: "or"; args: WireFilter[] };

/** Main thread → worker. */
export type ToThread =
  | { t: "init"; source: CodeSource }
  | { t: "run"; job: number; name: string; args: unknown; identity: UserIdentity | null; mount: string | null }
  | {
      t: "http";
      job: number;
      method: string;
      url: string;
      headers: [string, string][];
      body: ArrayBuffer | null;
      identity: UserIdentity | null;
      mount: string | null;
    }
  /** The answer to a worker's ctx call. */
  | { t: "result"; job: number; seq: number; ok: true; value: unknown }
  | { t: "result"; job: number; seq: number; ok: false; error: WireError }
  /** An HTTP action's response body: send the next chunk, or stop. */
  | { t: "pull"; job: number }
  | { t: "cancel"; job: number }
  | { t: "ping"; n: number };

/** Worker → main thread. */
export type FromThread =
  | { t: "ready"; functions: string[] }
  | { t: "failed"; error: string }
  /** A ctx call: `op` is its path in ctx, like ["scheduler", "runAfter"]. */
  | { t: "call"; job: number; seq: number; op: string[]; args: unknown[] }
  | { t: "log"; job: number; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
  | { t: "done"; job: number; ok: true; value: unknown }
  | { t: "done"; job: number; ok: false; error: WireError }
  /** An HTTP action's response; with `body`, the body follows as chunks the main thread pulls. */
  | { t: "head"; job: number; status: number; statusText: string; headers: [string, string][]; body: boolean }
  | { t: "chunk"; job: number; data: Uint8Array }
  | { t: "end"; job: number }
  | { t: "pong"; n: number };

export function toWire(err: unknown): WireError {
  if (err instanceof ConvexError) return { kind: "convex", message: err.message, data: err.data, stack: err.stack };
  if (err instanceof OnebaseError) return { kind: "onebase", message: err.message, stack: err.stack };
  if (err instanceof Error) return { kind: "error", message: err.message, stack: err.stack };
  return { kind: "error", message: String(err) };
}

/** The error again, as the class it was thrown as, so `instanceof ConvexError` and `err.data` still work. */
export function fromWire(wire: WireError): Error {
  const err = wire.kind === "convex" ? new ConvexError(wire.data) : wire.kind === "onebase" ? new OnebaseError(wire.message) : new Error(wire.message);
  if (wire.stack) err.stack = wire.stack;
  return err;
}

const REF = "__onebaseFunctionRef";

/** An object literal: not a Blob, Date, typed array or other class instance, which are copied as they are. */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== "object" || x === null) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/** Function references (api.x.y) in arguments, which can't be copied to another thread, as their names. */
export function encodeRefs(value: unknown, depth = 0): unknown {
  if (depth > 32 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => encodeRefs(v, depth + 1));
  let path: unknown;
  try {
    path = (value as any)[functionPathSymbol];
  } catch {}
  if (typeof path === "string") return { [REF]: path };
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = encodeRefs(v, depth + 1);
  return out;
}

/** encodeRefs undone: each name becomes a reference again. */
export function decodeRefs(value: unknown, depth = 0): unknown {
  if (depth > 32 || typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => decodeRefs(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === REF && typeof (value as any)[REF] === "string") return { [functionPathSymbol]: (value as any)[REF] };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = decodeRefs(v, depth + 1);
  return out;
}
