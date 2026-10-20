import { and, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { alerts, incidents, notificationChannels, users, workflowRuns, workflows } from '@supops/db';
import type { WorkflowLogEntry } from '@supops/db';
import { alertMatchLabels, matchesAll, parseMatchers } from '@supops/shared';
import { conditionHolds, NEEDS_INCIDENT, renderTemplate, type IncidentNote, type WorkflowStep, type WorkflowTrigger } from '@supops/core';
import { db } from '../context.ts';
import { recordIncidentEvent } from '../observe/incident-events.ts';
import { gatherEvidence, startIncidentRun } from '../observe/triage.ts';
import { sendToChannel } from '../notify/channels.ts';
import { noteFor } from '../notify/notifier.ts';

/**
 * Runs workflows: starts them when their trigger happens (once per event, like the
 * notifier), then works through each run's steps, pausing on `wait`. A run keeps the
 * steps of the revision it started on, so editing a workflow never changes a run
 * halfway through.
 */

type WorkflowRow = typeof workflows.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;
type RunRow = typeof workflowRuns.$inferSelect;

const RANK: Record<string, number> = { critical: 3, warning: 2, unknown: 2, info: 1 };
const rank = (s: string) => RANK[s] ?? 0;

export function startRun(wf: WorkflowRow, opts: { incidentId: string | null; reason: string; dedupeKey: string; startedBy?: string | null }): RunRow | null {
  const row = db
    .insert(workflowRuns)
    .values({ workflowId: wf.id, projectId: wf.projectId, revision: wf.revision, steps: wf.steps, incidentId: opts.incidentId, reason: opts.reason, dedupeKey: opts.dedupeKey, startedBy: opts.startedBy ?? null })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) db.update(workflows).set({ lastRunAt: new Date() }).where(eq(workflows.id, wf.id)).run();
  return row ?? null;
}

/** Start the workflows whose trigger happened. Returns how many runs started. */
export function planWorkflows(now = Date.now()): number {
  let started = 0;
  const all = db.select().from(workflows).where(eq(workflows.enabled, true)).all();
  const byProject = new Map<string, WorkflowRow[]>();
  for (const w of all) byProject.set(w.projectId, [...(byProject.get(w.projectId) ?? []), w]);
  for (const [projectId, wfs] of byProject) {
    for (const wf of wfs.filter((w) => (w.trigger as WorkflowTrigger).type === 'schedule')) {
      const every = (wf.trigger as Extract<WorkflowTrigger, { type: 'schedule' }>).everyMinutes * 60_000;
      const slot = Math.floor(now / every);
      // The first run is at the next slot after saving, not straight away.
      if (slot * every < wf.updatedAt.getTime()) continue;
      if (startRun(wf, { incidentId: null, reason: 'on its schedule', dedupeKey: `${wf.id}:sched:${slot}` })) started++;
    }
    const incidentWfs = wfs.filter((w) => (w.trigger as WorkflowTrigger).type === 'incident');
    if (!incidentWfs.length) continue;
    const recent = new Date(now - 2 * 3_600_000);
    const incs = db.select().from(incidents).where(and(eq(incidents.projectId, projectId), isNull(incidents.mergedInto), eq(incidents.held, false), or(eq(incidents.status, 'open'), gt(incidents.resolvedAt, recent)))).all();
    for (const inc of incs) {
      const members = db.select({ title: alerts.title, severity: alerts.severity, source: alerts.source, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
      if (members.length && members.every((m) => m.labels?.supops_test === 'true')) continue;
      const labelSets = members.map((m) => alertMatchLabels(m));
      for (const wf of incidentWfs) started += triggerOnIncident(wf, inc, labelSets);
    }
  }
  return started;
}

function triggerOnIncident(wf: WorkflowRow, inc: IncidentRow, labelSets: Array<Record<string, string>>): number {
  const t = wf.trigger as Extract<WorkflowTrigger, { type: 'incident' }>;
  if (rank(inc.severity) < rank(t.minSeverity)) return 0;
  const m = parseMatchers(t.matchers);
  if (m.ok && m.matchers.length && !labelSets.some((l) => matchesAll(m.matchers, l))) return 0;
  const since = wf.updatedAt.getTime();
  const prior = db.select({ key: workflowRuns.dedupeKey }).from(workflowRuns).where(and(eq(workflowRuns.workflowId, wf.id), eq(workflowRuns.incidentId, inc.id))).all().map((r) => r.key);
  const base = `${wf.id}:${inc.id}`;
  const candidates: Array<{ on: string; key: string; at: number; reason: string }> = [
    { on: 'opened', key: `${base}:opened@${inc.severity}`, at: inc.openedAt.getTime(), reason: 'the incident opened' },
  ];
  const opened = prior.some((k) => k.startsWith(`${base}:opened@`));
  const seenRank = Math.max(0, ...prior.map((k) => rank(k.split('@')[1] ?? '')));
  if (inc.status === 'open' && seenRank && rank(inc.severity) > seenRank) candidates.push({ on: 'escalated', key: `${base}:sev@${inc.severity}`, at: inc.lastSeenAt.getTime(), reason: `the incident became ${inc.severity}` });
  if (inc.acknowledgedAt) candidates.push({ on: 'acknowledged', key: `${base}:ack:${inc.acknowledgedAt.getTime()}`, at: inc.acknowledgedAt.getTime(), reason: 'the incident was acknowledged' });
  if (inc.status === 'resolved' && inc.resolvedAt) candidates.push({ on: 'resolved', key: `${base}:resolved:${inc.resolvedAt.getTime()}`, at: inc.resolvedAt.getTime(), reason: 'the incident resolved' });
  if (inc.triageState === 'done' && inc.rootCause && inc.runId) candidates.push({ on: 'diagnosed', key: `${base}:diag:${inc.runId}`, at: inc.lastSeenAt.getTime(), reason: 'the diagnosis finished' });
  let n = 0;
  for (const c of candidates) {
    if (!(t.on as string[]).includes(c.on) || c.at < since || prior.includes(c.key)) continue;
    // "Got worse" means worse than when the workflow first saw it; without that it is just "opened".
    if (c.on === 'escalated' && !opened && !(t.on as string[]).includes('opened')) continue;
    if (startRun(wf, { incidentId: inc.id, reason: c.reason, dedupeKey: c.key })) n++;
  }
  return n;
}

/** One step. Returns the log line, and whether the run goes on, waits, or stops. */
async function runStep(wf: { name: string }, run: RunRow, step: WorkflowStep, inc: IncidentRow | null, now: number): Promise<{ entry: Omit<WorkflowLogEntry, 'step' | 'at'>; next: 'continue' | 'wait' | 'stop'; resumeAt?: number }> {
  const who = `Workflow "${wf.name}"`;
  if (NEEDS_INCIDENT.has(step.kind) && !inc) return { entry: { status: 'skipped', text: 'No incident to act on.' }, next: 'continue' };
  switch (step.kind) {
    case 'notify': {
      const note: IncidentNote = inc ? noteFor(inc) : { id: run.id, title: '', severity: 'info', status: 'open', targets: [], alertCount: 0, rootCause: null, confidence: null, owner: null, acknowledgedBy: null, url: null, openedAt: now };
      const text = renderTemplate(step.message || '{{incident.title}}', { workflow: wf, incident: inc ? { title: note.title, severity: note.severity, status: note.status, url: note.url, rootCause: note.rootCause, targets: note.targets, owner: note.owner } : undefined });
      const [first, ...rest] = text.split('\n');
      const msg: IncidentNote = { ...note, id: run.id, title: first || wf.name, lines: [...rest.filter(Boolean), ...(note.url ? [note.url] : [])] };
      const channels = db.select().from(notificationChannels).where(and(inArray(notificationChannels.id, step.channelIds), eq(notificationChannels.projectId, run.projectId))).all();
      const results = await Promise.all(channels.map(async (c) => [c.name, c.enabled ? await sendToChannel(c, 'workflow', msg, { deliveryId: `${run.id}-${c.id}` }) : { ok: false, error: 'the channel is off' }] as const));
      const failed = results.filter(([, r]) => !r.ok);
      if (!channels.length) return { entry: { status: 'failed', text: 'None of its channels exist any more.' }, next: 'continue' };
      return {
        entry: { status: failed.length ? 'failed' : 'done', text: failed.length ? `Not sent to ${failed.map(([n, r]) => `${n} (${r.error})`).join(', ')}` : `Sent to ${results.map(([n]) => n).join(', ')}` },
        next: 'continue',
      };
    }
    case 'diagnose': {
      if (inc!.status !== 'open') return { entry: { status: 'skipped', text: 'The incident is not open.' }, next: 'continue' };
      if (inc!.runId) return { entry: { status: 'skipped', text: 'It already has a diagnosis.' }, next: 'continue' };
      // Read-only and unattended: anything that would change a system is refused by the run itself.
      const r = startIncidentRun(inc!, { mode: 'diagnose', startedBy: null });
      return r.ok ? { entry: { status: 'done', text: 'Started a read-only diagnosis.' }, next: 'continue' } : { entry: { status: 'failed', text: r.error }, next: 'continue' };
    }
    case 'recheck': {
      const ev = await gatherEvidence(inc!);
      return { entry: { status: 'done', text: `Ran the checks again: ${ev.length} results.` }, next: 'continue' };
    }
    case 'assign': {
      const to = step.userId ? db.select({ id: users.id, name: users.name, disabledAt: users.disabledAt }).from(users).where(eq(users.id, step.userId)).get() : null;
      if (step.userId && (!to || to.disabledAt)) return { entry: { status: 'failed', text: 'That user no longer exists.' }, next: 'continue' };
      db.update(incidents).set({ assigneeId: to?.id ?? null }).where(eq(incidents.id, inc!.id)).run();
      recordIncidentEvent(inc!.id, 'assigned', who, { to: to?.id ?? null, toName: to?.name ?? null });
      return { entry: { status: 'done', text: to ? `Assigned it to ${to.name}.` : 'Unassigned it.' }, next: 'continue' };
    }
    case 'severity': {
      if (inc!.severity === step.severity) return { entry: { status: 'skipped', text: `It is already ${step.severity}.` }, next: 'continue' };
      db.update(incidents).set({ severity: step.severity, severityPinned: true }).where(eq(incidents.id, inc!.id)).run();
      recordIncidentEvent(inc!.id, 'severity', who, { from: inc!.severity, to: step.severity });
      return { entry: { status: 'done', text: `Set the severity to ${step.severity}.` }, next: 'continue' };
    }
    case 'acknowledge': {
      if (inc!.status !== 'open' || inc!.acknowledgedAt) return { entry: { status: 'skipped', text: inc!.acknowledgedAt ? 'Already acknowledged.' : 'The incident is not open.' }, next: 'continue' };
      db.update(incidents).set({ acknowledgedAt: new Date(), acknowledgedBy: null }).where(eq(incidents.id, inc!.id)).run();
      recordIncidentEvent(inc!.id, 'acknowledged', null, { via: who });
      return { entry: { status: 'done', text: 'Acknowledged it.' }, next: 'continue' };
    }
    case 'note': {
      const n = noteFor(inc!);
      const text = renderTemplate(step.text, { workflow: wf, incident: { title: n.title, severity: n.severity, status: n.status, url: n.url, rootCause: n.rootCause, targets: n.targets, owner: n.owner } });
      recordIncidentEvent(inc!.id, 'comment', who, { text });
      return { entry: { status: 'done', text: 'Added a note.' }, next: 'continue' };
    }
    case 'wait':
      return { entry: { status: 'waiting', text: `Waiting ${step.minutes} minute${step.minutes === 1 ? '' : 's'}.` }, next: 'wait', resumeAt: now + step.minutes * 60_000 };
    case 'if': {
      const members = db.select({ title: alerts.title, severity: alerts.severity, source: alerts.source, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, inc!.id)).all();
      const ok = conditionHolds(step, inc!, members.map((m) => alertMatchLabels(m)));
      return ok ? { entry: { status: 'done', text: 'The condition holds: carrying on.' }, next: 'continue' } : { entry: { status: 'stopped', text: 'The condition does not hold: stopping here.' }, next: 'stop' };
    }
  }
}

/** Work through runs that are due, step by step. */
export async function executeRuns(now = Date.now()): Promise<number> {
  const due = db
    .select()
    .from(workflowRuns)
    .where(or(eq(workflowRuns.status, 'running'), and(eq(workflowRuns.status, 'waiting'), lte(workflowRuns.resumeAt, new Date(now)))))
    .orderBy(workflowRuns.startedAt)
    .limit(20)
    .all();
  for (const run of due) {
    const wf = db.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, run.workflowId)).get() ?? { name: 'removed workflow' };
    const steps = run.steps as unknown as WorkflowStep[];
    const log = [...run.log];
    let i = run.nextStep;
    let status: RunRow['status'] = 'running';
    let resumeAt: Date | null = null;
    // A paused run picks up after its wait step.
    while (i < steps.length) {
      const inc = run.incidentId ? db.select().from(incidents).where(eq(incidents.id, run.incidentId)).get() ?? null : null;
      let r: Awaited<ReturnType<typeof runStep>>;
      try {
        r = await runStep(wf, run, steps[i]!, inc, now);
      } catch (err) {
        r = { entry: { status: 'failed', text: err instanceof Error ? err.message : String(err) }, next: 'continue' };
      }
      log.push({ step: i, at: Date.now(), ...r.entry });
      i++;
      if (r.next === 'wait') {
        status = 'waiting';
        resumeAt = new Date(r.resumeAt!);
        break;
      }
      if (r.next === 'stop') {
        status = 'stopped';
        break;
      }
    }
    if (status === 'running') status = log.some((l) => l.status === 'failed') ? 'failed' : 'succeeded';
    db.update(workflowRuns)
      .set({ status, nextStep: i, log, resumeAt, ...(status === 'waiting' ? {} : { endedAt: new Date() }) })
      .where(eq(workflowRuns.id, run.id))
      .run();
  }
  return due.length;
}

/** Plan and run, every few seconds. */
export class WorkflowRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      planWorkflows(now);
      await executeRuns(now);
    } catch (err) {
      console.error('workflows:', err instanceof Error ? err.message : err);
    } finally {
      this.busy = false;
    }
  }
}

export const workflowRunner = new WorkflowRunner();

export const manualKey = (wfId: string) => `${wfId}:manual:${nanoid(10)}`;
