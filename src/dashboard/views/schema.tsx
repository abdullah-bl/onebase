/** @jsxImportSource preact */
// The schema as a diagram: one card per table with its fields, types and indexes, and a line
// from every v.id("table") field to the table it points to. Hover a table to see its links.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { call, on } from "../api";
import { Empty, errorText, throttle, typeText } from "../ui";

type V = { kind: string; isOptional?: boolean; tableName?: string; element?: V; fields?: Record<string, V>; values?: V; members?: V[]; value?: unknown } | null;
type Table = {
  name: string;
  component: string | null;
  count: number;
  inSchema: boolean;
  validator: V;
  indexes: { name: string; fields: string[] }[];
  searchIndexes: { name: string; searchField: string }[];
  vectorIndexes?: { name: string; vectorField: string; dimensions: number }[];
};
type Link = { from: string; field: string; to: string };
type Path = Link & { d: string };

/** The tables a field's validator points to, through arrays, unions, records and optionals. */
function referencedTables(v: V, out = new Set<string>()): Set<string> {
  if (!v) return out;
  if (v.kind === "id" && v.tableName) out.add(v.tableName);
  if (v.element) referencedTables(v.element, out);
  if (v.values) referencedTables(v.values, out);
  for (const m of v.members ?? []) referencedTables(m, out);
  return out;
}

/** v.id("x") inside a component means that component's "x" if it has one. */
function resolve(target: string, from: Table, names: Set<string>): string | null {
  const scoped = from.component ? `${from.component}.${target}` : target;
  if (names.has(scoped)) return scoped;
  if (names.has(target)) return target;
  return target === "_storage" ? null : target; // a table with no documents and not in the schema: still drawn
}

const key = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

export function SchemaView({ go }: { go: (route: string) => void }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [paths, setPaths] = useState<Path[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => call<Table[]>("tables").then(setTables, (e) => setError(errorText(e)));
    void load();
    // A deploy changes the schema; commits can add tables outside it.
    const refresh = throttle(() => void load(), 5000);
    const off = on("commit", refresh);
    return () => {
      off();
      refresh.cancel();
    };
  }, []);

  const { ordered, links } = useMemo(() => {
    const list = (tables ?? []).filter((t) => t.inSchema || t.count > 0);
    const names = new Set(list.map((t) => t.name));
    const links: Link[] = [];
    for (const t of list) {
      const fields = t.validator?.kind === "object" ? t.validator.fields ?? {} : {};
      for (const [field, v] of Object.entries(fields)) {
        for (const target of referencedTables(v)) {
          const to = resolve(target, t, names);
          if (to && names.has(to)) links.push({ from: t.name, field, to });
        }
      }
    }
    // Tables others point to come first (left), so most lines run right to left… then by name.
    const inbound = new Map<string, number>();
    for (const l of links) if (l.from !== l.to) inbound.set(l.to, (inbound.get(l.to) ?? 0) + 1);
    const ordered = [...list].sort(
      (a, b) =>
        Number(a.component !== null) - Number(b.component !== null) ||
        (a.component ?? "").localeCompare(b.component ?? "") ||
        (inbound.get(b.name) ?? 0) - (inbound.get(a.name) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    return { ordered, links };
  }, [tables]);

  // Lines are drawn between the cards' rendered positions, so they follow any layout.
  useLayoutEffect(() => {
    const root = canvas.current;
    if (!root) return;
    const draw = () => {
      const box = root.getBoundingClientRect();
      const at = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - box.left, right: r.right - box.left, y: r.top - box.top + r.height / 2 };
      };
      const next: Path[] = [];
      for (const l of links) {
        const src = at(root.querySelector(`[data-field="${key(l.from)}--${key(l.field)}"]`));
        const dst = at(root.querySelector(`[data-table="${key(l.to)}"] .schema-head`));
        if (!src || !dst) continue;
        let d: string;
        if (l.from === l.to) {
          // A table pointing to itself: a loop off its right side.
          d = `M ${src.right} ${src.y} C ${src.right + 36} ${src.y}, ${dst.right + 36} ${dst.y}, ${dst.right} ${dst.y}`;
        } else if (dst.left >= src.right) {
          const mid = (src.right + dst.left) / 2;
          d = `M ${src.right} ${src.y} C ${mid} ${src.y}, ${mid} ${dst.y}, ${dst.left} ${dst.y}`;
        } else if (dst.right <= src.left) {
          const mid = (src.left + dst.right) / 2;
          d = `M ${src.left} ${src.y} C ${mid} ${src.y}, ${mid} ${dst.y}, ${dst.right} ${dst.y}`;
        } else {
          // Same column: out of the right side and back in.
          const x = Math.max(src.right, dst.right) + 40;
          d = `M ${src.right} ${src.y} C ${x} ${src.y}, ${x} ${dst.y}, ${dst.right} ${dst.y}`;
        }
        next.push({ ...l, d });
      }
      setPaths(next);
      setSize({ w: root.scrollWidth, h: root.scrollHeight });
    };
    draw();
    const observer = new ResizeObserver(() => draw());
    observer.observe(root);
    return () => observer.disconnect();
  }, [ordered, links]);

  const related = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const l of links) {
      if (l.from === hover) set.add(l.to);
      if (l.to === hover) set.add(l.from);
    }
    return set;
  }, [hover, links]);

  return (
    <div class="page wide">
      <header class="page-head">
        <div>
          <h1>Schema</h1>
          <p class="muted">
            Tables from <code>schema.ts</code> and mounted components, with a line for each <code>v.id()</code> field. Hover a table to follow its links; click its name to browse it.
          </p>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}
      {tables === null && !error ? (
        <div class="skeleton" style="height:320px" />
      ) : ordered.length === 0 ? (
        <Empty title="No schema yet">Define tables in schema.ts with defineSchema().</Empty>
      ) : (
        <div class="schema-scroll">
          <div class="schema-canvas" ref={canvas}>
            <svg class="schema-lines" width={size.w} height={size.h} aria-hidden="true">
              <defs>
                <marker id="schema-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L8 4 L0 8 z" fill="context-stroke" />
                </marker>
              </defs>
              {paths.map((p) => {
                const active = hover !== null && (p.from === hover || p.to === hover);
                return <path d={p.d} class={`schema-line ${active ? "active" : hover ? "dim" : ""}`} marker-end="url(#schema-arrow)" />;
              })}
            </svg>
            {ordered.map((t) => (
              <TableCard
                table={t}
                links={links}
                dim={related !== null && !related.has(t.name)}
                onHover={setHover}
                onOpen={() => go(`data/${encodeURIComponent(t.name)}`)}
              />
            ))}
          </div>
        </div>
      )}
      {links.length > 0 && (
        <p class="muted schema-legend">
          {links.length} link{links.length === 1 ? "" : "s"} · arrows point from a field to the table its ids belong to
        </p>
      )}
    </div>
  );
}

function TableCard({ table: t, links, dim, onHover, onOpen }: { table: Table; links: Link[]; dim: boolean; onHover: (name: string | null) => void; onOpen: () => void }) {
  const fields = t.validator?.kind === "object" ? Object.entries(t.validator.fields ?? {}) : [];
  const refsOf = (field: string) => links.filter((l) => l.from === t.name && l.field === field).map((l) => l.to);
  const shortName = t.component ? t.name.slice(t.component.length + 1) : t.name;
  return (
    <section
      class={`schema-table ${t.inSchema ? "" : "orphan"} ${dim ? "dim" : ""}`}
      data-table={key(t.name)}
      onMouseEnter={() => onHover(t.name)}
      onMouseLeave={() => onHover(null)}
    >
      <header class="schema-head">
        <button class="schema-name" onClick={onOpen} title={`Browse ${t.name}`}>
          {t.component && <span class="schema-comp">{t.component}.</span>}
          {shortName}
        </button>
        <span class="muted">{t.count.toLocaleString()}</span>
      </header>
      {!t.inSchema && <p class="schema-note">Not in the schema</p>}
      <ul class="schema-fields">
        <li class="schema-field system"><span>_id</span><code>Id&lt;"{shortName}"&gt;</code></li>
        {fields.map(([name, v]) => {
          const to = refsOf(name);
          const type = typeText(v);
          return (
            <li class={`schema-field ${to.length ? "ref" : ""}`} data-field={`${key(t.name)}--${key(name)}`}>
              <span>
                {name}
                {v?.isOptional && <em title="optional">?</em>}
              </span>
              <code title={type}>{type}</code>
            </li>
          );
        })}
        {t.validator && t.validator.kind !== "object" && (
          <li class="schema-field"><span>document</span><code title={typeText(t.validator)}>{typeText(t.validator)}</code></li>
        )}
        <li class="schema-field system"><span>_creationTime</span><code>number</code></li>
      </ul>
      {(t.indexes.length > 1 || t.searchIndexes.length > 0 || (t.vectorIndexes?.length ?? 0) > 0) && (
        <ul class="schema-indexes">
          {t.indexes
            .filter((i) => i.name !== "by_creation_time")
            .map((i) => (
              <li title="index"><span class="schema-kind">idx</span><code>{i.name}</code><span class="muted">{i.fields.join(", ")}</span></li>
            ))}
          {t.searchIndexes.map((i) => (
            <li title="search index"><span class="schema-kind">search</span><code>{i.name}</code><span class="muted">{i.searchField}</span></li>
          ))}
          {(t.vectorIndexes ?? []).map((i) => (
            <li title="vector index"><span class="schema-kind">vector</span><code>{i.name}</code><span class="muted">{i.vectorField} · {i.dimensions}d</span></li>
          ))}
        </ul>
      )}
    </section>
  );
}
