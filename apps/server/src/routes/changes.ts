import { Router } from 'express';
import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { alertIntegrations, alerts, incidents, suspectFeedback } from '@supops/db';
import { CHANGE_KINDS } from '@supops/core';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { hashToken, overRate, presentedToken, receive, recordRejection, tokenMatches } from '../observe/hooks.ts';
import { forgetSuspectModel, listChanges, recordChanges, suspectsFor } from '../changes/store.ts';
import { incidentServices } from '../changes/incident.ts';

/**
 * `POST /api/changes` from CI/CD, with a changes sender's token (`sup_...`): the same
 * as posting to that sender's hook URL. Mounted before the session check; anything
 * that is not a sender token falls through to the signed-in routes below.
 */
export const changeIngestRoute = Router();

changeIngestRoute.post('/', (req, res, next) => {
  const token = presentedToken(req.headers);
  if (!token?.startsWith('sup_')) return next();
  const hash = hashToken(token);
  const row = db
    .select()
    .from(alertIntegrations)
    .where(and(eq(alertIntegrations.kind, 'changes'), or(eq(alertIntegrations.tokenHash, hash), eq(alertIntegrations.previousTokenHash, hash))))
    .get();
  if (!row || !tokenMatches(row, token)) {
    res.status(401).json({ error: 'Unknown sender or wrong token.' });
    return;
  }
  if (!row.enabled) {
    recordRejection(row.id, 'Sent while turned off');
    res.status(403).json({ error: 'This sender is turned off in SupOps.' });
    return;
  }
  if (overRate(row.id)) {
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'Too many requests. Slow down: at most 300 a minute.' });
    return;
  }
  const r = receive(row, req.body);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.status(202).json(r.result);
});

/** Signed in: the change log, recording a change by hand, and the suspects for an incident. */
export const changeRoutes = Router();

changeRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours ?? 72)));
  res.json(listChanges(projectId, { since: new Date(Date.now() - hours * 3_600_000), ...(typeof req.query.service === 'string' && req.query.service ? { service: req.query.service } : {}) }));
});

const manual = z.object({
  projectId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  kind: z.enum(CHANGE_KINDS as [string, ...string[]]).default('other'),
  service: z.string().trim().max(200).optional(),
  version: z.string().trim().max(120).optional(),
  url: z.string().trim().url().max(1000).optional(),
  startedAt: z.string().datetime().optional(),
});

changeRoutes.post('/', (req, res) => {
  const parsed = manual.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  const b = parsed.data;
  const [row] = recordChanges(b.projectId, 'manual', [
    {
      kind: b.kind as never,
      title: b.title,
      ...(b.service ? { service: b.service } : {}),
      ...(b.version ? { version: b.version } : {}),
      ...(b.url ? { url: b.url } : {}),
      author: req.user?.name ?? 'someone',
      startedAt: b.startedAt ? new Date(b.startedAt) : new Date(),
    },
  ]);
  audit(req.user, { projectId: b.projectId, entity: 'change', entityId: row!.id, action: 'record', after: { title: row!.title } });
  res.status(201).json(row);
});

/** The changes that may have caused this incident, likeliest first, each with why. */
changeRoutes.get('/suspects/:incidentId', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.incidentId)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).all();
  const scope = incidentServices(inc, members);
  const marks = new Map(db.select().from(suspectFeedback).where(eq(suspectFeedback.incidentId, inc.id)).all().map((f) => [f.changeId, f.verdict]));
  res.json(suspectsFor(inc.projectId, scope).map((r) => ({ ...r.change, score: Number(r.score.toFixed(3)), reason: r.reason, relation: r.relation, learned: r.learned, feedback: marks.get(r.change.id) ?? null })));
});

/**
 * "This was the cause" / "Not this" on a suspect (or null to take the mark back). The
 * learned ranking is retrained from these marks; it only ever reorders suggestions.
 */
changeRoutes.post('/suspects/:incidentId/feedback', (req, res) => {
  const p = z.object({ changeId: z.string().min(1), verdict: z.enum(['cause', 'not_cause']).nullable() }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: 'changeId and a verdict (cause, not_cause or null) are required' });
    return;
  }
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.incidentId)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  db.delete(suspectFeedback).where(and(eq(suspectFeedback.incidentId, inc.id), eq(suspectFeedback.changeId, p.data.changeId))).run();
  if (p.data.verdict) {
    const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).all();
    const ranked = suspectsFor(inc.projectId, incidentServices(inc, members), 20);
    const it = ranked.find((r) => r.change.id === p.data.changeId);
    if (!it) {
      res.status(404).json({ error: 'That change is not a suspect for this incident' });
      return;
    }
    db.insert(suspectFeedback).values({
      projectId: inc.projectId,
      incidentId: inc.id,
      changeId: it.change.id,
      changeTitle: it.change.title,
      verdict: p.data.verdict,
      features: it.features,
      others: p.data.verdict === 'cause' ? ranked.filter((r) => r.change.id !== it.change.id).slice(0, 8).map((r) => r.features) : [],
      userId: req.user?.id ?? null,
    }).run();
    // One confirmed cause per incident: confirming another replaces it.
    if (p.data.verdict === 'cause') {
      db.delete(suspectFeedback).where(and(eq(suspectFeedback.incidentId, inc.id), eq(suspectFeedback.verdict, 'cause'), sql`${suspectFeedback.changeId} != ${it.change.id}`)).run();
    }
  }
  forgetSuspectModel(inc.projectId);
  audit(req.user, { projectId: inc.projectId, entity: 'incident', entityId: inc.id, action: 'suspect_feedback', after: { changeId: p.data.changeId, verdict: p.data.verdict } });
  res.json({ ok: true });
});
