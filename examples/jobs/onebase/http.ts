import { httpRouter } from "onebase/server";
import { api } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

// POST /jobs { "title": "resize photo 12" } → { taskId }
http.route({
  path: "/jobs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const { title } = (await request.json()) as { title?: string };
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    const taskId = await ctx.runMutation(api.tasks.enqueue, { title });
    return Response.json({ taskId });
  }),
});

// GET /jobs → the last 50 tasks as JSON
http.route({
  path: "/jobs",
  method: "GET",
  handler: httpAction(async (ctx) => Response.json(await ctx.runQuery(api.tasks.list, {}))),
});

export default http;
