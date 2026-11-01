import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  todos: defineTable({
    text: v.string(),
    done: v.boolean(),
  }).index("by_done", ["done"]),
});
