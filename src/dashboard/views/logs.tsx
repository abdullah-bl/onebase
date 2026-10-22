/** @jsxImportSource preact */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { call, on, type CallRecord } from "../api";
import { Badge, Empty, clockTime, duration, errorText } from "../ui";

const SOURCES = ["client", "http", "subscription", "scheduler", "cron", "function", "dashboard"];

export function LogsView() {
  const [records, setRecords] = useState<CallRecord[]>([]);
  const [paused, setPaused] = useState(false);
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [hideSubs, setHideSubs] = useState(false);
  const [type, setType] = useState("");
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
      .filter((r) => (!errorsOnly || !r.ok) && (!hideSubs || r.source !== "subscription") && (!type || r.type === type))
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.error?.toLowerCase().includes(q) || r.lines.some((l) => l.text.toLowerCase().includes(q)))
      .slice(-500)
      .reverse();
  }, [records, errorsOnly, hideSubs, type, search]);

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
          <label class="check"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly((e.target as HTMLInputElement).checked)} /> Errors</label>
          <label class="check"><input type="checkbox" checked={hideSubs} onChange={(e) => setHideSubs((e.target as HTMLInputElement).checked)} /> Hide re-runs</label>
          <button class={`btn ${paused ? "primary" : ""}`} onClick={() => setPaused(!paused)}>
            {paused ? `Resume${buffer.current.length ? ` (${buffer.current.length})` : ""}` : "Pause"}
          </button>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}
      {shown.length === 0 ? (
        <Empty title="No calls yet">Calls show up here as clients use your functions.</Empty>
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
                  <tr key={r.id} class={`clickable ${r.ok ? "" : "row-err"}`} onClick={() => setOpen(open === r.id ? null : r.id)}>
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
