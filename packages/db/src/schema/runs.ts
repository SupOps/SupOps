import { blob, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  ChatMessage,
  RiskAssessment,
  RiskTier,
  RunStatus,
  RunTrigger,
  StepState,
  ToolCallState,
  ToolSpec,
} from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { agents } from './agents.ts';
import { targets } from './targets.ts';
import type { RiskPolicy, TargetSummary, ToolOutput } from './types.ts';

/**
 * A Run is one agentic execution. Everything needed to resume it lives in these
 * rows -- there is no in-memory state a restart could lose. A run suspended at an
 * approval gate for three days across two deploys resumes identically.
 */
export const runs = sqliteTable(
  'runs',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id),
    trigger: text('trigger').$type<RunTrigger>().notNull(),
    /**
     * An interactive run stays open when the agent finishes a turn, parking in
     * `awaiting_input` instead of succeeding, so the operator can follow up. One-shot
     * runs (Investigate, alerts) end as they always did.
     */
    interactive: integer('interactive', { mode: 'boolean' }).notNull().default(false),
    triggerPayload: text('trigger_payload', { mode: 'json' }).$type<unknown>(),
    title: text('title').notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    /** Kept by history clean-up regardless of age. */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    statusReason: text('status_reason'),

    // --- Frozen snapshots -------------------------------------------------
    // Taken at run start so that an allowlist edit, a policy change or a target
    // being deleted mid-run cannot retroactively change what the agent was
    // allowed to do. This is the audit trail's primary evidence.
    providerBaseUrl: text('provider_base_url').notNull(),
    model: text('model').notNull(),
    systemSnapshot: text('system_snapshot').notNull(),
    toolsSnapshot: text('tools_snapshot', { mode: 'json' }).$type<ToolSpec[]>().notNull(),
    targetsSnapshot: text('targets_snapshot', { mode: 'json' })
      .$type<TargetSummary[]>()
      .notNull(),
    policySnapshot: text('policy_snapshot', { mode: 'json' }).$type<RiskPolicy>().notNull(),

    iteration: integer('iteration').notNull().default(0),
    /** Monotonic allocator shared by run_steps.seq and run_events.seq. */
    nextSeq: integer('next_seq').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),

    /**
     * Lease-based ownership. A worker heartbeats while it holds a run; on boot any
     * `running` row whose lease has expired is swept back to `queued`. This is what
     * makes crash recovery work today with one process and still work with many.
     */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: ts('lease_expires_at'),
    /** Wall-clock deadline for RUNNING time; approval waits do not count against it. */
    deadlineAt: ts('deadline_at'),
    /** Set when backing off a 429/5xx, so a long wait survives a restart. */
    resumeAfter: ts('resume_after'),
    /**
     * Consecutive provider failures. Drives exponential backoff and eventually gives
     * up: retrying a rate limit at a fixed interval forever just keeps the limit
     * tripped and looks identical to a hung run.
     */
    retryCount: integer('retry_count').notNull().default(0),
    /**
     * The model's own summary of the conversation up to step `throughSeq`, sent in place
     * of those steps once the run outgrew its context. The steps themselves are kept.
     */
    compaction: text('compaction', { mode: 'json' }).$type<{ throughSeq: number; summary: string; at: number } | null>(),

    startedBy: text('started_by').references(() => users.id),
    startedAt: ts('started_at').notNull().$defaultFn(() => new Date()),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('runs_project_status').on(t.projectId, t.status, t.startedAt),
    index('runs_lease').on(t.status, t.leaseExpiresAt),
  ],
);

/**
 * One message in the conversation, stored in wire shape, ready to send.
 * Append-only and immutable once committed: `rebuildMessages` is a `map` over
 * these rows, so anything that edits history is a bug, not an optimisation.
 */
export const runSteps = sqliteTable(
  'run_steps',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    /** The complete message object. Store what was sent/received; never re-derive it. */
    messageJson: text('message_json', { mode: 'json' }).$type<ChatMessage>().notNull(),
    state: text('state').$type<StepState>().notNull(),
    finishReason: text('finish_reason'),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    latencyMs: integer('latency_ms'),
    /**
     * The model that wrote this reply. Usually the run's model; the fallback model when
     * the main one failed. Null for steps that are not model replies.
     */
    model: text('model'),
    /**
     * Null for ordinary steps. 'engine' marks a message SupOps itself wrote into the
     * conversation (e.g. "continue where you stopped"): sent to the model like any
     * user message, but it is not the operator speaking, so it never starts a turn.
     */
    origin: text('origin').$type<'engine'>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_steps_run_seq').on(t.runId, t.seq)],
);

export const toolCalls = sqliteTable(
  'tool_calls',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    /** The assistant step that requested this call. */
    stepId: text('step_id')
      .notNull()
      .references(() => runSteps.id, { onDelete: 'cascade' }),
    /** The model's own id. Doubles as the idempotency key for dispatch. */
    toolCallId: text('tool_call_id').notNull().unique(),
    /** Position within the assistant turn; tool replies must be emitted in this order. */
    callIndex: integer('call_index').notNull(),
    toolKey: text('tool_key').notNull(),
    targetId: text('target_id').references(() => targets.id),
    argsJson: text('args_json', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /**
     * sha256 of the canonicalised args, computed at classification time. Re-checked
     * immediately before dispatch, and matched against the approval, so that nothing
     * can alter a command between "a human approved this" and "this ran".
     */
    argsHash: text('args_hash').notNull(),
    /** Exactly what will run, shell-quoted, secrets masked. This is what an approver reads. */
    renderedCommand: text('rendered_command'),
    /**
     * Hash of the target's config and credential at classification time. Checked
     * again just before execution, so repointing a target after an action was
     * approved (say, staging's credential swapped for prod's) cannot ride that approval.
     */
    targetFingerprint: text('target_fingerprint'),
    /** Normalised identity of the action (see core/learning/signature.ts); how learned rules recognise it. */
    signature: text('signature'),
    /** Set once the learning harvester has counted this call. */
    learnedAt: integer('learned_at', { mode: 'timestamp_ms' }),
    tier: text('tier').$type<RiskTier>(),
    riskJson: text('risk_json', { mode: 'json' }).$type<RiskAssessment | null>(),
    state: text('state').$type<ToolCallState>().notNull(),
    approvalId: text('approval_id'),
    /**
     * Whether this call's `role:"tool"` reply has been written into the conversation.
     * Invariant A means replies are committed for a whole assistant turn at once, so
     * this is the flag that tells the engine a batch is still open.
     */
    replyCommitted: integer('reply_committed', { mode: 'boolean' }).notNull().default(false),
    decidedBy: text('decided_by').references(() => users.id),
    decidedAt: ts('decided_at'),
    decisionComment: text('decision_comment'),
    resultJson: text('result_json', { mode: 'json' }).$type<ToolOutput | null>(),
    isError: integer('is_error', { mode: 'boolean' }).notNull().default(false),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('tool_calls_step').on(t.stepId, t.callIndex),
    // Every per-run count, the stale-call sweeps and cascade deletes filter on run_id.
    index('tool_calls_run').on(t.runId, t.createdAt),
    index('tool_calls_signature').on(t.signature),
  ],
);

/**
 * A tool's whole output, when it was longer than the run's per-call budget. The model
 * is shown the head and tail (tool_calls.result_json) and reads the rest on demand with
 * read_output, instead of re-running the command. Already redacted like the rest.
 */
export const toolOutputs = sqliteTable('tool_outputs', {
  toolCallId: text('tool_call_id')
    .primaryKey()
    .references(() => toolCalls.id, { onDelete: 'cascade' }),
  runId: text('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  bytes: integer('bytes').notNull(),
  createdAt: createdAt(),
});

/**
 * The durable half of the UI stream. Token deltas are best-effort over the socket;
 * everything semantically meaningful is written here first, then emitted -- so a
 * reconnecting or late-joining client replays `seq > lastSeq` and is exactly caught up.
 */
export const runEvents = sqliteTable(
  'run_events',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    type: text('type').notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('run_events_run_seq').on(t.runId, t.seq)],
);

/**
 * Images the operator pasted into a run (a dashboard screenshot, an error dialog).
 * Kept out of `run_steps.messageJson`, which only holds a `supops-attachment:<id>`
 * reference: the engine inlines the bytes when it sends the turn, the UI fetches them
 * on demand, and the PDF embeds them as evidence. Always JPEG or PNG -- the browser
 * re-encodes on paste -- so every provider and the PDF renderer can use them as-is.
 */
export const runAttachments = sqliteTable(
  'run_attachments',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    mime: text('mime').$type<'image/jpeg' | 'image/png'>().notNull(),
    name: text('name'),
    width: integer('width'),
    height: integer('height'),
    bytes: integer('bytes').notNull(),
    data: blob('data', { mode: 'buffer' }).$type<Buffer>().notNull(),
    createdBy: text('created_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [index('run_attachments_run').on(t.runId, t.createdAt)],
);
