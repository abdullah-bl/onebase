// Scheduled jobs (ctx.scheduler.runAfter / runAt): the timer for the next due job, claiming and
// running jobs, and getting back the ones a stopped server left behind. Crons are CronRunner's.

import type { Exec } from "./driver";
import type { Runtime } from "./runtime";

/** Scheduled jobs one instance runs at the same time. */
const MAX_RUNNING_JOBS = 20;
/** Finished, failed and canceled jobs are kept this long. */
const KEEP_FINISHED_MS = 7 * 86400_000;

/** A running job's lease, as text that sorts by time (13 digits until the year 2286). */
export const leaseMark = (at: number) => `lease:${String(Math.floor(at)).padStart(13, "0")}`;

type Job = { id: string; fn: string; args: string };

export class Scheduler {
  /** How often a shared database is checked for missed work, and how long a job's claim lasts without being renewed. */
  static heartbeatMs = 30_000;
  static jobLeaseMs = 150_000;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly runningIds = new Set<string>();
  private stopped = false;
  private draining = false;

  constructor(private readonly runtime: Runtime) {}

  /** Jobs this instance is running right now. */
  get running() {
    return this.runningIds.size;
  }

  /**
   * Tidies old jobs, takes back interrupted ones and arms the timer. With a shared database it
   * also checks every `heartbeatMs` for work other instances left; `onHeartbeat` runs then too.
   */
  async start(onHeartbeat?: () => void) {
    const { runtime } = this;
    await runtime.withWriter((tx) => tx.run("DELETE FROM _scheduled WHERE state <> 'pending' AND run_at < ?", [Date.now() - KEEP_FINISHED_MS]));
    await this.recoverInterrupted();
    this.poke();
    // With a shared database, pick up jobs left by instances that went away.
    if (runtime.driver.shared) {
      await this.renewLeases();
      this.heartbeat = setInterval(() => {
        void this.renewLeases()
          .then(() => this.recoverInterrupted())
          .then(() => this.poke());
        onHeartbeat?.();
      }, Scheduler.heartbeatMs);
    }
  }

  /** Sets the timer for the next pending job. Call it whenever a job may have been added or changed. */
  poke() {
    if (this.stopped || this.draining) return;
    void this.runtime
      .withReader((tx) => tx.get("SELECT MIN(run_at) AS at FROM _scheduled WHERE state = 'pending'"))
      .then((next) => {
        if (this.stopped) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (next?.at === null || next?.at === undefined) return;
        const delay = Math.min(Math.max(0, Number(next.at) - Date.now()), 2 ** 31 - 1);
        this.timer = setTimeout(() => void this.runDue(), delay);
      })
      .catch((err) => this.logError(err));
  }

  /** Before a shutdown: starts no more jobs. The ones already running finish on their own (see `running`). */
  drain() {
    this.draining = true;
    if (this.timer) clearTimeout(this.timer);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
  }

  private logError(err: unknown) {
    this.runtime.log.error(`Scheduler: ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * On a shared database a job belongs to the instance that claimed it, and that instance may be
   * gone. So a claim is a lease: the instance running a job renews it on every heartbeat, and a
   * job whose lease ran out goes back in the queue for any instance to take.
   *
   * The lease is kept in the job's `error` column while it runs (nothing else uses it then), which
   * needs no change to the table: instances of an older onebase leave it empty, and their jobs
   * are never taken from them.
   */
  private async renewLeases() {
    if (this.stopped) return;
    const now = Date.now();
    try {
      const reclaimed = await this.runtime.withWriter(async (tx) => {
        for (const id of this.runningIds) await tx.run("UPDATE _scheduled SET error = ? WHERE id = ? AND state = 'running'", [leaseMark(now), id]);
        const { changes } = await tx.run(
          "UPDATE _scheduled SET state = 'pending', error = NULL WHERE state = 'running' AND error LIKE 'lease:%' AND error < ?",
          [leaseMark(now - Scheduler.jobLeaseMs)],
        );
        return changes;
      });
      if (reclaimed) this.runtime.log.warn(`${reclaimed} scheduled job(s) were left running by an instance that went away. They will run again.`);
    } catch (err) {
      this.logError(err);
    }
  }

  /**
   * Jobs left `running` by a process that died mid-job (a crash, SIGKILL, a lost machine) go back
   * to pending and run again (docs/scheduling.md): a migration's or workflow's next step continues
   * on its own. A mutation job never committed (it's marked done in its own transaction), so it
   * still runs exactly once; an action may run a second time, as documented.
   *
   * With a database only this process uses, every running job at startup is such a leftover. With
   * a shared one, a job with a lease is left to renewLeases(). One without (claimed by an older
   * onebase) counts as abandoned once it was claimed (run_at is set to the claim time) longer ago
   * than its time limit allows, plus a minute.
   */
  async recoverInterrupted(now = Date.now()) {
    if (this.stopped) return;
    const { runtime } = this;
    const shared = runtime.driver.shared;
    const limitOf = (ms: number) => (ms > 0 ? ms : 60 * 60_000) + 60_000;
    const cutoff = (type: string | undefined) => (!shared ? Infinity : now - limitOf(type === "mutation" ? runtime.timeLimits.mutationMs : runtime.timeLimits.actionMs));
    try {
      const recovered = await runtime.withWriter(async (tx) => {
        const jobs = (await tx.all("SELECT id, fn, run_at, error FROM _scheduled WHERE state = 'running'")) as { id: string; fn: string; run_at: number; error: string | null }[];
        let n = 0;
        for (const job of jobs) {
          // On a shared database a leased job is alive while its lease is renewed: renewLeases decides.
          if (shared && String(job.error ?? "").startsWith("lease:")) continue;
          const type = runtime.functions.get(job.fn)?.type;
          if (Number(job.run_at) >= cutoff(type)) continue;
          n += (await tx.run("UPDATE _scheduled SET state = 'pending', run_at = ?, error = NULL WHERE id = ? AND state = 'running'", [now, job.id])).changes;
        }
        return n;
      });
      if (recovered) runtime.log.info(`Scheduler: recovered ${recovered} job(s) interrupted by a stopped server.`);
    } catch (err) {
      this.logError(err);
    }
  }

  private async runDue() {
    // Every slot is taken: a finishing job pokes the scheduler again.
    const free = MAX_RUNNING_JOBS - this.runningIds.size;
    if (free <= 0 || this.draining) return;
    const shared = this.runtime.driver.shared;
    // Claim each job with a conditional update so that no two runs (or instances) take the same one.
    const due = await this.runtime
      .withWriter(async (tx) => {
        const jobs = (await tx.all("SELECT id, fn, args FROM _scheduled WHERE state = 'pending' AND run_at <= ? ORDER BY run_at LIMIT ?", [Date.now(), free])) as Job[];
        const claimed = [];
        for (const job of jobs) {
          // run_at becomes the claim time (recoverInterrupted); on a shared database the claim is also a lease (renewLeases).
          const now = Date.now();
          const { changes } = await tx.run("UPDATE _scheduled SET state = 'running', run_at = ?, error = ? WHERE id = ? AND state = 'pending'", [now, shared ? leaseMark(now) : null, job.id]);
          if (changes === 1) claimed.push(job);
        }
        return claimed;
      })
      .catch((err) => {
        this.logError(err);
        return [] as Job[];
      });
    // Jobs run on their own, so a slow or stuck one never holds up the jobs due after it.
    for (const job of due) {
      this.runningIds.add(job.id);
      void this.runJob(job).finally(() => {
        this.runningIds.delete(job.id);
        this.poke();
      });
    }
    this.poke();
  }

  private async runJob(job: Job) {
    const { runtime } = this;
    const setState = (tx: Exec, state: string, error: string | null = null) => tx.run("UPDATE _scheduled SET state = ?, error = ? WHERE id = ?", [state, error, job.id]);
    try {
      const args = JSON.parse(job.args);
      const fn = runtime.functions.get(job.fn);
      if (fn?.type === "mutation") {
        // Exactly once: the job is marked done in the mutation's own transaction.
        await runtime.runMutation(job.fn, args, { allowInternal: true, source: "scheduler", settle: "none", inTransaction: (tx) => setState(tx, "done") });
      } else {
        await runtime.call(job.fn, args, { allowInternal: true, source: "scheduler" });
        await runtime.withWriter((tx) => setState(tx, "done"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtime.log.error(`Scheduled ${job.fn} failed: ${message}`);
      await runtime.withWriter((tx) => setState(tx, "failed", message)).catch(() => {});
    }
  }
}
