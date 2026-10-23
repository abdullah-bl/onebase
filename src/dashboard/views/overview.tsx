/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { call, on, type CallRecord, type Stats } from "../api";
import { Badge, bytes, clockTime, duration, errorText, useTick } from "../ui";

type Overview = {
  version: string;
  uptimeMs: number;
  memory: { rss: number };
  driver: { kind: string; description: string };
  files: { backend: string; count: number; bytes: number };
  functions: Record<string, number>;
  crons: number;
  jobs: Record<string, number>;
  connections: number;
  subscriptions: number;
  totals: { calls: number; errors: number };
  tables: { name: string; count: number; inSchema: boolean }[];
  schema: boolean;
  signIn: string[];
};

const WINDOW = 60;

/** Calls per second over the last minute: counts keyed by epoch second, redrawn every second. */
function useThroughput(calls: CallRecord[]) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return useMemo(() => {
    const buckets = Array.from({ length: WINDOW }, () => ({ ok: 0, err: 0 }));
    for (const r of calls) {
      const age = now - Math.floor(r.at / 1000);
      if (age >= 0 && age < WINDOW) buckets[WINDOW - 1 - age]![r.ok ? "ok" : "err"]++;
    }
    return buckets;
  }, [calls, now]);
}

function Chart({ buckets }: { buckets: { ok: number; err: number }[] }) {
  const max = Math.max(4, ...buckets.map((b) => b.ok + b.err));
  const w = 600;
  const h = 120;
  const bw = w / buckets.length;
  const total = buckets.reduce((s, b) => s + b.ok + b.err, 0);
  return (
    <div class="card chart-card">
      <div class="card-head">
        <h3>Calls, last 60 seconds</h3>
        <span class="muted">
          {total} calls · peak {Math.max(...buckets.map((b) => b.ok + b.err))}/s
        </span>
      </div>
      <svg class="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="Calls per second">
        {[0.25, 0.5, 0.75].map((f) => (
          <line x1="0" x2={w} y1={h * f} y2={h * f} class="grid" />
        ))}
        {buckets.map((b, i) => {
          const okH = (b.ok / max) * (h - 4);
          const errH = (b.err / max) * (h - 4);
          return (
            <g key={i}>
              <rect x={i * bw + 1} width={Math.max(bw - 2, 1)} y={h - okH} height={okH} class="bar-ok" rx="1.5" />
              {b.err > 0 && <rect x={i * bw + 1} width={Math.max(bw - 2, 1)} y={h - okH - errH} height={errH} class="bar-err" rx="1.5" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function OverviewView({ go }: { go: (route: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  useTick(5000);

  const load = () =>
    Promise.all([call<Overview>("overview"), call<CallRecord[]>("calls", { limit: 1000 })])
      .then(([o, c]) => {
        setData(o);
        setCalls(c);
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
    const offStats = on("stats", setStats);
    const offCall = on("call", (r) => setCalls((c) => [...c.slice(-999), r]));
    const offCommit = on("commit", () => void call<Overview>("overview").then(setData).catch(() => {}));
    return () => {
      offStats();
      offCall();
      offCommit();
    };
  }, []);

  const buckets = useThroughput(calls);
  const errors = calls.filter((c) => !c.ok).slice(-6).reverse();

  if (error) return <div class="page"><p class="error-box">{error}</p></div>;
  if (!data) return <div class="page"><p class="muted">Loading…</p></div>;

  const live = stats ?? { ...data, memory: data.memory.rss };
  const fnCount = Object.values(data.functions).reduce((a, b) => a + b, 0);
  const docCount = data.tables.reduce((a, t) => a + t.count, 0);
  const totals = stats?.totals ?? data.totals;

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="muted">
            onebase v{data.version} · {data.driver.kind} · up {duration(live.uptimeMs)}
          </p>
        </div>
      </header>

      <div class="stat-grid">
        <div class="stat"><span>Live connections</span><b>{live.connections}</b><small>{live.subscriptions} subscriptions</small></div>
        <div class="stat"><span>Calls since start</span><b>{totals.calls.toLocaleString()}</b><small class={totals.errors ? "err" : ""}>{totals.errors.toLocaleString()} errors</small></div>
        <div class="stat"><span>Memory (RSS)</span><b>{bytes(typeof live.memory === "number" ? live.memory : data.memory.rss)}</b><small>one process</small></div>
        <div class="stat"><span>Documents</span><b>{docCount.toLocaleString()}</b><small>{data.tables.length} tables</small></div>
        <div class="stat"><span>Functions</span><b>{fnCount}</b><small>{["query", "mutation", "action"].map((t) => `${data.functions[t] ?? 0} ${t[0]}`).join(" · ")}</small></div>
        <div class="stat"><span>Files</span><b>{data.files.count.toLocaleString()}</b><small>{bytes(data.files.bytes)}</small></div>
      </div>

      <Chart buckets={buckets} />

      <div class="two-col">
        <div class="card">
          <div class="card-head"><h3>Tables</h3><button class="link" onClick={() => go("data")}>Browse data →</button></div>
          {data.tables.length === 0 ? (
            <p class="muted pad">No documents yet.</p>
          ) : (
            <table class="tbl">
              <tbody>
                {data.tables.map((t) => (
                  <tr class="clickable" onClick={() => go(`data/${t.name}`)}>
                    <td><code>{t.name}</code> {!t.inSchema && <Badge kind="warn">not in schema</Badge>}</td>
                    <td class="num">{t.count.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div class="card">
          <div class="card-head"><h3>Recent errors</h3><button class="link" onClick={() => go("logs")}>All logs →</button></div>
          {errors.length === 0 ? (
            <p class="muted pad">No errors in the last {calls.length} calls.</p>
          ) : (
            <ul class="err-list">
              {errors.map((e) => (
                <li>
                  <div><code>{e.name}</code> <span class="muted">{clockTime(e.at)}</span></div>
                  <p>{e.error}</p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h3>Setup</h3></div>
        <dl class="kv">
          <dt>Database</dt><dd><code>{data.driver.description}</code> ({data.driver.kind})</dd>
          <dt>Files</dt><dd><code>{data.files.backend}</code></dd>
          <dt>Schema</dt><dd>{data.schema ? "schema.ts, validated on every write" : "none (any document is accepted)"}</dd>
          <dt>Sign-in</dt><dd>{data.signIn.length ? data.signIn.join(", ") : "not built in (tokens from auth.config.ts providers, if any)"}</dd>
          <dt>Scheduler</dt><dd>{data.jobs.pending ?? 0} pending · {data.jobs.failed ?? 0} failed · {data.crons} crons</dd>
        </dl>
      </div>
    </div>
  );
}
