import { Router } from 'express';
import type { Request, Response } from 'express';
import { and, asc, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { changes, incidents, knowledgeDocs, learnedRules, lessons, runSteps, runs, suspectFeedback, targets, toolCalls } from '@supops/db';
import { blendWeight, describeModel, maskSecrets } from '@supops/core';
import { suspectModel } from '../changes/store.ts';
import { isAdmin } from '../auth.ts';
import { db, settingsStore } from '../context.ts';
import { audit } from '../services/audit.ts';

/**
 * What the engine learned from denials and failed changes. Anyone can read it; an admin
 * can switch a rule off or on, delete it, or reset them all (and undo the reset). A
 * rule only ever made actions stricter, so switching one off returns to the normal
 * rules; it never makes anything looser than that.
 */
export const learningRoutes = Router();

const projectOf = (q: unknown) => (typeof q === 'string' && q ? q : null);
const adminOnly = (req: Request, res: Response) => {
  if (isAdmin(req.user) && !req.apiKey) return true;
  res.status(403).json({ error: 'Only an admin can change what SupOps learned.' });
  return false;
};

learningRoutes.get('/rules', (req, res) => {
  const projectId = projectOf(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const slugs = new Map(db.select({ id: targets.id, slug: targets.slug }).from(targets).where(eq(targets.projectId, projectId)).all().map((t) => [t.id, t.slug]));
  const rows = db.select().from(learnedRules).where(eq(learnedRules.projectId, projectId)).orderBy(desc(learnedRules.updatedAt), desc(learnedRules.createdAt)).all();
  const lastReset = rows.find((r) => r.resetBatch && r.status === 'disabled')?.resetBatch ?? null;
  res.json({
    killSwitch: process.env.SUPOPS_LEARNED_RULES === 'off',
    undoableReset: lastReset,
    rules: rows.map((r) => ({ ...r, targetSlug: r.targetId ? slugs.get(r.targetId) ?? null : null })),
  });
});

learningRoutes.patch('/rules/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const p = z.object({ status: z.enum(['active', 'disabled']) }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'status must be active or disabled' });
    return;
  }
  const row = db.update(learnedRules).set({ status: p.data.status, resetBatch: null, updatedAt: new Date() }).where(eq(learnedRules.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'learned_rule', entityId: row.id, action: p.data.status === 'active' ? 'enable' : 'disable', after: { example: row.example } });
  res.json(row);
});

learningRoutes.delete('/rules/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(learnedRules).where(eq(learnedRules.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  // Its evidence stays counted, so the same denials do not rebuild it.
  audit(req.user, { projectId: row.projectId, entity: 'learned_rule', entityId: row.id, action: 'delete', before: { example: row.example, effect: row.effect, minTier: row.minTier } });
  res.json({ ok: true });
});

/** Switch every active rule off at once; the reset can be undone until the next one. */
learningRoutes.post('/reset', (req, res) => {
  if (!adminOnly(req, res)) return;
  const projectId = projectOf(req.body?.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const batch = nanoid(10);
  const n = db.update(learnedRules).set({ status: 'disabled', resetBatch: batch, updatedAt: new Date() }).where(and(eq(learnedRules.projectId, projectId), eq(learnedRules.status, 'active'))).run().changes;
  audit(req.user, { projectId, entity: 'learned_rule', entityId: batch, action: 'reset', after: { rules: n } });
  res.json({ ok: true, batch, rules: n });
});

learningRoutes.post('/reset/:batch/undo', (req, res) => {
  if (!adminOnly(req, res)) return;
  const any = db.select({ projectId: learnedRules.projectId }).from(learnedRules).where(eq(learnedRules.resetBatch, req.params.batch)).get();
  if (!any) {
    res.status(404).json({ error: 'Nothing to undo: that reset was already undone, or its rules were changed since.' });
    return;
  }
  const n = db.update(learnedRules).set({ status: 'active', resetBatch: null, updatedAt: new Date() }).where(and(eq(learnedRules.resetBatch, req.params.batch), eq(learnedRules.status, 'disabled'))).run().changes;
  audit(req.user, { projectId: any.projectId, entity: 'learned_rule', entityId: req.params.batch, action: 'undo_reset', after: { rules: n } });
  res.json({ ok: true, rules: n });
});

/** What runs taught, and what the lesson gate did with each, newest first. */
learningRoutes.get('/lessons', (req, res) => {
  const projectId = projectOf(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const rows = db
    .select({ l: lessons, runTitle: runs.title, docStatus: knowledgeDocs.status })
    .from(lessons)
    .leftJoin(runs, eq(runs.id, lessons.runId))
    .leftJoin(knowledgeDocs, eq(knowledgeDocs.id, lessons.knowledgeDocId))
    .where(eq(lessons.projectId, projectId))
    .orderBy(desc(lessons.createdAt))
    .limit(100)
    .all()
    .filter((r) => r.l.title !== '(nothing new)');
  res.json({ settings: settingsStore.learning(), lessons: rows.map((r) => ({ ...r.l, runTitle: r.runTitle, docStatus: r.docStatus })) });
});

learningRoutes.put('/settings', (req, res) => {
  if (!adminOnly(req, res)) return;
  const p = z.object({ reflect: z.enum(['off', 'drafts', 'auto']).optional(), reflectMinActions: z.number().int().min(1).max(50).optional() }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }
  const before = settingsStore.learning();
  const next = settingsStore.saveLearning(p.data);
  audit(req.user, { entity: 'settings', entityId: 'learning', action: 'update', before, after: next });
  res.json(next);
});

/** What the suspect ranking learned from people marking causes: its weights, and the marks. */
learningRoutes.get('/ranking', (req, res) => {
  const projectId = projectOf(req.query.projectId);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const m = suspectModel(projectId);
  const marks = db.select().from(suspectFeedback).where(eq(suspectFeedback.projectId, projectId)).orderBy(desc(suspectFeedback.createdAt)).limit(50).all();
  res.json({
    model: m ? { examples: m.examples, influence: blendWeight(m), weights: describeModel(m) } : null,
    marks: marks.map((f) => ({ id: f.id, incidentId: f.incidentId, changeTitle: f.changeTitle, verdict: f.verdict, createdAt: f.createdAt })),
  });
});

const EVAL_KINDS = new Set(['ssh', 'k8s', 'prometheus', 'loki', 'elasticsearch', 'alertmanager', 'tempo', 'jaeger']);
const reEscape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * An incident whose cause a person confirmed, as an accuracy eval case: its diagnosis
 * run's tool outputs as recordings (secrets masked), and naming that change as what a
 * correct answer must contain. It holds this environment's own output, so it is a
 * download for review, never written into the repository by SupOps.
 */
learningRoutes.get('/eval-case/:incidentId', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.incidentId)).get();
  const cause = inc ? db.select().from(suspectFeedback).where(and(eq(suspectFeedback.incidentId, inc.id), eq(suspectFeedback.verdict, 'cause'))).get() : undefined;
  if (!inc || !cause) {
    res.status(404).json({ error: 'No confirmed cause for this incident: mark one on the incident first.' });
    return;
  }
  const run = inc.runId ? db.select().from(runs).where(eq(runs.id, inc.runId)).get() : undefined;
  if (!run) {
    res.status(409).json({ error: 'This incident has no diagnosis run to record outputs from.' });
    return;
  }
  const slugs = new Map(db.select({ id: targets.id, slug: targets.slug }).from(targets).where(eq(targets.projectId, inc.projectId)).all().map((t) => [t.id, t.slug]));
  const calls = db.select().from(toolCalls).where(eq(toolCalls.runId, run.id)).orderBy(asc(toolCalls.createdAt)).all().filter((c) => c.resultJson && c.renderedCommand);
  const opening = db.select({ m: runSteps.messageJson }).from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.seq)).limit(1).get()?.m as { content?: unknown } | undefined;
  const change = db.select().from(changes).where(eq(changes.id, cause.changeId)).get();
  const key = change?.version ?? change?.service ?? cause.changeTitle;
  const evalCase = {
    id: `confirmed-${inc.id.slice(0, 8).toLowerCase()}`,
    title: `${inc.title}: caused by ${cause.changeTitle}`,
    tags: ['confirmed', 'change'],
    task: inc.title,
    mode: 'incident',
    evidence: typeof opening?.content === 'string' ? maskSecrets(opening.content).text : '',
    targets: run.targetsSnapshot.filter((t) => EVAL_KINDS.has(t.kind)).map((t) => ({ slug: t.slug, kind: t.kind, env: t.env, ...(t.description ? { description: t.description } : {}) })),
    replay: calls.map((c) => ({
      tool: c.toolKey,
      ...(c.targetId && slugs.get(c.targetId) ? { target: slugs.get(c.targetId) } : {}),
      match: reEscape(c.renderedCommand!).slice(0, 400),
      output: maskSecrets(c.resultJson!.text).text.slice(0, 20_000),
      ...(c.resultJson!.exitCode ? { exitCode: c.resultJson!.exitCode } : {}),
    })),
    expect: { elements: [{ text: `The cause is the change "${cause.changeTitle}"`, match: reEscape(key) }] },
  };
  res.setHeader('Content-Disposition', `attachment; filename="${evalCase.id}.json"`);
  res.json(evalCase);
});
