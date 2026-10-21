import { defineSchema, defineTable } from "onebase/server";
import { v } from "onebase/values";

export default defineSchema({
  channels: defineTable({
    name: v.string(),
  }).index("by_name", ["name"]),

  messages: defineTable({
    channel: v.id("channels"),
    author: v.string(),
    body: v.string(),
    likes: v.optional(v.number()),
    image: v.optional(v.id("_storage")),
  }).index("by_channel", ["channel"]),
});
