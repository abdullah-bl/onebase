/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { call, on } from "../api";
import { Empty, ago, errorText, fullTime, preview, sample, toast, typeText } from "../ui";

type Table = {
  name: string;
  component: string | null;
  count: number;
  inSchema: boolean;
  fields: string[];
  validator: any;
  indexes: { name: string; fields: string[] }[];
  searchIndexes: { name: string; searchField: string }[];
};
type Doc = Record<string, unknown> & { _id: string; _creationTime: number };
type Page = { page: Doc[]; isDone: boolean; continueCursor: string };

const PAGE = 50;

function Editor({
  table,
  doc,
  onClose,
}: {
  table: Table;
  doc: Doc | "new";
  onClose: () => void;
}) {
  const isNew = doc === "new";
  const initial = useMemo(() => {
    if (isNew) return JSON.stringify(sample(table.validator), null, 2);
    const { _id, _creationTime, ...fields } = doc;
    return JSON.stringify(fields, null, 2);
  }, [doc]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(initial), [initial]);

  const save = async () => {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      return setError(`Not valid JSON: ${errorText(e)}`);
    }
    setBusy(true);
    try {
      if (isNew) {
        const id = await call<string>("insert", { table: table.name, doc: value });
        toast(`Inserted ${id}`);
      } else {
        await call("replace", { id: doc._id, doc: value });
        toast("Saved");
      }
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew || !confirm(`Delete ${doc._id}? This can't be undone.`)) return;
    setBusy(true);
    try {
      await call("delete", { ids: [doc._id] });
      toast("Deleted");
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <aside class="drawer" role="dialog" aria-label={isNew ? "New document" : "Edit document"}>
      <div class="drawer-head">
        <div>
          <h3>{isNew ? `New ${table.name} document` : <code>{doc._id}</code>}</h3>
          {!isNew && <p class="muted" title={fullTime(doc._creationTime)}>created {ago(doc._creationTime)}</p>}
        </div>
        <button class="icon" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {table.validator && <p class="hint"><code>{typeText(table.validator)}</code></p>}
      <textarea
        class="code-input"
        spellcheck={false}
        value={text}
        onInput={(e) => {
          setText((e.target as HTMLTextAreaElement).value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            void save();
          }
        }}
      />
      {error && <p class="error-box">{error}</p>}
      <div class="drawer-actions">
        {!isNew && <button class="btn danger" disabled={busy} onClick={remove}>Delete</button>}
        <span class="spacer" />
        <button class="btn" onClick={onClose}>Cancel</button>
        <button class="btn primary" disabled={busy} onClick={save}>{isNew ? "Insert" : "Save"} <kbd>⌘S</kbd></button>
      </div>
      <p class="hint">Saving replaces the whole document and is checked against schema.ts. Live queries update right away.</p>
    </aside>
  );
}

/** App tables first, then each component's under its name. */
function groupByComponent(tables: Table[]): [string | null, Table[]][] {
  const groups = new Map<string | null, Table[]>([[null, []]]);
  for (const t of tables) groups.set(t.component, [...(groups.get(t.component) ?? []), t]);
  return [...groups].filter(([, list]) => list.length);
}

export function DataView({ table: selected, go }: { table?: string; go: (route: string) => void }) {
  const [tables, setTables] = useState<Table[] | null>(null);
  const [rows, setRows] = useState<Doc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(true);
  const [order, setOrder] = useState<"desc" | "asc">("desc");
  const [filterText, setFilterText] = useState("");
  const [filter, setFilter] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Doc | "new" | null>(null);
  const [flash, setFlash] = useState(false);
  const loaded = useRef(PAGE);

  const table = tables?.find((t) => t.name === selected) ?? null;

  const loadTables = () => call<Table[]>("tables").then(setTables).catch((e) => setError(errorText(e)));

  const load = async (more = false) => {
    if (!selected) return;
    try {
      const idLike = filterText.trim();
      const body =
        idLike && !idLike.startsWith("{")
          ? { table: selected, id: idLike }
          : { table: selected, order, filter, cursor: more ? cursor : null, numItems: more ? PAGE : Math.max(PAGE, loaded.current) };
      const res = await call<Page>("documents", body);
      const next = more ? [...rows, ...res.page] : res.page;
      loaded.current = Math.min(Math.max(next.length, PAGE), 500);
      setRows(next);
      setCursor(res.continueCursor);
      setDone(res.isDone);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    void loadTables();
  }, []);

  useEffect(() => {
    loaded.current = PAGE;
    setRows([]);
    setEditing(null);
    void load();
  }, [selected, order, filter]);

  // Refresh when this table changes, whoever changed it.
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(
    () =>
      on("commit", ({ tables: changed }) => {
        void loadTables();
        if (selected && changed.includes(selected)) {
          void loadRef.current();
          setFlash(true);
          setTimeout(() => setFlash(false), 700);
        }
      }),
    [selected],
  );

  useEffect(() => {
    if (!selected && tables?.length) go(`data/${tables[0]!.name}`);
  }, [tables, selected]);

  const columns = useMemo(() => {
    const keys = new Set<string>(table?.fields ?? []);
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!k.startsWith("_")) keys.add(k);
    return [...keys].slice(0, 10);
  }, [rows, table]);

  const clearTable = async (t: Table) => {
    if (!confirm(`Delete all ${t.count.toLocaleString()} documents in ${t.name}? This can't be undone.`)) return;
    try {
      await call("clearTable", { table: t.name });
      void loadTables();
      void load();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const applyFilter = (e: Event) => {
    e.preventDefault();
    const t = filterText.trim();
    if (!t || !t.startsWith("{")) {
      setFilter(null);
      void load();
      return;
    }
    try {
      setFilter(JSON.parse(t));
    } catch {
      setError('Filter must be JSON like {"author": "ali"}, or a document id.');
    }
  };

  return (
    <div class="data-layout">
      <nav class="table-list" aria-label="Tables">
        <p class="list-title">Tables</p>
        {tables === null && <p class="muted pad">Loading…</p>}
        {tables?.length === 0 && <p class="muted pad">No tables yet.</p>}
        {groupByComponent(tables ?? []).map(([component, list]) => (
          <>
            {component && <p class="list-title">Component: {component}</p>}
            {list.map((t) => (
              <a href={`#/data/${t.name}`} aria-current={t.name === selected ? "page" : undefined}>
                <span>{component ? t.name.slice(component.length + 1) : t.name}</span>
                <small>{t.count.toLocaleString()}</small>
              </a>
            ))}
          </>
        ))}
      </nav>

      <section class="data-main">
        {!table ? (
          <Empty title={tables?.length ? "Pick a table" : "No data yet"}>Documents appear here as your functions write them.</Empty>
        ) : (
          <>
            <header class="page-head compact">
              <div>
                <h1>
                  {table.name} <span class={`count ${flash ? "flash" : ""}`}>{table.count.toLocaleString()}</span>
                </h1>
                <p class="muted">
                  {table.inSchema
                    ? `Indexes: ${table.indexes.map((i) => i.name).join(", ")}` +
                      (table.searchIndexes.length ? ` · Search: ${table.searchIndexes.map((i) => `${i.name} (${i.searchField})`).join(", ")}` : "")
                    : table.component
                      ? `Component "${table.component}" isn't mounted in components.ts anymore; these documents are kept until you delete them.`
                      : "This table has documents but isn't in schema.ts."}
                </p>
              </div>
              <div class="toolbar">
                <form onSubmit={applyFilter} class="filter">
                  <input
                    placeholder='Filter {"field": value} or document id'
                    value={filterText}
                    onInput={(e) => setFilterText((e.target as HTMLInputElement).value)}
                    spellcheck={false}
                  />
                </form>
                <button class="btn" onClick={() => setOrder(order === "desc" ? "asc" : "desc")} title="Order by creation time">
                  {order === "desc" ? "Newest first" : "Oldest first"}
                </button>
                {table.inSchema && <button class="btn primary" onClick={() => setEditing("new")}>Add document</button>}
                {!table.inSchema && table.count > 0 && (
                  <button class="btn danger" onClick={() => void clearTable(table)}>
                    Delete all
                  </button>
                )}
              </div>
            </header>
            {error && <p class="error-box">{error}</p>}
            {rows.length === 0 && !error ? (
              <Empty title={filter || filterText ? "No matching documents" : "No documents"} />
            ) : (
              <div class="grid-wrap">
                <table class="tbl grid">
                  <thead>
                    <tr>
                      <th>_id</th>
                      {columns.map((c) => <th>{c}</th>)}
                      <th>_creationTime</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r._id} class={`clickable ${editing !== "new" && editing?._id === r._id ? "selected" : ""}`} onClick={() => setEditing(r)}>
                        <td><code class="id">{r._id}</code></td>
                        {columns.map((c) => (
                          <td class={typeof r[c] === "string" ? "" : "mono"}>{r[c] === undefined ? <span class="muted">–</span> : preview(r[c])}</td>
                        ))}
                        <td class="muted nowrap" title={fullTime(r._creationTime)}>{ago(r._creationTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!done && (
              <div class="more">
                <button class="btn" onClick={() => load(true)}>Load more</button>
              </div>
            )}
          </>
        )}
      </section>

      {editing && table && (
        <>
          <div class="drawer-backdrop" onClick={() => setEditing(null)} />
          <Editor table={table} doc={editing} onClose={() => setEditing(null)} />
        </>
      )}
    </div>
  );
}
