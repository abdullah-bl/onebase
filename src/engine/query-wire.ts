// What the main thread and a query worker say to each other (see query-pool.ts and
// query-thread.ts). Everything here crosses postMessage, so it's plain data.

import type { UserIdentity } from "../server";
import type { CodeSource, WireError } from "./action-wire";
import type { LogLine } from "./calllog";
import type { ReadSet } from "./database";
import type { CallLimits } from "./limits";

/** Main thread → query worker. */
export type ToQueryThread =
  | {
      t: "init-query";
      source: CodeSource;
      /** The SQLite file the server has open in WAL mode; the worker opens its own read-only connection. */
      path: string;
      /** For ctx.storage.getUrl(). */
      siteUrl: string;
      callLimits: CallLimits;
    }
  /** Runs one query in a snapshot of its own. `name` was already resolved and checked on the main thread. */
  | { t: "query"; job: number; name: string; args: unknown; identity: UserIdentity | null };

/** Query worker → main thread. */
export type FromQueryThread =
  | { t: "ready"; functions: string[] }
  | { t: "failed"; error: string }
  | { t: "done"; job: number; ok: true; json: string; readSet: ReadSet; lines: LogLine[] }
  | { t: "done"; job: number; ok: false; error: WireError; readSet: ReadSet; lines: LogLine[] }
  /** The query used something only the main thread has (a function handle): run it there instead. */
  | { t: "done"; job: number; ok: false; mainThread: string; lines: LogLine[] };
