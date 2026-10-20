import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { incidents, workflowRuns, workflows } from '@supops/db';
import { workflowProblem, type WorkflowStep, type WorkflowTrigger } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { manualKey, startRun, workflowRunner } from '../workflows/engine.ts';

/**
 * Workflows. Admins write them; anyone can see them and their runs. A workflow only
 * ever runs from a POST (a trigger, a schedule, or "Run now"), never from a link a
 * crawler could follow.
 */
export const workflowRoutes = Router();

const SEV = z.enum(['info', 'warning', 'critical']);
const trigger = z.discriminatedUnion('type', [
  z.object({ type: z.literal('incident'), on: z.array(z.enum(['opened', 'escalated', 'acknowledged', 'resolved', 'diagnosed'])).min(1), matchers: z.string().max(4000), minSeverity: SEV }),
  z.object({ type: z.literal('schedule'), everyMinutes: z.number().int() }),
  z.object({ type: z.literal('manual') }),
]);
const step = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notify'), channelIds: z.array(z.string()).max(10), message: z.string().max(4000) }),
  z.object({ kind: z.literal('diagnose') }),
  z.object({ kind: z.literal('recheck') }),
  z.object({ kind: z.literal('assign'), userId: z.string().nullable() }),
  z.object({ kind: z.literal('severity'), severity: SEV }),
  z.object({ kind: z.literal('acknowledge') }),
  z.object({ kind: z.literal('note'), text: z.string().max(4000) }),
  z.object({ kind: z.literal('wait'), minutes: z.number().int() }),
  z.object({ kind: z.literal('if'), matchers: z.string().max(4000), severityAtLeast: SEV.nullable(), stillOpen: z.boolean() }),
]);
const body = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(1000).optional(), trigger, steps: z.array(step).max(20) });

function adminOnly(req: { user?: Parameters<typeof isAdmin>[0] }, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change workflows.' });
  return false;
}

function check(b: z.infer<typeof body>): string | null {
  return workflowProblem(b.trigger as WorkflowTrigger, b.steps as WorkflowStep[]);
}

workflowRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) return void res.status(400).json({ error: 'projectId is required' });
  res.json(db.select().from(workflows).where(eq(workflows.projectId, projectId)).orderBy(desc(workflows.createdAt)).all());
});

workflowRoutes.post('/', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = body.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid workflow' });
  const why = check(b.data);
  if (why) return void res.status(400).json({ error: why });
  const row = db
    .insert(workflows)
    .values({ projectId: b.data.projectId, name: b.data.name, description: b.data.description || null, trigger: b.data.trigger, steps: b.data.steps, createdBy: req.user?.id ?? null })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'workflow', entityId: row.id, action: 'create', after: { name: row.name, trigger: row.trigger, steps: row.steps } });
  res.status(201).json(row);
});

workflowRoutes.patch('/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const before = db.select().from(workflows).where(eq(workflows.id, req.params.id)).get();
  if (!before) return void res.status(404).json({ error: 'Workflow not found' });
  if (Object.keys(req.body ?? {}).length === 1 && typeof req.body?.enabled === 'boolean') {
    const row = db.update(workflows).set({ enabled: req.body.enabled, updatedAt: new Date() }).where(eq(workflows.id, before.id)).returning().get();
    audit(req.user, { projectId: row.projectId, entity: 'workflow', entityId: row.id, action: row.enabled ? 'enable' : 'disable' });
    return void res.json(row);
  }
  const b = body.safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid workflow' });
  const why = check(b.data);
  if (why) return void res.status(400).json({ error: why });
  const row = db
    .update(workflows)
    .set({ name: b.data.name, description: b.data.description || null, trigger: b.data.trigger, steps: b.data.steps, revision: before.revision + 1, updatedAt: new Date() })
    .where(eq(workflows.id, before.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'workflow', entityId: row.id, action: 'update', before: { revision: before.revision, trigger: before.trigger, steps: before.steps }, after: { revision: row.revision, trigger: row.trigger, steps: row.steps } });
  res.json(row);
});

workflowRoutes.delete('/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(workflows).where(eq(workflows.id, req.params.id)).returning().get();
  if (!row) return void res.status(404).json({ error: 'Workflow not found' });
  audit(req.user, { projectId: row.projectId, entity: 'workflow', entityId: row.id, action: 'delete', before: { name: row.name, trigger: row.trigger, steps: row.steps } });
  res.json({ ok: true });
});

/** Run it now, optionally about an incident. POST only. */
workflowRoutes.post('/:id/run', async (req, res) => {
  if (!adminOnly(req, res)) return;
  const wf = db.select().from(workflows).where(eq(workflows.id, req.params.id)).get();
  if (!wf) return void res.status(404).json({ error: 'Workflow not found' });
  const b = z.object({ incidentId: z.string().nullish() }).safeParse(req.body ?? {});
  if (!b.success) return void res.status(400).json({ error: 'Invalid run' });
  if (b.data.incidentId && !db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, b.data.incidentId), eq(incidents.projectId, wf.projectId))).get()) {
    return void res.status(400).json({ error: 'No incident with that id in this project.' });
  }
  const run = startRun(wf, { incidentId: b.data.incidentId ?? null, reason: `run by hand by ${req.user?.name ?? 'someone'}`, dedupeKey: manualKey(wf.id), startedBy: req.user?.id ?? null });
  audit(req.user, { projectId: wf.projectId, entity: 'workflow', entityId: wf.id, action: 'run', after: { runId: run?.id, incidentId: b.data.incidentId ?? null } });
  void workflowRunner.tick();
  res.status(201).json(run);
});

workflowRoutes.get('/:id/runs', (req, res) => {
  res.json(db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, req.params.id)).orderBy(desc(workflowRuns.startedAt)).limit(50).all());
});

/** Stop a run that is waiting. */
workflowRoutes.post('/runs/:id/stop', (req, res) => {
  if (!adminOnly(req, res)) return;
  const run = db
    .update(workflowRuns)
    .set({ status: 'stopped', endedAt: new Date(), resumeAt: null })
    .where(and(eq(workflowRuns.id, req.params.id), eq(workflowRuns.status, 'waiting')))
    .returning()
    .get();
  if (!run) return void res.status(404).json({ error: 'No waiting run with that id.' });
  res.json(run);
});

/** The workflow as JSON, to keep in git or copy to another project. */
workflowRoutes.get('/:id/export', (req, res) => {
  const wf = db.select().from(workflows).where(eq(workflows.id, req.params.id)).get();
  if (!wf) return void res.status(404).json({ error: 'Workflow not found' });
  res.json({ supopsWorkflow: 1, name: wf.name, description: wf.description, trigger: wf.trigger, steps: wf.steps });
});

/** A workflow exported from here or another project. Channels and users it names must exist in this project. */
workflowRoutes.post('/import', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = z.object({ projectId: z.string().min(1), workflow: body.extend({ supopsWorkflow: z.literal(1) }) }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: `Not a SupOps workflow: ${b.error.issues[0]?.message ?? 'invalid'}` });
  const why = check(b.data.workflow);
  if (why) return void res.status(400).json({ error: why });
  const w = b.data.workflow;
  // Imported off: a person looks it over (its channels, its owner) before it runs.
  const row = db
    .insert(workflows)
    .values({ projectId: b.data.projectId, name: w.name, description: w.description || null, trigger: w.trigger, steps: w.steps, enabled: false, createdBy: req.user?.id ?? null })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'workflow', entityId: row.id, action: 'import', after: { name: row.name } });
  res.status(201).json(row);
});
