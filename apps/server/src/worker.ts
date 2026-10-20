import { reflectOnRun } from '@supops/core';
import { db, engine, llm, settingsStore } from './context.ts';

/**
 * The scheduler.
 *
 * Concurrency defaults to 1 and that is not timidity: a free-tier key has a real
 * requests-per-minute ceiling and a self-hosted model can usually serve one
 * conversation at a time. Running four agents in parallel against either one
 * produces a burst of 429s, which the engine then durably backs off from -- so the
 * work takes longer than if it had been serialised in the first place.
 */
export class Worker {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    // Anything left `running` by a previous process died mid-flight. Sweep it back
    // to `queued`, and mark any dispatched-but-unrecorded tool call as an unknown
    // outcome so it is never silently re-executed.
    const recovered = engine.store.recoverStaleRuns();
    if (recovered.runs || recovered.toolCalls) {
      console.log(
        `  recovered ${recovered.runs} interrupted run(s), ` +
          `${recovered.toolCalls} tool call(s) with unknown outcomes`,
      );
    }
    this.timer = setInterval(() => void this.poll(), 1000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Kick the scheduler immediately rather than waiting for the next tick. */
  nudge(): void {
    void this.poll();
  }

  private lastExpirySweep = 0;

  private async poll(): Promise<void> {
    // Approvals nobody answered within the policy's time-to-live. Checked every 15s:
    // the TTLs are minutes to hours, so there is no need to scan every tick.
    if (Date.now() - this.lastExpirySweep > 15_000) {
      this.lastExpirySweep = Date.now();
      for (const e of engine.store.expireStaleApprovals()) {
        engine.store.appendEvent(e.runId, {
          type: 'approval_expired',
          toolCallId: e.toolCallId,
          ...(e.aborted ? { aborted: true } : {}),
        });
      }
    }

    const free = settingsStore.concurrency() - this.running.size;
    if (free <= 0) return;

    for (const run of engine.store.claimable(free)) {
      if (this.running.has(run.id)) continue;
      this.running.add(run.id);
      void engine
        .runToCompletion(run.id)
        .then(() => this.reflect(run.id))
        .catch((err) => console.error(`run ${run.id} crashed:`, err))
        .finally(() => this.running.delete(run.id));
    }
  }

  /** After a run ends: what did it teach? A model proposes, the lesson gate decides. Never fails the run. */
  private async reflect(runId: string): Promise<void> {
    const cfg = settingsStore.learning();
    if (cfg.reflect === 'off') return;
    try {
      await reflectOnRun(db, llm, runId, { mode: cfg.reflect, minActions: cfg.reflectMinActions });
    } catch (err) {
      console.warn(`learning: could not reflect on run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

export const worker = new Worker();
