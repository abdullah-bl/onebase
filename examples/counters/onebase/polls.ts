import { ConvexError, v } from "onebase/values";
import { mutation, query } from "./_generated/server";

export const listOptions = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("options").collect(),
});

/** Returns the option with this label, creating it if needed. */
export const getOrCreateOption = mutation({
  args: { label: v.string() },
  handler: async (ctx, { label }) => {
    const existing = await ctx.db
      .query("options")
      .withIndex("by_label", (q) => q.eq("label", label))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("options", { label });
  },
});

/**
 * The leaderboard: every option with its live vote count from the aggregate
 * component. Counts take a few document reads however many votes there are.
 */
export const leaderboard = query({
  args: {},
  handler: async (ctx) => {
    const options = await ctx.db.query("options").collect();
    return Promise.all(
      options.map(async (option) => ({
        ...option,
        votes: await ctx.components.pollCounts.count({ namespace: option._id }),
      })),
    );
  },
});

/** All votes ever cast, from the sharded counter. */
export const totalVotes = query({
  args: {},
  handler: async (ctx) => await ctx.components.counter.count({ name: "votes" }),
});

/** Whether voting would be allowed right now, without taking a token. */
export const canVote = query({
  args: { voter: v.string() },
  handler: async (ctx, { voter }) => await ctx.components.limiter.check({ name: "vote", key: voter }),
});

export const vote = mutation({
  args: { option: v.id("options"), voter: v.string() },
  handler: async (ctx, { option, voter }) => {
    const { ok, retryAfter } = await ctx.components.limiter.limit({ name: "vote", key: voter });
    if (!ok) throw new ConvexError(`Slow down: your next vote is ready in ${Math.ceil(retryAfter / 1000)}s.`);
    await ctx.db.insert("votes", { option, voter });
    await ctx.components.counter.inc({ name: "votes" });
    return await ctx.components.pollCounts.count({ namespace: option });
  },
});

/** Take back your most recent vote for an option. */
export const undo = mutation({
  args: { option: v.id("options"), voter: v.string() },
  handler: async (ctx, { option, voter }) => {
    const last = await ctx.db
      .query("votes")
      .withIndex("by_option_voter", (q) => q.eq("option", option).eq("voter", voter))
      .order("desc")
      .first();
    if (!last) return 0;
    await ctx.db.delete(last._id);
    await ctx.components.counter.dec({ name: "votes" });
    return await ctx.components.pollCounts.count({ namespace: option });
  },
});
