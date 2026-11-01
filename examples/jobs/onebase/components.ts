import { defineComponents } from "onebase/components";
import { workQueue } from "onebase/components/work-queue";

export default defineComponents({
  // At most 2 items run at once (watch the console queue up more), failed
  // actions are retried up to 3 times with exponential backoff.
  queue: workQueue({ maxParallelism: 2, retry: { maxAttempts: 3 } }),
});
