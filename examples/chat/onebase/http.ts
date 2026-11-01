import { httpRouter } from "onebase/server";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// Example webhook: POST /hooks/post { "channel": "general", "body": "hi" }
http.route({
  path: "/hooks/post",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const { channel, body } = (await request.json()) as { channel: string; body: string };
    const channelId = await ctx.runMutation(api.channels.getOrCreate, { name: channel });
    await ctx.runMutation(api.messages.send, { channel: channelId, author: "webhook", body });
    return Response.json({ ok: true });
  }),
});

export default http;
