import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  todos: defineTable({
    text: v.string(),
    done: v.boolean(),
  }).index("by_done", ["done"]),

  // Bench table: big payloads, no index on tag (forces full scans)
  docs: defineTable({
    payload: v.string(),
    tag: v.string(),
  }),

  // Vector-search bench: 1536-dim unit vectors generated server-side from idx.
  embeddings: defineTable({
    idx: v.number(),
    kind: v.string(),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_idx", ["idx"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["kind"],
    }),

  vectorsMeta: defineTable({
    name: v.string(),
    n: v.number(),
  }),
});
