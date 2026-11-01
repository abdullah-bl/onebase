import { cronJobs } from "onebase/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Every 5 minutes, forget finished tasks older than half an hour.
crons.interval("clean finished tasks", { minutes: 5 }, internal.workers.pruneFinished, {});

export default crons;
