import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  options: defineTable({
    label: v.string(),
  }).index("by_label", ["label"]),

  // One row per vote. The aggregate component follows this table and keeps
  // per-option counts; nothing here maintains counters by hand.
  votes: defineTable({
    option: v.id("options"),
    voter: v.string(),
  })
    .index("by_option", ["option"])
    .index("by_option_voter", ["option", "voter"]),
});
