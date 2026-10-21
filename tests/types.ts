// Type-level tests, checked by `bun run typecheck`. Each @ts-expect-error must stay an error.

import { OnebaseClient } from "../src/client/index";
import { useQuery } from "../src/client/react";
import { api } from "../example/onebase/_generated/api";
import type { Doc, Id } from "../example/onebase/_generated/dataModel";
import { query } from "../example/onebase/_generated/server";
import { v } from "../src/values";

declare const client: OnebaseClient;
declare const channel: Id<"channels">;

export async function clientTypes() {
  const messages = await client.query(api.messages.list, { channel });
  const first: Doc<"messages"> | undefined = messages[0];
  const body: string | undefined = first?.body;
  const likes: number | undefined = first?.likes;

  // @ts-expect-error wrong arg type
  await client.query(api.messages.list, { channel: 123 });
  // @ts-expect-error missing required arg
  await client.mutation(api.messages.send, { channel, author: "a" });
  // @ts-expect-error internal functions aren't in `api`
  api.messages.remove;
  // @ts-expect-error a query is not a mutation
  await client.mutation(api.messages.list, { channel });

  const id: Id<"channels"> = await client.mutation(api.channels.getOrCreate, { name: "x" });
  // @ts-expect-error ids are table-specific
  const wrong: Id<"messages"> = id;
  return [body, likes, wrong];
}

export const typedDb = query({
  args: { channel: v.id("channels") },
  handler: async (ctx, args) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", args.channel))
      .collect();
    // @ts-expect-error unknown table
    ctx.db.query("users");
    // @ts-expect-error unknown index
    ctx.db.query("messages").withIndex("by_author");
    // @ts-expect-error field not in the index
    ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("author", "x"));
    // @ts-expect-error queries can't write
    ctx.db.insert("messages", {});
    const chan = await ctx.db.get(args.channel);
    return { count: msgs.length, name: chan?.name };
  },
});

export function ReactTypes() {
  const msgs = useQuery(api.messages.list, { channel });
  const skipped = useQuery(api.messages.list, "skip");
  // @ts-expect-error wrong args
  useQuery(api.messages.list, { nope: 1 });
  return [msgs?.length, skipped];
}
