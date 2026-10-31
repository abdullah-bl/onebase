---
title: Benchmarks
description: How onebase compared with self-hosted Convex on one machine, how we tested, and what we didn't test.
---

# Benchmarks

In our tests on one machine, onebase used far less memory than self-hosted Convex and was faster at writes and vector search. It lost no acknowledged writes when the process was killed.

Convex won one test: it served a repeated scan about 5× faster, most likely from its query cache. onebase also doesn't isolate long-running functions, hasn't been tested through a power cut, and hasn't been compared with a tuned Convex. Read these numbers as one machine's results, not as a general ranking.

## Test setup

| | |
|---|---|
| Machine | NVIDIA DGX Spark: arm64, 20 cores (10 Cortex-X925, 10 Cortex-A725), 121 GiB RAM visible to Linux |
| Disk | Samsung NVMe, 4 TB (MZALC4T0HBL1), ext4 |
| OS | Linux with NVIDIA's kernel, Docker 29.6.2 |
| Containers | On the same disk, with no CPU or memory limits. Load went to one backend at a time |
| onebase | Docker image built from `main` after [PR #22](https://github.com/abdullah-bl/onebase/pull/22), Bun 1.4.4, SQLite in WAL mode. `synchronous=NORMAL` (the default) unless a row says `FULL` |
| Convex | `ghcr.io/convex/convex-backend:latest` (image `bb1c324d822c`) from the official self-hosted compose file, with default settings and its default SQLite storage |
| Load | Node 22 on the same machine, sending HTTP requests over loopback. Each worker waits for a reply before sending its next request |
| Dates | October 29–31, 2026 |

Both backends ran the same functions, apart from the imports (`convex/*` or `onebase/*`) and the filter syntax in the scan test. The crash and correctness functions exist only on onebase.

Each sustained test ran for 60 seconds. CPU and memory come from `docker stats`, sampled about every 2 seconds, where 100% is one core. `docker stats` reads lower than process RSS: a fresh onebase server on this machine showed about 46 MB RSS, against about 10 MiB in `docker stats`.

| Test | What each request does | Concurrent workers |
|---|---|---|
| ping | Query that returns a constant | 300 |
| scan | Query that filters a 2,000-document table, unindexed, matching nothing | 100 |
| write | Mutation that inserts a 1 KB document and deletes it | 100 |
| bigdoc | The same with a 512 KB document | 50 |
| mixed | Half ping, half write | 150 |
| vector | Action that searches 10,000 × 1536-dimension vectors for the top 10 | 50 |

## Results

### Sustained load

| Test | Requests/s: Convex | onebase | CPU: Convex | onebase | Memory: Convex | onebase |
|---|---|---|---|---|---|---|
| ping | 10,406 | 10,702 | 176% | 57% | 2,510 MiB | 32 MiB |
| scan | **12,936** | 2,467 | 222% | 102% | 2,514 MiB | 30 MiB |
| write | 971 | **10,665** | 268% | 61% | 3,035 MiB | 39 MiB |
| bigdoc | 805 | **1,383** | 375% | 105% | 3,199 MiB | 168 MiB |
| mixed | 2,048 | **11,388** | 298% | 54% | 3,181 MiB | 42 MiB |

No request failed on either side.

### Writes and durability

| 1 KB writes | One at a time | 100 concurrent | Median latency at 100 |
|---|---|---|---|
| Convex (fsync policy unknown) | 59–60/s | 952–971/s | 101 ms |
| onebase `NORMAL` (no fsync per commit) | 372–463/s | 7,822–10,665/s | 9–13 ms |
| onebase `FULL` (fsync on commit) | 152/s | 4,389/s | 22 ms |

`FULL` is the fairer comparison if you assume Convex syncs every commit, but we don't know that it does. The ranges come from repeated rounds.

### Vector search

10,000 documents with 1536 dimensions.

| | Convex | onebase |
|---|---|---|
| One search at a time, median / p95 | 10 ms / 13 ms | 5 ms / 6 ms |
| With a filter, median | 9 ms | 5 ms |
| 200 searches at once | 1,130/s | 1,117/s |
| Sustained, 50 workers | 1,556–1,575/s | 2,099/s |
| CPU under sustained load | about 16.6 cores | about 7.9 cores |
| Memory under sustained load | 11.8 GiB | 363 MiB |
| Inserting the documents | 221–225/s (held back by Convex's write limit) | 1,415–1,528/s |

We only checked that each stored vector finds itself as the top hit (score 1.0 on both). We didn't compare recall.

### Default limits

| | Convex | onebase |
|---|---|---|
| One document | fails at 1 MiB | 32 MiB passed (largest tried) |
| Writes in one function | fails at 16,001 documents | 128,000 passed (largest tried) |
| Scan 100,000 documents in a query | fails after about 15 s | 91 ms |

Convex's limits are deliberate protections. Having fewer limits isn't simply better: on onebase, nothing stops a function from using up the server.

### Crash and correctness tests

These ran on onebase only, once each, with default settings.

| Test | Result |
|---|---|
| `kill -9` during writes, 20 clients | 32,606 writes acknowledged, 0 lost, 0 duplicated. Up again 311 ms after a manual restart |
| 200 concurrent increments of one document | All succeeded, returning exactly 1 to 200 |
| 30 updates on a live query | Final value correct, in order. 17 of the 30 were delivered because close updates merge |
| Vector search right after each write | 2,500 searches, each of a vector just written, 0 missed it (8 dimensions, outside Docker) |
| Pings during a 3-second CPU-bound function | **The ping waited 3,013 ms**, against 3 ms normally |

## Where onebase falls short

- **Long-running functions block the server.** Functions share one thread, so CPU-bound code stalls every other request, as the last row above shows. [Time limits](./functions.md#time-limits) can't interrupt code that never yields.
- **Power loss is untested.** `kill -9` only tests a process crash. With the default `synchronous=NORMAL`, a power cut or OS crash can lose the most recent commits. Set `ONEBASE_SYNCHRONOUS=FULL` if you can't accept that, and expect the slower numbers above.
- **It writes more to disk.** An earlier version wrote 20.6 KB per 1 KB write, against Convex's 7.8 KB, and 545 KB per 512 KB write, against 8 KB. Convex seems to merge an insert and delete in one transaction, which flatters it here. We haven't repeated this since the write path changed.
- **Repeated reads aren't cached.** The scan test reran the query for every HTTP request, while Convex most likely answered from its cache. We didn't confirm the cache was the cause.
- **Vector search checks every vector.** Time grows with the size of the index. We tested up to 10,000 vectors, where it took 3, 4 and 5 ms at 1,000, 5,000 and 10,000. Convex may win on latency at larger sizes.
- **Vector search can drop off sharply.** An index over the memory budget (2,048 MB by default, or roughly 335,000 × 1536 vectors, untested) falls back to scanning in SQL. That managed about 6 searches/s at 10,000 vectors.
- **Vector search slows during writes.** In a run outside Docker, it managed 1,836 searches/s with 1 writer and 794 with 8. We don't have the same numbers for Convex.
- **SQLite means one server.** Postgres, MySQL and Turso are available for several instances, but none of them were benchmarked.

## What these tests don't show

- **Tuned Convex.** Convex ran with its defaults, including 16 concurrent functions per kind and a 4 MiB/s write limit, and these may cap its write numbers. We didn't try raising them, or running on Postgres.
- **Convex Cloud.** Only the self-hosted backend was tested.
- **Fair memory numbers for Convex.** Its memory grows with stored write history. The volume had been through several rounds: idle memory was 2.4 GiB here, against 177 MiB on a younger volume.
- **Repeatability.** Each sustained result is mostly a single run. Convex's write results varied by about 25% between rounds, so ignore smaller differences.
- **Other hardware.** Nothing was measured on x86-64. With 121 GiB of RAM, reads came from the page cache and never touched the disk. A smaller machine will behave differently.
- **A real network.** The load generator ran on the same machine and shared its CPU.
- **Live queries at scale.** We counted open WebSockets, but didn't measure delivering updates to many subscribers on either side.
- **Consistency.** We didn't compare the guarantees of Convex's optimistic concurrency with onebase's serial writes.
- **Long-running functions on Convex.** Our CPU test looped until `Date.now()` advanced. It failed on Convex at 500 ms, but Convex documents a clock that doesn't advance during a function, so the test itself is the likely cause. We have no valid comparison of how each backend handles this.

The scripts are in [`benchmarks/convex`](https://github.com/abdullah-bl/onebase/tree/main/benchmarks/convex), with the commands to rerun these tests. A few numbers have no script: disk writes per request, and the vector search runs outside Docker. The CPU test has changed since these runs: it now does a fixed amount of computation instead of watching the clock, so it can run on Convex. Nobody has rerun it yet, so the comparison of long-running functions on Convex is still missing. `bun run bench` in this repository is a different benchmark: it measures onebase's engine in-process, with no HTTP and no Convex.
