import { nextCronTime, parseCron, type ParsedCron } from "../cron";
import type { CronJob } from "../server";
import type { Runtime } from "./runtime";

type State = { job: CronJob; cron: ParsedCron | null; nextRun: number; running: boolean };

/**
 * Runs crons.ts jobs. Next run times are stored in the database, so a restart neither skips
 * nor repeats a run; a run missed while the server was down happens once on startup.
 * Each run is claimed with a compare-and-set on next_run, so with several instances sharing a
 * database only one of them runs it. A job still running when it's due again is skipped.
 */
export class CronRunner {
  private states: State[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly jobs: CronJob[],
  ) {}

  private next(state: Pick<State, "job" | "cron">, from: number): number {
    return state.job.schedule.type === "interval" ? from + state.job.schedule.ms : nextCronTime(state.cron!, from);
  }

  async start() {
    for (const job of this.jobs) this.runtime.resolve(job.fn, null, true); // fail fast on typos
    const now = Date.now();
    await this.runtime.withWriter(async (tx) => {
      this.states = [];
      const rows = new Map((await tx.all("SELECT name, spec, next_run FROM _crons")).map((r) => [r.name as string, r]));
      for (const job of this.jobs) {
        const spec = JSON.stringify([job.schedule, job.fn, job.args]);
        const cron = job.schedule.type === "cron" ? parseCron(job.schedule.expression) : null;
        const row = rows.get(job.name);
        if (row && row.spec === spec) {
          this.states.push({ job, cron, nextRun: Number(row.next_run), running: false });
          continue;
        }
        const nextRun = this.next({ job, cron }, now);
        await tx.run(
          "INSERT INTO _crons (name, spec, next_run) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET spec = excluded.spec, next_run = excluded.next_run",
          [job.name, spec, nextRun],
        );
        this.states.push({ job, cron, nextRun, running: false });
      }
      const names = new Set(this.jobs.map((j) => j.name));
      for (const name of rows.keys()) if (!names.has(name)) await tx.run("DELETE FROM _crons WHERE name = ?", [name]);
    });
    this.arm();
  }

  private arm() {
    if (this.stopped || this.states.length === 0) return;
    if (this.timer) clearTimeout(this.timer);
    const soonest = Math.min(...this.states.map((s) => s.nextRun));
    this.timer = setTimeout(() => void this.fire(), Math.min(Math.max(0, soonest - Date.now()), 2 ** 31 - 1));
  }

  private async fire() {
    const now = Date.now();
    await Promise.all(this.states.filter((s) => s.nextRun <= now).map((s) => this.claimAndRun(s, now)));
    this.arm();
  }

  private async claimAndRun(state: State, now: number) {
    const due = state.nextRun;
    const next = this.next(state, now);
    // Persisting the next run before running means a crash mid-run doesn't repeat it after a restart.
    const claimed = await this.runtime
      .withWriter(async (tx) => {
        const { changes } = await tx.run("UPDATE _crons SET next_run = ? WHERE name = ? AND next_run = ?", [next, state.job.name, due]);
        if (changes === 1) return true;
        const row = await tx.get("SELECT next_run FROM _crons WHERE name = ?", [state.job.name]);
        state.nextRun = Number(row?.next_run ?? next); // another instance took this run
        return false;
      })
      .catch((err) => {
        this.runtime.log.error(`Cron "${state.job.name}": ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    if (!claimed) return;
    state.nextRun = next;
    if (state.running) {
      this.runtime.log.warn(`Cron "${state.job.name}" is still running; skipping this run.`);
      return;
    }
    void this.run(state, now);
  }

  private async run(state: State, startedAt: number) {
    state.running = true;
    let error: string | null = null;
    try {
      await this.runtime.call(state.job.fn, state.job.args, { allowInternal: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.runtime.log.error(`Cron "${state.job.name}" (${state.job.fn}) failed: ${error}`);
    } finally {
      state.running = false;
    }
    if (this.stopped) return;
    await this.runtime
      .withWriter((tx) => tx.run("UPDATE _crons SET last_run = ?, last_error = ? WHERE name = ?", [startedAt, error, state.job.name]))
      .catch(() => {});
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
