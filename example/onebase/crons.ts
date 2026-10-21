import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every day at 03:00 UTC, delete messages older than 30 days.
crons.daily("prune old messages", { hourUTC: 3, minuteUTC: 0 }, internal.messages.prune, { days: 30 });

export default crons;
