// Counts, sums, ranks and "the n-th item" over a table, in O(log n), kept in step with the table
// by a table hook (or fed by hand).
//
//   // onebase/components.ts
//   export default defineComponents({
//     leaderboard: aggregate({ table: "scores", sortKey: (d: Doc<"scores">) => d.points, sumValue: (d) => d.points }),
//   });
//   // in a query
//   const players = await ctx.components.leaderboard.count();
//   const rank = await ctx.components.leaderboard.indexOf({ key: points, order: "desc" });

import {
  componentServer,
  defineComponent,
  splitMountOptions,
  tableChangesValidator,
  type ComponentFn,
  type HookStatus,
  type Mount,
  type MountOptions,
} from "..";
import { defineSchema, defineTable, type DataModelFromSchema } from "../../schema";
import { v } from "../../values";
import { at, compareItems, compareKeys, countBefore, insert, remove, type Item, type NodeDoc, type Store } from "./btree";

export { compareKeys } from "./btree";

const item = v.object({ k: v.any(), id: v.string(), s: v.number() });
const schema = defineSchema({
  /** One tree per namespace (the JSON of the namespace value). */
  trees: defineTable({ ns: v.string(), root: v.string(), count: v.number(), sum: v.number() }).index("by_ns", ["ns"]),
  nodes: defineTable({
    leaf: v.boolean(),
    items: v.array(item),
    children: v.array(v.object({ node: v.string(), count: v.number(), sum: v.number(), first: item })),
  }),
});

type Config = {
  /** The app table to follow. Without it, the app adds and removes items itself (insert / delete / replace). */
  table?: string;
  sortKey?: (doc: any) => unknown;
  sumValue?: (doc: any) => number;
  namespace?: (doc: any) => unknown;
  filter?: (doc: any) => boolean;
  /** Items per tree node (default 32). */
  maxNodeSize?: number;
};

const DEFAULT_NODE_SIZE = 32;
const { query, mutation, internalMutation } = componentServer<DataModelFromSchema<typeof schema>, Config>();
type Ctx = { db: any; config: Config };

/** Node reads cached for the length of one call: a query walks the same top nodes again and again. */
function store(db: any): Store {
  const cache = new Map<string, NodeDoc>();
  return {
    async node(id) {
      let node = cache.get(id);
      if (!node) {
        node = (await db.get(id)) as NodeDoc | null ?? undefined;
        if (!node) throw new Error(`Aggregate node ${id} is missing; reset the component's data.`);
        cache.set(id, node);
      }
      return node;
    },
    async newNode(fields) {
      const id = await db.insert("nodes", fields);
      cache.set(id, { _id: id, ...fields });
      return id;
    },
    async saveNode(id, fields) {
      await db.patch(id, fields);
      cache.set(id, { ...(cache.get(id) as NodeDoc), ...fields, _id: id });
    },
    async deleteNode(id) {
      await db.delete(id);
      cache.delete(id);
    },
  };
}

const nsKey = (namespace: unknown) => JSON.stringify(namespace ?? null);

/** A key as stored: undefined becomes null, and it must be plain data. */
function storedKey(key: unknown): unknown {
  if (key === undefined) return null;
  const json = JSON.stringify(key);
  if (json === undefined) throw new Error(`Aggregate keys must be numbers, strings, booleans, null, arrays or objects, got ${typeof key}.`);
  return JSON.parse(json);
}

async function getTree(ctx: Ctx, namespace: unknown) {
  return ctx.db.query("trees").withIndex("by_ns", (q: any) => q.eq("ns", nsKey(namespace))).unique();
}

async function addItem(ctx: Ctx, namespace: unknown, x: Item) {
  const s = store(ctx.db);
  let tree = await getTree(ctx, namespace);
  if (!tree) {
    const root = await s.newNode({ leaf: true, items: [], children: [] });
    const id = await ctx.db.insert("trees", { ns: nsKey(namespace), root, count: 0, sum: 0 });
    tree = { _id: id, root, count: 0, sum: 0 };
  }
  const root = await insert(s, tree.root, x, ctx.config.maxNodeSize ?? DEFAULT_NODE_SIZE);
  await ctx.db.patch(tree._id, { root, count: tree.count + 1, sum: tree.sum + x.s });
}

async function removeItem(ctx: Ctx, namespace: unknown, key: { k: unknown; id: string }): Promise<boolean> {
  const tree = await getTree(ctx, namespace);
  if (!tree) return false;
  const { root, removed } = await remove(store(ctx.db), tree.root, key);
  if (!removed) return false;
  await ctx.db.patch(tree._id, { root, count: tree.count - 1, sum: tree.sum - removed.s });
  return true;
}

/** What a document of the followed table contributes, or null when `filter` leaves it out. */
function itemOf(config: Config, doc: any): { namespace: unknown; item: Item } | null {
  if (config.filter && !config.filter(doc)) return null;
  const s = config.sumValue ? config.sumValue(doc) : 0;
  if (typeof s !== "number" || !Number.isFinite(s)) throw new Error(`aggregate sumValue must return a finite number, got ${String(s)} for ${doc._id}.`);
  return { namespace: config.namespace ? (config.namespace(doc) ?? null) : null, item: { k: storedKey(config.sortKey!(doc)), id: doc._id, s } };
}

// ---- Queries ----

const bound = v.optional(v.object({ key: v.any(), inclusive: v.boolean() }));
const boundsArg = v.optional(v.object({ lower: bound, upper: bound }));
type Bound = { key: unknown; inclusive: boolean } | undefined;

/** Items before the start (or after the end) of all items with this key. */
const startOf = (key: unknown) => (x: Item) => compareKeys(x.k, key) < 0;
const endOf = (key: unknown) => (x: Item) => compareKeys(x.k, key) <= 0;

/** Positions (in key order) of the first item within the bounds and just past the last. */
async function range(s: Store, tree: { root: string; count: number }, bounds?: { lower?: Bound; upper?: Bound }) {
  const lower = bounds?.lower ? await countBefore(s, tree.root, bounds.lower.inclusive ? startOf(bounds.lower.key) : endOf(bounds.lower.key)) : { count: 0, sum: 0 };
  const upper = bounds?.upper ? await countBefore(s, tree.root, bounds.upper.inclusive ? endOf(bounds.upper.key) : startOf(bounds.upper.key)) : null;
  return { lower, upper };
}

const out = (x: Item | null) => (x ? { key: x.k, id: x.id, sumValue: x.s } : null);

/** How many items (within `bounds`, if given). */
const count = query({
  args: { namespace: v.optional(v.any()), bounds: boundsArg },
  handler: async (ctx, { namespace, bounds }) => {
    const tree = await getTree(ctx, namespace);
    if (!tree) return 0;
    if (!bounds) return tree.count;
    const { lower, upper } = await range(store(ctx.db), tree, bounds);
    return Math.max(0, (upper?.count ?? tree.count) - lower.count);
  },
});

/** The total of sumValue over the items (within `bounds`, if given). */
const sum = query({
  args: { namespace: v.optional(v.any()), bounds: boundsArg },
  handler: async (ctx, { namespace, bounds }) => {
    const tree = await getTree(ctx, namespace);
    if (!tree) return 0;
    if (!bounds) return tree.sum;
    const { lower, upper } = await range(store(ctx.db), tree, bounds);
    return (upper?.sum ?? tree.sum) - lower.sum;
  },
});

/**
 * How many items come before `key` (in "desc" order: after it). With `id`, the position of that
 * exact item; without, of the first item with this key: a rank.
 */
const indexOf = query({
  args: { namespace: v.optional(v.any()), key: v.any(), id: v.optional(v.string()), order: v.optional(v.union(v.literal("asc"), v.literal("desc"))) },
  handler: async (ctx, { namespace, key, id, order }) => {
    const tree = await getTree(ctx, namespace);
    if (!tree) return 0;
    const s = store(ctx.db);
    const k = storedKey(key);
    if (order === "desc") {
      const upTo = id === undefined ? endOf(k) : (x: Item) => compareItems(x, { k, id }) <= 0;
      return tree.count - (await countBefore(s, tree.root, upTo)).count;
    }
    const before = id === undefined ? startOf(k) : (x: Item) => compareItems(x, { k, id }) < 0;
    return (await countBefore(s, tree.root, before)).count;
  },
});

/** The item at a 0-based position, in key order or (with order: "desc") from the largest. */
const atIndex = query({
  args: { namespace: v.optional(v.any()), index: v.number(), order: v.optional(v.union(v.literal("asc"), v.literal("desc"))) },
  handler: async (ctx, { namespace, index, order }) => {
    const tree = await getTree(ctx, namespace);
    if (!tree || !Number.isInteger(index) || index < 0 || index >= tree.count) return null;
    return out(await at(store(ctx.db), tree.root, order === "desc" ? tree.count - 1 - index : index));
  },
});

const min = query({
  args: { namespace: v.optional(v.any()) },
  handler: async (ctx, { namespace }) => {
    const tree = await getTree(ctx, namespace);
    return tree?.count ? out(await at(store(ctx.db), tree.root, 0)) : null;
  },
});

const max = query({
  args: { namespace: v.optional(v.any()) },
  handler: async (ctx, { namespace }) => {
    const tree = await getTree(ctx, namespace);
    return tree?.count ? out(await at(store(ctx.db), tree.root, tree.count - 1)) : null;
  },
});

/** Items in key order (or "desc"), a page at a time; pass back continueCursor for the next page. */
const paginate = query({
  args: {
    namespace: v.optional(v.any()),
    bounds: boundsArg,
    cursor: v.optional(v.union(v.string(), v.null())),
    numItems: v.number(),
    order: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
  },
  handler: async (ctx, { namespace, bounds, cursor, numItems, order }) => {
    const tree = await getTree(ctx, namespace);
    if (!tree) return { page: [], isDone: true, continueCursor: cursor ?? "" };
    const s = store(ctx.db);
    const { lower, upper } = await range(s, tree, bounds);
    const first = lower.count;
    const end = upper?.count ?? tree.count;
    const last = cursor ? (JSON.parse(cursor) as { k: unknown; id: string }) : null;
    const page: Item[] = [];
    if (order === "desc") {
      let i = last ? (await countBefore(s, tree.root, (x) => compareItems(x, last) < 0)).count - 1 : end - 1;
      for (; i >= first && page.length < numItems; i--) page.push((await at(s, tree.root, i))!);
      const isDone = i < first;
      return { page: page.map(out), isDone, continueCursor: page.length ? JSON.stringify({ k: page.at(-1)!.k, id: page.at(-1)!.id }) : (cursor ?? "") };
    }
    let i = last ? (await countBefore(s, tree.root, (x) => compareItems(x, last) <= 0)).count : first;
    for (; i < end && page.length < numItems; i++) page.push((await at(s, tree.root, i))!);
    const isDone = i >= end;
    return { page: page.map(out), isDone, continueCursor: page.length ? JSON.stringify({ k: page.at(-1)!.k, id: page.at(-1)!.id }) : (cursor ?? "") };
  },
});

/** Whether the aggregate has caught up with its table (it counts only part of it while backfilling). */
const status = query({
  args: {},
  handler: async (ctx): Promise<HookStatus | { table: null; state: "ready"; ready: true }> =>
    ctx.config.table ? ctx.hooks.status(ctx.config.table) : { table: null, state: "ready", ready: true },
});

// ---- Manual mode ----

function manualOnly(config: Config) {
  if (config.table) throw new Error(`This aggregate follows table "${config.table}" and updates itself; it can't be changed by hand.`);
}

const insertItem = mutation({
  args: { namespace: v.optional(v.any()), key: v.any(), id: v.string(), sumValue: v.optional(v.number()) },
  handler: async (ctx, { namespace, key, id, sumValue }) => {
    manualOnly(ctx.config);
    await addItem(ctx, namespace, { k: storedKey(key), id, s: sumValue ?? 0 });
    return null;
  },
});

const deleteItem = mutation({
  args: { namespace: v.optional(v.any()), key: v.any(), id: v.string() },
  handler: async (ctx, { namespace, key, id }) => {
    manualOnly(ctx.config);
    return removeItem(ctx, namespace, { k: storedKey(key), id });
  },
});

const replaceItem = mutation({
  args: {
    from: v.object({ namespace: v.optional(v.any()), key: v.any(), id: v.string() }),
    to: v.object({ namespace: v.optional(v.any()), key: v.any(), id: v.string(), sumValue: v.optional(v.number()) }),
  },
  handler: async (ctx, { from, to }) => {
    manualOnly(ctx.config);
    if (!(await removeItem(ctx, from.namespace, { k: storedKey(from.key), id: from.id }))) throw new Error(`Item ${from.id} isn't in the aggregate.`);
    await addItem(ctx, to.namespace, { k: storedKey(to.key), id: to.id, s: to.sumValue ?? 0 });
    return null;
  },
});

// ---- Following a table ----

const onChange = internalMutation({
  args: tableChangesValidator,
  handler: async (ctx, { changes }) => {
    for (const change of changes) {
      const before = change.before ? itemOf(ctx.config, change.before) : null;
      const after = change.after ? itemOf(ctx.config, change.after) : null;
      if (
        before &&
        after &&
        nsKey(before.namespace) === nsKey(after.namespace) &&
        compareItems(before.item, after.item) === 0 &&
        before.item.s === after.item.s
      ) {
        continue;
      }
      if (before) await removeItem(ctx, before.namespace, before.item);
      if (after) await addItem(ctx, after.namespace, after.item);
    }
    return null;
  },
});

/** Deletes what was built, a batch at a time; done once nothing is left. */
const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    const batch = [...(await ctx.db.query("nodes").take(200)), ...(await ctx.db.query("trees").take(200))];
    for (const doc of batch) await ctx.db.delete(doc._id);
    return { done: batch.length === 0 };
  },
});

/** Empties a namespace (or, without one, the aggregate). Manual mode only. */
const clear = mutation({
  args: { namespace: v.optional(v.any()) },
  handler: async (ctx, { namespace }) => {
    manualOnly(ctx.config);
    const tree = await getTree(ctx, namespace);
    if (!tree) return null;
    const s = store(ctx.db);
    const drop = async (id: string): Promise<void> => {
      const node = await s.node(id);
      for (const child of node.children) await drop(child.node);
      await s.deleteNode(id);
    };
    await drop(tree.root);
    await ctx.db.delete(tree._id);
    return null;
  },
});

export const definition = defineComponent({
  name: "aggregate",
  schema,
  functions: { count, sum, indexOf, at: atIndex, min, max, paginate, status, insert: insertItem, delete: deleteItem, replace: replaceItem, clear, onChange, reset },
  checkConfig: (config: Config) => {
    if (config.table !== undefined && typeof config.sortKey !== "function") throw new Error(`aggregate({ table: "${config.table}" }) needs sortKey: (doc) => key.`);
    if (config.table === undefined && (config.sortKey || config.sumValue || config.namespace || config.filter)) {
      throw new Error("aggregate(): sortKey, sumValue, namespace and filter describe a table's documents; add table, or insert items by hand.");
    }
    const size = config.maxNodeSize ?? DEFAULT_NODE_SIZE;
    if (!Number.isInteger(size) || size < 4 || size > 1024) throw new Error("aggregate(): maxNodeSize must be a whole number from 4 to 1024.");
  },
  hooks: (config: Config) =>
    config.table
      ? [
          {
            table: config.table,
            onChange,
            reset,
            // A different key, value, namespace or node size means rebuilding from the table.
            fingerprint: [config.sortKey, config.sumValue, config.namespace, config.filter, config.maxNodeSize].map(String).join("\n"),
          },
        ]
      : [],
});

// ---- Types for the app ----

export type AggregateItem<K> = { key: K; id: string; sumValue: number };
export type AggregateBounds<K> = { lower?: { key: K; inclusive: boolean }; upper?: { key: K; inclusive: boolean } };
type Order = "asc" | "desc";
type NsArg<N> = { namespace?: N };

export type AggregateApi<K, N> = {
  count: ComponentFn<"query", (args?: NsArg<N> & { bounds?: AggregateBounds<K> }) => Promise<number>>;
  sum: ComponentFn<"query", (args?: NsArg<N> & { bounds?: AggregateBounds<K> }) => Promise<number>>;
  indexOf: ComponentFn<"query", (args: NsArg<N> & { key: K; id?: string; order?: Order }) => Promise<number>>;
  at: ComponentFn<"query", (args: NsArg<N> & { index: number; order?: Order }) => Promise<AggregateItem<K> | null>>;
  min: ComponentFn<"query", (args?: NsArg<N>) => Promise<AggregateItem<K> | null>>;
  max: ComponentFn<"query", (args?: NsArg<N>) => Promise<AggregateItem<K> | null>>;
  paginate: ComponentFn<
    "query",
    (args: NsArg<N> & { bounds?: AggregateBounds<K>; cursor?: string | null; numItems: number; order?: Order }) => Promise<{
      page: AggregateItem<K>[];
      isDone: boolean;
      continueCursor: string;
    }>
  >;
  status: ComponentFn<"query", (args?: {}) => Promise<{ ready: boolean; state: HookStatus["state"] }>>;
};

export type ManualAggregateApi<K, N> = AggregateApi<K, N> & {
  insert: ComponentFn<"mutation", (args: NsArg<N> & { key: K; id: string; sumValue?: number }) => Promise<null>>;
  delete: ComponentFn<"mutation", (args: NsArg<N> & { key: K; id: string }) => Promise<boolean>>;
  replace: ComponentFn<
    "mutation",
    (args: { from: NsArg<N> & { key: K; id: string }; to: NsArg<N> & { key: K; id: string; sumValue?: number } }) => Promise<null>
  >;
  clear: ComponentFn<"mutation", (args?: NsArg<N>) => Promise<null>>;
};

/**
 * Mounts an aggregate. With `table`, it follows that table: every insert, patch, replace and
 * delete updates it in the same transaction, and existing documents are added in the background
 * (`status()` says when that's done). Without `table`, add items yourself with insert / delete / replace.
 */
export function aggregate<D, K, N = undefined, const E extends keyof AggregateApi<K, N> & string = never>(
  opts: {
    table: string;
    sortKey: (doc: D) => K;
    sumValue?: (doc: NoInfer<D>) => number;
    namespace?: (doc: NoInfer<D>) => N;
    filter?: (doc: NoInfer<D>) => boolean;
    maxNodeSize?: number;
  } & MountOptions<E>,
): Mount<AggregateApi<K, N>, E>;
export function aggregate<K = unknown, N = undefined, const E extends keyof AggregateApi<K, N> & string = never>(
  opts?: { maxNodeSize?: number } & MountOptions<E>,
): Mount<ManualAggregateApi<K, N>, E>;
export function aggregate(opts: Config & MountOptions = {}): Mount<any, any> {
  const { config, options } = splitMountOptions(opts);
  return definition.mount(config, options);
}
