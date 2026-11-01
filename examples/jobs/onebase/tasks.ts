import { v } from "onebase/values";
import { internal } from "./_generated/api";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";

export const get = internalQuery({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => await ctx.db.get(id),
});

/** Marks a task as running; the process action calls this between queries. */
export const setRunning = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    await ctx.db.patch(taskId, { state: "running", error: undefined });
  },
});

export const list = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db.query("tasks").withIndex("by_creation_time").order("desc").take(50),
});

/** What the queue itself says about a task: state, attempts, next run, error. */
export const detail = query({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => {
    const task = await ctx.db.get(id);
    if (!task) return null;
    const queue = task.itemId ? await ctx.components.queue.status({ id: task.itemId }) : null;
    return { task, queue };
  },
});

/** The queue's own pending items, oldest first. */
export const queuePending = query({
  args: {},
  handler: async (ctx) => {
    const page = await ctx.components.queue.list({
      state: "pending",
      paginationOpts: { numItems: 10, cursor: null },
    });
    return page.page;
  },
});

/** Queue a job to run right away (bounded by maxParallelism). */
export const enqueue = mutation({
  args: { title: v.string() },
  handler: async (ctx, { title }) => {
    const taskId = await ctx.db.insert("tasks", { title, state: "queued" });
    // Queued in this mutation's transaction: if it fails, nothing is queued.
    const itemId = await ctx.components.queue.enqueueAction({
      fn: internal.workers.process,
      args: { taskId },
      retry: { maxAttempts: 3 },
      onComplete: internal.workers.finished,
      context: { taskId },
    });
    await ctx.db.patch(taskId, { itemId });
    return taskId;
  },
});

/** Queue a job that the scheduler starts later. */
export const enqueueLater = mutation({
  args: { title: v.string(), delayMs: v.number() },
  handler: async (ctx, { title, delayMs }) => {
    const taskId = await ctx.db.insert("tasks", { title, state: "scheduled" });
    const job = await ctx.scheduler.runAt(Date.now() + delayMs, internal.tasks.start, { taskId });
    await ctx.db.patch(taskId, { job });
    return taskId;
  },
});

/** Runs when the scheduler releases a delayed task. */
export const start = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task || task.state !== "scheduled") return;
    await ctx.db.patch(taskId, { state: "queued" });
    const itemId = await ctx.components.queue.enqueueAction({
      fn: internal.workers.process,
      args: { taskId },
      retry: { maxAttempts: 3 },
      onComplete: internal.workers.finished,
      context: { taskId },
    });
    await ctx.db.patch(taskId, { itemId });
  },
});

export const cancel = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => {
    const task = await ctx.db.get(id);
    if (!task) return;
    if (task.state === "scheduled") {
      // Not released yet, so the queue doesn't know about it: stop the scheduler instead.
      if (task.job) await ctx.scheduler.cancel(task.job);
      await ctx.db.patch(id, { state: "canceled", error: "canceled" });
      return;
    }
    if (task.itemId) await ctx.components.queue.cancel({ id: task.itemId });
  },
});

export const clearFinished = mutation({
  args: {},
  handler: async (ctx) => {
    let removed = 0;
    for (const state of ["done", "failed", "canceled"]) {
      const finished = await ctx.db
        .query("tasks")
        .withIndex("by_state", (q) => q.eq("state", state))
        .collect();
      for (const task of finished) {
        await ctx.db.delete(task._id);
        removed++;
      }
    }
    return removed;
  },
});
