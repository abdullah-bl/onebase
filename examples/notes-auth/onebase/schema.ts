import { authTables, defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  // The users table built-in sign-in needs.
  ...authTables,

  notes: defineTable({
    owner: v.id("users"),
    title: v.string(),
    body: v.string(),
    pinned: v.boolean(),
  })
    .index("by_owner", ["owner"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["owner"] }),
});
