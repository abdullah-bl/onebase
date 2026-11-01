# jobs — background work: queue, scheduler, crons and HTTP routes

A small console for background work. Jobs are processed by the work-queue component at a fixed pace, retried when they fail, and reported back through a completion callback. You can also start them from curl.

## Run it

```bash
cd examples/jobs
bun ../../src/cli.ts dev
```

Open the printed URL (http://localhost:8090). Type a title and **Run now**, or **In 5s** to watch the scheduler release it later. A title containing "fail" throws on purpose — watch the queue retry it with backoff before marking it failed. Only two jobs process at a time, so a burst queues up visibly.

From another terminal:

```bash
curl localhost:8090/jobs                                      # the last 50 tasks
curl -X POST localhost:8090/jobs -d '{"title":"from curl"}'   # enqueue one
```

## What it shows

- **`workQueue`** — `enqueueAction` with `retry: { maxAttempts: 3 }` and an `onComplete` mutation; `maxParallelism: 2` paces the work; `list({ state })` and `status({ id })` drive the console, live like any query; `cancel({ id })` stops pending items.
- **`onCompleteArgs`** — types the `context` the callback receives, with `result.kind` telling success, failure (after the last retry) and cancellation apart.
- **The action/mutation split** — the worker is an internal action (timers, network, anything Node offers, no database); it writes through `ctx.runMutation`.
- **`ctx.scheduler.runAt`** — delayed jobs; jobs and schedules survive restarts.
- **Cron jobs** — `crons.interval` in `onebase/crons.ts` prunes finished tasks every 5 minutes (the work queue also runs its own internal sweep cron).
- **HTTP routes** — `onebase/http.ts` exposes `GET`/`POST /jobs` via `httpRouter` + `httpAction` + `ctx.runQuery`/`ctx.runMutation`, so scripts can enqueue without the WebSocket client.

## Files

```
onebase/
  schema.ts       tasks table (state, output, itemId)
  components.ts   queue: workQueue({ maxParallelism: 2, retry: { maxAttempts: 3 } })
  tasks.ts        list, detail, queuePending, enqueue, enqueueLater, cancel, clearFinished
  workers.ts      start, process (the action), setRunning, finished (onComplete), pruneFinished
  crons.ts        interval cron pruning finished tasks
  http.ts         GET/POST /jobs
public/index.html job console, no build step
```
