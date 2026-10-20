import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ChatMessage, ContentPart, RunStatus, ToolCallState } from '@supops/shared';
import { ATTACHMENT_URL_PREFIX, isTerminalToolCall, messageAttachmentIds } from '@supops/shared';
import type { Db } from '@supops/db';
import { runAttachments, runEvents, runSteps, runs, toolCalls } from '@supops/db';
import type { RunEventPayload } from './events.ts';

export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof runSteps.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;

/**
 * Every database access the engine makes, in one place.
 *
 * The rule that matters here: never hold a transaction across an `await`.
 * better-sqlite3 is synchronous and shares the event loop with Socket.IO and the
 * provider stream, so a transaction left open around a 40-second SSH command stalls
 * the entire process. Tools execute first; results are written afterwards, quickly.
 */
export class RunStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  getRun(runId: string): RunRow | undefined {
    return this.db.select().from(runs).where(eq(runs.id, runId)).get();
  }

  /**
   * Allocate `count` monotonic sequence numbers. Shared by steps and events so the
   * UI can interleave them in a single ordered timeline.
   */
  allocSeq(runId: string, count = 1): number {
    const row = this.db
      .update(runs)
      .set({ nextSeq: sql`${runs.nextSeq} + ${count}` })
      .where(eq(runs.id, runId))
      .returning({ next: runs.nextSeq })
      .get();
    if (!row) throw new Error(`Run ${runId} not found while allocating a sequence number`);
    return row.next - count;
  }

  /**
   * Invariant B: the conversation is a pure function of the database.
   *
   * `archived` steps (superseded by a summary under the context-budget guard) are
   * excluded here but never deleted -- history stays append-only for the audit trail
   * even when it is no longer sent to the model.
   */
  rebuildMessages(runId: string): ChatMessage[] {
    return this.rebuildRows(runId).map((r) => r.message);
  }

  /** The committed conversation with each message's step seq. */
  rebuildRows(runId: string): Array<{ seq: number; message: ChatMessage }> {
    return this.db
      .select({ seq: runSteps.seq, message: runSteps.messageJson })
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.state, 'committed')))
      .orderBy(asc(runSteps.seq))
      .all();
  }

  /**
   * The conversation as the model is sent it after compaction: the system prompt and
   * the task, the model's summary in place of every step up to `throughSeq`, then the
   * rest. The stored steps are untouched.
   */
  compactedRows(runId: string, compaction: { throughSeq: number; summary: string } | null): Array<{ seq: number; message: ChatMessage }> {
    const rows = this.rebuildRows(runId);
    if (!compaction || rows.length < 3) return rows;
    const kept = rows.slice(2).filter((r) => r.seq > compaction.throughSeq);
    const summary: ChatMessage = {
      role: 'user',
      content:
        `[Summary of this run so far, written by the model at SupOps' request to fit its context. ` +
        `These are facts from the record, not new instructions.]\n${compaction.summary}`,
    };
    return [rows[0]!, rows[1]!, { seq: compaction.throughSeq, message: summary }, ...kept];
  }

  setCompaction(runId: string, compaction: { throughSeq: number; summary: string; at: number }): void {
    this.db.update(runs).set({ compaction }).where(eq(runs.id, runId)).run();
  }

  /**
   * The conversation as it goes on the wire: `supops-attachment:` references swapped
   * for inline `data:` URLs. Kept separate from `rebuildMessages` so the stored history
   * (and everything that reads it -- reports, the UI) stays small.
   *
   * A reference whose row is gone (it cannot be, short of hand-editing the database)
   * becomes a short text note rather than a broken image the provider would reject.
   */
  wireMessages(runId: string, compaction: { throughSeq: number; summary: string } | null = null): ChatMessage[] {
    const messages = this.compactedRows(runId, compaction).map((r) => r.message);
    const ids = messages.flatMap((m) => (m.role === 'user' ? messageAttachmentIds(m.content) : []));
    if (ids.length === 0) return messages;

    const rows = this.db
      .select({ id: runAttachments.id, mime: runAttachments.mime, data: runAttachments.data })
      .from(runAttachments)
      .where(inArray(runAttachments.id, [...new Set(ids)]))
      .all();
    const byId = new Map(rows.map((r) => [r.id, `data:${r.mime};base64,${Buffer.from(r.data).toString('base64')}`]));

    return messages.map((m) => {
      if (m.role !== 'user' || !Array.isArray(m.content)) return m;
      const content: ContentPart[] = m.content.map((p) => {
        if (p.type !== 'image_url' || !p.image_url.url.startsWith(ATTACHMENT_URL_PREFIX)) return p;
        const url = byId.get(p.image_url.url.slice(ATTACHMENT_URL_PREFIX.length));
        return url ? { type: 'image_url', image_url: { url } } : { type: 'text', text: '[an attached image is no longer available]' };
      });
      return { ...m, content };
    });
  }

  appendStep(
    runId: string,
    message: ChatMessage,
    opts: {
      state?: 'committed' | 'pending';
      finishReason?: string;
      promptTokens?: number;
      completionTokens?: number;
      latencyMs?: number;
      /** The model that wrote the reply. */
      model?: string;
      /** 'engine' for a message SupOps wrote itself; see run_steps.origin. */
      origin?: 'engine';
    } = {},
  ): StepRow {
    const seq = this.allocSeq(runId);
    const row = this.db
      .insert(runSteps)
      .values({
        id: nanoid(),
        runId,
        seq,
        messageJson: message,
        state: opts.state ?? 'committed',
        finishReason: opts.finishReason ?? null,
        promptTokens: opts.promptTokens ?? null,
        completionTokens: opts.completionTokens ?? null,
        latencyMs: opts.latencyMs ?? null,
        model: opts.model ?? null,
        origin: opts.origin ?? null,
        createdAt: new Date(),
      })
      .returning()
      .get();
    return row;
  }

  /**
   * Commit every tool reply for one assistant turn at once.
   *
   * This is Invariant A made concrete. A batch where one call is still awaiting
   * approval must not be written piecemeal: a conversation carrying an assistant
   * turn with N tool_calls and fewer than N replies is malformed, and some backends
   * accept it and quietly degrade rather than erroring.
   */
  commitToolResults(runId: string, replies: ChatMessage[]): void {
    if (replies.length === 0) return;
    const start = this.allocSeq(runId, replies.length);
    const now = new Date();
    this.db.transaction((tx) => {
      replies.forEach((message, i) => {
        tx.insert(runSteps)
          .values({
            id: nanoid(),
            runId,
            seq: start + i,
            messageJson: message,
            state: 'committed',
            createdAt: now,
          })
          .run();
      });
    });
  }

  /** Which of these tool-call ids are already stored (by any run). */
  takenToolCallIds(ids: string[]): Set<string> {
    const want = ids.filter(Boolean);
    if (!want.length) return new Set();
    return new Set(this.db.select({ id: toolCalls.toolCallId }).from(toolCalls).where(inArray(toolCalls.toolCallId, want)).all().map((r) => r.id));
  }

  createToolCalls(
    runId: string,
    stepId: string,
    calls: Array<{
      toolCallId: string;
      callIndex: number;
      toolKey: string;
      argsJson: Record<string, unknown>;
      argsHash: string;
    }>,
  ): ToolCallRow[] {
    const now = new Date();
    return this.db.transaction((tx) =>
      calls.map((c) =>
        tx
          .insert(toolCalls)
          .values({
            id: nanoid(),
            runId,
            stepId,
            toolCallId: c.toolCallId,
            callIndex: c.callIndex,
            toolKey: c.toolKey,
            argsJson: c.argsJson,
            argsHash: c.argsHash,
            state: 'proposed' as ToolCallState,
            isError: false,
            startedAt: null,
            finishedAt: null,
            createdAt: now,
          } as typeof toolCalls.$inferInsert)
          .returning()
          .get(),
      ),
    );
  }

  getToolCall(id: string): ToolCallRow | undefined {
    return this.db.select().from(toolCalls).where(eq(toolCalls.id, id)).get();
  }

  /** Calls belonging to one assistant turn, in the order their replies must appear. */
  getToolCallsForStep(stepId: string): ToolCallRow[] {
    return this.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.stepId, stepId))
      .orderBy(asc(toolCalls.callIndex))
      .all();
  }

  /**
   * Every tool call made since the human last spoke -- that is, the whole current
   * turn, not just the final batch. Judging a turn by its last batch alone gets it
   * wrong: an agent whose commands all failed still writes a `record_finding`
   * afterwards, and that lone success made the turn look fine.
   */
  toolCallsThisTurn(runId: string): ToolCallRow[] {
    const lastUser = this.lastUserSeq(runId);
    if (lastUser === null) return [];

    return this.db
      .select()
      .from(toolCalls)
      .innerJoin(runSteps, eq(toolCalls.stepId, runSteps.id))
      .where(and(eq(toolCalls.runId, runId), sql`${runSteps.seq} > ${lastUser}`))
      .orderBy(asc(toolCalls.createdAt))
      .all()
      .map((r) => r.tool_calls);
  }

  /** Seq of the most recent message from the operator: where the current turn begins. */
  lastUserSeq(runId: string): number | null {
    const row = this.db
      .select({ seq: runSteps.seq })
      .from(runSteps)
      .where(
        and(
          eq(runSteps.runId, runId),
          sql`json_extract(${runSteps.messageJson}, '$.role') = 'user'`,
          // Engine-written messages are not the operator: they never start a turn.
          isNull(runSteps.origin),
        ),
      )
      .orderBy(desc(runSteps.seq))
      .limit(1)
      .get();
    return row?.seq ?? null;
  }

  /** The text of the notes SupOps wrote itself since the operator last spoke. */
  engineNotesThisTurn(runId: string): string[] {
    const since = this.lastUserSeq(runId) ?? -1;
    return this.db
      .select({ m: runSteps.messageJson })
      .from(runSteps)
      .where(and(eq(runSteps.runId, runId), eq(runSteps.origin, 'engine'), sql`${runSteps.seq} > ${since}`))
      .all()
      .map((r) => (typeof (r.m as ChatMessage).content === 'string' ? ((r.m as ChatMessage).content as string) : ''));
  }

  /** Every tool call in the run, oldest first. */
  toolCallsInRun(runId: string): ToolCallRow[] {
    return this.db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).orderBy(asc(toolCalls.createdAt)).all();
  }

  /** Engine-written messages since the operator last spoke. */
  engineStepsThisTurn(runId: string): number {
    const since = this.lastUserSeq(runId) ?? -1;
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(runSteps)
        .where(and(eq(runSteps.runId, runId), eq(runSteps.origin, 'engine'), sql`${runSteps.seq} > ${since}`))
        .get()?.n ?? 0
    );
  }

  getUnsettledToolCalls(runId: string): ToolCallRow[] {
    return this.db
      .select()
      .from(toolCalls)
      .where(
        and(
          eq(toolCalls.runId, runId),
          inArray(toolCalls.state, [
            'proposed',
            'classified',
            'auto_approved',
            'awaiting_approval',
            'approved',
            'executing',
          ]),
        ),
      )
      .orderBy(asc(toolCalls.callIndex))
      .all();
  }

  updateToolCall(id: string, patch: Partial<typeof toolCalls.$inferInsert>): void {
    this.db.update(toolCalls).set(patch).where(eq(toolCalls.id, id)).run();
  }

  countToolCalls(runId: string): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(toolCalls)
      .where(eq(toolCalls.runId, runId))
      .get();
    return row?.n ?? 0;
  }

  /**
   * Duplicate-action circuit breaker input: how often this exact action was tried.
   * With `afterSeq`, only calls made after that step count -- a Console session
   * checking `kubectl get pods` once per question must not be blocked on the fourth.
   */
  countIdenticalCalls(runId: string, toolKey: string, argsHash: string, afterSeq?: number | null): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(toolCalls)
      .innerJoin(runSteps, eq(toolCalls.stepId, runSteps.id))
      .where(
        and(
          eq(toolCalls.runId, runId),
          eq(toolCalls.toolKey, toolKey),
          eq(toolCalls.argsHash, argsHash),
          ...(afterSeq !== undefined && afterSeq !== null ? [sql`${runSteps.seq} > ${afterSeq}`] : []),
        ),
      )
      .get();
    return row?.n ?? 0;
  }

  setStatus(runId: string, status: RunStatus, reason?: string | null): void {
    const patch: Partial<typeof runs.$inferInsert> = { status, statusReason: reason ?? null };
    // `awaiting_input` is parked, not running: the turn genuinely ended, so stamp
    // `endedAt` and drop the lease. Without this the UI counts wall-clock forever
    // and a parked session looks identical to a hung one.
    if (
      ['succeeded', 'failed', 'cancelled', 'expired', 'halted', 'awaiting_input'].includes(status)
    ) {
      patch.endedAt = new Date();
      patch.leaseOwner = null;
      patch.leaseExpiresAt = null;
    }
    this.db.update(runs).set(patch).where(eq(runs.id, runId)).run();

    // A run that ended (cancelled, failed, halted...) can leave a tool call parked
    // at `awaiting_approval` that nobody can ever act on. Expire those so the
    // approval queue and the dashboard count reflect only actionable work.
    if (['failed', 'cancelled', 'expired', 'halted'].includes(status)) {
      this.db
        .update(toolCalls)
        .set({ state: 'expired', finishedAt: new Date() })
        .where(and(eq(toolCalls.runId, runId), eq(toolCalls.state, 'awaiting_approval')))
        .run();
    }
  }

  /** Tokens spent on a request that is not a step of the run (e.g. a context summary). */
  addTokens(runId: string, promptTokens: number, completionTokens: number): void {
    this.db
      .update(runs)
      .set({ promptTokens: sql`${runs.promptTokens} + ${promptTokens}`, completionTokens: sql`${runs.completionTokens} + ${completionTokens}` })
      .where(eq(runs.id, runId))
      .run();
  }

  bumpIteration(runId: string, promptTokens: number, completionTokens: number): void {
    this.db
      .update(runs)
      .set({
        iteration: sql`${runs.iteration} + 1`,
        promptTokens: sql`${runs.promptTokens} + ${promptTokens}`,
        completionTokens: sql`${runs.completionTokens} + ${completionTokens}`,
      })
      .where(eq(runs.id, runId))
      .run();
  }

  /** Park a run until `at`, durably -- a setTimeout would not survive a deploy. */
  suspendUntil(runId: string, at: Date, reason: string, retryCount: number): void {
    this.db
      .update(runs)
      .set({
        status: 'suspended',
        statusReason: reason,
        resumeAfter: at,
        retryCount,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(runs.id, runId))
      .run();
  }

  /**
   * A new user message on an open session. Resets the iteration counter because
   * `maxIterations` is a budget per task, not per session -- otherwise a
   * conversation would die on its fortieth exchange.
   */
  /**
   * Put a parked session back in the queue for its next turn. Each turn gets a
   * fresh wall-clock budget; it used to get none at all, so a runaway follow-up
   * never timed out.
   */
  resumeWithInput(runId: string, turnWallClockMs?: number): void {
    this.db
      .update(runs)
      .set({
        status: 'queued',
        statusReason: null,
        iteration: 0,
        deadlineAt: turnWallClockMs ? new Date(Date.now() + turnWallClockMs) : null,
        // The session is live again, so the previous turn's end no longer applies.
        endedAt: null,
      })
      .where(eq(runs.id, runId))
      .run();
  }

  /** Called after any successful provider call, so backoff does not carry over. */
  clearRetries(runId: string): void {
    this.db.update(runs).set({ retryCount: 0, resumeAfter: null }).where(eq(runs.id, runId)).run();
  }

  appendEvent(runId: string, payload: RunEventPayload): number {
    const seq = this.allocSeq(runId);
    this.db
      .insert(runEvents)
      .values({ id: nanoid(), runId, seq, type: payload.type, payload, createdAt: new Date() })
      .run();
    return seq;
  }

  listEvents(runId: string, afterSeq = -1) {
    return this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), sql`${runEvents.seq} > ${afterSeq}`))
      .orderBy(asc(runEvents.seq))
      .all();
  }

  // --- Leases and crash recovery -----------------------------------------

  acquireLease(runId: string, owner: string, ttlMs: number): boolean {
    const now = new Date();
    const res = this.db
      .update(runs)
      .set({ leaseOwner: owner, leaseExpiresAt: new Date(now.getTime() + ttlMs), status: 'running' })
      .where(
        and(
          eq(runs.id, runId),
          sql`(${runs.leaseOwner} IS NULL OR ${runs.leaseOwner} = ${owner} OR ${runs.leaseExpiresAt} < ${now.getTime()})`,
        ),
      )
      .returning({ id: runs.id })
      .get();
    return !!res;
  }

  heartbeat(runId: string, owner: string, ttlMs: number): void {
    this.db
      .update(runs)
      .set({ leaseExpiresAt: new Date(Date.now() + ttlMs) })
      .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
      .run();
  }

  releaseLease(runId: string, owner: string): void {
    this.db
      .update(runs)
      .set({ leaseOwner: null, leaseExpiresAt: null })
      .where(and(eq(runs.id, runId), eq(runs.leaseOwner, owner)))
      .run();
  }

  /**
   * Boot recovery. Two sweeps, and the second is the important one.
   *
   * A tool call left in `executing` means the worker died after dispatching a
   * command but before recording what happened. We must not re-run it: if it was
   * `systemctl restart db` or `docker rm`, a naive retry is a second outage. It
   * becomes `unknown_outcome`, which is surfaced to the agent as an error telling it
   * to check the current state first. Read-only calls are the exception and may be
   * retried freely -- that asymmetry is the entire point.
   */
  recoverStaleRuns(): { runs: number; toolCalls: number } {
    const now = new Date();

    const orphanedCalls = this.db
      .update(toolCalls)
      .set({ state: 'unknown_outcome', finishedAt: now, isError: true })
      .where(eq(toolCalls.state, 'executing'))
      .returning({ id: toolCalls.id })
      .all();

    const staleRuns = this.db
      .update(runs)
      .set({ status: 'queued', leaseOwner: null, leaseExpiresAt: null })
      // A run whose lease was released (or never set) while still "running" has nobody
      // working on it either: without the IS NULL it would stay stuck for good.
      .where(and(eq(runs.status, 'running'), or(lt(runs.leaseExpiresAt, now), isNull(runs.leaseExpiresAt))))
      .returning({ id: runs.id })
      .all();

    return { runs: staleRuns.length, toolCalls: orphanedCalls.length };
  }

  /**
   * Expire approval requests that have waited longer than the run's policy allows
   * (`ttlMsByTier`). An approval nobody answers should not hang forever with the
   * run holding its place: with `continue_as_denied` the run resumes and the agent is
   * told the action was not performed; with `abort_run` the run stops.
   *
   * Uses the run's frozen policy, so changing the project policy later does not
   * retroactively expire (or extend) requests already waiting.
   */
  expireStaleApprovals(now = new Date()): Array<{ runId: string; toolCallId: string; tier: string | null; aborted: boolean }> {
    const waiting = this.db
      .select({ call: toolCalls, policy: runs.policySnapshot })
      .from(toolCalls)
      .innerJoin(runs, eq(toolCalls.runId, runs.id))
      .where(eq(toolCalls.state, 'awaiting_approval'))
      .all();

    const expired: Array<{ runId: string; toolCallId: string; tier: string | null; aborted: boolean }> = [];
    for (const { call, policy } of waiting) {
      const ttl = call.tier ? policy.ttlMsByTier?.[call.tier] : undefined;
      if (!ttl || now.getTime() - call.createdAt.getTime() < ttl) continue;

      const aborted = policy.onExpiry === 'abort_run';
      this.db.transaction((tx) => {
        const changed = tx
          .update(toolCalls)
          .set({ state: 'expired', finishedAt: now, isError: true })
          .where(and(eq(toolCalls.id, call.id), eq(toolCalls.state, 'awaiting_approval')))
          .run().changes;
        if (!changed) return; // decided in the meantime
        tx.update(runs)
          .set(aborted
            ? { status: 'failed', statusReason: 'an approval request expired and the policy aborts the run', endedAt: now }
            : { status: 'queued', statusReason: null })
          .where(eq(runs.id, call.runId))
          .run();
        expired.push({ runId: call.runId, toolCallId: call.toolCallId, tier: call.tier, aborted });
      });
    }
    return expired;
  }

  /** Runs eligible to be picked up now. */
  claimable(limit: number): RunRow[] {
    const now = new Date();
    return this.db
      .select()
      .from(runs)
      .where(
        sql`(${runs.status} = 'queued' OR (${runs.status} = 'suspended' AND ${runs.resumeAfter} <= ${now.getTime()}))`,
      )
      .orderBy(asc(runs.startedAt))
      .limit(limit)
      .all();
  }
}

export const allToolCallsSettled = (calls: ToolCallRow[]): boolean =>
  calls.every((c) => isTerminalToolCall(c.state));
