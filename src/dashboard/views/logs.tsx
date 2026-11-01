/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { call, on, type CallRecord } from "../api";
import { Badge, Empty, Icon, clockTime, duration, errorText, rowLink } from "../ui";

const SOURCES = ["client", "http", "subscription", "scheduler", "cron", "function", "dashboard", "auth"];

/** Routes: logs, logs/errors, logs/all/<function>, logs/errors/<function>. */
export function LogsView({ scope, fn, go }: { scope?: string; fn?: string; go: (route: string) => void }) {
  const errorsOnly = scope === "errors";
  const [records, setRecords] = useState<CallRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [hideSubs, setHideSubs] = useState(false);
  const [type, setType] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buffer = useRef<CallRecord[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  useEffect(() => {
    call<CallRecord[]>("calls", { limit: 1000 }).then(setRecords).catch((e) => setError(errorText(e)));
    return on("call", (r) => {
      if (pausedRef.current) buffer.current.push(r);
      else setRecords((list) => [...list.slice(-999), r]);
    });
  }, []);

  useEffect(() => {
    if (!paused && buffer.current.length) {
      const pending = buffer.current;
      buffer.current = [];
      setRecords((list) => [...list, ...pending].slice(-1000));
    }
  }, [paused]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return records
      .filter((r) => (!errorsOnly || !r.ok) && (!fn || r.name === fn) && (!hideSubs || r.source !== "subscription") && (!type || r.type === type) && (!source || r.source === source))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.error?.toLowerCase().includes(q) || r.lines.some((l) => l.text.toLowerCase().includes(q)))
      .slice(-500)
      .reverse();
  }, [records, errorsOnly, fn, hideSubs, type, source, search]);

  const route = (errors: boolean, name?: string) => `logs${errors || name ? `/${errors ? "errors" : "all"}` : ""}${name ? `/${encodeURIComponent(name)}` : ""}`;
  const narrowed = errorsOnly || fn || hideSubs || type || source || search.trim();
  const clear = () => {
    setSearch("");
    setType("");
    setSource("");
    setHideSubs(false);
    go("logs");
  };

  return (
    <div class="page wide">
      <header class="page-head">
        <div>
          <h1>Logs</h1>
          <p class="muted">The last 1,000 function calls, live. Kept in memory: they reset when the server restarts.</p>
        </div>
        <div class="toolbar">
          <input class="search" placeholder="Search name, error or output" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
          <select value={type} onChange={(e) => setType((e.target as HTMLSelectElement).value)} aria-label="Function type">
            <option value="">All types</option>
            <option value="query">Queries</option>
            <option value="mutation">Mutations</option>
            <option value="action">Actions</option>
            <option value="http">HTTP</option>
          </select>
          <select value={source} onChange={(e) => setSource((e.target as HTMLSelectElement).value)} aria-label="Called from">
            <option value="">All sources</option>
            {SOURCES.map((s) => <option value={s}>{s}</option>)}
          </select>
          <label class="check"><input type="checkbox" checked={errorsOnly} onChange={(e) => go(route((e.target as HTMLInputElement).checked, fn))} /> Errors</label>
          <label class="check"><input type="checkbox" checked={hideSubs} onChange={(e) => setHideSubs((e.target as HTMLInputElement).checked)} /> Hide re-runs</label>
          <button class={`btn ${paused ? "primary" : ""}`} onClick={() => setPaused(!paused)}>
            {paused ? `Resume${buffer.current.length ? ` (${buffer.current.length})` : ""}` : "Pause"}
          </button>
        </div>
      </header>
      {fn && (
        <p class="filter-chip">
          <span>Only <code>{fn}</code></span>
          <button class="icon tiny" aria-label="Show all functions" title="Show all functions" onClick={() => go(route(errorsOnly))}><Icon name="close" size={13} /></button>
        </p>
      )}
      {error && <p class="error-box">{error}</p>}
      {shown.length === 0 ? (
        narrowed ? (
          <Empty title="No matching calls">
            <button class="btn small" onClick={clear}>Clear filters</button>
          </Empty>
        ) : (
          <Empty title="No calls yet">Calls show up here as clients use your functions.</Empty>
        )
      ) : (
        <div class="grid-wrap">
          <table class="tbl logs">
            <thead>
              <tr>
                <th>Time</th>
                <th>Function</th>
                <th>Type</th>
                <th>Source</th>
                <th class="num">Duration</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <>
                  <tr key={r.id} class={`clickable ${r.ok ? "" : "row-err"}`} aria-expanded={open === r.id} {...rowLink(() => setOpen(open === r.id ? null : r.id))}>
                    <td class="mono nowrap muted">{clockTime(r.at)}</td>
                    <td><code>{r.name}</code>{r.lines.length > 0 && <span class="lines-count" title="console output">{r.lines.length}</span>}</td>
                    <td><Badge kind={r.type} /></td>
                    <td class="muted">{SOURCES.includes(r.source) ? r.source : "–"}</td>
                    <td class={`num mono ${r.ms > 500 ? "slow" : ""}`}>{duration(r.ms)}</td>
                    <td class="ellipsis">{r.ok ? <span class="ok">ok</span> : <span class="err">{r.error}</span>}</td>
                  </tr>
                  {open === r.id && (
                    <tr class="detail">
                      <td colSpan={6}>
                        {r.error && <pre class="json err">{r.error}</pre>}
                        {r.lines.length ? (
                          <pre class="console">
                            {r.lines.map((l) => (
                              <div class={`ln ln-${l.level}`}>{l.text}</div>
                            ))}
                          </pre>
                        ) : (
                          <p class="muted">No console output.</p>
                        )}
                        <p class="detail-links">
                          {r.name !== fn && <button class="link" onClick={() => go(route(errorsOnly, r.name))}>Only this function</button>}
                          {r.type !== "http" && r.name.includes(":") && <button class="link" onClick={() => go(`functions/${encodeURIComponent(r.name)}`)}>Open function</button>}
                        </p>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
