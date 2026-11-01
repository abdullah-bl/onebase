/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { call, on, refreshScheduler, type Cron } from "../api";
import { Badge, Empty, Icon, ago, errorText, fullTime, preview, throttle, toast, useLive, useTick } from "../ui";

type Job = { id: string; fn: string; args: unknown; runAt: number; state: string; error: string | null };

const STATES = ["pending", "running", "failed", "done", "canceled"];

export function SchedulerView({ state: routeState, go }: { state?: string; go: (route: string) => void }) {
  const state = routeState && STATES.includes(routeState) ? routeState : "pending";
  const { scheduler } = useLive();
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [crons, setCrons] = useState<Cron[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTick(5000);

  const load = () =>
    Promise.all([call<Job[]>("jobs", { state }), call<Cron[]>("crons")])
      .then(([j, c]) => {
        setJobs(j);
        setCrons(c);
      })
      .catch((e) => setError(errorText(e)));

  useEffect(() => {
    void load();
    if (!scheduler) void refreshScheduler();
    // Jobs change when functions run; refresh on any call from the scheduler or crons.
    const refresh = throttle(() => void load(), 1000);
    const off = on("call", (r) => {
      if (r.source === "scheduler" || r.source === "cron") refresh();
    });
    const t = setInterval(load, 10_000);
    return () => {
      off();
      clearInterval(t);
      refresh.cancel();
    };
  }, [state]);

  const act = async (endpoint: string, id: string, done: string) => {
    try {
      await call(endpoint, { id });
      toast(done);
      void load();
      void refreshScheduler();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

  const retryAll = () => {
    const n = counts.failed ?? 0;
    if (confirm(`Run ${n.toLocaleString()} failed ${n === 1 ? "job" : "jobs"} again? Side effects happen again too.`)) void act("retryFailedJobs", "", "Queued to run again");
  };

  const runCron = async (c: Cron) => {
    try {
      const r = await call<{ ok: boolean; error?: string }>("run", { name: c.fn, args: c.args });
      toast(r.ok ? `Ran ${c.name}` : r.error ?? "Failed", r.ok ? "ok" : "error");
    } catch (e) {
      toast(errorText(e), "error");
    }
    void load();
  };

  const counts = scheduler?.jobs ?? {};

  return (
    <div class="page wide">
      <header class="page-head">
        <div>
          <h1>Scheduler</h1>
          <p class="muted">Jobs from <code>ctx.scheduler</code> and cron jobs from <code>crons.ts</code>.</p>
        </div>
      </header>
      {error && <p class="error-box">{error}</p>}

      <div class="card">
        <div class="card-head">
          <h3>Cron jobs</h3>
        </div>
        {crons?.length === 0 ? (
          <p class="muted pad">No crons. Add them in <code>crons.ts</code>.</p>
        ) : (
          <div class="grid-wrap flat">
            <table class="tbl">
              <thead><tr><th>Name</th><th>Function</th><th>Schedule (UTC)</th><th>Next run</th><th>Last run</th><th></th></tr></thead>
              <tbody>
                {crons?.map((c) => (
                  <tr>
                    <td>{c.name}</td>
                    <td><code>{c.fn}</code></td>
                    <td class="mono">{c.schedule}</td>
                    <td title={c.nextRun ? fullTime(c.nextRun) : ""}>{c.nextRun ? ago(c.nextRun) : "–"}</td>
                    <td>
                      {c.lastRun ? <span title={fullTime(c.lastRun)}>{ago(c.lastRun)}</span> : <span class="muted">never</span>}{" "}
                      {c.lastError && <Badge kind="error">failed</Badge>}
                      {c.lastError && <p class="cell-error" title={c.lastError}>{c.lastError}</p>}
                    </td>
                    <td class="actions">
                      <button class="btn small" title="Runs it once now. The schedule doesn't change." onClick={() => void runCron(c)}><Icon name="play" size={12} /> Run now</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div class="card">
        <div class="card-head">
          <h3>Scheduled functions</h3>
          <div class="toolbar">
            {state === "failed" && (counts.failed ?? 0) > 0 && (
              <button class="btn small" onClick={retryAll}><Icon name="retry" size={12} /> Retry all</button>
            )}
            <div class="tabs" role="tablist">
              {STATES.map((s) => (
                <button role="tab" aria-selected={s === state} class={s === state ? "active" : ""} onClick={() => go(`scheduler/${s}`)}>
                  {s}{counts[s] ? <span class={`tab-count ${s === "failed" ? "err" : ""}`}>{counts[s]!.toLocaleString()}</span> : null}
                </button>
              ))}
            </div>
          </div>
        </div>
        {jobs === null ? (
          <div class="skeleton" style="height:120px;margin:14px 16px" />
        ) : jobs.length === 0 ? (
          <Empty title={`No ${state} jobs`} />
        ) : (
          <div class="grid-wrap flat">
            <table class="tbl">
              <thead><tr><th>Function</th><th>Arguments</th><th>{state === "pending" ? "Runs" : "Scheduled for"}</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr>
                    <td><code>{j.fn}</code></td>
                    <td class="mono ellipsis">{preview(j.args)}</td>
                    <td title={fullTime(j.runAt)}>{ago(j.runAt)}</td>
                    <td class="wrap"><Badge kind={j.state === "failed" ? "error" : j.state === "done" ? "ok" : "muted"}>{j.state}</Badge>{j.error && <p class="cell-error" title={j.error}>{j.error}</p>}</td>
                    <td class="actions">
                      {j.state === "failed" && (
                        <button class="btn small" title="Queues it again, due now. Side effects happen again too." onClick={() => act("retryJob", j.id, "Queued to run again")}>Retry</button>
                      )}
                      {j.state === "pending" && (
                        <>
                          <button class="btn small" onClick={() => act("runJobNow", j.id, "Running now")}>Run now</button>
                          <button class="btn small danger" onClick={() => act("cancelJob", j.id, "Canceled")}>Cancel</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
