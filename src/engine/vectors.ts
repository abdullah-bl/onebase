// In-memory vector indexes for local SQLite. The side tables stay the source of truth; a search
// ranks a copy held here, normalized and side by side in memory, instead of calling a JS function
// from SQL for every row. Every write logs which document changed in its own transaction, so a
// rollback undoes the log entry too, and a search catches up from the log on its read snapshot.
//
// The copy lives in shared memory, so big indexes are searched on worker threads and only the
// answer comes back here. Rows are versioned, so writes and searches don't wait for each other: a
// search compares the rows of the version it started on, a write only adds rows of a newer one,
// and a slot is used again only when no running search can still see what it held.

import { availableParallelism } from "node:os";
import type { VectorIndexDef } from "../schema";
import { floats as blobFloats, sqliteDialect, type Dialect, type VectorHit, type VectorMatch } from "./dialect";
import type { Exec } from "./driver";

const VECTOR_LOG_DDL = "CREATE TABLE IF NOT EXISTS _vector_log (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, doc_id TEXT NOT NULL)";
/** The log keeps this many changes; a search further behind than that reloads instead. */
const LOG_KEEP = 1024;
/** Rows read per query while loading, so a big index doesn't sit in memory twice. */
const LOAD_PAGE = 4096;
/** An index nobody searched for this long gives its memory back; the next search reloads it. */
const IDLE_MS = 30 * 60 * 1000;
const MIN_ROWS = 64;
const WASM_PAGE = 65536;
const WASM_MAX_PAGES = 65536;
/** Past this many workers, memory bandwidth limits a search more than cores do. */
const MAX_DEFAULT_WORKERS = 8;
/** Smaller indexes are searched right here: about 130 µs of work, not worth starting threads for. */
const MIN_WORKER_FLOATS = 1 << 20;

/**
 * dot(a, b, bytes): the dot product of two float32 vectors in memory, 16 bytes at a time.
 *
 *   (import "e" "m" (memory 0 65536 shared))
 *   (func (export "d") (param $a i32) (param $b i32) (param $n i32) (result f32) (local $sum v128)
 *     (block (loop
 *       (br_if 1 (i32.eqz (local.get $n)))
 *       (local.set $sum (f32x4.add (local.get $sum) (f32x4.mul (v128.load (local.get $a)) (v128.load (local.get $b)))))
 *       (local.set $a (i32.add (local.get $a) (i32.const 16)))
 *       (local.set $b (i32.add (local.get $b) (i32.const 16)))
 *       (local.set $n (i32.sub (local.get $n) (i32.const 16)))
 *       (br 0)))
 *     (f32.add (f32.add (f32.add (f32x4.extract_lane 0 (local.get $sum)) (f32x4.extract_lane 1 (local.get $sum)))
 *                       (f32x4.extract_lane 2 (local.get $sum))) (f32x4.extract_lane 3 (local.get $sum))))
 */
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];
const DOT_BODY = [
  1, 1, 0x7b, // one v128 local
  0x02, 0x40, 0x03, 0x40, // block, loop
  0x20, 2, 0x45, 0x0d, 1, // br_if 1 (n == 0)
  0x20, 3, 0x20, 0, 0xfd, 0, 2, 0, 0x20, 1, 0xfd, 0, 2, 0, 0xfd, 0xe6, 1, 0xfd, 0xe4, 1, 0x21, 3, // sum += a * b
  0x20, 0, 0x41, 16, 0x6a, 0x21, 0, // a += 16
  0x20, 1, 0x41, 16, 0x6a, 0x21, 1, // b += 16
  0x20, 2, 0x41, 16, 0x6b, 0x21, 2, // n -= 16
  0x0c, 0, 0x0b, 0x0b, // br 0, end, end
  0x20, 3, 0xfd, 0x1f, 0, 0x20, 3, 0xfd, 0x1f, 1, 0x92, 0x20, 3, 0xfd, 0x1f, 2, 0x92, 0x20, 3, 0xfd, 0x1f, 3, 0x92, // add the lanes
  0x0b,
];
const DOT_WASM = new Uint8Array([
  0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
  ...section(1, [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7d]), // (i32, i32, i32) -> f32
  ...section(2, [1, 1, 0x65, 1, 0x6d, 2, 3, 0, 0x80, 0x80, 4]), // imports shared memory "e" "m", up to 4 GiB
  ...section(3, [1, 0]),
  ...section(7, [1, 1, 0x64, 0, 0]), // exports function "d"
  ...section(10, [1, DOT_BODY.length, ...DOT_BODY]),
]);

/** Null where WebAssembly SIMD or threads aren't available; vectors are then compared in plain JS, on this thread. */
const dotModule = (() => {
  try {
    return WebAssembly.validate(DOT_WASM) ? new WebAssembly.Module(DOT_WASM) : null;
  } catch {
    return null;
  }
})();

type Dot = (a: number, b: number, bytes: number) => number;

/** Rows are visible from this version on... */
const BORN = 0;
/** ...until this one. Set in this order, read in the reverse, so a slot being reused never looks visible. */
const DIED = 1;
const FIELDS = 2;
const FOREVER = 0x7fffffff;

/** Where to look, as sent to a worker. A row starts with its versions and filter value ids, then its vector. */
type ScanTask = {
  version: number;
  firstRow: number;
  endRow: number;
  queryRow: number;
  /** Floats per row, and how many of them come before the vector. */
  stride: number;
  header: number;
  dimensions: number;
  limit: number;
  /** Flat [field, value id, ...]: a row must have one of these. Null for no filter. */
  any: number[] | null;
};

/** The best rows, most similar first. */
type Scanned = {
  found: number;
  rows: Int32Array;
  scores: Float64Array;
  /** Another row scored the same as the last one, and only ids can say which comes first. */
  tie: boolean;
};

/**
 * Finds the rows nearest to the query. Workers run this from its source text, so it can't use
 * anything from outside. `before` orders rows with equal scores; without it the first row wins
 * and a tie at the cut-off is reported.
 */
function scan(t: ScanTask, floats: Float32Array, ints: Int32Array, dot: Dot, before?: (a: number, b: number) => boolean): Scanned {
  const { version, firstRow, endRow, queryRow, stride, header, dimensions, limit, any } = t;
  const rowBytes = stride * 4;
  const headerBytes = header * 4;
  const vectorBytes = (stride - header) * 4;
  const query = queryRow * rowBytes + headerBytes;
  const best = new Float32Array(limit);
  const rows = new Int32Array(limit);
  let found = 0;
  let tie = false;
  for (let row = firstRow; row < endRow; row++) {
    const at = row * stride;
    // DIED, then BORN, with the filter values after them: scan() can't use those names from here.
    if (Atomics.load(ints, at + 1) <= version || Atomics.load(ints, at) > version) continue;
    if (any) {
      let matches = false;
      for (let i = 0; i < any.length && !matches; i += 2) matches = ints[at + 2 + any[i]!] === any[i + 1];
      if (!matches) continue;
    }
    const score = dot(query, row * rowBytes + headerBytes, vectorBytes);
    if (found === limit && score <= best[limit - 1]!) {
      if (score < best[limit - 1]!) continue;
      if (!before) tie = true;
      if (!before || !before(row, rows[limit - 1]!)) continue;
    }
    let i = found < limit ? found++ : limit - 1;
    for (; i > 0 && (score > best[i - 1]! || (score === best[i - 1] && before !== undefined && before(row, rows[i - 1]!))); i--) {
      best[i] = best[i - 1]!;
      rows[i] = rows[i - 1]!;
    }
    best[i] = score;
    rows[i] = row;
  }
  // Float32 sums are good enough to choose; the scores returned are computed like SQL's.
  const scores = new Float64Array(limit);
  const q = queryRow * stride + header;
  for (let i = 0; i < found; i++) {
    const r = rows[i]! * stride + header;
    let product = 0;
    let nx = 0;
    let ny = 0;
    for (let j = 0; j < dimensions; j++) {
      product += floats[q + j]! * floats[r + j]!;
      nx += floats[q + j]! * floats[q + j]!;
      ny += floats[r + j]! * floats[r + j]!;
    }
    scores[i] = nx === 0 || ny === 0 ? 0 : product / Math.sqrt(nx * ny);
  }
  return { found, rows, scores, tie };
}

/** A worker's whole program. Like scan(), it runs from its source text. */
function workerMain(scanRows: typeof scan, wasm: Uint8Array<ArrayBuffer>) {
  const module = new WebAssembly.Module(wasm);
  const scope = globalThis as any;
  const tables = new Map<number, { memory: WebAssembly.Memory; dot: Dot; bytes: number; floats: Float32Array; ints: Int32Array }>();
  scope.onmessage = ({ data }: { data: any }) => {
    if (data.open !== undefined) {
      const dot = new WebAssembly.Instance(module, { e: { m: data.memory } }).exports.d as Dot;
      tables.set(data.open, { memory: data.memory, dot, bytes: 0, floats: new Float32Array(0), ints: new Int32Array(0) });
    } else if (data.close !== undefined) {
      tables.delete(data.close);
    } else {
      const table = tables.get(data.table)!;
      const buffer = table.memory.buffer;
      if (buffer.byteLength !== table.bytes) {
        table.bytes = buffer.byteLength;
        table.floats = new Float32Array(buffer);
        table.ints = new Int32Array(buffer);
      }
      scope.postMessage(scanRows(data.scan, table.floats, table.ints, table.dot));
    }
  };
}

/** `value` as a SQL parameter, which is how `=` sees it. */
const sqlValue = (value: unknown) => sqliteDialect.encode(value ?? null, "json");

/** Whether a filter can be answered here: the values SQLite hands back are strings, numbers and null. */
function comparable(match: VectorMatch): boolean {
  if (match.op === "or") return match.args.every(comparable);
  const value = sqlValue(match.value);
  return value === null || typeof value === "string" || typeof value === "number";
}

let nextTableId = 1;

/** One index in memory. The first rows hold query vectors, one for each thread that can search it; slot `s` is the row after them. */
export class VectorTable {
  readonly id = nextTableId++;
  readonly fields: string[];
  usedAt = 0;
  /** Dropped from the cache; running searches can still finish. */
  dropped = false;
  /** What new searches see. Rows being written belong to the next one, so a batch of writes appears all at once. */
  private version = 1;
  /** Running searches per version they see. */
  private readonly readers = new Map<number, number>();
  /** Slots whose document changed, with the version it stopped being visible at, oldest first. */
  private readonly retired: { slot: number; died: number }[] = [];
  private readonly dimensions: number;
  /** Floats per row and before its vector, in multiples of 4 for SIMD. */
  private readonly stride: number;
  private readonly header: number;
  private readonly memory: WebAssembly.Memory | null = null;
  private readonly dot: Dot;
  private floats!: Float32Array;
  private ints!: Int32Array;
  private capacity = 0;
  /** The document in each slot; null for a free one. */
  private readonly ids: (string | null)[] = [];
  /** The slot each document is visible in, as of the next version. */
  private readonly slots = new Map<string, number>();
  private readonly free: number[] = [];
  /** Each filter field's values, numbered: rows hold the numbers, so workers needn't know the values. */
  private readonly values: Map<unknown, number>[];

  constructor(
    index: VectorIndexDef,
    private readonly budget: { left: number },
    simd = dotModule !== null,
    private readonly queries = 1,
  ) {
    this.fields = index.filterFields;
    this.values = index.filterFields.map(() => new Map());
    this.dimensions = index.dimensions;
    this.header = (index.filterFields.length + FIELDS + 3) & ~3;
    this.stride = this.header + ((index.dimensions + 3) & ~3);
    const initial = queries * this.stride * 4;
    let dot: Dot | null = null;
    if (simd) {
      try {
        this.memory = new WebAssembly.Memory({ initial: Math.ceil(initial / WASM_PAGE), maximum: WASM_MAX_PAGES, shared: true });
        dot = new WebAssembly.Instance(dotModule!, { e: { m: this.memory } }).exports.d as Dot;
      } catch {
        this.memory = null; // no room to reserve shared memory, say under ulimit -v
      }
    }
    this.view(this.memory?.buffer ?? new ArrayBuffer(initial));
    this.dot =
      dot ??
      ((a, b, bytes) => {
        const data = this.floats;
        const x = a >>> 2;
        const y = b >>> 2;
        const n = bytes >>> 2;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += data[x + i]! * data[y + i]!;
        return Math.fround(sum); // what the WebAssembly version returns, so ties stay ties
      });
  }

  private view(buffer: ArrayBufferLike) {
    this.floats = new Float32Array(buffer);
    this.ints = new Int32Array(buffer);
  }

  /** The memory workers can search, if any. */
  get shared() {
    return this.memory;
  }

  get size() {
    return this.slots.size;
  }

  get bytes() {
    return this.capacity * this.stride * 4;
  }

  /** How much a search compares, to decide whether it's worth a worker. */
  get searchFloats() {
    return this.size * this.dimensions;
  }

  /** Too much of it is free, and WebAssembly memory can't shrink: better to reload. So too before versions run out. */
  get wasteful() {
    return (this.capacity > MIN_ROWS && this.size * 4 < this.capacity) || this.version > FOREVER / 2;
  }

  get current() {
    return this.version;
  }

  /** Makes the writes so far visible to searches that start from now on. */
  publish() {
    this.version++;
  }

  /** Keeps the current version's rows in place until leave(), and returns the version. */
  enter(): number {
    this.readers.set(this.version, (this.readers.get(this.version) ?? 0) + 1);
    return this.version;
  }

  leave(version: number) {
    const left = this.readers.get(version)! - 1;
    if (left) this.readers.set(version, left);
    else this.readers.delete(version);
  }

  /** Frees the slots no running search can see any more. */
  private reclaim() {
    let oldest = FOREVER;
    for (const version of this.readers.keys()) oldest = Math.min(oldest, version);
    let done = 0;
    while (done < this.retired.length && this.retired[done]!.died <= oldest) {
      const { slot } = this.retired[done++]!;
      this.ids[slot] = null;
      this.free.push(slot);
    }
    if (done) this.retired.splice(0, done);
  }

  private retire(id: string) {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    this.slots.delete(id);
    const died = this.version + 1;
    Atomics.store(this.ints, (slot + this.queries) * this.stride + DIED, died);
    this.retired.push({ slot, died });
  }

  /** Makes room for more rows within the budget; false when there's none left. */
  private grow(): boolean {
    const rowBytes = this.stride * 4;
    const rows = Math.min(Math.max(this.capacity * 2, MIN_ROWS), this.capacity + Math.floor(this.budget.left / rowBytes));
    if (rows <= this.capacity) return false;
    const needed = (rows + this.queries) * rowBytes;
    try {
      if (this.memory) {
        const have = this.memory.buffer.byteLength;
        if (needed > have) this.memory.grow(Math.ceil((needed - have) / WASM_PAGE));
        this.view(this.memory.buffer);
      } else {
        const floats = new Float32Array(needed / 4);
        floats.set(this.floats);
        this.view(floats.buffer);
      }
    } catch {
      return false; // past what one WebAssembly memory can hold
    }
    this.budget.left -= (rows - this.capacity) * rowBytes;
    this.capacity = rows;
    return true;
  }

  /** Stores `values`, as float32, normalized as `row`'s vector. One too large or small for float32 counts as all zeros, like one that is. */
  private writeVector(row: number, values: ArrayLike<number>) {
    const offset = row * this.stride + this.header;
    let sum = 0;
    for (let i = 0; i < this.dimensions; i++) {
      const x = Math.fround(values[i]!);
      sum += x * x;
    }
    const norm = Math.sqrt(sum);
    const usable = norm > 0 && Number.isFinite(norm);
    for (let i = 0; i < this.dimensions; i++) this.floats[offset + i] = usable ? Math.fround(values[i]!) / norm : 0;
  }

  /** False when the budget ran out, in which case the document may be left out. */
  put(id: string, vec: Uint8Array, values: unknown[]): boolean {
    this.reclaim();
    const slot = this.free.pop() ?? this.ids.length;
    if (slot >= this.capacity && !this.grow()) return false;
    this.retire(id);
    this.ids[slot] = id;
    this.slots.set(id, slot);
    const row = slot + this.queries;
    const at = row * this.stride;
    Atomics.store(this.ints, at + BORN, FOREVER);
    this.writeVector(row, blobFloats(vec));
    for (let i = 0; i < this.values.length; i++) {
      const numbers = this.values[i]!;
      const value = values[i] ?? null;
      let number = numbers.get(value);
      if (number === undefined) numbers.set(value, (number = numbers.size));
      this.ints[at + FIELDS + i] = number;
    }
    Atomics.store(this.ints, at + DIED, FOREVER);
    Atomics.store(this.ints, at + BORN, this.version + 1);
    return true;
  }

  remove(id: string) {
    this.retire(id);
  }

  /** Flat [field, value id, ...]. A value no row has can't match, so it's left out. */
  private matching(match: VectorMatch, any: number[] = []): number[] {
    if (match.op === "or") {
      for (const m of match.args) this.matching(m, any);
    } else {
      const field = this.fields.indexOf(match.field);
      const number = this.values[field]!.get(sqlValue(match.value));
      if (number !== undefined) any.push(field, number);
    }
    return any;
  }

  /** Puts the query in `queryRow` and describes the search. */
  prepare(queryRow: number, version: number, vector: number[], limit: number, filter: VectorMatch | null): ScanTask {
    this.writeVector(queryRow, vector);
    return {
      version,
      firstRow: this.queries,
      endRow: this.queries + this.ids.length,
      queryRow,
      stride: this.stride,
      header: this.header,
      dimensions: this.dimensions,
      limit,
      any: filter ? this.matching(filter) : null,
    };
  }

  /** What a scan found, the same order as SQL: by score, then by id. */
  hits({ found, rows, scores }: Scanned): VectorHit[] {
    const hits: VectorHit[] = [];
    for (let i = 0; i < found; i++) hits.push({ _id: this.ids[rows[i]! - this.queries]!, _score: scores[i]! });
    return hits.sort((a, b) => b._score - a._score || (a._id < b._id ? -1 : 1));
  }

  /** Searches on this thread, with its own query row, what `version` holds. */
  search(version: number, vector: number[], limit: number, filter: VectorMatch | null): VectorHit[] {
    const { ids, queries } = this;
    const before = (a: number, b: number) => ids[a - queries]! < ids[b - queries]!;
    return this.hits(scan(this.prepare(queries - 1, version, vector, limit, filter), this.floats, this.ints, this.dot, before));
  }
}

/** The workers' program. A blob, not a file, so that it's in the compiled binary without further ado. */
let workerUrl: string | undefined;

type Job = { table: VectorTable; version: number; vector: number[]; limit: number; filter: VectorMatch | null; resolve: (found: Scanned | null) => void };
type Thread = { worker: Worker; row: number; job: Job | null; opened: Set<number> };

/** Worker threads running one job each; the rest wait in order. Each searches with its own query row. */
class VectorWorkers {
  private readonly threads: Thread[];
  private readonly idle: Thread[];
  private readonly waiting: Job[] = [];
  private stopped = false;

  constructor(
    count: number,
    private readonly onFailure: (reason: unknown) => void,
  ) {
    workerUrl ??= URL.createObjectURL(new Blob([`(${workerMain})(${scan}, new Uint8Array([${DOT_WASM}]))`], { type: "text/javascript" }));
    this.threads = Array.from({ length: count }, (_, row) => {
      const worker = new Worker(workerUrl!);
      (worker as any).unref(); // an idle worker mustn't keep the process alive
      const thread: Thread = { worker, row, job: null, opened: new Set() };
      worker.onmessage = ({ data }) => this.finished(thread, data);
      worker.onerror = (event) => this.fail(event.message);
      worker.addEventListener("close", () => this.fail("a worker exited"));
      return thread;
    });
    this.idle = [...this.threads];
  }

  /** What the search found; null if the workers are gone, for the caller to do it instead. */
  run(table: VectorTable, version: number, vector: number[], limit: number, filter: VectorMatch | null): Promise<Scanned | null> {
    return new Promise((resolve) => {
      const job = { table, version, vector, limit, filter, resolve };
      if (this.stopped) return resolve(null);
      const thread = this.idle.pop();
      if (thread) this.start(thread, job);
      else this.waiting.push(job);
    });
  }

  private start(thread: Thread, job: Job) {
    const { table, version, vector, limit, filter } = job;
    thread.job = job;
    if (!thread.opened.has(table.id)) {
      thread.opened.add(table.id);
      thread.worker.postMessage({ open: table.id, memory: table.shared });
    }
    thread.worker.postMessage({ table: table.id, scan: table.prepare(thread.row, version, vector, limit, filter) });
  }

  private finished(thread: Thread, found: Scanned) {
    const job = thread.job!;
    thread.job = null;
    if (job.table.dropped) this.close(thread, job.table.id);
    const next = this.waiting.shift();
    if (next) this.start(thread, next);
    else this.idle.push(thread);
    job.resolve(found);
  }

  private close(thread: Thread, tableId: number) {
    if (thread.opened.delete(tableId)) thread.worker.postMessage({ close: tableId });
  }

  /** Lets the workers release a dropped table's memory, once they've finished with it. */
  forget(tableId: number) {
    for (const thread of this.threads) if (thread.job?.table.id !== tableId) this.close(thread, tableId);
  }

  private fail(reason: unknown) {
    if (this.stopped) return;
    this.stop();
    this.onFailure(reason);
  }

  /** Whatever hadn't finished is answered with null. */
  stop() {
    this.stopped = true;
    for (const thread of this.threads) {
      thread.worker.terminate();
      thread.job?.resolve(null);
      thread.job = null;
    }
    for (const job of this.waiting.splice(0)) job.resolve(null);
  }
}

/** The in-memory indexes of one database. Everything but finishing a search runs on its read queue, one at a time. */
export class VectorCache {
  /** Smaller indexes aren't worth a worker. */
  minWorkerFloats = MIN_WORKER_FLOATS;
  private readonly tables = new Map<string, VectorTable>();
  /** Indexes that don't fit in the budget: SQL ranks them until the schema changes or memory frees up. */
  private readonly tooBig = new Set<string>();
  private readonly budget: { left: number };
  /** The last log entry the tables reflect. */
  private seq = 0;
  private schemaVersion = -1;
  /** Log entries written since the log was last cut back. */
  private logged = 0;
  /** How many threads search; 0 for just this one. */
  private workerCount: number;
  private readonly queryRows: number;
  private workers: VectorWorkers | null = null;
  /** Searches running on workers, and whoever's closing, waiting for them to finish. */
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxBytes: number,
    workers = Math.min(MAX_DEFAULT_WORKERS, availableParallelism() - 1),
  ) {
    this.budget = { left: maxBytes };
    this.workerCount = dotModule ? workers : 0;
    this.queryRows = this.workerCount + 1;
  }

  get usedBytes() {
    return this.maxBytes - this.budget.left;
  }

  /** Runs in the write's transaction. */
  async log(tx: Exec, docId: string, entries: { name: string }[]) {
    for (const e of entries) await tx.run("INSERT INTO _vector_log (name, doc_id) VALUES (?, ?)", [e.name, docId]);
    this.logged += entries.length;
    if (this.logged >= LOG_KEEP) {
      this.logged = 0;
      await tx.run("DELETE FROM _vector_log WHERE seq <= (SELECT MAX(seq) FROM _vector_log) - ?", [LOG_KEEP]);
    }
  }

  private drop(name: string) {
    const table = this.tables.get(name);
    if (!table) return;
    this.budget.left += table.bytes;
    this.tables.delete(name);
    table.dropped = true;
    this.workers?.forget(table.id);
  }

  private dropAll() {
    for (const name of [...this.tables.keys()]) this.drop(name);
  }

  /** Brings the tables up to this read's snapshot, or drops the ones that are quicker to reload. */
  private async sync(tx: Exec) {
    // Any index being created, dropped or rebuilt changes this; so does a VACUUM.
    const version = Number((await tx.get("PRAGMA schema_version"))!.schema_version);
    if (version !== this.schemaVersion) {
      this.schemaVersion = version;
      this.tooBig.clear();
      this.dropAll();
    }
    if (!this.tables.size) return;
    const changes = await tx.all("SELECT seq, name, doc_id FROM _vector_log WHERE seq > ? ORDER BY seq LIMIT ?", [this.seq, LOG_KEEP + 1]);
    if (!changes.length) return;
    if (changes[0]!.seq !== this.seq + 1 || changes.length > LOG_KEEP) return this.dropAll();
    this.seq = changes[changes.length - 1]!.seq;
    const seen = new Set<string>();
    const touched = new Set<VectorTable>();
    for (const { name, doc_id } of changes) {
      const table = this.tables.get(name);
      const key = `${name} ${doc_id}`;
      if (!table || seen.has(key)) continue;
      seen.add(key);
      touched.add(table);
      const row = await tx.get(`${selectRows(name, table.fields)} WHERE v.doc_id = ?`, [doc_id]);
      if (!row) table.remove(doc_id);
      else if (!table.put(doc_id, row.vec, table.fields.map((_, i) => row[`f${i}`]))) {
        this.drop(name);
        this.tooBig.add(name);
      }
    }
    for (const table of touched) table.publish();
    for (const [name, table] of this.tables) if (table.wasteful) this.drop(name);
  }

  private async load(tx: Exec, name: string, index: VectorIndexDef): Promise<VectorTable | null> {
    if (!this.tables.size) this.seq = Number((await tx.get("SELECT MAX(seq) AS seq FROM _vector_log"))!.seq ?? 0);
    const table = new VectorTable(index, this.budget, undefined, this.queryRows);
    const select = `${selectRows(name, table.fields)} WHERE v.doc_id > ? ORDER BY v.doc_id LIMIT ${LOAD_PAGE}`;
    let after = "";
    while (true) {
      const rows = await tx.all(select, [after]);
      for (const row of rows) {
        if (!table.put(row.doc_id, row.vec, table.fields.map((_, i) => row[`f${i}`]))) {
          this.budget.left += table.bytes;
          this.tooBig.add(name);
          return null;
        }
      }
      if (rows.length < LOAD_PAGE) break;
      after = rows[rows.length - 1]!.doc_id;
      await new Promise((resolve) => setImmediate(resolve)); // a big index mustn't hold up every request
    }
    table.publish();
    this.tables.set(name, table);
    return table;
  }

  /** Runs on a worker, outside the read queue, so that other searches and reads carry on meanwhile. */
  private async searchOnWorker(table: VectorTable, vector: number[], limit: number, filter: VectorMatch | null) {
    this.workers ??= new VectorWorkers(this.workerCount, (reason) => {
      this.workers = null;
      this.workerCount = 0;
      console.error(`onebase: vector search workers stopped (${reason}); searching on the main thread from now on.`);
    });
    this.running++;
    const version = table.enter();
    try {
      const found = await this.workers.run(table, version, vector, limit, filter);
      return found && !found.tie ? table.hits(found) : table.search(version, vector, limit, filter);
    } finally {
      table.leave(version);
      if (--this.running === 0) for (const resolve of this.waiting.splice(0)) resolve();
    }
  }

  /** The nearest documents, or null to leave this search to SQL. `results` can finish after the read transaction. */
  async rank(tx: Exec, name: string, index: VectorIndexDef, vector: number[], limit: number, filter: VectorMatch | null) {
    await this.sync(tx);
    if (this.tooBig.has(name) || (filter && !comparable(filter))) return null;
    let table = this.tables.get(name);
    // Filter fields can change without the side table changing.
    if (table && table.fields.join() !== index.filterFields.join()) {
      this.drop(name);
      table = undefined;
    }
    table ??= (await this.load(tx, name, index)) ?? undefined;
    if (!table) return null;
    table.usedAt = Date.now();
    const onWorker = this.workerCount > 0 && table.shared !== null && table.searchFloats >= this.minWorkerFloats;
    return { results: onWorker ? this.searchOnWorker(table, vector, limit, filter) : Promise.resolve(table.search(table.current, vector, limit, filter)) };
  }

  private stopWorkers() {
    this.workers?.stop();
    this.workers = null;
  }

  /** Frees the indexes nobody has searched lately, and the workers if none are left. */
  evictIdle(now = Date.now()) {
    for (const [name, table] of this.tables) {
      if (now - table.usedAt < IDLE_MS) continue;
      this.drop(name);
      this.tooBig.clear();
    }
    if (!this.tables.size && !this.running) this.stopWorkers();
  }

  async close() {
    if (this.running) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.stopWorkers();
  }
}

function selectRows(name: string, fields: string[]) {
  const columns = fields.map((field, i) => `, ${sqliteDialect.field(field)} AS f${i}`).join("");
  const join = fields.length ? " JOIN documents ON documents.id = v.doc_id" : "";
  return `SELECT v.doc_id, v.vec${columns} FROM "${name}" v${join}`;
}

/** The SQLite dialect with vector indexes also kept in memory by `cache`. */
export function withVectorCache(cache: VectorCache): Dialect {
  return {
    ...sqliteDialect,
    ddl: [...sqliteDialect.ddl, VECTOR_LOG_DDL],
    async syncVector(tx, docId, entries) {
      await sqliteDialect.syncVector!(tx, docId, entries);
      await cache.log(tx, docId, entries);
    },
    rankVectors: (tx, name, index, vector, limit, filter) => cache.rank(tx, name, index, vector, limit, filter),
  };
}
