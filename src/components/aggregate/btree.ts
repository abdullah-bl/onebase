// A counted B+ tree stored as documents: leaves hold items in key order, and every internal
// node keeps each child's count, sum and first item, so counts, sums, ranks and "the n-th item"
// take one root-to-leaf walk (O(log n) documents) instead of a scan.

/** One aggregated document: its sort key, id and value to sum. */
export type Item = { k: unknown; id: string; s: number };
export type Child = { node: string; count: number; sum: number; first: Item };
export type NodeFields = { leaf: boolean; items: Item[]; children: Child[] };
export type NodeDoc = NodeFields & { _id: string };

/** Reads and writes nodes; reads within one call are cached by the caller's store. */
export interface Store {
  node(id: string): Promise<NodeDoc>;
  newNode(fields: NodeFields): Promise<string>;
  saveNode(id: string, fields: Partial<NodeFields>): Promise<void>;
  deleteNode(id: string): Promise<void>;
}

const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
const typeRank = (v: unknown) =>
  v === null || v === undefined ? 0 : typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : typeof v === "string" ? 3 : Array.isArray(v) ? 4 : 5;

/** One total order over keys: null < booleans < numbers < strings < arrays (element by element) < objects. */
export function compareKeys(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return sign(ra - rb);
  if (ra === 1 || ra === 2) return sign(Number(a) - Number(b));
  if (ra === 3) return a === b ? 0 : (a as string) < (b as string) ? -1 : 1;
  if (ra === 4) {
    const x = a as unknown[];
    const y = b as unknown[];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
      const c = compareKeys(x[i], y[i]);
      if (c !== 0) return c;
    }
    return sign(x.length - y.length);
  }
  if (ra === 5) return compareKeys(JSON.stringify(a), JSON.stringify(b));
  return 0;
}

/** Items order by key, then by id, so equal keys keep a stable order. */
export function compareItems(a: { k: unknown; id: string }, b: { k: unknown; id: string }): number {
  return compareKeys(a.k, b.k) || (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
}

type Totals = { count: number; sum: number; first: Item };
const leafTotals = (items: Item[]): Totals => ({ count: items.length, sum: items.reduce((n, x) => n + x.s, 0), first: items[0]! });
const childTotals = (children: Child[]): Totals => ({
  count: children.reduce((n, c) => n + c.count, 0),
  sum: children.reduce((n, c) => n + c.sum, 0),
  first: children[0]!.first,
});

/** The child whose range holds `item`: the last one whose first item isn't after it. */
function route(children: Child[], item: { k: unknown; id: string }): number {
  let i = 0;
  while (i + 1 < children.length && compareItems(children[i + 1]!.first, item) <= 0) i++;
  return i;
}

type Inserted = { self: Totals; split: Child | null };

async function save(store: Store, id: string, leaf: boolean, list: Item[] | Child[], max: number): Promise<Inserted> {
  const totals = (l: any[]) => (leaf ? leafTotals(l) : childTotals(l));
  const fields = (l: any[]): Partial<NodeFields> => (leaf ? { items: l } : { children: l });
  if (list.length <= max) {
    await store.saveNode(id, fields(list));
    return { self: totals(list), split: null };
  }
  const half = Math.ceil(list.length / 2);
  const left = list.slice(0, half);
  const right = list.slice(half);
  await store.saveNode(id, fields(left));
  const node = await store.newNode({ leaf, items: leaf ? (right as Item[]) : [], children: leaf ? [] : (right as Child[]) });
  return { self: totals(left), split: { node, ...totals(right) } };
}

async function insertInto(store: Store, id: string, item: Item, max: number): Promise<Inserted> {
  const node = await store.node(id);
  if (node.leaf) {
    const items = [...node.items];
    let pos = items.findIndex((x) => compareItems(x, item) > 0);
    if (pos === -1) pos = items.length;
    if (pos > 0 && compareItems(items[pos - 1]!, item) === 0) throw new Error(`Document ${item.id} is already in the aggregate with this key.`);
    items.splice(pos, 0, item);
    return save(store, id, true, items, max);
  }
  const children = [...node.children];
  const i = route(children, item);
  const r = await insertInto(store, children[i]!.node, item, max);
  children[i] = { node: children[i]!.node, ...r.self };
  if (r.split) children.splice(i + 1, 0, r.split);
  return save(store, id, false, children, max);
}

/** Adds an item; returns the root (a new one when the old root split). */
export async function insert(store: Store, root: string, item: Item, max: number): Promise<string> {
  const r = await insertInto(store, root, item, max);
  if (!r.split) return root;
  return store.newNode({ leaf: false, items: [], children: [{ node: root, ...r.self }, r.split] });
}

type Removed = { removed: Item | null; self: Totals | null };

async function removeFrom(store: Store, id: string, key: { k: unknown; id: string }): Promise<Removed> {
  const node = await store.node(id);
  if (node.leaf) {
    const at = node.items.findIndex((x) => compareItems(x, key) === 0);
    if (at === -1) return { removed: null, self: null };
    const items = node.items.filter((_, j) => j !== at);
    await store.saveNode(id, { items });
    return { removed: node.items[at]!, self: items.length ? leafTotals(items) : null };
  }
  const children = [...node.children];
  const i = route(children, key);
  const r = await removeFrom(store, children[i]!.node, key);
  if (!r.removed) return r;
  if (r.self) children[i] = { node: children[i]!.node, ...r.self };
  else {
    await store.deleteNode(children[i]!.node);
    children.splice(i, 1);
  }
  await store.saveNode(id, { children });
  return { removed: r.removed, self: children.length ? childTotals(children) : null };
}

/** Removes the item with this key and id; returns the root (a lower one when the tree shrank) and what was removed. */
export async function remove(store: Store, root: string, key: { k: unknown; id: string }): Promise<{ root: string; removed: Item | null }> {
  const r = await removeFrom(store, root, key);
  if (!r.removed) return { root, removed: null };
  for (;;) {
    const node = await store.node(root);
    if (node.leaf) break;
    if (node.children.length === 0) {
      await store.saveNode(root, { leaf: true, items: [], children: [] });
      break;
    }
    if (node.children.length > 1) break;
    await store.deleteNode(root);
    root = node.children[0]!.node;
  }
  return { root, removed: r.removed };
}

/** Count and sum of the items that come before a position (`before(item)` is true for exactly those). */
export async function countBefore(store: Store, root: string, before: (item: Item) => boolean): Promise<{ count: number; sum: number }> {
  let id = root;
  let count = 0;
  let sum = 0;
  for (;;) {
    const node = await store.node(id);
    if (node.leaf) {
      for (const x of node.items) {
        if (!before(x)) break;
        count++;
        sum += x.s;
      }
      return { count, sum };
    }
    // A child is wholly before the position when the next child's first item is.
    let i = 0;
    while (i + 1 < node.children.length && before(node.children[i + 1]!.first)) {
      count += node.children[i]!.count;
      sum += node.children[i]!.sum;
      i++;
    }
    if (!node.children.length) return { count, sum };
    id = node.children[i]!.node;
  }
}

/** The item at a 0-based position in key order, or null. */
export async function at(store: Store, root: string, index: number): Promise<Item | null> {
  let id = root;
  let i = index;
  for (;;) {
    const node = await store.node(id);
    if (node.leaf) return node.items[i] ?? null;
    const child = node.children.find((c) => (i < c.count ? true : ((i -= c.count), false)));
    if (!child) return null;
    id = child.node;
  }
}
