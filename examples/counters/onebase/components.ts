import { defineComponents } from "onebase/components";
import { aggregate } from "onebase/components/aggregate";
import { rateLimiter, SECOND } from "onebase/components/rate-limiter";
import { shardedCounter } from "onebase/components/sharded-counter";
import type { Doc } from "./_generated/dataModel";

export default defineComponents({
  // One vote count per option: follows the votes table through a table hook,
  // so every insert and delete updates it in the same transaction.
  pollCounts: aggregate({
    table: "votes",
    sortKey: (d: Doc<"votes">) => d._creationTime,
    namespace: (d) => d.option,
  }),
  // The grand total across all options, split over shards so concurrent
  // writers each touch a different document.
  counter: shardedCounter({ shards: 8 }),
  // Bursts of 3 votes per voter, then one more every 2 seconds.
  limiter: rateLimiter({
    rates: { vote: { kind: "token bucket", rate: 1, period: 2 * SECOND, capacity: 3 } },
  }),
});
