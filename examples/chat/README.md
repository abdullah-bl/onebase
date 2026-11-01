# chat — the flagship example

A chat app with channels, live messages, likes, image uploads, full-text search, pagination and self-destructing messages. It's the app the quick start runs with `bun run example`, and the one the end-to-end tests exercise.

## Run it

```bash
bun run example            # from the repository root
# or:
cd examples/chat
bun ../../src/cli.ts dev
```

Open http://localhost:8090 in two browser windows — messages appear in both at once.

## What it shows

- **Schema** — `channels` and `messages` tables with a uniqueness-style lookup (`by_name`), a channel index, and a full-text `searchIndex` filtered by channel.
- **Live queries** — `client.onUpdate` over WebSocket; open two windows to see it.
- **Optimistic updates** — likes appear instantly via `optimisticUpdate` + `store.getAllQueries`.
- **Pagination** — `.paginate(paginationOpts)` behind the `page` query.
- **File storage** — `generateUploadUrl` + a browser `fetch`, with `ctx.storage.getUrl` for display and transactional delete.
- **Scheduler** — messages starting with `/tmp` self-destruct after 5 seconds via `ctx.scheduler.runAfter`.
- **Cron** — a daily job prunes messages older than 30 days (`by_creation_time` index).
- **Components** — the rate limiter paces each author, and the aggregate component counts messages per channel with a table hook.
- **HTTP routes** — `POST /hooks/post` is a webhook that creates the channel and sends the message.
- **The no-build frontend** — `public/index.html` imports the client from `/_onebase/client.js`.

## Files

```
onebase/
  schema.ts        channels + messages with indexes and the search index
  channels.ts      list, getOrCreate
  messages.ts      list, page, search, count, generateUploadUrl, send, like, remove, prune
  components.ts    limiter (rateLimiter), messageCounts (aggregate)
  crons.ts         daily prune
  http.ts          POST /hooks/post webhook
public/index.html  the chat UI
```
