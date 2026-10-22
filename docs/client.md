---
title: Client
description: Use onebase from the browser, React, scripts and plain HTTP.
---

# Client

## Generated API

`onebase dev` (or `onebase codegen`) writes `onebase/_generated/api.ts`. Import `api` from it for type-checked function references:

```ts
import { api } from "../onebase/_generated/api";
await client.mutation(api.tasks.add, { text: "Hi" }); // args and return type are checked
```

Without the generated types you can use `anyApi` (untyped) or plain strings like `"tasks:add"`.

## Connecting to your backend

When onebase serves your frontend (from `public/`), the client connects to the same address and you don't pass a URL. When the frontend is hosted somewhere else (Vercel, Netlify, a CDN, a mobile app), pass the backend's URL:

```ts
const client = new OnebaseClient("https://api.example.com");
```

- **WebSocket:** derived automatically (`https://api.example.com` → `wss://api.example.com/api/sync`).
- **Per environment:** keep the URL in an environment variable, e.g. `new OnebaseClient(import.meta.env.VITE_ONEBASE_URL)`.
- **CORS:** any origin can call the API by default. Restrict it with `--cors https://app.example.com` (comma-separate several origins).
- **File URLs:** start the server with `--url https://api.example.com`, so `ctx.storage.getUrl()` returns public addresses instead of `localhost`.

## Browser

```ts
import { OnebaseClient } from "onebase/browser";

const client = new OnebaseClient("https://api.example.com"); // defaults to the page's origin

const stop = client.onUpdate(api.tasks.list, {}, (tasks) => render(tasks), (err) => showError(err));
await client.mutation(api.tasks.add, { text: "Write docs" });
const result = await client.action(api.ai.summarize, { id });
const once = await client.query(api.tasks.list, {});
stop(); // unsubscribe
```

The client uses one WebSocket:
- It reconnects with backoff and re-subscribes automatically.
- `client.onConnectionChange(state => ...)` reports `"connecting"`, `"open"` or `"closed"`.
- If the connection drops before a call is answered, the call rejects instead of being retried silently, so you never run a mutation twice by accident.

**Without a bundler:** every onebase server serves the client as an ES module:

```html
<script type="module">
  import { OnebaseClient, anyApi as api } from "/_onebase/client.js";
</script>
```

## React

```tsx
import { OnebaseClient, OnebaseProvider, useMutation, useQuery } from "onebase/react";
import { api } from "../onebase/_generated/api";

const client = new OnebaseClient(import.meta.env.VITE_ONEBASE_URL);

export function App() {
  return (
    <OnebaseProvider client={client}>
      <Tasks />
    </OnebaseProvider>
  );
}

function Tasks() {
  const tasks = useQuery(api.tasks.list); // undefined while loading
  const add = useMutation(api.tasks.add);
  if (tasks === undefined) return <p>Loading…</p>;
  return (
    <>
      {tasks.map((t) => <p key={t._id}>{t.text}</p>)}
      <button onClick={() => add({ text: "New task" })}>Add</button>
    </>
  );
}
```

| Hook | |
|---|---|
| `useQuery(ref, args \| "skip")` | live result; `undefined` while loading; errors throw to the nearest error boundary |
| `useMutation(ref)` | returns `(args) => Promise` |
| `useAction(ref)` | returns `(args) => Promise` |
| `usePaginatedQuery(ref, args, { initialNumItems })` | `{ results, status, isLoading, loadMore(n) }`; every loaded page stays live |
| `useConnectionState()` | `"connecting" \| "open" \| "closed"` |

**Porting from Convex:** the aliases `ConvexProvider` and `ConvexReactClient` are exported too, so code written for Convex works after changing the import path.

## Authentication

```ts
client.setAuth(async () => await getTokenFromYourAuthProvider()); // called on every (re)connect
client.clearAuth();
```

The server then re-runs your subscriptions as that user. See [Auth](./auth.md).

## Scripts and servers

`OnebaseHttpClient` uses plain HTTP, with no WebSocket and no subscriptions:

```ts
import { OnebaseHttpClient } from "onebase/browser";
const http = new OnebaseHttpClient("http://localhost:8090");
http.setAuth(token);
await http.mutation(api.tasks.add, { text: "From a cron script" });
```

## HTTP API

Any language can call functions over HTTP:

```bash
curl -X POST http://localhost:8090/api/mutation \
  -H "Content-Type: application/json" \
  -d '{"path": "tasks:add", "args": {"text": "From curl"}}'
```

```json
{ "status": "success", "value": "k3m8x…" }
```

| Endpoint | |
|---|---|
| `POST /api/query`, `/api/mutation`, `/api/action` | `{ path, args }` → `{ status, value }` or `{ status: "error", errorMessage, errorData }` |
| `POST /api/run` | same, for any function type |
| `GET /api/health` | `{ ok, functions, subscriptions }` |
| `WS /api/sync` | the live protocol used by the clients |

Send `Authorization: Bearer <token>` to call as a user.
