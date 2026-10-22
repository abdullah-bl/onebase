/** @jsxImportSource preact */
import { useEffect, useState } from "preact/hooks";
import { call, on } from "../api";
import { Badge, Empty, ago, errorText, fullTime, preview, toast, useTick } from "../ui";

type Job = { id: string; fn: string; args: unknown; runAt: number; state: string; error: string | null };
type Cron = { name: string; fn: string; args: unknown; schedule: string; nextRun: number | null; lastRun: number | null; lastError: string | null };

const STATES = ["pending", "running", "failed", "done", "canceled"];

export function SchedulerView() {
  const [state, setState] = useState("pending");
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
    // Jobs change when functions run; refresh on any call from the scheduler or crons.
    const off = on("call", (r) => {
      if (r.source === "scheduler" || r.source === "cron") void load();
    });
    const t = setInterval(load, 10_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [state]);

  const act = async (endpoint: string, id: string, done: string) => {
    try {
      await call(endpoint, { id });
      toast(done);
      void load();
    } catch (e) {
      toast(errorText(e), "error");
    }
  };

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
              <thead><tr><th>Name</th><th>Function</th><th>Schedule (UTC)</th><th>Next run</th><th>Last run</th></tr></thead>
              <tbody>
                {crons?.map((c) => (
                  <tr>
                    <td>{c.name}</td>
                    <td><code>{c.fn}</code></td>
                    <td class="mono">{c.schedule}</td>
                    <td title={c.nextRun ? fullTime(c.nextRun) : ""}>{c.nextRun ? ago(c.nextRun) : "–"}</td>
                    <td>
                      {c.lastRun ? <span title={fullTime(c.lastRun)}>{ago(c.lastRun)}</span> : <span class="muted">never</span>}{" "}
                      {c.lastError && <span class="err" title={c.lastError}>failed</span>}
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
          <div class="tabs" role="tablist">
            {STATES.map((s) => (
              <button role="tab" aria-selected={s === state} class={s === state ? "active" : ""} onClick={() => setState(s)}>{s}</button>
            ))}
          </div>
        </div>
        {jobs?.length === 0 ? (
          <Empty title={`No ${state} jobs`} />
        ) : (
          <div class="grid-wrap flat">
            <table class="tbl">
              <thead><tr><th>Function</th><th>Arguments</th><th>{state === "pending" ? "Runs" : "Scheduled for"}</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {jobs?.map((j) => (
                  <tr>
                    <td><code>{j.fn}</code></td>
                    <td class="mono ellipsis">{preview(j.args)}</td>
                    <td title={fullTime(j.runAt)}>{ago(j.runAt)}</td>
                    <td><Badge kind={j.state === "failed" ? "error" : j.state === "done" ? "ok" : "muted"}>{j.state}</Badge> {j.error && <span class="err">{j.error}</span>}</td>
                    <td class="actions">
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
