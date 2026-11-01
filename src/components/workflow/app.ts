// The app half of a workflow: defineWorkflow() creates the runner function the component calls
// back through a handle. It executes the workflow's steps in one transaction, replaying the steps
// the journal already has, and pauses (by returning a signal) at actions, sleeps and failures —
// the durable points the component takes over from.

import type { FunctionArgs, FunctionReference, FunctionReturnType } from "../../api";
import { createFunctionHandle, internalMutation } from "../../server";
import { v } from "../../values";

/** Retry policy for a step: runs once by default, then `maxAttempts - 1` retries with backoff. */
export type RetryConfig = {
  maxAttempts?: number;
  initialBackoffMs?: number;
  base?: number;
};

/** What a workflow's `run` function gets instead of ctx: steps that survive restarts. */
export type StepCtx = {
  /** Runs a query in the workflow's snapshot; its result is journaled and replayed. */
  runQuery<F extends FunctionReference<"query", any, any, any>>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  /** Runs a mutation in the workflow's transaction; its result is journaled and replayed. */
  runMutation<F extends FunctionReference<"mutation", any, any, any>>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  /** Runs an action out of the transaction; the workflow pauses until it's done. */
  runAction<F extends FunctionReference<"action", any, any, any>>(fn: F, args: FunctionArgs<F>, opts?: { retry?: RetryConfig }): Promise<FunctionReturnType<F>>;
  /** Pauses the workflow until `ms` from now. */
  sleep(ms: number): Promise<void>;
};

/** One journaled step: the runner gets these back to skip work it already did. */
export type CompletedStep = { number: number; result: unknown };

/** What the runner returns to the component, describing how far it got and what it needs next. */
export type WorkflowSignal = {
  /** Steps executed in this run, in order. */
  steps: { number: number; kind: "query" | "mutation"; result: unknown }[];
  pause:
    | { kind: "action"; number: number; fn: string; args: unknown; retry: RetryConfig | null }
    | { kind: "sleep"; number: number; ms: number }
    | { kind: "failed"; number: number | null; error: string; retry: RetryConfig | null }
    | { kind: "yield" }
    | null;
  returnValue: unknown;
};

/** Steps one run executes before it yields, so a long workflow can't hold a mutation forever. */
export const YIELD_AFTER = 100;

class Pause extends Error {
  constructor(readonly signal: WorkflowSignal["pause"] & {}) {
    super("workflow pause");
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Keeps only what a document can hold, so journal entries and results survive the database. */
export function storable(value: unknown): unknown {
  try {
    return value === undefined ? null : JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

/**
 * The app half of a workflow: export it from your functions folder and pass it to `start()` as
 * its `fn`. Inside `run`, do everything through `step` — plain ctx calls aren't journaled and
 * re-run from scratch on a replay. Steps run in call order; always make the same calls in the
 * same order (branch on journaled results, not on the clock or random values), or the replay
 * won't line up with the journal.
 */
export function defineWorkflow<A>(def: { run: (step: StepCtx, args: A) => Promise<unknown> }) {
  if (typeof def?.run !== "function") throw new Error("defineWorkflow({ run }) needs a run function.");
  return internalMutation({
    args: {
      workflowId: v.string(),
      args: v.optional(v.any()),
      completed: v.optional(v.array(v.object({ number: v.number(), result: v.any() }))),
    },
    handler: async (ctx: any, call: { workflowId: string; args?: unknown; completed?: CompletedStep[] }): Promise<WorkflowSignal> => {
      const results = new Map<number, unknown>((call.completed ?? []).map((s) => [s.number, s.result]));
      let counter = 0;
      const steps: WorkflowSignal["steps"] = [];
      const yieldIfDue = () => {
        if (steps.length >= YIELD_AFTER) throw new Pause({ kind: "yield" });
      };
      const step: StepCtx = {
        runQuery: async (fn: any, args: any): Promise<any> => {
          const number = ++counter;
          if (results.has(number)) return results.get(number);
          const result = await ctx.runQuery(fn, args);
          steps.push({ number, kind: "query", result: storable(result) });
          yieldIfDue();
          return result;
        },
        runMutation: async (fn: any, args: any): Promise<any> => {
          const number = ++counter;
          if (results.has(number)) return results.get(number);
          const result = await ctx.runMutation(fn, args);
          steps.push({ number, kind: "mutation", result: storable(result) });
          yieldIfDue();
          return result;
        },
        runAction: async (fn: any, args: any, opts?: { retry?: RetryConfig }): Promise<any> => {
          const number = ++counter;
          if (results.has(number)) return results.get(number);
          throw new Pause({ kind: "action", number, fn: await createFunctionHandle(fn), args: storable(args), retry: opts?.retry ?? null });
        },
        sleep: async (ms: number): Promise<void> => {
          const number = ++counter;
          if (results.has(number)) return;
          throw new Pause({ kind: "sleep", number, ms });
        },
      };
      try {
        const returnValue = await def.run(step, call.args as A);
        return { steps, pause: null, returnValue: storable(returnValue) };
      } catch (err) {
        if (err instanceof Pause) return { steps, pause: err.signal, returnValue: null };
        return { steps, pause: { kind: "failed", number: null, error: message(err), retry: null }, returnValue: null };
      }
    },
  });
}
