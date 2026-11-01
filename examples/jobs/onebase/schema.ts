import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  // The human-facing record of each job. The work-queue component keeps its
  // own items; this table holds what the console displays.
  tasks: defineTable({
    title: v.string(),
    // scheduled -> queued -> running -> done | failed | canceled
    state: v.string(),
    output: v.optional(v.string()),
    error: v.optional(v.string()),
    // The queue item's id, so the console can show attempts and retry timing.
    itemId: v.optional(v.string()),
    // The scheduled start of a delayed task, so it can be canceled.
    job: v.optional(v.string()),
  }).index("by_state", ["state"]),
});
