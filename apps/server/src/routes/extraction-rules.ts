import { Router } from 'express';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { alerts, extractionRules } from '@supops/db';
import { alertMatchLabels, formatMatchers, parseMatchers } from '@supops/shared';
import { extractLabels, patternProblem } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';

/** Extraction rules: labels pulled out of alert text. Admins write them; a rule is tried on real alerts first. */
export const extractionRuleRoutes = Router();

const body = z.object({
  name: z.string().trim().min(1).max(120),
  matchers: z.string().max(4000),
  field: z.enum(['title', 'summary', 'label']),
  labelName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\-]*$/).max(64).nullish(),
  pattern: z.string().min(1).max(256),
});

function parse(b: z.infer<typeof body>) {
  const m = parseMatchers(b.matchers);
  if (!m.ok) return { error: `Matchers: ${m.error}` };
  const why = patternProblem(b.pattern);
  if (why) return { error: why };
  if (b.field === 'label' && !b.labelName) return { error: 'Say which label to read.' };
  return { rule: { name: b.name, matchers: m.matchers, field: b.field, labelName: b.field === 'label' ? b.labelName ?? null : null, pattern: b.pattern } };
}

const view = (r: typeof extractionRules.$inferSelect) => ({ ...r, matcherText: formatMatchers(r.matchers) });

extractionRuleRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(extractionRules).where(eq(extractionRules.projectId, projectId)).orderBy(asc(extractionRules.priority), asc(extractionRules.createdAt)).all().map(view));
});

/** Try a rule on the last day's alerts: what it would add, to which. Nothing is stored. */
extractionRuleRoutes.post('/preview', (req, res) => {
  const b = body.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!b.success) {
    res.json({ ok: false, error: b.error.issues[0]?.message ?? 'Incomplete rule' });
    return;
  }
  const p = parse(b.data);
  if ('error' in p) {
    res.json({ ok: false, error: p.error });
    return;
  }
  const recent = db
    .select({ title: alerts.title, summary: alerts.summary, severity: alerts.severity, source: alerts.source, labels: alerts.labels })
    .from(alerts)
    .where(and(eq(alerts.projectId, b.data.projectId), gt(alerts.receivedAt, new Date(Date.now() - 86_400_000))))
    .orderBy(desc(alerts.receivedAt))
    .limit(500)
    .all();
  let seen = 0;
  const examples: Array<{ title: string; added: Record<string, string> }> = [];
  for (const a of recent) {
    const out = extractLabels([{ id: 'preview', ...p.rule }], { title: a.title, summary: a.summary, labels: a.labels ?? {} }, alertMatchLabels(a));
    if (!out.byRule[0]!.seen) continue;
    seen++;
    if (Object.keys(out.added).length) examples.push({ title: a.title, added: out.added });
  }
  res.json({ ok: true, considered: recent.length, seen, applied: examples.length, examples: examples.slice(0, 10) });
});

extractionRuleRoutes.post('/', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can change extraction rules.' });
    return;
  }
  const b = body.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid rule' });
    return;
  }
  const p = parse(b.data);
  if ('error' in p) {
    res.status(400).json({ error: p.error });
    return;
  }
  const n = db.select({ id: extractionRules.id }).from(extractionRules).where(eq(extractionRules.projectId, b.data.projectId)).all().length;
  const row = db.insert(extractionRules).values({ ...p.rule, projectId: b.data.projectId, priority: 100 + n * 10, createdBy: req.user?.id ?? null }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'extraction_rule', entityId: row.id, action: 'create', after: view(row) });
  res.status(201).json(view(row));
});

extractionRuleRoutes.patch('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can change extraction rules.' });
    return;
  }
  const b = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: 'enabled is required' });
    return;
  }
  const row = db.update(extractionRules).set({ enabled: b.data.enabled }).where(eq(extractionRules.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'extraction_rule', entityId: row.id, action: b.data.enabled ? 'enable' : 'disable' });
  res.json(view(row));
});

extractionRuleRoutes.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can change extraction rules.' });
    return;
  }
  const row = db.delete(extractionRules).where(eq(extractionRules.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'extraction_rule', entityId: row.id, action: 'delete', before: view(row) });
  res.json({ ok: true });
});
