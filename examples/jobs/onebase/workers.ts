import { v } from "onebase/values";
import { onCompleteArgs } from "onebase/components/work-queue";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

/**
 * The queued work itself: an internal action, so it can use timers, network,
 * anything Node offers — with no database access (writes go through
 * runMutation). Titles containing "fail" always throw, to show retries.
 */
export const process = internalAction({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.runQuery(internal.tasks.get, { id: taskId });
    await ctx.runMutation(internal.tasks.setRunning, { taskId });
    const startedAt = Date.now();
    // Simulated work; with maxParallelism: 2, extra items wait their turn.
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (task?.title.toLowerCase().includes("fail")) {
      throw new Error(`Simulated failure for "${task.title}"`);
    }
    return `processed "${task?.title ?? ""}" in ${Date.now() - startedAt}ms`;
  },
});

/** Called by the queue for every item, success or not. */
export const finished = internalMutation({
  args: onCompleteArgs(v.object({ taskId: v.id("tasks") })),
  handler: async (ctx, { context, result }) => {
    if (result.kind === "success") {
      await ctx.db.patch(context.taskId, { state: "done", output: String(result.returnValue), error: undefined });
    } else if (result.kind === "failed") {
      await ctx.db.patch(context.taskId, { state: "failed", error: result.error });
    } else {
      await ctx.db.patch(context.taskId, { state: "canceled", error: "canceled" });
    }
  },
});

/** Run by crons.ts every 5 minutes: forget finished tasks older than 30. */
export const pruneFinished = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 30 * 60_000;
    const old = await ctx.db
      .query("tasks")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .collect();
    let removed = 0;
    for (const task of old) {
      if (task.state !== "scheduled" && task.state !== "queued" && task.state !== "running") {
        await ctx.db.delete(task._id);
        removed++;
      }
    }
    return removed;
  },
});
