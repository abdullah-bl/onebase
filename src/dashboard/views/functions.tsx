/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { call, on, type CallRecord } from "../api";
import { Badge, Empty, Icon, JsonView, ago, compact, duration, errorText, percent, sample, typeText, useLive } from "../ui";

type Fn = { name: string; type: "query" | "mutation" | "action"; visibility: "public" | "internal"; args: any; returns: any };
type Result = { ok: boolean; value?: unknown; error?: string; ms: number; at: number };

const RECENT = 8;

/** How this function has been doing: last hour's numbers and its latest calls. */
function FunctionHealth({ name, go }: { name: string; go: (route: string) => void }) {
  const { metrics } = useLive();
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const m = metrics?.functions.find((f) => f.name === name);

  useEffect(() => {
    setCalls([]);
    call<CallRecord[]>("calls", { limit: 1000 })
      .then((list) => setCalls(list.filter((r) => r.name === name).slice(-RECENT)))
      .catch(() => {});
    return on("call", (r) => {
      if (r.name === name) setCalls((list) => [...list.slice(-(RECENT - 1)), r]);
    });
  }, [name]);

  return (
    <section class="fn-health">
      <div class="section-head">
        <h2 class="section-title">Last hour</h2>
        <button class="link" onClick={() => go(`logs/all/${encodeURIComponent(name)}`)}>All calls <Icon name="arrow" size={13} /></button>
      </div>
      {!m ? (
        <p class="muted hint">Not called in the last hour.</p>
      ) : (
        <div class="figures small">
          <div class="figure"><span>Calls</span><b>{compact(m.calls)}</b></div>
          <div class="figure"><span>Errors</span><b class={m.errors ? "err" : ""}>{percent(m.errors, m.calls)}</b></div>
          <div class="figure"><span>Cached</span><b>{percent(m.cached, m.calls)}</b></div>
          <div class="figure"><span>p50</span><b>{m.p50 === null ? "–" : duration(m.p50)}</b></div>
          <div class="figure"><span>p95</span><b>{m.p95 === null ? "–" : duration(m.p95)}</b></div>
        </div>
      )}
      {calls.length > 0 && (
        <ul class="rows compact">
          {[...calls].reverse().map((r) => (
            <li key={r.id} class="row-line">
              <span class="row-when">{ago(r.at)}</span>
              <span class={r.ok ? "muted" : "err"}>{r.ok ? "ok" : r.error}</span>
              <span class="muted nowrap">{r.source} · {duration(r.ms)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function FunctionsView({ name: selected, go }: { name?: string; go: (route: string) => void }) {
  const [fns, setFns] = useState<Fn[] | null>(null);
  const [search, setSearch] = useState("");
  const [args, setArgs] = useState("{}");
  const [asUser, setAsUser] = useState(false);
  const [identity, setIdentity] = useState('{ "subject": "user_123", "name": "Test User", "email": "test@example.com" }');
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    call<Fn[]>("functions").then(setFns).catch((e) => setError(errorText(e)));
  }, []);

  const fn = fns?.find((f) => f.name === selected) ?? null;

  useEffect(() => {
    if (fn) setArgs(JSON.stringify(sample(fn.args), null, 2));
    setResult(null);
  }, [fn?.name]);

  useEffect(() => {
    if (!selected && fns?.length) go(`functions/${encodeURIComponent(fns[0]!.name)}`);
  }, [fns, selected]);

  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const map = new Map<string, Fn[]>();
    for (const f of fns ?? []) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      const mod = f.name.split(":")[0]!;
      map.set(mod, [...(map.get(mod) ?? []), f]);
    }
    return [...map];
  }, [fns, search]);

  const run = async () => {
    if (!fn) return;
    let parsedArgs: unknown;
    let parsedIdentity: unknown = null;
    try {
      parsedArgs = JSON.parse(args || "{}");
      if (asUser) parsedIdentity = JSON.parse(identity);
    } catch (e) {
      return setResult({ ok: false, error: `Not valid JSON: ${errorText(e)}`, ms: 0, at: Date.now() });
    }
    setRunning(true);
    try {
      const r = await call<Omit<Result, "at">>("run", { name: fn.name, args: parsedArgs, identity: parsedIdentity });
      setResult({ ...r, at: Date.now() });
    } catch (e) {
      setResult({ ok: false, error: errorText(e), ms: 0, at: Date.now() });
    } finally {
      setRunning(false);
    }
  };

  if (error) return <div class="page"><p class="error-box">{error}</p></div>;

  return (
    <div class="data-layout">
      <nav class="table-list" aria-label="Functions">
        <input class="list-search" placeholder="Search functions" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
        {fns === null && <p class="muted pad">Loading…</p>}
        {groups.map(([mod, list]) => (
          <div class="fn-group">
            <p class="list-title">{mod}</p>
            {list.map((f) => (
              <a href={`#/functions/${encodeURIComponent(f.name)}`} aria-current={f.name === selected ? "page" : undefined}>
                <span>{f.name.split(":")[1]}</span>
                <small title={f.type}>{f.type[0]!.toUpperCase()}</small>
              </a>
            ))}
          </div>
        ))}
      </nav>
      <section class="data-main">
        {!fn ? (
          <Empty title={fns?.length ? "Pick a function" : "No functions yet"}>Export a query, mutation or action from a file in your functions folder.</Empty>
        ) : (
          <div class="page narrow">
            <header class="page-head compact">
              <div>
                <h1><code>{fn.name}</code></h1>
                <p class="badges">
                  <Badge kind={fn.type} />
                  {fn.visibility === "internal" && <Badge kind="internal" />}
                </p>
              </div>
            </header>

            <label class="field">
              <span>Arguments {fn.args && <code class="muted">{typeText(fn.args)}</code>}</span>
              <textarea
                class="code-input short"
                spellcheck={false}
                value={args}
                onInput={(e) => setArgs((e.target as HTMLTextAreaElement).value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
                }}
              />
            </label>

            <label class="check">
              <input type="checkbox" checked={asUser} onChange={(e) => setAsUser((e.target as HTMLInputElement).checked)} />
              Run as a signed-in user (<code>ctx.auth.getUserIdentity()</code>)
            </label>
            {asUser && (
              <textarea class="code-input tiny" spellcheck={false} value={identity} onInput={(e) => setIdentity((e.target as HTMLTextAreaElement).value)} />
            )}

            <div class="run-row">
              <button class="btn primary" onClick={run} disabled={running}>
                {running ? "Running…" : `Run ${fn.type}`} <kbd>⌘↵</kbd>
              </button>
              {fn.type !== "query" && <span class="hint">Runs for real: writes and side effects happen.</span>}
            </div>

            {result && (
              <div class={`result ${result.ok ? "ok" : "fail"}`}>
                <div class="result-head">
                  <span class="result-state"><Icon name={result.ok ? "check" : "critical"} size={14} /> {result.ok ? "Success" : "Error"}</span>
                  <span class="muted">{duration(result.ms)}</span>
                </div>
                {result.ok ? <JsonView value={result.value} /> : <pre class="json err">{result.error}</pre>}
              </div>
            )}

            <FunctionHealth name={fn.name} go={go} />
          </div>
        )}
      </section>
    </div>
  );
}
