# counters — a live poll driven by components

A poll where every window updates the moment anyone votes. It mounts the three counting components onebase ships with and lets them do the work — no counter fields, no trigger wiring.

## Run it

```bash
cd examples/counters
bun ../../src/cli.ts dev
```

Open the printed URL (http://localhost:8090) in two windows, vote in both, and watch the leaderboard and total re-rank live.

## What it shows

- **`aggregate` with a table hook** — `pollCounts` follows the `votes` table (`sortKey`, `namespace`), so every insert *and delete* keeps per-option counts in the same transaction. `count({ namespace })` reads a few documents however many votes exist.
- **`shardedCounter`** — `counter.inc`/`dec`/`count` for the grand total, spread over 8 shard documents so concurrent writers don't touch the same one.
- **`rateLimiter`** — a token bucket (`capacity: 3`, one token per 2s) per voter key inside the vote mutation's transaction; `check` preflights the button so it dims while you're out of tokens.
- **Two-field index** — `by_option_voter` powers "undo my last vote" with `.order("desc").first()`.
- **Live queries** — the leaderboard is a plain query; sorting happens in the browser on every push.

## Files

```
onebase/
  schema.ts       options + votes (by_option, by_option_voter indexes)
  components.ts   pollCounts (aggregate), counter (shardedCounter), limiter (rateLimiter)
  polls.ts        listOptions, getOrCreateOption, leaderboard, totalVotes, canVote, vote, undo
public/index.html voting UI, no build step
```
