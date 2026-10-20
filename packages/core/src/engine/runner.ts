import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { ChatMessage, RiskAssessment, ToolCallRequest, ToolMessage } from '@supops/shared';
import { isTerminalRun, isTerminalToolCall, tierAtMost, tierRank } from '@supops/shared';
import type { Db, RunBudget } from '@supops/db';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_SESSION_TOOL_CALLS, agents, knowledgeDocs, learnedRules as learnedRulesTable, projects, runKnowledge, toolCalls as toolCallsTable, toolOutputs as toolOutputsTable, trustedCommands, users, runSteps } from '@supops/db';
import type { LLMClient } from '../llm/client.ts';
import { backoffMs } from '../llm/client.ts';
import { FatalLLMError, RetryableLLMError } from '../llm/errors.ts';
import type { KnowledgeAccess, OutputAccess, ResolvedTarget, ResolvedTool, ToolDef } from '../tools/types.ts';
import { KNOWLEDGE_TOOL_KEYS, OBSERVABILITY_TOOL_KEYS, SESSION_TOOL_KEYS } from '../tools/builtin.ts';
import { FULL_OUTPUT_BYTES, readOutputTool } from '../tools/read-output.ts';
import { planFromArgs, planTool, renderPlan, type PlanStep } from '../tools/plan.ts';
import { truncateOutput } from '../tools/output.ts';
import { readRunKnowledge, searchRunKnowledge, type RunScope } from '../knowledge/retrieve.ts';
import { bindTools, effectiveToolKeys, type ToolRegistry } from '../tools/registry.ts';
import { assessRisk, matchesRule, trustEnvOf, trustText, withObservations } from '../risk/index.ts';
import { simulate } from '../sim/index.ts';
import type { EventSink, OutputSink } from './events.ts';
import { nullOutputSink } from './events.ts';
import { executeToolCall, ToolExecutionRefused } from './execute.ts';
import { COMPACT_AT, COMPACTION_PROMPT, compactionCut, DEFAULT_CONTEXT_TOKENS, elideOldOutputs, estimateTokens, fitToContext, transcriptFor } from './context.ts';
import { signatureOf } from '../learning/signature.ts';
import { harvest } from '../learning/harvest.ts';
import { preflightWarning, stuckNote, verifyNote } from './self-check.ts';
import { hashArgs, targetFingerprint } from './canonical.ts';
import { loadTargets } from './targets.ts';
import { isNetworkTarget, netCheckTool, NETWORK_TARGET } from '../tools/net-check.ts';
import { RunStore, type RunRow, type ToolCallRow } from './store.ts';

const LEASE_TTL_MS = 60_000;
/** Three identical attempts is a wedged agent, not persistence. */
const DUPLICATE_LIMIT = 3;
/** Automatic "continue" prompts after a reply was cut off, per turn. */
const MAX_CONTINUATIONS = 2;
/**
 * Give up after this many consecutive provider failures. A free-tier daily quota can
 * take hours to reset, and a run that silently retries forever is indistinguishable
 * from one that is hung -- better to fail with a message that names the cause.
 */
const MAX_PROVIDER_RETRIES = 8;

/** Read-only calls in one model turn that may run at the same time. */
const PARALLEL_READS = 4;
/** A shadow simulation older than this is re-checked before a human-approved change runs. */
const RESIM_STALE_MS = 10 * 60_000;
/** The self-check nudges (verify / stuck / pre-flight) can be switched off for weak models. */
const selfCheckOn = () => process.env.SUPOPS_SELFCHECK !== 'off';

/**
 * The fail-closed sandbox gate. When on, a non-read-only action that a sandbox could
 * NOT actually verify is blocked rather than left to run on real infrastructure after a
 * (possibly mistaken) approval -- the point being that a malicious payload's real impact
 * is absorbed in the sandbox, not on the box.
 *
 * - `off`     (default): raise-only, fail-open. The sandbox only escalates what it catches.
 * - `scripts`: block an unverified run_script (always detonatable when a detonator is up).
 * - `prod`:    block any unverified non-read-only action on a production target.
 * - `all`:     block any unverified non-read-only action.
 *
 * NOTE: `all` without a sandbox backend that can observe arbitrary commands (the target
 * shadow) blocks most changes, because most commands have no native dry-run. That is the
 * safe-but-strict trade; `scripts`/`prod` are the usable middle ground until the shadow
 * (or detonator) is running.
 */
type SandboxGate = 'off' | 'scripts' | 'prod' | 'all';
const sandboxGate = (): SandboxGate => {
  const v = process.env.SUPOPS_SANDBOX_GATE;
  return v === 'scripts' || v === 'prod' || v === 'all' ? v : 'off';
};
const PROD_ENVS = new Set(['production', 'prod', 'live']);

export interface EngineOptions {
  db: Db;
  llm: LLMClient;
  registry: ToolRegistry;
  sink: EventSink;
  /** Optional live command output. Omitted, execution is unchanged. */
  output?: OutputSink;
  workerId: string;
  /** Shadow-execution simulator. Defaults to the real one; tests inject a fake. */
  simulate?: typeof simulate;
}

export class Engine {
  readonly store: RunStore;
  private db: Db;
  private llm: LLMClient;
  private registry: ToolRegistry;
  private sink: EventSink;
  private output: OutputSink;
  private workerId: string;
  private simulate: typeof simulate;
  private aborts = new Map<string, AbortController>();

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.store = new RunStore(opts.db);
    this.llm = opts.llm;
    this.registry = opts.registry;
    this.sink = opts.sink;
    this.output = opts.output ?? nullOutputSink;
    this.workerId = opts.workerId;
    this.simulate = opts.simulate ?? simulate;
  }

  /** Cooperative cancellation for an in-flight tool call. */
  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    this.store.setStatus(runId, 'cancelled', 'cancelled by an operator');
    this.event(runId, { type: 'status', status: 'cancelled', reason: 'cancelled by an operator' });
  }

  /**
   * Drive a run until it can make no further progress without waiting for
   * something -- a human decision, a backoff timer, or the end of the task.
   *
   * The loop is written so that every iteration starts by re-reading state from the
   * database. That is what makes a crash survivable: there is no progress held in a
   * local variable that a restart would lose.
   */
  async runToCompletion(runId: string): Promise<void> {
    if (!this.store.acquireLease(runId, this.workerId, LEASE_TTL_MS)) return;

    const abort = new AbortController();
    this.aborts.set(runId, abort);
    const heartbeat = setInterval(
      () => this.store.heartbeat(runId, this.workerId, LEASE_TTL_MS),
      LEASE_TTL_MS / 4,
    );

    try {
      for (;;) {
        const progressed = await this.tick(runId, abort.signal);
        if (!progressed) break;
      }
    } catch (err) {
      // A bug, not the model or a tool (those are handled where they happen). Fail the
      // run with the reason rather than leave it "running" with nobody working on it.
      const run = this.store.getRun(runId);
      if (run && !isTerminalRun(run.status)) this.fail(runId, `SupOps hit an internal error and stopped this run: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      clearInterval(heartbeat);
      this.aborts.delete(runId);
      this.store.releaseLease(runId, this.workerId);
    }
  }

  /** One unit of progress. Returns false when the run is waiting or finished. */
  private async tick(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running') return false;

    const ctx = this.loadContext(run);
    if (!ctx) {
      this.fail(runId, 'the run references an agent or project that no longer exists');
      return false;
    }

    if (ctx.killSwitch) {
      this.store.setStatus(runId, 'halted', 'the project kill switch is active');
      this.event(runId, { type: 'status', status: 'halted', reason: 'kill switch active' });
      return false;
    }
    if (this.overBudget(run, ctx.budget)) return false;

    // --- Phase A: settle any tool calls left outstanding -------------------
    const open = this.store.getUnsettledToolCalls(runId);
    if (open.length > 0) {
      // Calls are taken in the model's order. Consecutive read-only calls that need
      // no approval run together; anything else runs alone, after everything before
      // it has finished, so a change is never raced against the checks around it.
      let batch: ToolCallRow[] = [];
      const flush = async () => {
        for (let i = 0; i < batch.length; i += PARALLEL_READS) {
          await Promise.all(batch.slice(i, i + PARALLEL_READS).map((c) => this.settleCall(run, ctx, c, signal)));
        }
        batch = [];
      };
      for (const call of open) {
        if (signal.aborted) return false;
        if (call.state === 'proposed' && !(await this.classify(run, ctx, call, signal))) continue;
        const current = this.store.getToolCall(call.id);
        if (current && this.readsOnly(current)) {
          batch.push(current);
          continue;
        }
        await flush();
        if (current) await this.settleCall(run, ctx, current, signal);
      }
      await flush();
      if (signal.aborted) return false;

      const after = this.store.getUnsettledToolCalls(runId);
      if (after.some((c) => c.state === 'awaiting_approval')) {
        this.store.setStatus(runId, 'awaiting_approval', 'waiting for a human decision');
        this.event(runId, {
          type: 'status',
          status: 'awaiting_approval',
          reason: 'waiting for a human decision',
        });
        return false;
      }
      if (after.length > 0) return true; // still working; come back round
    }

    // --- Phase B: close any complete-but-unreplied batch -------------------
    if (this.commitOpenBatch(runId)) return true;

    // --- Phase C: ask the model what to do next ---------------------------
    return await this.step(run, ctx, signal);
  }

  // ------------------------------------------------------------------
  // Phase C -- one model turn
  // ------------------------------------------------------------------

  private async step(run: RunRow, ctx: RunContext, signal: AbortSignal): Promise<boolean> {
    // Old command output is elided on the wire once the conversation outgrows the
    // budget; past that, the model summarises the older turns once (compact), and the
    // mechanical recap in fitToContext is the last resort. The stored history is untouched.
    const budget = ctx.budget.contextTokens ?? DEFAULT_CONTEXT_TOKENS;
    // Going round in circles (the same action again, or failure after failure): say so
    // before the next model call, once per pattern.
    const stuck = selfCheckOn() ? stuckNote(this.store.toolCallsThisTurn(run.id), this.store.engineNotesThisTurn(run.id)) : null;
    if (stuck) this.store.appendStep(run.id, { role: 'user', content: stuck }, { origin: 'engine' });
    let compaction = run.compaction ?? null;
    let wire = this.store.wireMessages(run.id, compaction);
    if (elideOldOutputs(wire, budget).total > budget * COMPACT_AT) {
      const next = await this.compact(run, compaction, budget);
      if (next) {
        compaction = next;
        wire = this.store.wireMessages(run.id, compaction);
      }
    }
    const { messages } = fitToContext(wire, budget);

    // A run records the model it started with, but the provider can be changed from
    // the UI while a run is parked at an approval gate. Sending a Gemini model name
    // to a local Ollama server 404s, so when the endpoint has moved we follow it
    // rather than replaying a name that no longer means anything.
    const providerMoved = run.providerBaseUrl !== this.llm.config.baseUrl;
    const model = providerMoved ? this.llm.config.model : run.model;

    let result;
    try {
      result = await this.llm.complete(messages, run.toolsSnapshot, {
        model,
        maxTokens: ctx.budget.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      if (err instanceof RetryableLLMError) {
        const attempt = run.retryCount + 1;
        if (attempt > MAX_PROVIDER_RETRIES) {
          this.fail(
            run.id,
            `${err.message} -- gave up after ${MAX_PROVIDER_RETRIES} attempts. ` +
              (err.status === 429
                ? 'The provider is rate limiting this key. Check your quota, lower run concurrency, or switch to a local model in Settings.'
                : 'The provider has been unavailable; try again later.'),
          );
          return false;
        }

        // Back off exponentially, but never retry sooner than the provider asked.
        // A flat interval against a rate limit just keeps the limit tripped.
        const delay = Math.max(err.retryAfterMs, backoffMs(attempt));
        const at = new Date(Date.now() + delay);

        // Park durably rather than sleeping: a setTimeout would not survive a deploy,
        // and free-tier daily limits can mean waiting a long time.
        this.store.suspendUntil(run.id, at, err.message, attempt);
        this.event(run.id, {
          type: 'status',
          status: 'suspended',
          reason: `${err.message} -- attempt ${attempt}/${MAX_PROVIDER_RETRIES}, retrying in ${Math.round(delay / 1000)}s`,
        });
        return false;
      }
      this.fail(run.id, err instanceof FatalLLMError ? err.message : String(err));
      return false;
    }

    if (signal.aborted) return false;

    // The provider answered, so any accumulated backoff is stale.
    if (run.retryCount > 0) this.store.clearRetries(run.id);

    // Tool-call ids come from the provider, and not every provider makes them unique:
    // local models (Ollama, LM Studio) and some OpenAI-compatible APIs start again at
    // call_0 in every conversation, or send none. SupOps keys calls by id across all
    // runs, so a reused, repeated or missing id gets one of SupOps' own -- before the
    // reply is stored, so the conversation history and the tool results agree.
    if (result.message.tool_calls?.length) {
      const taken = this.store.takenToolCallIds(result.message.tool_calls.map((c) => c.id));
      const seen = new Set<string>();
      result.message.tool_calls = result.message.tool_calls.map((c) => {
        const id = !c.id || seen.has(c.id) || taken.has(c.id) ? `call_${nanoid(16)}` : c.id;
        seen.add(id);
        return id === c.id ? c : { ...c, id };
      });
    }

    const step = this.store.appendStep(run.id, result.message, {
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
      model: result.model,
    });
    this.store.bumpIteration(run.id, result.promptTokens, result.completionTokens);

    if (result.message.content) {
      this.event(run.id, { type: 'assistant_text', text: result.message.content });
    }

    const requested = result.message.tool_calls ?? [];
    const cutOff = result.finishReason === 'length';

    // The reply hit the output limit mid-answer. Ask it to carry on rather than
    // presenting half an answer as the conclusion -- at most twice per turn, so a
    // model that keeps rambling cannot loop.
    if (cutOff && requested.length === 0 && this.store.engineStepsThisTurn(run.id) < MAX_CONTINUATIONS) {
      this.store.appendStep(
        run.id,
        { role: 'user', content: '[SupOps] Your last reply was cut off by the output length limit. Continue exactly where you stopped; do not repeat what you already wrote.' },
        { origin: 'engine' },
      );
      return true;
    }

    // About to conclude after a change nobody has checked: verify first (once a turn).
    if (requested.length === 0 && selfCheckOn()) {
      const verify = verifyNote(this.store.toolCallsThisTurn(run.id), this.store.engineNotesThisTurn(run.id));
      if (verify) {
        this.store.appendStep(run.id, { role: 'user', content: verify }, { origin: 'engine' });
        return true;
      }
    }

    // Before concluding: if the turn was empty (no action and no answer) OR the plan
    // still shows open steps, nudge the model to finish rather than silently ending a
    // run that looks unfinished. Bounded like the cut-off continuation so a stuck model
    // cannot loop. A turn that ran out of length is handled above.
    const CONCLUDE_MARK = '[SupOps] Before you conclude';
    const priorConcludeNudges = this.store.engineNotesThisTurn(run.id).filter((t) => t.startsWith(CONCLUDE_MARK)).length;
    const hasAnswer = !!result.message.content?.trim();
    const openSteps = (this.currentPlan(run.id) ?? []).filter((s) => s.status === 'todo' || s.status === 'doing');
    if (requested.length === 0 && priorConcludeNudges < MAX_CONTINUATIONS && (!hasAnswer || openSteps.length)) {
      const planNote = openSteps.length ? ` your plan still shows ${openSteps.length} step${openSteps.length === 1 ? '' : 's'} not done (next: "${openSteps[0]!.step}").` : '';
      const msg = !hasAnswer
        ? `${CONCLUDE_MARK}: your last turn was empty -- no action and no final answer, and${planNote || ' there is more to do.'} Take the next step now, or give your final answer. If you genuinely cannot proceed, say so and why.`
        : `${CONCLUDE_MARK}:${planNote} Finish those steps, or -- if you have already covered them -- mark each done or dropped with update_plan, then give your final answer.`;
      this.store.appendStep(run.id, { role: 'user', content: msg }, { origin: 'engine' });
      return true;
    }

    if (requested.length === 0) {
      // A one-shot run is done. An interactive session is only done with *this*
      // turn -- it parks and waits for the next message, which `rebuildMessages`
      // will pick up with the whole conversation intact.
      //
      // Except when nothing in the turn worked. A session whose every action was
      // blocked by policy or errored has nothing to follow up on, so parking it at
      // "waiting for input" describes a conversation that is never going to happen
      // and leaves the run un-deletable. Such a turn ends the session as failed.
      if (run.interactive) {
        const dead = this.deadTurnReason(run.id);
        if (dead) {
          this.fail(run.id, dead);
          return false;
        }
      }

      // Interactive sessions end their turn as `succeeded` too. They stay
      // resumable -- posting a message revives a succeeded session -- but there is
      // no separate parked state to get stuck in, and the run is terminal, so it
      // can be deleted like any other.
      const next = 'succeeded';
      // A conclusion that carries no answer (the model gave up after the nudges, or the
      // plan is unfinished) should not read as a clean success -- say so, so the person
      // knows to send a message to continue.
      const open = (this.currentPlan(run.id) ?? []).filter((s) => s.status === 'todo' || s.status === 'doing');
      const reason = !result.message.content?.trim()
        ? `ended without a final answer${open.length ? ` and with ${open.length} plan step${open.length === 1 ? '' : 's'} unfinished` : ''} -- send a message to continue`
        : open.length
          ? `the answer is in, but ${open.length} plan step${open.length === 1 ? '' : 's'} ${open.length === 1 ? 'is' : 'are'} still marked unfinished ("${open[0]!.step}") -- continue if it is not done`
          : null;
      this.store.setStatus(run.id, next, reason);
      this.event(run.id, { type: 'status', status: next, ...(reason ? { reason } : {}) });
      return false;
    }

    this.store.createToolCalls(
      run.id,
      step.id,
      requested.map((c, i) => {
        const args = parseArgs(c);
        // A call whose arguments were cut off by the output limit is marked so the
        // model is told why it failed, instead of a baffling "invalid arguments".
        if (cutOff && '__parse_error' in args) args.__truncated = true;
        return {
          toolCallId: c.id,
          callIndex: i,
          toolKey: c.function.name,
          argsJson: args,
          argsHash: hashArgs(args),
        };
      }),
    );

    for (const c of requested) {
      this.event(run.id, {
        type: 'tool_call',
        toolCallId: c.id,
        toolKey: c.function.name,
        target: (parseArgs(c).target as string) ?? null,
        rendered: '',
      });
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Phase A -- classify and execute one call
  // ------------------------------------------------------------------

  private async settleCall(
    run: RunRow,
    ctx: RunContext,
    call: ToolCallRow,
    signal: AbortSignal,
  ): Promise<void> {
    if (call.state === 'proposed') {
      const classified = await this.classify(run, ctx, call, signal);
      if (!classified) return; // classify() already marked it blocked
    }

    const current = this.store.getToolCall(call.id);
    if (!current || isTerminalToolCall(current.state)) return;
    if (current.state === 'awaiting_approval') return;
    if (current.state !== 'auto_approved' && current.state !== 'approved') return;

    const tool = ctx.tools.find((t) => t.def.key === current.toolKey);
    const target = tool?.targetsBySlug.get(String(current.argsJson.target));
    if (!tool || !target) {
      this.blockCall(current, `target "${String(current.argsJson.target)}" is not available`);
      return;
    }

    // TOCTOU: a human may have approved this a while ago, and the target's state can
    // have drifted since the simulation ran (the packages a removal would take, the
    // object a patch would change). Re-simulate a stale, human-approved change before
    // running it; if it now looks worse than what was approved, send it back for a
    // fresh decision rather than acting on one that no longer holds.
    if (
      current.state === 'approved' && current.riskJson?.observed && current.tier !== 'read_only' &&
      Date.now() - current.riskJson.observed.at > RESIM_STALE_MS && !run.policySnapshot.advisory && !isNetworkTarget(target)
    ) {
      try {
        const resim = await this.simulate({ db: this.db, tool, target, args: current.argsJson, runId: run.id, toolCallId: current.toolCallId, signal });
        if (resim.status !== 'skipped') {
          const updated = withObservations(current.riskJson, resim.contributions);
          const observed = { status: resim.status, simulator: resim.simulator, ...(resim.command ? { command: resim.command } : {}), ...(resim.note ? { note: resim.note } : {}), items: resim.observations.map((o) => ({ kind: o.kind, detail: o.detail })), ...(resim.blindSpots?.length ? { blindSpots: resim.blindSpots } : {}), at: Date.now() };
          if (tierRank(updated.tier) > tierRank(current.tier ?? 'read_only')) {
            // Worse than what was approved. Re-park (or block) and drop the stale decision.
            const next = { ...updated, observed, decision: updated.decision === 'block' ? ('block' as const) : ('approve' as const) };
            this.store.updateToolCall(current.id, { state: next.decision === 'block' ? 'blocked' : 'awaiting_approval', tier: next.tier, riskJson: next, decidedBy: null, decidedAt: null } as never);
            this.event(run.id, { type: 'tool_classified', toolCallId: current.toolCallId, tier: next.tier, assessment: next });
            if (next.decision === 'block') {
              this.store.updateToolCall(current.id, { resultJson: { ok: false, text: `BLOCKED on re-check: the simulation now shows a worse effect than when this was approved.` }, isError: true, finishedAt: new Date() } as never);
              this.event(run.id, { type: 'tool_blocked', toolCallId: current.toolCallId, reason: 'the pre-execution re-check found a worse effect' });
            } else {
              this.event(run.id, { type: 'approval_required', toolCallId: current.toolCallId, tier: next.tier, rendered: current.renderedCommand ?? '' });
            }
            return; // do not run on the stale approval
          }
          // Not worse: just refresh the timestamp so we do not re-simulate every tick.
          this.store.updateToolCall(current.id, { riskJson: { ...current.riskJson, observed: { ...current.riskJson.observed, at: Date.now() } } } as never);
        }
      } catch (err) {
        console.warn(`re-simulation error for ${current.toolCallId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.event(run.id, { type: 'tool_started', toolCallId: current.toolCallId });

    let output;
    try {
      output = await executeToolCall(
        {
          db: this.db,
          store: this.store,
          killSwitchActive: () => !!this.store.getRun(run.id) && ctx.killSwitch,
          // Captured whole (up to FULL_OUTPUT_BYTES); the model is shown the budget's worth below.
          maxOutputBytes: Math.max(FULL_OUTPUT_BYTES, ctx.budget.maxOutputBytesPerCall),
          onChunk: (chunk) => this.output.chunk(run.id, current.toolCallId, chunk),
        },
        {
          call: current,
          tool,
          target,
          projectId: run.projectId,
          toolsSnapshotKeys: run.toolsSnapshot.map((t) => t.function.name),
          signal,
          ...(KNOWLEDGE_TOOL_KEYS.includes(current.toolKey) ? { knowledge: this.knowledgeAccess(run, ctx.knowledgeScope) } : {}),
          ...(current.toolKey === readOutputTool.key ? { outputs: this.outputAccess(run.id) } : {}),
        },
      );
    } catch (err) {
      if (err instanceof ToolExecutionRefused) {
        this.blockCall(current, err.message);
        return;
      }
      output = { ok: false, text: `Execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    // Longer than the model should read at once: keep it whole, show the head and tail,
    // and say how to read the rest (read_output) instead of running the command again.
    const budget = ctx.budget.maxOutputBytesPerCall;
    const bytes = Buffer.byteLength(output.text);
    if (bytes > budget && current.toolKey !== readOutputTool.key) {
      this.db.insert(toolOutputsTable).values({ toolCallId: current.id, runId: run.id, text: output.text, bytes }).onConflictDoNothing().run();
      const view = truncateOutput(output.text, budget);
      output = {
        ...output,
        text:
          `${view.text}\n\n[Full output kept by SupOps: ${bytes.toLocaleString()} bytes, ${output.text.split('\n').length.toLocaleString()} lines. ` +
          `Read any part with read_output {"call": "${current.toolCallId}", "grep": "..."} or {"call": "${current.toolCallId}", "offset": <line>} ` +
          `instead of running the command again.]`,
      };
    }

    this.store.updateToolCall(current.id, {
      state: output.outcome ?? (output.ok ? 'succeeded' : 'failed'),
      resultJson: output,
      isError: !output.ok,
      exitCode: output.exitCode ?? null,
      finishedAt: new Date(),
    } as never);
    // A change that ran on its own and failed teaches the engine to ask next time.
    if (!output.ok && !output.outcome && current.signature && current.riskJson?.decision === 'auto' && current.tier !== 'read_only') {
      try {
        harvest(this.db, run.projectId, current.signature);
      } catch (err) {
        console.warn(`learning: could not record the failed change: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.event(run.id, {
      type: 'tool_result',
      toolCallId: current.toolCallId,
      ok: output.ok,
      text: output.text,
      ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    });
  }

  private async classify(run: RunRow, ctx: RunContext, call: ToolCallRow, signal: AbortSignal): Promise<boolean> {
    // Checked first: a cut-off call has no usable arguments at all, target included.
    if (call.argsJson.__truncated) {
      this.blockCall(
        call,
        'your reply hit the output length limit before this call was complete, so it was not run. ' +
          'Split the script or file into smaller pieces and try again.',
      );
      return false;
    }

    const tool = ctx.tools.find((t) => t.def.key === call.toolKey);
    if (!tool) {
      this.blockCall(
        call,
        `"${call.toolKey}" is not an available tool. Use only the tools you were given.`,
      );
      return false;
    }

    const slug = String(call.argsJson.target ?? '');
    const target = tool.targetsBySlug.get(slug);
    if (!target) {
      // Small models invent enum values confidently. This is a routine correction,
      // not an exceptional case -- so say exactly what the valid options are.
      this.blockCall(
        call,
        `"${slug}" is not a registered target for ${call.toolKey}. ` +
          `Valid targets: ${[...tool.targetsBySlug.keys()].join(', ')}.`,
      );
      return false;
    }

    const turnStart = run.interactive ? this.store.lastUserSeq(run.id) : null;
    if (this.store.countIdenticalCalls(run.id, call.toolKey, call.argsHash, turnStart) > DUPLICATE_LIMIT) {
      this.blockCall(
        call,
        `you have attempted this identical action ${DUPLICATE_LIMIT} times and it is now blocked. ` +
          `Change your approach or escalate to a human.`,
      );
      return false;
    }

    const parsed = tool.def.argsSchema.safeParse(call.argsJson);
    if (!parsed.success) {
      this.blockCall(
        call,
        `invalid arguments for ${call.toolKey}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}.`,
      );
      return false;
    }

    const rendered = tool.def.render(parsed.data as never, target);
    const signature = signatureOf(call.toolKey, call.argsJson);

    // Denied once already in this turn: do not ask the same person again.
    if (signature) {
      const denied = this.store
        .toolCallsThisTurn(run.id)
        .find((c) => c.id !== call.id && c.signature === signature && c.state === 'denied');
      if (denied) {
        this.store.updateToolCall(call.id, { signature } as never);
        this.blockCall(
          call,
          `this action was already denied in this turn${denied.decisionComment ? ` ("${denied.decisionComment}")` : ''}. Do not propose it again; take a different approach or ask the operator.`,
        );
        return false;
      }
    }

    const learnedRules = this.db
      .select()
      .from(learnedRulesTable)
      .where(and(eq(learnedRulesTable.projectId, run.projectId), eq(learnedRulesTable.status, 'active')))
      .all();
    let assessment = assessRisk({
      def: tool.def,
      args: call.argsJson,
      rendered,
      target,
      policy: run.policySnapshot,
      trigger: run.trigger,
      learned: { signature, rules: learnedRules },
    });
    for (const c of assessment.contributions) {
      if (c.stage === 'learned' && c.ruleId) {
        this.db
          .update(learnedRulesTable)
          .set({ hits: sql`${learnedRulesTable.hits} + 1`, lastHitAt: new Date() })
          .where(eq(learnedRulesTable.id, c.ruleId.slice('learned.'.length)))
          .run();
      }
    }

    // Shadow execution: before approval, see what the action would ACTUALLY do (a
    // native dry-run today; the target/detonation sandbox in later phases). It only
    // ever raises -- a quiet simulation never unlocks anything, and if the sandbox
    // cannot run, nothing is added (fail closed). Run it for anything that is not
    // plainly read-only, including an auto-approved change, so a cascade the rules
    // never saw (e.g. apt removing sshd) can still stop the action.
    // A script is always detonated, whatever its text classified as: malice hides in a
    // script that reads benign. Everything else is simulated only when it is not plainly
    // read-only.
    const alwaysSimulate = tool.def.key === 'run_script';
    // Whether a simulator actually ran and observed this action (status 'observed').
    // 'skipped'/'unavailable'/'error' all mean it was NOT verified -- the gate below cares.
    let simObserved = false;
    if (assessment.decision !== 'block' && (assessment.tier !== 'read_only' || alwaysSimulate) && !run.policySnapshot.advisory && !isNetworkTarget(target)) {
      try {
        const sim = await this.simulate({ db: this.db, tool, target, args: call.argsJson, runId: run.id, toolCallId: call.toolCallId, signal });
        simObserved = sim.status === 'observed';
        if (sim.status !== 'skipped') {
          assessment = withObservations(assessment, sim.contributions);
          assessment = { ...assessment, observed: { status: sim.status, simulator: sim.simulator, ...(sim.command ? { command: sim.command } : {}), ...(sim.note ? { note: sim.note } : {}), items: sim.observations.map((o) => ({ kind: o.kind, detail: o.detail })), ...(sim.blindSpots?.length ? { blindSpots: sim.blindSpots } : {}), at: Date.now() } };
          this.event(run.id, { type: 'tool_simulated', toolCallId: call.toolCallId, status: sim.status, tier: assessment.tier });
        }
      } catch (err) {
        // A simulation failure must never fail the run or relax the tier.
        console.warn(`simulation error for ${call.toolCallId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Fail-closed sandbox gate: a change the sandbox could not verify should not reach
    // real infrastructure on a (possibly mistaken) approval. Raise it to forbidden so no
    // approval can authorise it -- the operator brings up the sandbox or relaxes the gate.
    const gate = sandboxGate();
    const gated =
      gate === 'all' ? true : gate === 'scripts' ? tool.def.key === 'run_script' : gate === 'prod' ? PROD_ENVS.has(target.env) : false;
    if (
      gate !== 'off' && gated && !simObserved &&
      assessment.decision !== 'block' && assessment.tier !== 'read_only' &&
      !run.policySnapshot.advisory && !isNetworkTarget(target)
    ) {
      assessment = withObservations(assessment, [{
        stage: 'observed',
        tier: 'forbidden',
        reason:
          `the sandbox could not verify what this would do before it ran, and the sandbox gate ` +
          `(${gate}) blocks unverified changes -- bring up the detonator/target-shadow, or relax SUPOPS_SANDBOX_GATE`,
      }]);
    }

    // A person already approved exactly this (a trusted command): skip the wait, keep
    // the tier. Never for a forbidden action (that is 'block'), and never in automatic
    // runs: an unattended or advisory run promised not to change anything on its own.
    if (assessment.decision === 'approve' && !run.policySnapshot.unattended && !run.policySnapshot.advisory && !isNetworkTarget(target)) {
      const trusted = this.trustedFor(run.projectId, call.toolKey, call.argsJson, target);
      if (trusted) assessment = { ...assessment, decision: 'auto', trusted };
    }
    // Tell the approver when a change comes before anything on that machine was read.
    if (selfCheckOn() && assessment.decision === 'approve' && assessment.tier !== 'read_only' && !isNetworkTarget(target)) {
      const preflight = preflightWarning(this.store.toolCallsInRun(run.id), target.id, target.slug);
      if (preflight) assessment = { ...assessment, preflight };
    }

    this.store.updateToolCall(call.id, {
      state:
        assessment.decision === 'auto'
          ? 'auto_approved'
          : assessment.decision === 'approve'
            ? 'awaiting_approval'
            : 'blocked',
      tier: assessment.tier,
      riskJson: assessment,
      targetFingerprint: targetFingerprint(target),
      signature,
      renderedCommand: rendered,
      // The SupOps server is not a row in targets (and the column is a foreign key).
      targetId: isNetworkTarget(target) ? null : target.id,
    } as never);

    this.event(run.id, {
      type: 'tool_classified',
      toolCallId: call.toolCallId,
      tier: assessment.tier,
      assessment,
    });

    if (assessment.decision === 'block') {
      const why = assessment.contributions
        .filter((c) => c.tier === 'forbidden')
        .map((c) => c.reason)
        .join('; ');
      this.store.updateToolCall(call.id, {
        resultJson: {
          ok: false,
          text: `BLOCKED: ${why || 'this action is forbidden'}. No approval can authorise it.`,
        },
        isError: true,
        finishedAt: new Date(),
      } as never);
      this.event(run.id, { type: 'tool_blocked', toolCallId: call.toolCallId, reason: why });
      return false;
    }

    if (assessment.decision === 'approve' && run.policySnapshot.unattended) {
      const why = assessment.contributions
        .filter((c) => c.tier === assessment.tier)
        .map((c) => c.reason)
        .join('; ');
      this.blockCall(
        call,
        `NOT RUN: this is an unattended run and this action needs a human's approval ` +
          `(${assessment.tier}${why ? `: ${why}` : ''}). Use a standard read-only command ` +
          `instead, or record that it could not be checked.`,
      );
      return false;
    }

    if (assessment.decision === 'approve') {
      this.event(run.id, {
        type: 'approval_required',
        toolCallId: call.toolCallId,
        tier: assessment.tier,
        rendered,
      });
      return false;
    }

    return true;
  }

  /** The project's trusted command that covers this call, if any; counts the use. */
  private trustedFor(projectId: string, toolKey: string, args: Record<string, unknown>, target: ResolvedTarget): RiskAssessment['trusted'] | null {
    const text = trustText(toolKey, args);
    if (!text) return null;
    const env = trustEnvOf(target);
    const rules = this.db
      .select()
      .from(trustedCommands)
      .where(and(eq(trustedCommands.projectId, projectId), eq(trustedCommands.status, 'active')))
      .all();
    const hit = rules.find((r) => matchesRule(r, toolKey, text, env));
    if (!hit) return null;
    this.db.update(trustedCommands).set({ hits: sql`${trustedCommands.hits} + 1`, lastUsedAt: new Date() }).where(eq(trustedCommands.id, hit.id)).run();
    const by = hit.approvedBy ?? hit.createdBy;
    const byName = by ? this.db.select({ name: users.name }).from(users).where(eq(users.id, by)).get()?.name ?? null : null;
    return { ruleId: hit.id, by, byName };
  }

  /** The run's to-do list as its latest update_plan call left it. */
  private currentPlan(runId: string): PlanStep[] | null {
    const row = this.db
      .select({ args: toolCallsTable.argsJson })
      .from(toolCallsTable)
      .innerJoin(runSteps, eq(runSteps.id, toolCallsTable.stepId))
      .where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.toolKey, planTool.key), eq(toolCallsTable.state, 'succeeded')))
      .orderBy(desc(runSteps.seq), desc(toolCallsTable.callIndex))
      .limit(1)
      .get();
    return row ? planFromArgs(row.args) : null;
  }

  /**
   * Cleared to run now and classified read-only (this call, not the tool: ssh_exec
   * running `df -h` reads), so it is safe beside other such calls. Each call opens its
   * own connection.
   */
  private readsOnly(call: ToolCallRow): boolean {
    return call.state === 'auto_approved' && call.tier === 'read_only';
  }

  private blockCall(call: ToolCallRow, reason: string): void {
    this.store.updateToolCall(call.id, {
      state: 'blocked',
      resultJson: { ok: false, text: reason },
      isError: true,
      finishedAt: new Date(),
    } as never);
    this.event(call.runId, { type: 'tool_blocked', toolCallId: call.toolCallId, reason });
  }

  // ------------------------------------------------------------------
  // Phase B -- materialise a completed batch of tool replies
  // ------------------------------------------------------------------

  /**
   * Invariant A. Replies for one assistant turn are written all at once, and only
   * once every sibling call has reached a terminal state. A conversation containing
   * an assistant turn with N tool_calls and fewer than N replies is malformed, and
   * the failure mode is nastier than an error: several backends accept it and
   * silently produce a worse agent.
   */
  private commitOpenBatch(runId: string): boolean {
    const pending = this.db
      .select()
      .from(toolCallsTable)
      .where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.replyCommitted, false)))
      .orderBy(asc(toolCallsTable.callIndex))
      .all();

    if (pending.length === 0) return false;

    const batchStepId = pending[0]!.stepId;
    const batch = pending.filter((c) => c.stepId === batchStepId);
    if (!batch.every((c) => isTerminalToolCall(c.state))) return false;

    const replies: ChatMessage[] = batch
      .sort((a, b) => a.callIndex - b.callIndex)
      .map((c) => toReply(c));

    this.store.commitToolResults(runId, replies);
    for (const c of batch) {
      this.store.updateToolCall(c.id, { replyCommitted: true } as never);
    }
    return true;
  }

  // ------------------------------------------------------------------

  private loadContext(run: RunRow): RunContext | null {
    const agent = this.db.select().from(agents).where(eq(agents.id, run.agentId)).get();
    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    if (!agent || !project) return null;

    // The run's frozen snapshots are the boundary, not the project's current state.
    // Binding every project target here let a run scoped to one host reach any other
    // host by slug: the tool enum sent to the model is only a hint, and the model
    // can type any name. Same for tools: only what the run was started with.
    const inScope = new Set(run.targetsSnapshot.map((t) => t.slug));
    const targets = loadTargets(this.db, run.projectId).filter((t) => inScope.has(t.slug));
    const snapshotKeys = run.toolsSnapshot.map((t) => t.function.name);
    // An advisory run has no targets. Its only tools -- net_check if it was started
    // with network checks, and the knowledge tools -- act on the virtual SupOps-server
    // target. An empty snapshot must not fall back to the agent's tool list below.
    if (run.policySnapshot.advisory) {
      const keys = new Set(snapshotKeys);
      const defs = [
        ...(run.policySnapshot.networkChecks && keys.has(netCheckTool.key) ? [netCheckTool as never as ToolDef<never>] : []),
        ...[...KNOWLEDGE_TOOL_KEYS, ...SESSION_TOOL_KEYS].filter((k) => keys.has(k)).map((k) => this.registry.get(k)).filter((d): d is NonNullable<typeof d> => !!d),
      ];
      // Observability connections in the snapshot stay readable (see start-run).
      const obsDefs = OBSERVABILITY_TOOL_KEYS.filter((k) => keys.has(k)).map((k) => this.registry.get(k)).filter((d): d is NonNullable<typeof d> => !!d);
      return {
        budget: agent.budget,
        killSwitch: project.killSwitch,
        tools: [...bindTools(defs, [NETWORK_TARGET]), ...bindTools(obsDefs, targets)].sort((a, b) => a.def.key.localeCompare(b.def.key)),
        knowledgeScope: 'all',
      };
    }
    const defs = snapshotKeys.length
      ? snapshotKeys.map((k) => this.registry.get(k)).filter((d): d is NonNullable<typeof d> => !!d)
      : this.registry.resolve(effectiveToolKeys(agent.toolKeys ?? null));

    return {
      budget: agent.budget,
      killSwitch: project.killSwitch,
      tools: bindTools(defs, targets),
      // The same scope the opening message's knowledge was chosen by.
      knowledgeScope: {
        targetIds: targets.map((t) => t.id),
        kinds: [...new Set(targets.map((t) => t.kind))],
        envs: [...new Set(targets.map((t) => t.env))],
      },
    };
  }

  /** Runs whose summary request failed recently, so a broken provider is not asked every step. */
  private compactFailed = new Map<string, number>();

  /**
   * Ask the model to summarise the older part of the conversation, and keep the summary
   * (runs.compaction) to send in its place. Only accepted when it is clearly smaller.
   * Null when there is nothing worth summarising or the request failed.
   */
  private async compact(run: RunRow, current: { throughSeq: number; summary: string } | null, budget: number): Promise<{ throughSeq: number; summary: string; at: number } | null> {
    const failedAt = this.compactFailed.get(run.id);
    if (failedAt !== undefined && run.iteration - failedAt < 5) return null;
    const rows = this.store.compactedRows(run.id, current);
    const messages = rows.map((r) => r.message);
    const cut = compactionCut(messages);
    if (cut === null) return null;
    const older = messages.slice(2, cut);
    const transcript = transcriptFor(older);
    const before = estimateTokens(older);
    try {
      const r = await this.llm.complete(
        [
          { role: 'system', content: COMPACTION_PROMPT },
          { role: 'user', content: `The task:\n${typeof messages[1]!.content === 'string' ? messages[1]!.content.slice(0, 4000) : '[task]'}\n\nThe investigation so far:\n${transcript.slice(0, Math.floor(budget * 3))}` },
        ],
        [],
        { model: run.model, maxTokens: 1500 },
      );
      const summary = (r.message.content ?? '').trim();
      if (!summary || estimateTokens([{ role: 'user', content: summary }]) >= before * 0.6) throw new Error('the summary was empty or not shorter');
      // The plan lives in a tool call that may now be summarised away: carry it over whole.
      const plan = this.currentPlan(run.id);
      const kept = `${summary.slice(0, 12_000)}${plan ? `\n\nYour plan as you last updated it (${planTool.key}):\n${renderPlan(plan)}` : ''}`;
      const next = { throughSeq: rows[cut - 1]!.seq, summary: kept, at: Date.now() };
      this.store.setCompaction(run.id, next);
      // Its tokens are counted; it is not a step, so it does not use up the run's step budget.
      this.store.addTokens(run.id, r.promptTokens, r.completionTokens);
      this.compactFailed.delete(run.id);
      return next;
    } catch {
      this.compactFailed.set(run.id, run.iteration);
      return null;
    }
  }

  /** read_output's view: this run's own results only, whole when SupOps kept them whole. */
  private outputAccess(runId: string): OutputAccess {
    return {
      read: (toolCallId) => {
        const call = this.db.select().from(toolCallsTable).where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.toolCallId, toolCallId))).get();
        if (!call) return null;
        const full = this.db.select({ text: toolOutputsTable.text }).from(toolOutputsTable).where(eq(toolOutputsTable.toolCallId, call.id)).get();
        return { toolKey: call.toolKey, rendered: call.renderedCommand ?? call.toolKey, text: full?.text ?? call.resultJson?.text ?? '' };
      },
    };
  }

  /**
   * What the knowledge tools may see: the project's approved documents in this run's
   * scope. A document the agent reads is recorded on the run (and counted as used),
   * so the run page and the document both show it.
   */
  private knowledgeAccess(run: RunRow, scope: RunScope | 'all'): KnowledgeAccess {
    return {
      search: (query) => searchRunKnowledge(this.db, { projectId: run.projectId, scope, query }),
      read: (slug) => {
        const d = readRunKnowledge(this.db, { projectId: run.projectId, scope, slug });
        if (!d) return null;
        const seen = this.db
          .select({ id: runKnowledge.id })
          .from(runKnowledge)
          .where(and(eq(runKnowledge.runId, run.id), eq(runKnowledge.docId, d.id)))
          .get();
        if (!seen) {
          this.db.insert(runKnowledge).values({ runId: run.id, docId: d.id, via: 'read' }).run();
          this.db
            .update(knowledgeDocs)
            .set({ useCount: sql`${knowledgeDocs.useCount} + 1`, lastUsedAt: new Date() })
            .where(eq(knowledgeDocs.id, d.id))
            .run();
        }
        return { slug: d.slug, title: d.title, kind: d.kind, body: d.body, source: d.source ?? null };
      },
    };
  }

  private overBudget(run: RunRow, budget: RunBudget): boolean {
    if (run.iteration >= budget.maxIterations) {
      this.fail(run.id, `reached the maximum of ${budget.maxIterations} reasoning steps`);
      return true;
    }
    // A one-shot run's budget is the whole run. An interactive session's is per turn
    // (iterations and the wall clock are already reset by resumeWithInput), with a
    // session-wide ceiling as the backstop.
    const calls = run.interactive ? this.store.toolCallsThisTurn(run.id).length : this.store.countToolCalls(run.id);
    if (calls >= budget.maxToolCalls) {
      this.fail(run.id, `reached the maximum of ${budget.maxToolCalls} tool calls${run.interactive ? ' in this turn' : ''}`);
      return true;
    }
    const sessionCap = budget.maxSessionToolCalls ?? DEFAULT_SESSION_TOOL_CALLS;
    if (run.interactive && this.store.countToolCalls(run.id) >= sessionCap) {
      this.fail(run.id, `reached the session maximum of ${sessionCap} tool calls; start a new session`);
      return true;
    }
    if (run.deadlineAt && run.deadlineAt.getTime() < Date.now()) {
      this.fail(run.id, 'exceeded the wall-clock budget for this run');
      return true;
    }
    return false;
  }

  /**
   * Why this turn was a dead end, or null if any part of it got through. Only
   * every-call-failed counts: a turn where one command worked and another did not
   * still leaves the human something to act on, so the session ends normally.
   */
  private deadTurnReason(runId: string): string | null {
    // `record_finding` and `update_plan` only write to the run's own notes, so they
    // succeed even when every command failed. Counting them would mask exactly the
    // turns this catches.
    const batch = this.store
      .toolCallsThisTurn(runId)
      .filter((c) => c.toolKey !== 'record_finding' && c.toolKey !== planTool.key);
    if (batch.length === 0) return null;
    if (!batch.every((c) => c.state === 'blocked' || c.state === 'failed' || c.state === 'denied'))
      return null;

    const blocked = batch.filter((c) => c.state === 'blocked').length;
    const denied = batch.filter((c) => c.state === 'denied').length;
    const n = batch.length;
    const what = n === 1 ? 'The action' : `All ${n} actions`;
    if (blocked === n) return `${what} in this turn ${n === 1 ? 'was' : 'were'} blocked by policy.`;
    if (denied === n) return `${what} in this turn ${n === 1 ? 'was' : 'were'} rejected.`;
    return `${what} in this turn failed. The last error is in the transcript.`;
  }

  private fail(runId: string, reason: string): void {
    this.store.setStatus(runId, 'failed', reason);
    this.event(runId, { type: 'status', status: 'failed', reason });
  }

  private event(runId: string, payload: Parameters<EventSink['emit']>[2]): void {
    // Persist first, emit second: a client must never see an event the database
    // does not know about, or replay after a reconnect would silently lose it.
    const seq = this.store.appendEvent(runId, payload);
    this.sink.emit(runId, seq, payload);
  }
}

interface RunContext {
  budget: RunBudget;
  killSwitch: boolean;
  tools: ResolvedTool[];
  knowledgeScope: RunScope | 'all';
}

/** Models emit malformed JSON often enough that this must never throw. */
function parseArgs(call: ToolCallRequest): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __parse_error: call.function.arguments };
  }
}

/**
 * Turn a settled call into the reply the model will read.
 *
 * There is no `is_error` flag in this protocol, so a failure has to be unmistakable
 * in the text itself. A small model reading a bare denial without the marker will
 * cheerfully treat it as success and carry on.
 */
function toReply(call: ToolCallRow): ToolMessage {
  const base: ToolMessage = {
    role: 'tool',
    tool_call_id: call.toolCallId,
    name: call.toolKey,
    content: '',
  };

  switch (call.state) {
    case 'denied':
      return {
        ...base,
        content:
          `ERROR: DENIED by a human reviewer.` +
          (call.decisionComment ? ` Reason: "${call.decisionComment}".` : '') +
          ` Do not retry this action; propose a different approach or explain why you cannot proceed.`,
      };
    case 'expired':
      return {
        ...base,
        content:
          'ERROR: the approval request expired with no decision. Treat this action as not performed, ' +
          'and do not retry it without a new justification.',
      };
    case 'unknown_outcome':
      return {
        ...base,
        content:
          'ERROR: execution outcome unknown -- the worker stopped after dispatching this command but ' +
          'before recording its result. The action may or may not have taken effect. Verify the ' +
          'current state with a read-only check before deciding whether to retry.',
      };
    case 'blocked':
      return { ...base, content: `ERROR: ${call.resultJson?.text ?? 'blocked'}` };
    case 'timed_out':
      return { ...base, content: `ERROR: ${call.resultJson?.text ?? 'timed out'}` };
    default: {
      const out = call.resultJson;
      if (!out) return { ...base, content: 'ERROR: no result was recorded.' };
      return { ...base, content: out.ok ? out.text : `ERROR: ${out.text}` };
    }
  }
}

export { tierAtMost };
