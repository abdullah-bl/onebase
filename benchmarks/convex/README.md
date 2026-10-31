# Convex comparison scripts

The scripts behind [docs/benchmarks.md](../../docs/benchmarks.md). They run the same functions on self-hosted Convex and onebase, over HTTP on one machine.

You need Docker, Node 22 or later, Bun, Python 3 and `curl`. Run every command below from this folder, `benchmarks/convex`, in one shell, so the exported keys stay set.

| Folder | |
|---|---|
| `docker/` | `docker-compose.yml` is Convex's official self-hosted file, unchanged. `onebase-compose.yml` runs onebase |
| `app/` | The functions. The two apps match except for imports and the filter syntax in `scanDocs`, and only onebase has the correctness functions |
| `bench/` | Limit tests (`bench.mjs`), sustained load (`stress.mjs`, `run-stress.sh`), resource samples (`sample-stats.sh`, `aggregate.py`), crash and correctness tests (`correctness/`) |

## Start both backends

Keep both running, even when you only test one: `run-stress.sh` samples both containers and stops if either is missing. Keep the project name `convex` too, because it gives the container name `convex-backend-1` that the sampling expects.

```bash
docker build -t onebase:local ../..
```

```bash
export ONEBASE_ADMIN_KEY=$(openssl rand -hex 32)
```

```bash
docker compose -p onebase -f docker/onebase-compose.yml up -d
```

```bash
docker compose -p convex -f docker/docker-compose.yml up -d
```

Convex takes a few seconds to come up. Then get its admin key:

```bash
export CONVEX_ADMIN_KEY=$(docker compose -p convex -f docker/docker-compose.yml exec -T backend ./generate_admin_key.sh | tail -1)
```

onebase listens on port 8190 and Convex on 3210. To use other addresses, set `ONEBASE_URL` and `CONVEX_URL`.

The published numbers used the Convex image `sha256:207cf95def42f01614b6e3af0af5c20d0dcaa5ff2adf258ee7bc9555576644fa`. The compose file pulls `latest`, which may have moved since.

## Deploy the functions

```bash
(cd app/convex-app && npm ci && npx convex dev --url http://127.0.0.1:3210 --admin-key "$CONVEX_ADMIN_KEY" --once)
```

```bash
(cd app/onebase-app && bun install && ONEBASE_DEPLOY_URL=http://127.0.0.1:8190 ONEBASE_DEPLOY_KEY="$ONEBASE_ADMIN_KEY" bun ../../../../src/cli.ts deploy)
```

The onebase app installs this repository as its `onebase` package, so run `bun install` again after changing `src/`.

## Stress test

> **Warning:** clear Convex's `docs` table before a stress run, or the scan and memory results get polluted. The stress run seeds its own 2,000 documents and expects the table to start empty, but limit tests such as `node bench/bench.mjs convex` can leave documents behind.

```bash
node bench/bench.mjs convex docs-clear
```

```bash
node bench/bench.mjs onebase docs-clear
```

Restart the containers so memory starts clean:

```bash
docker restart convex-backend-1 onebase-bench
```

Convex's memory also grows with stored write history, which a restart doesn't remove. When memory is what you're comparing, start from a new volume with `docker compose -p convex -f docker/docker-compose.yml down -v`, then bring it up, get a new admin key and deploy again.

Each round takes about 6 minutes:

```bash
bench/run-stress.sh convex 2>&1 | tee bench/stress-convex.log
```

```bash
bench/run-stress.sh onebase 2>&1 | tee bench/stress-onebase.log
```

Requests per second and latency are on the `RESULT` lines. For CPU and memory:

```bash
python3 bench/aggregate.py
```

Each row reports both containers. Read the one that was under load: `convex-backend-1` in `convex_*` rows and `onebase-bench` in `onebase_*` rows.

To run some modes only, set `MODES` to `mode:workers` pairs, such as `MODES="write:100" bench/run-stress.sh onebase`.

For the `synchronous=FULL` rows, recreate onebase, then measure writes one at a time and with 100 workers:

```bash
ONEBASE_SYNCHRONOUS=FULL docker compose -p onebase -f docker/onebase-compose.yml up -d --force-recreate
```

```bash
node bench/bench.mjs onebase throughput
```

```bash
node bench/stress.mjs onebase write 60 100
```

## Vector tests

Seeding inserts 10,000 × 1536-dimension documents, then these measure search. Seeding is slower on Convex, which has a 4 MiB/s write limit.

```bash
node bench/bench.mjs convex vector-seed vector-search vector-scale
```

```bash
node bench/bench.mjs onebase vector-seed vector-search vector-scale
```

Sustained search with resource samples, over the documents seeded above:

```bash
MODES="vector:50" bench/run-stress.sh convex 2>&1 | tee bench/stress-vector-convex.log
```

```bash
MODES="vector:50" bench/run-stress.sh onebase 2>&1 | tee bench/stress-vector-onebase.log
```

Remove the documents afterwards, since they also affect later memory results. This takes about two minutes on Convex, because its write limit counts deletes.

```bash
node bench/bench.mjs convex vector-clear
```

```bash
node bench/bench.mjs onebase vector-clear
```

## Crash and correctness tests

These run on onebase. Rows left in `docs` affect them, and they leave rows that would pollute a later scan, so clear the table before each test and after the last one. `killtest.mjs` kills and restarts the `onebase-bench` container.

```bash
node bench/bench.mjs onebase docs-clear
```

```bash
node bench/correctness/killtest.mjs
```

```bash
node bench/bench.mjs onebase docs-clear
```

```bash
node bench/correctness/contention.mjs
```

```bash
node bench/correctness/subs.mjs
```

```bash
node bench/bench.mjs onebase docs-clear
```

## CPU-bound test

`bench:busy` runs a fixed number of iterations and returns `{ iterations, checksum }`. The caller measures the time. The same iterations give the same checksum on both backends, so a matching checksum shows both did the same work.

`exec-time` tries a rising number of iterations, up to about 3 seconds on the machine in the docs:

```bash
node bench/bench.mjs convex exec-time
```

```bash
node bench/bench.mjs onebase exec-time
```

`correctness/busy.mjs` sends pings while the function runs, to show whether other requests wait. Its default is 4 billion iterations, which Convex failed after about 1 second in a quick check. For a comparison, set `BUSY_ITERATIONS` to a count that finishes on both backends:

```bash
BUSY_ITERATIONS=1000000000 node bench/correctness/busy.mjs convex
```

```bash
BUSY_ITERATIONS=1000000000 node bench/correctness/busy.mjs onebase
```

This test replaced one that looped until `Date.now()` advanced, which can't work on Convex because its clock doesn't advance during a function. The published CPU results came from that older version.

## Other limit tests

```bash
node bench/bench.mjs convex arg-size doc-size docs-per-txn scan read-volume
```

```bash
node bench/bench.mjs onebase arg-size doc-size docs-per-txn scan read-volume
```

`node bench/bench.mjs <convex|onebase>` with no scenario runs everything, including the vector seeding, and takes a long time. `node bench/bench.mjs` with no arguments lists the scenarios. Results are appended to `bench/results.json`.

## Not covered

No script here produces these numbers from the docs page: disk writes per request, vector search right after each write, vector search alongside concurrent writers, and the fallback when a vector index is over its memory budget.
