---
title: HTTP actions
description: Webhooks and custom HTTP endpoints with http.ts.
---

# HTTP actions

Define HTTP endpoints in `onebase/http.ts`. They're served on the same port as everything else.

```ts
import { httpRouter } from "onebase/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/webhooks/stripe",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const event = await request.json();
    await ctx.runMutation(internal.billing.handleEvent, { event });
    return new Response(null, { status: 200 });
  }),
});

// Every path under /files/ ("pathPrefix" matches the longest prefix)
http.route({
  pathPrefix: "/files/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const id = new URL(request.url).pathname.slice("/files/".length);
    const url = await ctx.storage.getUrl(id);
    return url ? Response.redirect(url) : new Response("Not found", { status: 404 });
  }),
});

export default http;
```

- **Handlers** get the same `ctx` as actions (`runQuery`, `runMutation`, `scheduler`, `storage`, `auth`) and a standard `Request`. They return a standard `Response`.
- **Auth:** an `Authorization: Bearer` header is verified like any other token (see [Auth](./auth.md)).
- **Reserved paths:** `/api/*` and `/_onebase/*` belong to onebase. Static files from `public/` are matched after your routes.
