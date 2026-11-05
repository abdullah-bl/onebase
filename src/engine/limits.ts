// How much one query or mutation may read and write. Convex has the same kind of limits, much
// lower; these are generous defaults meant to stop a runaway call, not to shape normal code.

import { OnebaseError } from "./database";

/** What one call may read and write; 0 turns a limit off. */
export type CallLimits = {
  /** Documents a query or mutation may read with db.get() and db.query(). */
  documentsRead: number;
  /** Documents a mutation may insert, patch, replace or delete. */
  documentsWritten: number;
  /** Bytes of documents (as stored JSON) a mutation may write. */
  bytesWritten: number;
  /** Bytes in one document, as stored JSON. */
  documentBytes: number;
};

export const DEFAULT_CALL_LIMITS: CallLimits = {
  documentsRead: 256_000,
  documentsWritten: 128_000,
  bytesWritten: 128 * 2 ** 20,
  documentBytes: 16 * 2 ** 20,
};

/** The environment variable that sets each limit, for error messages and the CLI. */
export const CALL_LIMIT_ENV: Record<keyof CallLimits, string> = {
  documentsRead: "ONEBASE_MAX_READS",
  documentsWritten: "ONEBASE_MAX_WRITES",
  bytesWritten: "ONEBASE_MAX_WRITE_MB",
  documentBytes: "ONEBASE_MAX_DOCUMENT_MB",
};

export function formatBytes(bytes: number): string {
  if (bytes >= 2 ** 20) return `${+(bytes / 2 ** 20).toFixed(1)} MB`;
  if (bytes >= 1024) return `${+(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

const count = (n: number) => n.toLocaleString("en-US");

/**
 * One call's reads and writes against its limits. Going over the total for the call fails it:
 * the error is thrown again on every later read or write and when the call ends, so a function
 * can't catch it and carry on (a mutation's writes are rolled back). Nested calls in the same
 * transaction share their caller's budget.
 */
export class CallBudget {
  private reads = 0;
  private writes = 0;
  private bytes = 0;
  private exceeded: OnebaseError | null = null;

  constructor(
    readonly name: string,
    readonly kind: "query" | "mutation",
    private readonly limits: CallLimits,
  ) {}

  /** Throws again the error that ended this call, if one did. */
  check(): void {
    if (this.exceeded) throw this.exceeded;
  }

  /** How many more documents this call may read (Infinity: no limit). */
  readsLeft(): number {
    this.check();
    const max = this.limits.documentsRead;
    return max ? Math.max(0, max - this.reads) : Infinity;
  }

  /** Counts `n` documents read. */
  read(n: number): void {
    this.check();
    this.reads += n;
    const max = this.limits.documentsRead;
    if (max && this.reads > max) {
      this.fail(
        `${this.name} read more than ${count(max)} documents, the limit for one ${this.kind}. ` +
          `Read fewer with an index (.withIndex()), .take(n) or .paginate(), or raise ${CALL_LIMIT_ENV.documentsRead}.`,
      );
    }
  }

  /** Counts a write of `json` (null for a delete), before it reaches the database. */
  write(table: string, json: string | null): void {
    this.check();
    const size = json === null ? 0 : Buffer.byteLength(json);
    const { documentBytes, documentsWritten, bytesWritten } = this.limits;
    if (documentBytes && size > documentBytes) {
      // Like a schema error: this write is refused, and the function may handle it.
      throw new OnebaseError(
        `${this.name}: this "${table}" document is ${formatBytes(size)}, over the ${formatBytes(documentBytes)} limit for one document. ` +
          `Keep large data in file storage (ctx.storage) and store its id, or raise ${CALL_LIMIT_ENV.documentBytes}.`,
      );
    }
    this.writes += 1;
    this.bytes += size;
    if (documentsWritten && this.writes > documentsWritten) {
      this.fail(
        `${this.name} wrote more than ${count(documentsWritten)} documents, the limit for one mutation. ` +
          `Split the work into several mutations, e.g. a batch at a time with ctx.scheduler.runAfter(0, ...), or raise ${CALL_LIMIT_ENV.documentsWritten}.`,
      );
    }
    if (bytesWritten && this.bytes > bytesWritten) {
      this.fail(
        `${this.name} wrote more than ${formatBytes(bytesWritten)} of documents, the limit for one mutation. ` +
          `Split the work into several mutations, or raise ${CALL_LIMIT_ENV.bytesWritten}.`,
      );
    }
  }

  private fail(message: string): never {
    this.exceeded = new OnebaseError(message);
    throw this.exceeded;
  }
}
