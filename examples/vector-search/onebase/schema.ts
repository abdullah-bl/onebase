import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  items: defineTable({
    text: v.string(),
    kind: v.string(),
    // Written by the addAndIndex action; documents without it aren't indexed.
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_kind", ["kind"])
    .searchIndex("search_text", { searchField: "text", filterFields: ["kind"] })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 64,
      filterFields: ["kind"],
    }),
});
