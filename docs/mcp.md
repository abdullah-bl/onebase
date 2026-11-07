---
title: MCP
description: Let AI agents use your app through an MCP server at /mcp, with sign-in over OAuth 2.1 or API keys.
---

# MCP

Your app can be an [MCP](https://modelcontextprotocol.io) server. A user adds one URL, `https://your-app.com/mcp`, to Claude, ChatGPT, Cursor or Claude Code, approves the agent on a page in your app, and the agent can then call the tools you define, as that user.

onebase includes everything this takes. It has the `/mcp` endpoint (streamable HTTP) and an OAuth 2.1 authorization server: discovery, dynamic client registration, PKCE, refresh tokens that rotate, and revocation. API keys are also available for agents you set up by hand.

## Define the server and its tools

```ts
// onebase/mcp.ts
import { defineMcp, tool } from "onebase/mcp";
import { v } from "onebase/values";
import { api } from "./_generated/api";

export default defineMcp({
  name: "Notes",
  instructions: "The user's private notes. Search before adding, so you don't create duplicates.",
  consentUrl: "/connect.html",
  scopes: {
    read: "Read and search your notes",
    write: "Add and edit your notes",
  },
});

export const searchNotes = tool({
  description: "Full-text search over the user's notes.",
  scope: "read",
  annotations: { readOnlyHint: true },
  args: { text: v.string() },
  returns: v.object({ notes: v.array(v.object({ title: v.string(), body: v.string() })) }),
  handler: async (ctx, { text }) => {
    const notes = await ctx.runQuery(api.notes.search, { text });
    return { notes: notes.map((n) => ({ title: n.title, body: n.body })) };
  },
});

export const addNote = tool({
  description: "Adds a note for the user.",
  scope: "write",
  args: { title: v.string(), body: v.string() },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.notes.add, args);
    return "Added.";
  },
});
```

A tool is an internal action with a description:

- **The approving user:** in `ctx.auth`, so `ctx.runQuery(api.notes.search)` runs your existing query with that user's identity and its existing ownership checks. `getAuthUserId(ctx)` works inside tools too.
- **Same as any action:** it runs on a worker thread, with the action time limit, and shows in the dashboard's logs with the source `mcp`.
- **Location:** tools can live in any file. `onebase/mcp.ts` must have the `defineMcp` default export. The tool's name is its export name, or the `name` you give it.
- **Validation:** `args` and `returns` are validators. Agents receive them as JSON Schema (`inputSchema`, and `outputSchema` for object results). When the arguments don't match, the agent gets a tool error it can correct, so nothing throws in your code. Declare `returns` on tools that return objects, because returned values are checked against it. This keeps fields you didn't mean to share from reaching the agent.
- **Results:** strings go back as text. Anything else goes back as JSON, and as `structuredContent` when `returns` is an object.
- **Who's calling:** `getMcpCaller(ctx)` from `onebase/mcp` returns `{ userId, connectionId, clientName, scopes }` inside a tool, and `null` outside one.

### Scopes

`scopes` names the permissions a user can grant, and each tool lists the one it needs:

- **Visibility:** a connection sees, and can call, only the tools in the scopes it was granted. Tools without a `scope` are available to every connection.
- **Out-of-scope calls:** calling a tool outside the granted scopes returns HTTP 403 with `WWW-Authenticate: Bearer error="insufficient_scope"`, so the agent can ask for more.
- **No scopes defined:** every tool is available to every connection.

Keep reading and writing in separate scopes, and set `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) on every tool. Agents use them to decide when to ask the user before calling a tool.

## The consent page

`consentUrl` is a page in your app. Agents send the user there as `<consentUrl>?request=<id>`. It signs the user in if needed, shows who is asking, and sends the answer:

```js
import { OnebaseClient } from "/_onebase/client.js";

if (window.top !== window.self) throw new Error("This page can't be framed.");

const client = new OnebaseClient();
const requestId = new URL(location.href).searchParams.get("request");

// Once signed in:
const request = await client.mcp.request(requestId);
// request.client.name: what the agent calls itself. request.client.redirectHost: where approving sends the user.
// request.scopes: [{ scope, description }]

const { redirect } = await client.mcp.authorize({ request: requestId, approve: true, scopes: ["read"] });
location.assign(redirect); // back to the agent, with its code (or access_denied)
```

[`examples/notes-auth/public/connect.html`](../examples/notes-auth/public/connect.html) is a complete page. A few things matter for safety:

- **Don't let the page be framed.** If you can set headers, send `Content-Security-Policy: frame-ancestors 'none'`. On a static host, use a `window.top` check like the one above. Otherwise another site could load the page in a frame and trick the user into clicking Allow (clickjacking).
- **Show `redirectHost`.** Agents register themselves, so anyone can choose a name like "Claude". The host the user is sent back to can't be faked.
- **Let the user narrow scopes.** Pass the scopes they kept as `scopes`.

The page works with any sign-in the app accepts: built-in sessions, or a Clerk, Auth0 or other OIDC token through `client.setAuth`.

## Connected agents and API keys

For a settings page, as the signed-in user:

```js
await client.mcp.connections();            // [{ id, kind: "oauth" | "key", name, clientName, scopes, created, lastUsed }]
await client.mcp.revoke(id);               // disconnects an agent or deletes a key, at once
const { key } = await client.mcp.createKey({ name: "CI", scopes: ["read"] }); // shown only this once
```

An API key is a bearer token for agents you set up by hand:

```bash
claude mcp add --transport http notes https://your-app.com/mcp --header "Authorization: Bearer ob_mcpk_..."
```

## How it fits together

| Endpoint | |
|---|---|
| `POST /mcp` | MCP JSON-RPC: `initialize`, `ping`, `tools/list`, `tools/call`. Needs `Authorization: Bearer <token or key>` |
| `GET /.well-known/oauth-protected-resource/mcp` | Resource metadata (RFC 9728). A 401 from `/mcp` points here |
| `GET /.well-known/oauth-authorization-server` | Authorization server metadata (RFC 8414) |
| `POST /api/mcp/oauth/register` | Dynamic client registration (RFC 7591). Public clients only (`token_endpoint_auth_method: none`) |
| `GET /api/mcp/oauth/authorize` | Checks the request and redirects to your `consentUrl` |
| `POST /api/mcp/oauth/token` | `authorization_code` (with the PKCE `code_verifier`) and `refresh_token` |
| `POST /api/mcp/oauth/revoke` | Token revocation (RFC 7009) |
| `GET /api/mcp/request`, `POST /api/mcp/authorize` | What `client.mcp.request` and `client.mcp.authorize` call |
| `GET /api/mcp/connections`, `POST /api/mcp/connections/revoke`, `POST /api/mcp/keys` | The settings calls |

- **Connections:** each approval is one connection: a user, an agent and the scopes granted. Its tokens, or the API key, belong to it, so revoking the connection ends them all. Deleting the user does too.
- **Tokens:** stored only as SHA-256 hashes. They work at `/mcp` and nowhere else: `/api/query`, the WebSocket and HTTP routes refuse them, so an agent can do only what its tools do.
- **Lifetimes:** access tokens last an hour (`accessTokenSeconds`). Refresh tokens rotate on every use and last 30 days (`refreshTokenDays`).
- **Replay detection:** if a refresh token is used twice, it has probably leaked, so the whole connection ends and the agent has to connect again.
- **Codes and PKCE:** authorization codes work once, for five minutes, only for the client they were issued to, and only with the right `code_verifier` (S256). Pending requests expire after ten minutes.
- **Redirect URIs:** must use https, http on `localhost`, `127.0.0.1` or `[::1]` (on any port, per RFC 8252), or an app's own scheme such as `cursor://`. An unregistered redirect gets an error page and is never followed.
- **Rate limiting:** `--rate-limit` also counts registrations, token requests and `/mcp` calls.

## Not supported yet

- **Streaming:** answers come back as a single JSON response, and `GET /mcp` returns 405.
- **Other MCP features:** resources, prompts, sampling and change notifications.
- **Device flow:** agents that can't open a browser (RFC 8628) aren't supported. Use an API key.
- **Confidential clients:** clients that authenticate with a client secret can't register.

## Testing

Tools are internal actions, so you can test them like any other function. You can also drive the whole flow over HTTP; [`tests/mcp.test.ts`](../tests/mcp.test.ts) does both. To try a server by hand, run the [MCP Inspector](https://github.com/modelcontextprotocol/inspector) and point it at `http://localhost:8090/mcp`.
