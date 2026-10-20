import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  knowledgeDocs,
  projects,
  runKnowledge,
  runAttachments,
  runFeedback,
  targets,
  runEvents,
  runSteps,
  runs,
  toolCalls,
  users,
  trustedCommands,
} from '@supops/db';
import {
  CLIENT_REPORT_PROMPT,
  RUNBOOK_FROM_CALL_PROMPT,
  buildCallTranscript,
  buildClientPdfDefinition,
  callScreenshots,
  reportScreenshots,
  buildClientReportMarkdown,
  parseClientReport,
  parseRunbookDraft,
  REPORT_DOC_PROMPT,
  buildRcaPdfDefinition,
  canDecide,
  mergePolicy,
  globalRolesMeeting,
  harvest,
  matchesRule,
  rateSuggestedCommand,
  requiredRole,
  buildReportMarkdown,
  buildRunDigest,
  parseReportDoc,
  renderPdf,
  reportFilename,
} from '@supops/core';
import type { ReportVisuals } from '@supops/core';
import { ATTACHMENT_URL_PREFIX, diagramKey, repairMermaid } from '@supops/shared';
import type { ChatMessage, RiskTier } from '@supops/shared';
import { db, engine, llm } from '../context.ts';
import { worker } from '../worker.ts';
import { startRun } from '../services/start-run.ts';
import { decodeImages, imagesInput, saveImages, userContent } from '../services/attachments.ts';
import { runHistoryCleanup } from '../services/retention.ts';
import { isAdmin } from '../auth.ts';
import { audit } from '../services/audit.ts';

export const runRoutes = Router();

runRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const rows = projectId
    ? db.select().from(runs).where(eq(runs.projectId, projectId)).orderBy(desc(runs.startedAt)).limit(100).all()
    : db.select().from(runs).orderBy(desc(runs.startedAt)).limit(100).all();

  // Fetch every run's actions in ONE query rather than per row. The list view draws
  // a risk fingerprint for each run, and an N+1 here would make the page cost grow
  // with history.
  const ids = rows.map((r) => r.id);
  const actionsByRun = new Map<string, Array<{ tier: string | null; state: string; toolKey: string; command: string | null }>>();
  // Which machines a run actually touched -- so the list shows those, not the whole
  // frozen scope (which, for a jump, is every VM behind it and drowns the row).
  const actedByRun = new Map<string, Set<string>>();
  // Human decisions per run, rolled up so the list shows who approved the RUN.
  const decisionsByRun = new Map<string, Array<{ userId: string; denied: boolean }>>();
  if (ids.length) {
    for (const c of db
      .select({
        runId: toolCalls.runId,
        tier: toolCalls.tier,
        state: toolCalls.state,
        toolKey: toolCalls.toolKey,
        command: toolCalls.renderedCommand,
        decidedBy: toolCalls.decidedBy,
        target: sql<string | null>`json_extract(${toolCalls.argsJson}, '$.target')`,
      })
      .from(toolCalls)
      .where(inArray(toolCalls.runId, ids))
      .orderBy(asc(toolCalls.createdAt))
      .all()) {
      const list = actionsByRun.get(c.runId) ?? [];
      list.push({ tier: c.tier, state: c.state, toolKey: c.toolKey, command: c.command });
      if (c.decidedBy) {
        const d = decisionsByRun.get(c.runId) ?? [];
        d.push({ userId: c.decidedBy, denied: DENIED_STATES.has(c.state) });
        decisionsByRun.set(c.runId, d);
      }
      actionsByRun.set(c.runId, list);
      if (c.target) {
        const set = actedByRun.get(c.runId) ?? new Set<string>();
        set.add(c.target);
        actedByRun.set(c.runId, set);
      }
    }
  }

  // Resolve who started each run (and who decided its approvals) to names.
  const startedNames = resolveUserNames([
    ...rows.map((r) => r.startedBy),
    ...[...decisionsByRun.values()].flat().map((d) => d.userId),
  ]);

  // The snapshots are large and only useful on the detail view.
  res.json(
    rows.map(({ systemSnapshot, toolsSnapshot, targetsSnapshot, ...r }) => {
      const snapshot = targetsSnapshot ?? [];
      const acted = [...(actedByRun.get(r.id) ?? [])];
      // Show what was actually touched; if nothing ran, show the direct/jump targets
      // (snapshot entries that are not "Behind <jump>" machines) rather than all VMs.
      const primaries = snapshot.filter((t) => !/^Behind\s/.test(t.description ?? '')).map((t) => t.slug);
      // Always show the jump/direct target(s); add any behind-a-jump VMs actually
      // acted on. This keeps the entry point visible even when the work happened on
      // a VM one hop away.
      const base = primaries.length ? primaries : snapshot.map((t) => t.slug);
      const targets = [...new Set([...base, ...acted])];
      return {
        ...r,
        targets,
        actions: actionsByRun.get(r.id) ?? [],
        startedByName: r.startedBy ? (startedNames.get(r.startedBy) ?? null) : null,
        approvals: rollUpDecisions(decisionsByRun.get(r.id) ?? [], startedNames),
      };
    }),
  );
});

/** Decisions that count as a rejection; every other decided state was an approval. */
const DENIED_STATES = new Set(['denied', 'expired']);

/**
 * One run's approvals as a summary: how many steps were approved/rejected and by
 * whom, each person once, in the order they first decided.
 */
function rollUpDecisions(
  decisions: Array<{ userId: string; denied: boolean }>,
  names: Map<string, string>,
): { approved: number; denied: number; by: Array<{ name: string; approved: number; denied: number }> } {
  const by = new Map<string, { name: string; approved: number; denied: number }>();
  let approved = 0;
  let denied = 0;
  for (const d of decisions) {
    const who = by.get(d.userId) ?? { name: names.get(d.userId) ?? 'unknown user', approved: 0, denied: 0 };
    if (d.denied) { who.denied += 1; denied += 1; } else { who.approved += 1; approved += 1; }
    by.set(d.userId, who);
  }
  return { approved, denied, by: [...by.values()] };
}

/** Resolve a set of user ids to display names (name, falling back to email). */
function resolveUserNames(ids: Array<string | null>): Map<string, string> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, string>();
  if (uniq.length) {
    for (const u of db.select().from(users).where(inArray(users.id, uniq)).all()) {
      map.set(u.id, u.name || u.email);
    }
  }
  return map;
}

const startBody = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1).max(10_000),
  /** Console sessions stay open after each turn instead of ending. */
  interactive: z.boolean().optional(),
  /**
   * Restrict this run to specific targets. Omit or leave empty for every target in
   * the project. Scoping is enforced by building the tool schemas from only these
   * targets, so anything outside the selection is unrepresentable in a tool call --
   * not merely discouraged by the prompt.
   */
  targetIds: z.array(z.string()).optional(),
  /** Screenshots pasted with the task. Sent to the model as images (vision). */
  images: imagesInput,
  /** An approved runbook to follow. */
  runbookId: z.string().optional(),
  /** Advise only: no targets, no tools (see StartRunInput.advisory). */
  advisory: z.boolean().optional(),
  /** Advisory runs: allow read-only network checks from the SupOps server (default true). */
  networkChecks: z.boolean().optional(),
  /** A live call with a client: advisory, conversational, kept open between turns. */
  call: z.boolean().optional(),
});

runRoutes.post('/', (req, res) => {
  const parsed = startBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid run' });
    return;
  }
  const { projectId, agentId, task, targetIds, interactive, images, runbookId, advisory, networkChecks, call } = parsed.data;
  const decoded = decodeImages(images);
  if (!decoded.ok) {
    res.status(400).json({ error: decoded.error });
    return;
  }

  const result = startRun({
    projectId,
    agentId,
    task,
    targetIds,
    interactive,
    trigger: 'chat',
    startedBy: req.user?.id ?? null,
    images: decoded.decoded,
    runbookId: runbookId ?? null,
    advisory: advisory ?? false,
    networkChecks: call ? networkChecks === true : networkChecks ?? true,
    ...(call ? { call: true, interactive: true } : {}),
  });
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(201).json(result.run);
});

const rateBody = z.object({ commands: z.array(z.string().max(2000)).max(100), projectId: z.string().optional() });

/**
 * Rate the commands an advisory run suggested, so the person about to run them by
 * hand sees the same verdict the engine would give a live run. Nothing is executed.
 */
runRoutes.post('/rate-commands', (req, res) => {
  const parsed = rateBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'commands must be a list of up to 100 lines' });
    return;
  }
  // A command the project trusts is marked as such (in any of its environments): the
  // engineer reads that a person on the team already approved exactly this.
  const rules = parsed.data.projectId
    ? db.select().from(trustedCommands).where(and(eq(trustedCommands.projectId, parsed.data.projectId), eq(trustedCommands.status, 'active'))).all()
    : [];
  res.json(parsed.data.commands.map((c) => {
    const rating = rateSuggestedCommand(c);
    const trusted = rating.tier !== 'forbidden' && rules.some((r) => r.envs.some((env) => matchesRule(r, 'ssh_exec', c, env)));
    return trusted ? { ...rating, trusted: true } : rating;
  }));
});

/** Everything the run detail view needs, in one round trip. */
runRoutes.get('/:id', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const calls = db.select().from(toolCalls).where(eq(toolCalls.runId, run.id)).orderBy(asc(toolCalls.callIndex)).all();
  res.json({
    run: { ...run, startedByName: run.startedBy ? (resolveUserNames([run.startedBy]).get(run.startedBy) ?? null) : null },
    steps: db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.seq)).all(),
    // Resolve approver ids to names so the run page can show WHO decided each action,
    // not an opaque id.
    toolCalls: withApproverNames(calls),
    events: db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)).all(),
    // Which project knowledge the run was given, so the page can name it instead of
    // printing every excerpt from the opening message.
    knowledge: db
      .select({ docId: runKnowledge.docId, via: runKnowledge.via, title: knowledgeDocs.title, kind: knowledgeDocs.kind })
      .from(runKnowledge)
      .innerJoin(knowledgeDocs, eq(runKnowledge.docId, knowledgeDocs.id))
      .where(eq(runKnowledge.runId, run.id))
      .all(),
  });
});

/** Attach `decidedByName` to any decided tool calls, resolving ids to display names. */
function withApproverNames<T extends { decidedBy: string | null }>(calls: T[]): Array<T & { decidedByName: string | null }> {
  const ids = [...new Set(calls.map((c) => c.decidedBy).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const u of db.select().from(users).where(inArray(users.id, ids)).all()) {
      names.set(u.id, u.name || u.email);
    }
  }
  return calls.map((c) => ({ ...c, decidedByName: c.decidedBy ? (names.get(c.decidedBy) ?? c.decidedBy) : null }));
}

/**
 * Decided-approval history for a project, newest first -- the at-a-glance "which
 * account approved what" an admin wants. Read straight from the execution record.
 */
/**
 * Decided approvals, one entry per RUN (not per step): which investigation, console
 * session or health check it was, who started it, and who approved or rejected its
 * gated steps. The per-step detail stays on the run page.
 */
runRoutes.get('/approvals/history', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const rows = db
    .select({
      runId: runs.id,
      runTitle: runs.title,
      trigger: runs.trigger,
      interactive: runs.interactive,
      status: runs.status,
      startedAt: runs.startedAt,
      startedBy: runs.startedBy,
      state: toolCalls.state,
      decidedBy: toolCalls.decidedBy,
      decidedAt: toolCalls.decidedAt,
      comment: toolCalls.decisionComment,
    })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(and(eq(runs.projectId, projectId), isNotNull(toolCalls.decidedBy)))
    .orderBy(desc(toolCalls.decidedAt))
    .limit(1000)
    .all();

  // Group, keeping runs ordered by their most recent decision.
  const byRun = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byRun.get(r.runId) ?? [];
    list.push(r);
    byRun.set(r.runId, list);
  }
  const grouped = [...byRun.values()].slice(0, 50);
  const names = resolveUserNames(rows.flatMap((r) => [r.decidedBy, r.startedBy]));

  res.json(
    grouped.map((list) => {
      const head = list[0]!;
      // Oldest first, so the approver order reads as the order decisions were made.
      const summary = rollUpDecisions(
        [...list].reverse().map((r) => ({ userId: r.decidedBy!, denied: DENIED_STATES.has(r.state) })),
        names,
      );
      const lastComment = list.find((r) => r.comment)?.comment ?? null;
      return {
        runId: head.runId,
        runTitle: head.runTitle,
        kind: head.interactive ? 'console' : head.trigger === 'health' ? 'health' : head.trigger === 'alert' ? 'alert' : 'investigate',
        status: head.status,
        startedAt: head.startedAt,
        startedByName: head.startedBy ? (names.get(head.startedBy) ?? null) : null,
        lastDecidedAt: head.decidedAt,
        lastComment,
        ...summary,
      };
    }),
  );
});

/** Replay for a reconnecting client. */
runRoutes.get('/:id/events', (req, res) => {
  const after = Number(req.query.after ?? -1);
  res.json(engine.store.listEvents(req.params.id, Number.isFinite(after) ? after : -1));
});

runRoutes.post('/:id/cancel', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  engine.cancel(run.id);
  res.json({ ok: true });
});

/**
 * End a live call (or any interactive session) that is waiting for its next message:
 * it becomes a finished run, ready for its report. While the model is still answering
 * the person is asked to wait for that reply rather than losing it.
 */
runRoutes.post('/:id/finish', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  if (!run.interactive) {
    res.status(409).json({ error: 'Only a conversation can be ended this way.' });
    return;
  }
  if (run.statusReason === 'ended by the operator') {
    res.json({ ok: true });
    return;
  }
  // A session's turn ends as `succeeded` (a new message revives it), or parks at `awaiting_input`.
  if (run.status !== 'succeeded' && run.status !== 'awaiting_input') {
    res.status(409).json({ error: 'SupOps is still answering; end the call once its reply arrives.' });
    return;
  }
  db.update(runs).set({ status: 'succeeded', statusReason: 'ended by the operator', endedAt: new Date() }).where(eq(runs.id, run.id)).run();
  res.json({ ok: true });
});

/**
 * The approval queue, scoped to one project. Without the `projectId` filter this
 * returned every waiting call in the database, so approvals raised in one project
 * showed up in every other project's badge and could never be cleared from there.
 * Calls whose parent run is no longer active are dropped too: a run cancelled or
 * failed while a call sat pending leaves a row nobody can resolve.
 */
const ACTIVE_FOR_APPROVAL = ['running', 'awaiting_approval', 'suspended', 'queued'] as const;

runRoutes.get('/approvals/pending', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const rows = db
    .select({ toolCall: toolCalls, run: runs })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(
      and(
        eq(toolCalls.state, 'awaiting_approval'),
        eq(runs.projectId, projectId),
        inArray(runs.status, [...ACTIVE_FOR_APPROVAL]),
      ),
    )
    .all();

  res.json(
    rows.map(({ toolCall, run }) => {
      const { systemSnapshot, toolsSnapshot, targetsSnapshot, ...rest } = run;
      return { toolCall, run: rest };
    }),
  );
});

const decisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  comment: z.string().max(1000).optional(),
});

/**
 * The moment the product exists for. A human decides, the call flips state, and the
 * run goes back in the queue -- where the engine rebuilds the entire conversation
 * from SQLite and carries on. The decision may be minutes or days later, across any
 * number of restarts; nothing about the resume path cares.
 */
runRoutes.post('/tool-calls/:id/decision', (req, res) => {
  const parsed = decisionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'decision must be "approve" or "deny"' });
    return;
  }

  const call = db.select().from(toolCalls).where(eq(toolCalls.id, req.params.id)).get();
  if (!call) {
    res.status(404).json({ error: 'Tool call not found' });
    return;
  }
  if (call.state !== 'awaiting_approval') {
    res.status(409).json({ error: `This call is already ${call.state}; it cannot be decided again` });
    return;
  }

  const run = db.select().from(runs).where(eq(runs.id, call.runId)).get();
  if (!run || !req.user) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  // What the agent may do is frozen with the run, but who may approve is read from
  // the project's settings now: changing them in Settings applies to actions already
  // waiting, not just to runs started afterwards.
  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  const agent = run.agentId ? db.select().from(agents).where(eq(agents.id, run.agentId)).get() : undefined;
  const approvalPolicy = project ? mergePolicy(project.riskPolicy, agent?.riskPolicyOverride) : run.policySnapshot;
  const tier = (call.tier ?? 'high') as RiskTier;
  const need = requiredRole(tier, approvalPolicy);
  const eligibleApprovers =
    db
      .select({ n: sql<number>`count(*)` })
      .from(users)
      .where(and(inArray(users.globalRole, globalRolesMeeting(need) as never), isNull(users.disabledAt)))
      .get()?.n ?? 0;
  const check = canDecide({
    decision: parsed.data.decision,
    tier,
    policy: approvalPolicy,
    decider: { id: req.user.id, globalRole: req.user.globalRole },
    startedBy: run.startedBy,
    eligibleApprovers,
  });
  if (!check.ok) {
    res.status(403).json({ error: check.reason });
    return;
  }

  const approved = parsed.data.decision === 'approve';
  db.transaction((tx) => {
    tx.update(toolCalls)
      .set({
        state: approved ? 'approved' : 'denied',
        decidedBy: req.user?.id ?? null,
        decidedAt: new Date(),
        decisionComment: parsed.data.comment ?? null,
        ...(approved ? {} : { isError: true, finishedAt: new Date() }),
      })
      .where(and(eq(toolCalls.id, call.id), eq(toolCalls.state, 'awaiting_approval')))
      .run();

    tx.update(runs)
      .set({ status: 'queued', statusReason: null })
      .where(eq(runs.id, call.runId))
      .run();
  });

  engine.store.appendEvent(call.runId, {
    type: 'approval_decided',
    toolCallId: call.toolCallId,
    decision: approved ? 'approved' : 'denied',
    by: req.user?.name ?? 'operator',
    // Only possible on an install with one eligible approver; recorded so it shows.
    ...(check.selfApproved ? { selfApproved: true } : {}),
  });

  // A denial is a lesson: the same action denied again needs more approval, or is blocked.
  if (!approved && call.signature) {
    const learned = harvest(db, run.projectId, call.signature);
    for (const l of learned) audit(req.user, { projectId: run.projectId, entity: 'learned_rule', entityId: l.ruleId, action: l.created ? 'learn' : 'strengthen', after: { effect: l.effect, minTier: l.minTier } });
  }

  worker.nudge();
  res.json({ ok: true, state: approved ? 'approved' : 'denied' });
});

/**
 * Active runs must be stopped before they can be removed. `awaiting_input` is not
 * here: a parked session has nothing in flight, and refusing to delete it left old
 * console sessions permanently stuck in the list with no way to clear them.
 */
const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'suspended'] as const;

/**
 * Bulk-remove finished runs.
 *
 * Deliberately refuses to touch anything still in flight: deleting a run that is
 * mid-command would orphan a dispatched tool call and lose the record of what was
 * already done to a machine. Cancel it first. Steps, tool calls and events cascade.
 * Deleting runs erases the audit trail, so it is limited to owners and admins.
 */
runRoutes.post('/prune', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can delete runs.' });
    return;
  }
  const { projectId, olderThanDays } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  // The same service as scheduled retention, so pinned runs and runs an open health
  // issue still points at are kept here too, and the freed space goes back to disk.
  const days = typeof olderThanDays === 'number' && olderThanDays > 0 ? olderThanDays : 0;
  runHistoryCleanup({ olderThanDays: days, projectId })
    .then((r) => res.json({ deleted: r.runs, freedBytes: r.freedBytes }))
    .catch((err: unknown) => res.status(409).json({ error: err instanceof Error ? err.message : 'Clean-up failed' }));
});

/** Pin a run so history clean-up never removes it, or unpin it. */
runRoutes.post('/:id/pin', (req, res) => {
  const pinned = req.body?.pinned !== false;
  const row = db.update(runs).set({ pinned }).where(eq(runs.id, req.params.id)).returning({ id: runs.id, pinned: runs.pinned }).get();
  if (!row) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  res.json(row);
});

runRoutes.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can delete runs.' });
    return;
  }
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  if ((ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
    res.status(409).json({
      error: `This run is ${run.status}. Cancel it before deleting, so nothing is left mid-flight.`,
    });
    return;
  }

  db.delete(runs).where(eq(runs.id, run.id)).run();
  res.json({ ok: true });
});

/**
 * The incident document for a run.
 *
 * Served as Markdown so it can be pasted into a ticket, a wiki or a postmortem
 * template without conversion, and so the download and the clipboard copy are
 * byte-identical -- the browser never assembles its own version.
 */
/**
 * An image pasted into a run. Fetched with the bearer token like any API call (the
 * UI turns it into an object URL), so an attachment is only visible to signed-in users.
 */
runRoutes.get('/:id/attachments/:attachmentId', (req, res) => {
  const row = db
    .select()
    .from(runAttachments)
    .where(and(eq(runAttachments.id, req.params.attachmentId), eq(runAttachments.runId, req.params.id)))
    .get();
  if (!row) {
    res.status(404).json({ error: 'Attachment not found' });
    return;
  }
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Length', String(row.bytes));
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(Buffer.from(row.data));
});

/**
 * Diagrams the browser rendered for the PDF. Mermaid needs a DOM, which the server
 * does not have, so the client renders each ```mermaid block to a PNG and sends it
 * with the request. Only PNGs matching a diagram the agent actually wrote are used.
 */
const reportBody = z.object({
  diagrams: z
    .array(z.object({ source: z.string().max(20_000), png: z.string().max(4_000_000) }))
    .max(12)
    .optional(),
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The PDF's pictures: browser-rendered diagrams (validated) and the run's screenshots. */
function reportVisuals(runId: string, body: unknown): ReportVisuals {
  const diagrams = new Map<string, string>();
  const parsed = reportBody.safeParse(body ?? {});
  for (const d of parsed.success ? (parsed.data.diagrams ?? []) : []) {
    const b64 = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(d.png)?.[1];
    if (!b64 || !Buffer.from(b64.slice(0, 16), 'base64').subarray(0, 8).equals(PNG_MAGIC)) continue;
    diagrams.set(diagramKey(repairMermaid(d.source)), d.png);
  }
  const images = db
    .select()
    .from(runAttachments)
    .where(eq(runAttachments.runId, runId))
    .orderBy(asc(runAttachments.createdAt))
    .all()
    .map((a) => ({
      name: a.name,
      width: a.width,
      height: a.height,
      dataUrl: `data:${a.mime};base64,${Buffer.from(a.data).toString('base64')}`,
    }));
  return { diagrams, images };
}

const reportHandler = async (req: Request<{ id: string }>, res: Response): Promise<void> => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  const agent = db.select().from(agents).where(eq(agents.id, run.agentId)).get();
  const steps = db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, run.id), eq(runSteps.state, 'committed')))
    .orderBy(asc(runSteps.seq))
    .all();
  const calls = db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.runId, run.id))
    .orderBy(asc(toolCalls.createdAt))
    .all();

  // A call's report for the client: plain language, no internal parts (see client-report.ts).
  if (req.query.audience === 'client') {
    await clientReport(req, res, run, project?.name ?? 'Unknown project', steps);
    return;
  }

  // Resolve approver ids to names so the document reads as a record of who decided
  // what, rather than a list of opaque identifiers.
  const approverIds = [...new Set(calls.map((c) => c.decidedBy).filter((x): x is string => !!x))];
  const approverNames: Record<string, string> = {};
  if (approverIds.length) {
    for (const u of db.select().from(users).where(inArray(users.id, approverIds)).all()) {
      approverNames[u.id] = u.name || u.email;
    }
  }

  const reportInput = {
    run: {
      id: run.id,
      title: run.title,
      status: run.status,
      statusReason: run.statusReason,
      model: run.model,
      iteration: run.iteration,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      targetsSnapshot: run.targetsSnapshot,
    },
    steps: steps.map((s) => ({ seq: s.seq, messageJson: s.messageJson })),
    toolCalls: calls.map((c) => ({
      toolKey: c.toolKey,
      callIndex: c.callIndex,
      renderedCommand: c.renderedCommand,
      argsJson: c.argsJson,
      tier: c.tier,
      riskJson: c.riskJson,
      state: c.state,
      resultJson: c.resultJson,
      isError: c.isError,
      decidedBy: c.decidedBy,
      decisionComment: c.decisionComment,
      decidedAt: c.decidedAt,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
    })),
    projectName: project?.name ?? 'Unknown project',
    agentName: agent?.name ?? 'Unknown agent',
    approverNames,
    // Health runs (scheduled or manual scans, and issue investigations) get the
    // thorough per-target report; everything else the concise incident RCA.
    kind: (run.trigger === 'health' ? 'health' : 'incident') as 'health' | 'incident',
  };

  // The model returns the report as structured JSON (title, type, verdict, metrics,
  // evidence chain, ...), which the PDF and Markdown are both laid out from. If the
  // provider is unavailable the document is assembled from the execution record, so
  // a report is always produced.
  let raw: string | null = null;
  try {
    const result = await llm.complete(
      [
        { role: 'system', content: REPORT_DOC_PROMPT },
        { role: 'user', content: buildRunDigest(reportInput) },
      ],
      [],
      { maxTokens: reportInput.kind === 'health' ? 3500 : 2500, temperature: 0.2 },
    );
    raw = typeof result.message.content === 'string' ? result.message.content : null;
  } catch (err) {
    console.warn('report: model unavailable, using the mechanical document:', err instanceof Error ? err.message : err);
  }
  const doc = parseReportDoc(raw, reportInput);
  const base = reportFilename({ title: doc.title, startedAt: run.startedAt });

  if (req.query.format === 'pdf') {
    const pdf = await renderPdf(buildRcaPdfDefinition(reportInput, doc, reportVisuals(run.id, req.body)));
    const filename = base.replace(/\.md$/, '.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(pdf);
    return;
  }

  const markdown = buildReportMarkdown(reportInput, doc);
  if (req.query.download === '1') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    res.send(markdown);
    return;
  }
  res.json({ filename: base, markdown, title: doc.title, type: doc.type, outcome: doc.outcome });
};
/** The client-facing report of a call (or any advisory run): Markdown, JSON or PDF. */
async function clientReport(req: Request<{ id: string }>, res: Response, run: typeof runs.$inferSelect, projectName: string, steps: Array<{ messageJson: ChatMessage }>): Promise<void> {
  const engineer = run.startedBy ? db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, run.startedBy)).get() : undefined;
  const meta = { projectName, engineer: engineer ? engineer.name || engineer.email : null, startedAt: run.startedAt, endedAt: run.endedAt };
  const transcript = buildCallTranscript(steps);
  let raw: string | null = null;
  try {
    const result = await llm.complete(
      [
        { role: 'system', content: CLIENT_REPORT_PROMPT },
        { role: 'user', content: `Client: ${projectName}\n\nCall transcript:\n\n${transcript}` },
      ],
      [],
      { maxTokens: 2500, temperature: 0.2 },
    );
    raw = typeof result.message.content === 'string' ? result.message.content : null;
  } catch (err) {
    console.warn('client report: model unavailable:', err instanceof Error ? err.message : err);
  }
  const doc = parseClientReport(raw, run.title.replace(/^Call · [^·]+ · /, '').slice(0, 120) || 'Support call');
  // Sent to a client: no vendor prefix in the file name.
  const base = reportFilename({ title: doc.title, startedAt: run.startedAt }).replace(/^supops-/, '').replace(/\.md$/, '-report.md');
  if (req.query.format === 'pdf') {
    // Only the few screenshots chosen for the client, never every capture of the call.
    const shots = callScreenshots(steps);
    const chosen = reportScreenshots(doc, shots.length);
    const ids = chosen.map((c) => shots[c.n - 1]!).filter((u) => u.startsWith(ATTACHMENT_URL_PREFIX)).map((u) => u.slice(ATTACHMENT_URL_PREFIX.length));
    const rows = new Map(
      (ids.length ? db.select().from(runAttachments).where(and(eq(runAttachments.runId, run.id), inArray(runAttachments.id, ids))).all() : []).map((a) => [
        a.id,
        `data:${a.mime};base64,${Buffer.from(a.data).toString('base64')}`,
      ]),
    );
    const images = chosen.flatMap((c) => {
      const url = shots[c.n - 1]!;
      const dataUrl = url.startsWith(ATTACHMENT_URL_PREFIX) ? rows.get(url.slice(ATTACHMENT_URL_PREFIX.length)) : /^data:image\//.test(url) ? url : undefined;
      return dataUrl ? [{ dataUrl, n: c.n, caption: c.caption }] : [];
    });
    const pdf = await renderPdf(buildClientPdfDefinition(doc, meta, images, shots.length));
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${base.replace(/\.md$/, '.pdf')}"`);
    res.end(pdf);
    return;
  }
  const markdown = buildClientReportMarkdown(doc, meta);
  if (req.query.download === '1') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    res.send(markdown);
    return;
  }
  res.json({ filename: base, markdown, title: doc.title, status: doc.status });
}

/**
 * A runbook drafted from a call, for the person to review and save to Knowledge.
 * Nothing is saved here: the draft goes through the normal document flow (an admin's
 * save is approved, anyone else's is a draft).
 */
runRoutes.post('/:id/runbook', async (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const steps = db.select().from(runSteps).where(and(eq(runSteps.runId, run.id), eq(runSteps.state, 'committed'))).orderBy(asc(runSteps.seq)).all();
  const transcript = buildCallTranscript(steps);
  let raw: string | null = null;
  try {
    const result = await llm.complete(
      [
        { role: 'system', content: RUNBOOK_FROM_CALL_PROMPT },
        { role: 'user', content: `Call transcript:\n\n${transcript}` },
      ],
      [],
      { maxTokens: 3000, temperature: 0.2 },
    );
    raw = typeof result.message.content === 'string' ? result.message.content : null;
  } catch (err) {
    res.status(502).json({ error: `The model could not draft the runbook: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  res.json(parseRunbookDraft(raw, run.title.replace(/^Call · [^·]+ · /, '').slice(0, 120), transcript));
});

runRoutes.get('/:id/report', reportHandler);
runRoutes.post('/:id/report', reportHandler);

const messageBody = z.object({ message: z.string().min(1).max(10_000), images: imagesInput });

/**
 * Continue an open session.
 *
 * Appends a user turn and puts the run back in the queue. No new resume machinery is
 * needed: the conversation was always a pure function of the database, so the engine
 * rebuilds the whole history and carries on -- across a restart if need be.
 */
runRoutes.post('/:id/message', (req, res) => {
  const parsed = messageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  // A follow-up is allowed once the run has finished a turn -- an interactive
  // Console session parked at `awaiting_input`, or any run (an investigation
  // included) that reached `succeeded`. The whole conversation replays from the
  // steps, so continuing an investigation just adds another turn on top of it.
  if (run.status !== 'awaiting_input' && run.status !== 'succeeded') {
    res.status(409).json({
      error: `This run is ${run.status}. You can follow up once it has finished.`,
    });
    return;
  }

  const decoded = decodeImages(parsed.data.images);
  if (!decoded.ok) {
    res.status(400).json({ error: decoded.error });
    return;
  }
  const ids = saveImages(run.id, decoded.decoded, req.user?.id ?? null);
  engine.store.appendStep(run.id, { role: 'user', content: userContent(parsed.data.message, ids) });
  const agentBudget = db.select({ budget: agents.budget }).from(agents).where(eq(agents.id, run.agentId)).get()?.budget;
  engine.store.resumeWithInput(run.id, agentBudget?.maxWallClockMs);
  worker.nudge();

  res.status(201).json({ ok: true });
});

const feedbackBody = z.object({
  stepId: z.string().max(60).optional(),
  rating: z.enum(['up', 'down']),
  /** What the agent got wrong, in the operator's words. Becomes a knowledge note. */
  correction: z.string().trim().min(3).max(2000).optional(),
});

/**
 * Feedback on an agent reply. A correction becomes a knowledge note scoped to the
 * run's targets, so future runs start from it: approved immediately when an admin
 * wrote it, a draft for an admin to approve otherwise.
 */
runRoutes.post('/:id/feedback', (req, res) => {
  const parsed = feedbackBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid feedback' });
    return;
  }
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const admin = isAdmin(req.user);
  let docId: string | null = null;
  if (parsed.data.correction) {
    const slugs = (run.targetsSnapshot as Array<{ slug: string }>).map((t) => t.slug);
    const targetIds = slugs.length
      ? db.select({ id: targets.id }).from(targets).where(and(eq(targets.projectId, run.projectId), inArray(targets.slug, slugs))).all().map((t) => t.id)
      : [];
    const doc = db
      .insert(knowledgeDocs)
      .values({
        projectId: run.projectId,
        slug: `correction-${Date.now().toString(36)}`,
        kind: 'note',
        title: `Correction: ${run.title.slice(0, 100)}`,
        body: parsed.data.correction,
        tags: ['correction'],
        scope: targetIds.length ? { targetIds } : {},
        pinned: true,
        status: admin ? 'approved' : 'draft',
        sourceRunId: run.id,
        createdBy: req.user?.id ?? null,
        ...(admin ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .returning({ id: knowledgeDocs.id })
      .get();
    docId = doc.id;
  }
  const row = db
    .insert(runFeedback)
    .values({
      projectId: run.projectId,
      runId: run.id,
      runTitle: run.title,
      stepId: parsed.data.stepId ?? null,
      userId: req.user?.id ?? null,
      rating: parsed.data.rating,
      correction: parsed.data.correction ?? null,
      docId,
    })
    .returning()
    .get();
  res.status(201).json({ ...row, docStatus: docId ? (admin ? 'approved' : 'draft') : null });
});

runRoutes.get('/:id/feedback', (req, res) => {
  res.json(db.select().from(runFeedback).where(eq(runFeedback.runId, req.params.id)).all());
});
