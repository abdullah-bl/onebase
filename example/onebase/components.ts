import { defineComponents } from "onebase/components";
import { aggregate } from "onebase/components/aggregate";
import { rateLimiter, SECOND } from "onebase/components/rate-limiter";
import type { Doc } from "./_generated/dataModel";

export default defineComponents({
  // Each author can post 5 messages at once, then one more every 2 seconds.
  limiter: rateLimiter({
    rates: { sendMessage: { kind: "token bucket", rate: 1, period: 2 * SECOND, capacity: 5 } },
  }),
  // Messages per channel, in time order: follows the messages table by itself.
  messageCounts: aggregate({
    table: "messages",
    sortKey: (d: Doc<"messages">) => d._creationTime,
    namespace: (d) => d.channel,
  }),
});
