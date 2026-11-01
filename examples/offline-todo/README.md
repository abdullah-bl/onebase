# offline-todo — the client's offline mode

The classic todo list, but the client is created with `offline: true`: the newest query results are cached in `localStorage`, and mutations made while the server is unreachable are queued and replayed, in order, when the connection returns — even across page reloads.

## Run it

```bash
cd examples/offline-todo
bun ../../src/cli.ts dev
```

Open the printed URL (http://localhost:8090), then try the demo:

1. Add and toggle a few todos.
2. **Stop the server** (Ctrl+C in the terminal). The banner turns amber; keep using the page — every edit applies instantly (optimistic update) and is queued.
3. Reload the page while the server is down: your todos are still there, from the offline cache.
4. **Start the server again.** The client reconnects and the queued mutations replay in the order you made them.

## What it shows

- **`new OnebaseClient(undefined, { offline: true })`** — cached results (newest 100 by default, `localStorage`) and queued mutations.
- **Optimistic updates** — the toggle's `optimisticUpdate` flips the todo in every subscribed instance of the list before the server replies; the server's result replaces it, and it rolls back if the mutation fails.
- **`client.queuedMutations`** — the banner counts what's waiting to replay.
- **`client.onConnectionChange`** — `"connecting"` / `"open"` / `"closed"` in the header.

Worth knowing (from the client docs): a queued mutation is sent at most once per session — one that was in flight when the connection dropped is never silently re-sent, since it may or may not have run. Make such mutations idempotent if that matters to you.

## Files

```
onebase/
  schema.ts   todos (by_done index: open and done lists are both cheap)
  todos.ts    list, done, add, toggle, remove
public/index.html  todo UI with offline banner, no build step
```
