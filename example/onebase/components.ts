import { defineComponents } from "onebase/components";
import { rateLimiter, SECOND } from "onebase/components/rate-limiter";

export default defineComponents({
  // Each author can post 5 messages at once, then one more every 2 seconds.
  limiter: rateLimiter({
    rates: { sendMessage: { kind: "token bucket", rate: 1, period: 2 * SECOND, capacity: 5 } },
  }),
});
