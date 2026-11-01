/** @jsxImportSource preact */
import { useEffect, useMemo, useState } from "preact/hooks";
import { call, on, refreshScheduler, type CallPoint, type Cron, type FunctionMetrics, type Metrics, type SchedulerSummary } from "../api";
import { Badge, Icon, ago, bytes, clockTime, compact, duration, errorText, fullTime, percent, rowLink, throttle, toast, useLatest, useLive, useTick } from "../ui";
import { CallsChart, ChartTable, LatencyChart } from "./charts";

type Overview = {
  version: string;
  uptimeMs: number;
  memory: { rss: number };
  driver: { kind: string; description: string };
  files: { backend: string; count: number; bytes: number };
  functions: Record<string, number>;
  crons: number;
  connections: number;
  subscriptions: number;
  tables: { name: string; count: number; inSchema: boolean }[];
  schema: boolean;
  signIn: string[];
  deployment: { id: string; created: number } | null;
};

type Go = (route: string) => void;
type Range = "1m" | "15m" | "1h";

const RANGES: Range[] = ["1m", "15m", "1h"];
const RANGE_LABEL: Record<Range, string> = { "1m": "minute", "15m": "15 minutes", "1h": "hour" };

// What counts as worth interrupting someone: a real share of calls failing, or calls slow enough to feel.
const MIN_ERROR_SHARE = 0.01;
const SLOW_MS = { query: 1000, mutation: 1000, action: 10_000, http: 5000 };
const MIN_SLOW_CALLS = 5;
const MAX_ATTENTION = 5;
const TOP_FUNCTIONS = 8;
const TOP_TABLES = 8;

const encoded = encodeURIComponent;
const logsFor = (name: string, errors = false) => `logs/${errors ? "errors" : "all"}/${encoded(name)}`;
/** Function page if there is one; "auth", "dashboard edit" and HTTP routes only have logs. */
const routeFor = (f: FunctionMetrics) => (f.type !== "http" && f.name.includes(":") ? `functions/${encoded(f.name)}` : logsFor(f.name));

async function attempt(work: () => Promise<unknown>, done: string) {
  try {
    await work();
    toast(done);
  } catch (e) {
    toast(errorText(e), "error");
  }
  void refreshScheduler();
}

async function runCron(cron: Cron) {
  try {
    const r = await call<{ ok: boolean; error?: string }>("run", { name: cron.fn, args: cron.args });
    toast(r.ok ? `Ran ${cron.name}` : r.error ?? "Failed", r.ok ? "ok" : "error");
  } catch (e) {
    toast(errorText(e), "error");
  }
}

// ---------- what needs attention ----------

type Item = {
  key: string;
  level: "critical" | "warning" | "info";
  title: string;
  detail?: string | null;
  actions: { label: string; run: () => void; primary?: boolean }[];
};

function attention(overview: Overview | null, metrics: Metrics | null, scheduler: SchedulerSummary | null, go: Go): Item[] {
  const items: Item[] = [];
  const failedJobs = scheduler?.jobs.failed ?? 0;
  if (failedJobs > 0) {
    const last = scheduler!.lastFailed;
    items.push({
      key: "failed-jobs",
      level: "critical",
      title: `${failedJobs.toLocaleString()} scheduled ${failedJobs === 1 ? "job" : "jobs"} failed`,
      detail: last ? `Latest: ${last.fn}${last.error ? `: ${last.error}` : ""}` : null,
      actions: [
        {
          label: failedJobs === 1 ? "Retry" : "Retry all",
          primary: true,
          run: () => {
            if (confirm(`Run ${failedJobs.toLocaleString()} failed ${failedJobs === 1 ? "job" : "jobs"} again? Side effects happen again too.`)) void attempt(() => call("retryFailedJobs"), "Queued to run again");
          },
        },
        { label: "View", run: () => go("scheduler/failed") },
      ],
    });
  }
  for (const cron of scheduler?.crons ?? []) {
    if (!cron.lastError) continue;
    items.push({
      key: `cron-${cron.name}`,
      level: "critical",
      title: `Cron "${cron.name}" failed on its last run`,
      detail: cron.lastError,
      actions: [
        { label: "Run now", primary: true, run: () => void runCron(cron).then(refreshScheduler) },
        { label: "View", run: () => go("scheduler") },
      ],
    });
  }
  // A failing job or cron is already listed, with its fix: don't list its function a second time.
  const listed = new Set((scheduler?.crons ?? []).filter((c) => c.lastError).map((c) => c.fn));
  if (failedJobs > 0 && scheduler?.lastFailed) listed.add(scheduler.lastFailed.fn);
  for (const f of metrics?.functions ?? []) {
    if (f.errors && listed.has(f.name)) continue;
    if (f.errors && f.errors / f.calls >= MIN_ERROR_SHARE) {
      items.push({
        key: `err-${f.name}`,
        level: f.errors / f.calls >= 0.05 ? "critical" : "warning",
        title: `${f.name} is failing ${percent(f.errors, f.calls)} of calls`,
        detail: `${f.errors.toLocaleString()} of ${f.calls.toLocaleString()} in the last hour. ${f.lastError ?? ""}`,
        actions: [{ label: "See errors", primary: true, run: () => go(logsFor(f.name, true)) }],
      });
    } else if (f.p95 !== null && f.p95 >= SLOW_MS[f.type] && f.calls - f.cached >= MIN_SLOW_CALLS) {
      items.push({
        key: `slow-${f.name}`,
        level: "warning",
        title: `${f.name} is slow: ${duration(f.p95)} at p95`,
        detail: `Slowest call ${duration(f.maxMs)}, over ${(f.calls - f.cached).toLocaleString()} runs in the last hour.`,
        actions: [{ label: "See calls", run: () => go(logsFor(f.name)) }],
      });
    }
  }
  if (scheduler?.overdue.count) {
    items.push({
      key: "overdue",
      level: "warning",
      title: `${scheduler.overdue.count.toLocaleString()} ${scheduler.overdue.count === 1 ? "job is" : "jobs are"} overdue`,
      detail: scheduler.overdue.oldest ? `The oldest was due ${ago(scheduler.overdue.oldest)}. The scheduler may be falling behind.` : null,
      actions: [{ label: "View", run: () => go("scheduler/pending") }],
    });
  }
  if (overview?.schema) {
    for (const t of overview.tables) {
      if (t.inSchema || !t.count) continue;
      items.push({
        key: `orphan-${t.name}`,
        level: "info",
        title: `${t.name} has ${t.count.toLocaleString()} documents but isn't in any schema`,
        actions: [{ label: "Open table", run: () => go(`data/${encoded(t.name)}`) }],
      });
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

function Attention({ items, ready }: { items: Item[]; ready: boolean }) {
  const [all, setAll] = useState(false);
  if (!ready) return <div class="attention skeleton" style="height:58px" />;
  if (items.length === 0) {
    return (
      <section class="attention calm" aria-label="Status">
        <span class="calm-mark"><Icon name="check" size={15} /></span>
        <div>
          <b>Nothing needs attention</b>
          <p class="muted">No failed jobs or crons, and no function failing or slow in the last hour.</p>
        </div>
      </section>
    );
  }
  const shown = all ? items : items.slice(0, MAX_ATTENTION);
  return (
    <section class="attention" aria-label="Needs attention">
      <h2 class="section-title">Needs attention <span class="count">{items.length}</span></h2>
      <ul>
        {shown.map((item) => (
          <li key={item.key} class={`alert a-${item.level}`}>
            <span class="alert-icon" title={item.level}><Icon name={item.level} /></span>
            <div class="alert-body">
              <b>{item.title}</b>
              {item.detail && <p title={item.detail}>{item.detail}</p>}
            </div>
            <div class="alert-actions">
              {item.actions.map((a) => (
                <button key={a.label} class={`btn small ${a.primary ? "primary" : ""}`} onClick={a.run}>{a.label}</button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {items.length > MAX_ATTENTION && (
        <button class="link pad-link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show ${items.length - MAX_ATTENTION} more`}</button>
      )}
    </section>
  );
}

// ---------- traffic ----------

function Figure({ label, value, note, tone }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <div class="figure">
      <span>{label}</span>
      <b class={tone ?? ""}>{value}</b>
      <small>{note}</small>
    </div>
  );
}

function Traffic({ metrics, overview }: { metrics: Metrics | null; overview: Overview | null }) {
  const [range, setRange] = useState<Range>("15m");
  const { stats } = useLive();

  const points: CallPoint[] = !metrics ? [] : range === "1m" ? metrics.seconds : range === "15m" ? metrics.minutes.slice(-15) : metrics.minutes;
  const stamp = range === "1m" ? clockTime : (at: number) => clockTime(at).slice(0, 5);
  const summary = metrics?.ranges[range];
  const rangeMinutes = range === "1m" ? 1 : range === "15m" ? 15 : 60;
  // A server up for 5 minutes shouldn't have its rate averaged over 15.
  const minutes = Math.max(1, Math.min(rangeMinutes, (stats?.uptimeMs ?? overview?.uptimeMs ?? Infinity) / 60_000));
  const connections = stats?.connections ?? overview?.connections ?? 0;
  const subscriptions = stats?.subscriptions ?? overview?.subscriptions ?? 0;
  const memory = stats?.memory ?? overview?.memory.rss ?? 0;

  return (
    <section class="traffic reveal" style="--i:1">
      <div class="section-head">
        <h2 class="section-title">Traffic</h2>
        <div class="tabs" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} aria-pressed={r === range} class={r === range ? "active" : ""} onClick={() => setRange(r)}>{r}</button>
          ))}
        </div>
      </div>
      <div class="figures">
        {summary ? (
          <>
            <Figure label="Calls" value={compact(summary.calls)} note={`${compact(Math.round(summary.calls / minutes))} per minute`} />
            <Figure label="Error rate" value={percent(summary.errors, summary.calls)} note={`${summary.errors.toLocaleString()} failed`} tone={summary.errors ? "err" : ""} />
            <Figure label="p95 latency" value={summary.p95 === null ? "–" : duration(summary.p95)} note={summary.p50 === null ? "no function runs" : `p50 ${duration(summary.p50)}`} />
            <Figure label="Connections" value={connections.toLocaleString()} note={`${subscriptions.toLocaleString()} subscriptions`} />
            <Figure label="Memory" value={bytes(memory)} note="server process" />
          </>
        ) : (
          [0, 1, 2, 3, 4].map((i) => <div key={i} class="figure"><div class="skeleton" style="height:58px" /></div>)
        )}
      </div>
      <div class="chart-row">
        <figure class="chart">
          <figcaption>
            <span>Calls {range === "1m" ? "per second" : "per minute"}</span>
            <span class="legend"><i class="key mark-ok" />Succeeded<i class="key mark-err" />Failed</span>
          </figcaption>
          {metrics ? <CallsChart points={points} unit={range === "1m" ? "per second" : "per minute"} stamp={stamp} /> : <div class="skeleton" style="height:184px" />}
        </figure>
        <figure class="chart">
          <figcaption><span>p95 latency</span></figcaption>
          {metrics ? <LatencyChart points={points} stamp={stamp} /> : <div class="skeleton" style="height:184px" />}
        </figure>
      </div>
      <ChartTable points={points} stamp={stamp} />
      <p class="sr-only">Range: last {RANGE_LABEL[range]}.</p>
    </section>
  );
}

// ---------- functions ----------

type SortKey = "name" | "calls" | "errors" | "cached" | "p50" | "p95";
const COLUMNS: { key: SortKey; label: string; title?: string }[] = [
  { key: "calls", label: "Calls" },
  { key: "errors", label: "Errors" },
  { key: "cached", label: "Cached", title: "Answered from the query cache, without running the function" },
  { key: "p50", label: "p50" },
  { key: "p95", label: "p95" },
];

function FunctionHealth({ metrics, go }: { metrics: Metrics | null; go: Go }) {
  const [sort, setSort] = useState<SortKey>("calls");
  const [search, setSearch] = useState("");
  const [all, setAll] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (metrics?.functions ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
    if (sort === "name") return list.sort((a, b) => a.name.localeCompare(b.name));
    return list.sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || b.calls - a.calls);
  }, [metrics, sort, search]);
  const shown = all || search ? rows : rows.slice(0, TOP_FUNCTIONS);
  const total = metrics?.functions.length ?? 0;

  return (
    <section class="panel reveal" style="--i:2">
      <div class="section-head">
        <h2 class="section-title">Functions <span class="section-note">last hour</span></h2>
        {total > TOP_FUNCTIONS && (
          <input class="mini-search" aria-label="Filter functions" placeholder="Filter" value={search} onInput={(e) => setSearch((e.target as HTMLInputElement).value)} />
        )}
      </div>
      {!metrics ? (
        <div class="skeleton" style="height:220px" />
      ) : total === 0 ? (
        <div class="inline-empty">
          <p><b>No calls in the last hour.</b> Connect a client, or try a function from here.</p>
          <button class="btn small" onClick={() => go("functions")}><Icon name="play" size={13} /> Run a function</button>
        </div>
      ) : (
        <>
          <div class="table-scroll">
            <table class="tbl fn-table">
              <thead>
                <tr>
                  <th aria-sort={sort === "name" ? "ascending" : "none"}><button class="sort" onClick={() => setSort("name")}>Function</button></th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} class="num" title={c.title} aria-sort={sort === c.key ? "descending" : "none"}>
                      <button class={`sort ${sort === c.key ? "on" : ""}`} onClick={() => setSort(c.key)}>{c.label}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr key={f.name} class="clickable" {...rowLink(() => go(routeFor(f)))}>
                    <td class="fn-name"><code title={f.name}>{f.name}</code> <Badge kind={f.type} /></td>
                    <td class="num">{compact(f.calls)}</td>
                    <td class="num">
                      {f.errors ? (
                        <button class="link err-link" title={`${f.errors.toLocaleString()} failed. See them in Logs.`} onClick={(e) => { e.stopPropagation(); go(logsFor(f.name, true)); }}>
                          {percent(f.errors, f.calls)}
                        </button>
                      ) : <span class="muted">0</span>}
                    </td>
                    <td class="num muted">{f.cached ? percent(f.cached, f.calls) : "–"}</td>
                    <td class="num">{f.p50 === null ? "–" : duration(f.p50)}</td>
                    <td class={`num ${f.p95 !== null && f.p95 >= SLOW_MS[f.type] ? "slow" : ""}`}>{f.p95 === null ? "–" : duration(f.p95)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown.length === 0 && <p class="muted pad">No function matches "{search}".</p>}
          {!search && total > TOP_FUNCTIONS && (
            <button class="link pad-link" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${total}`}</button>
          )}
        </>
      )}
    </section>
  );
}

// ---------- side panels ----------

function RecentErrors({ metrics, go }: { metrics: Metrics | null; go: Go }) {
  const errors = (metrics?.functions ?? [])
    .filter((f) => f.lastErrorAt !== null)
    .sort((a, b) => b.lastErrorAt! - a.lastErrorAt!)
    .slice(0, 4);
  return (
    <section class="panel reveal" style="--i:3">
      <div class="section-head">
        <h2 class="section-title">Latest errors</h2>
        <button class="link" onClick={() => go("logs/errors")}>All logs <Icon name="arrow" size={13} /></button>
      </div>
      {!metrics ? (
        <div class="skeleton" style="height:90px" />
      ) : errors.length === 0 ? (
        <p class="inline-empty muted">No errors in the last hour.</p>
      ) : (
        <ul class="rows">
          {errors.map((f) => (
            <li key={f.name}>
              <button class="row-button" onClick={() => go(logsFor(f.name, true))}>
                <span class="row-top">
                  <code>{f.name}</code>
                  <span class="muted nowrap">{f.errors > 1 ? `${f.errors.toLocaleString()} · ` : ""}{ago(f.lastErrorAt!)}</span>
                </span>
                <span class="err-text">{f.lastError}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Upcoming({ scheduler, go }: { scheduler: SchedulerSummary | null; go: Go }) {
  const entries = [
    ...(scheduler?.upcoming ?? []).map((j) => ({ key: j.id, at: j.runAt, name: j.fn, kind: "job", title: j.fn })),
    ...(scheduler?.crons ?? []).filter((c) => c.nextRun !== null).map((c) => ({ key: c.name, at: c.nextRun!, name: c.name, kind: "cron", title: `${c.fn} (${c.schedule})` })),
  ]
    .sort((a, b) => a.at - b.at)
    .slice(0, 5);
  return (
    <section class="panel reveal" style="--i:4">
      <div class="section-head">
        <h2 class="section-title">Up next</h2>
        <button class="link" onClick={() => go("scheduler")}>Scheduler <Icon name="arrow" size={13} /></button>
      </div>
      {!scheduler ? (
        <div class="skeleton" style="height:90px" />
      ) : entries.length === 0 ? (
        <p class="inline-empty muted">Nothing scheduled. Use <code>ctx.scheduler</code> or <code>crons.ts</code>.</p>
      ) : (
        <ul class="rows compact">
          {entries.map((e) => (
            <li key={e.key} class="row-line" title={e.title}>
              <span class="row-when" title={fullTime(e.at)}>{ago(e.at)}</span>
              <code>{e.name}</code>
              <Badge kind="muted">{e.kind}</Badge>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Tables({ overview, go }: { overview: Overview | null; go: Go }) {
  const tables = overview ? [...overview.tables].sort((a, b) => b.count - a.count) : [];
  const largest = Math.max(1, ...tables.map((t) => t.count));
  const documents = tables.reduce((sum, t) => sum + t.count, 0);
  return (
    <section class="panel reveal" style="--i:5">
      <div class="section-head">
        <h2 class="section-title">Data {overview && <span class="section-note">{documents.toLocaleString()} documents · {overview.files.count.toLocaleString()} files, {bytes(overview.files.bytes)}</span>}</h2>
        <button class="link" onClick={() => go("data")}>Browse <Icon name="arrow" size={13} /></button>
      </div>
      {!overview ? (
        <div class="skeleton" style="height:150px" />
      ) : tables.length === 0 ? (
        <p class="inline-empty muted">No tables yet. They appear when a function writes a document or <code>schema.ts</code> declares one.</p>
      ) : (
        <>
          <ul class="rows compact">
            {tables.slice(0, TOP_TABLES).map((t) => (
              <li key={t.name}>
                <a class="table-row" href={`#/data/${encoded(t.name)}`}>
                  <code title={t.name}>{t.name}</code>
                  <span class="meter" aria-hidden="true"><i style={{ transform: `scaleX(${t.count / largest})` }} /></span>
                  <span class="num">{t.count.toLocaleString()}</span>
                </a>
              </li>
            ))}
          </ul>
          {tables.length > TOP_TABLES && <button class="link pad-link" onClick={() => go("data")}>{tables.length - TOP_TABLES} more tables</button>}
        </>
      )}
    </section>
  );
}

function Setup({ overview, reload }: { overview: Overview | null; reload: () => void }) {
  const rollback = async () => {
    if (!confirm("Go back to the previous deployment? Its functions and schema replace the current ones right away.")) return;
    try {
      await call("rollback");
      toast("Rolled back");
      reload();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };
  const fnCounts = overview ? ["query", "mutation", "action"].map((t) => `${overview.functions[t] ?? 0} ${t === "query" ? "queries" : `${t}s`}`).join(" · ") : "";
  return (
    <section class="panel reveal" style="--i:6">
      <div class="section-head"><h2 class="section-title">Setup</h2></div>
      {!overview ? (
        <div class="skeleton" style="height:150px" />
      ) : (
        <dl class="kv">
          <dt>Deployment</dt>
          <dd>
            {overview.deployment ? (
              <span class="kv-action">
                <span><code title={overview.deployment.id}>{overview.deployment.id.slice(0, 10)}</code> <span class="muted" title={fullTime(overview.deployment.created)}>pushed {ago(overview.deployment.created)}</span></span>
                <button class="btn small" onClick={rollback}>Roll back</button>
              </span>
            ) : (
              <span class="muted">Local code (nothing pushed with <code>onebase deploy</code>)</span>
            )}
          </dd>
          <dt>Functions</dt><dd>{fnCounts}</dd>
          <dt>Database</dt><dd><code>{overview.driver.description}</code></dd>
          <dt>Files</dt><dd><code>{overview.files.backend}</code></dd>
          <dt>Schema</dt><dd>{overview.schema ? "schema.ts, checked on every write" : "None: any document is accepted"}</dd>
          <dt>Sign-in</dt><dd>{overview.signIn.length ? overview.signIn.join(", ") : "Not built in (auth.config.ts providers, if any)"}</dd>
        </dl>
      )}
    </section>
  );
}

// ---------- page ----------

export function OverviewView({ go }: { go: Go }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { metrics, scheduler, stats } = useLive();
  useTick(5000);

  const load = () =>
    call<Overview>("overview")
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((e) => setError(errorText(e)));
  const loadRef = useLatest(load);

  useEffect(() => {
    void load();
    if (!scheduler) void refreshScheduler();
    // Table counts scan the documents table, so a busy server refreshes them on a slow clock.
    const refresh = throttle(() => {
      if (!document.hidden) void loadRef.current();
    }, 10_000);
    const off = on("commit", refresh);
    const timer = setInterval(refresh, 30_000);
    return () => {
      off();
      clearInterval(timer);
      refresh.cancel();
    };
  }, []);

  const items = useMemo(() => attention(overview, metrics, scheduler, go), [overview, metrics, scheduler]);
  const uptime = stats?.uptimeMs ?? overview?.uptimeMs;

  return (
    <div class="page overview">
      <header class="page-head">
        <div>
          <h1>Overview</h1>
          <p class="muted">
            {overview ? <>onebase v{overview.version} · {overview.driver.kind}{uptime !== undefined && ` · up ${duration(uptime)}`}</> : "Loading…"}
          </p>
        </div>
        <div class="toolbar">
          <button class="btn" onClick={() => go("functions")}><Icon name="play" size={14} /> Run a function</button>
          <button class="btn" onClick={() => go("data")}><Icon name="data" size={14} /> Browse data</button>
        </div>
      </header>

      {error && (
        <p class="error-box error-row">
          <span>Couldn't load the overview: {error}</span>
          <button class="btn small" onClick={() => void load()}>Try again</button>
        </p>
      )}

      <Attention items={items} ready={Boolean(overview && metrics && scheduler)} />
      <Traffic metrics={metrics} overview={overview} />

      <div class="split">
        <FunctionHealth metrics={metrics} go={go} />
        <div class="stack">
          <RecentErrors metrics={metrics} go={go} />
          <Upcoming scheduler={scheduler} go={go} />
        </div>
      </div>

      <div class="split even">
        <Tables overview={overview} go={go} />
        <Setup overview={overview} reload={() => void load()} />
      </div>
    </div>
  );
}
