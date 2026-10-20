import { Router } from 'express';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { alerts, correlationRules, incidents } from '@supops/db';
import { alertMatchLabels, formatMatchers, parseMatchers } from '@supops/shared';
import { previewRule } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { enqueueTriage } from '../observe/triage.ts';

/**
 * Correlation rules: how a team wants its alerts grouped. Admins write them; anyone
 * can see them and try one out on the last day's alerts.
 */
export const correlationRuleRoutes = Router();

const LABEL = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

const ruleBody = z.object({
  name: z.string().trim().min(1).max(120),
  matchers: z.string().max(4000),
  groupBy: z.array(z.string().regex(LABEL, 'Group-by entries are label names')).max(10),
  windowMin: z.number().int().min(1).max(24 * 60),
  threshold: z.number().int().min(1).max(1000),
  resolveOn: z.enum(['all', 'first', 'never']),
  titleTemplate: z.string().max(200),
});

function parse(b: z.infer<typeof ruleBody>) {
  const m = parseMatchers(b.matchers);
  if (!m.ok) return { error: `Matchers: ${m.error}` };
  if (!m.matchers.length) return { error: 'Add at least one matcher, so the rule says which alerts it is about.' };
  return { rule: { ...b, matchers: m.matchers } };
}

/**
 * A rule that is removed or turned off can no longer bring its held incidents up to
 * the threshold, so they are released: listed and diagnosed now, never left hidden.
 */
function releaseHeld(ruleId: string): void {
  const held = db.update(incidents).set({ held: false }).where(and(eq(incidents.ruleId, ruleId), eq(incidents.held, true), eq(incidents.status, 'open'))).returning({ id: incidents.id }).all();
  for (const h of held) enqueueTriage(h.id);
}

const view = (r: typeof correlationRules.$inferSelect) => ({ ...r, matcherText: formatMatchers(r.matchers) });

function requireAdmin(req: Parameters<Parameters<typeof correlationRuleRoutes.post>[1]>[0], res: Parameters<Parameters<typeof correlationRuleRoutes.post>[1]>[1]): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change correlation rules.' });
  return false;
}

correlationRuleRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(correlationRules).where(eq(correlationRules.projectId, projectId)).orderBy(asc(correlationRules.priority), asc(correlationRules.createdAt)).all().map(view));
});

/** What the rule would have made of the last day's alerts. Nothing is stored. */
correlationRuleRoutes.post('/preview', (req, res) => {
  const b = ruleBody.extend({ projectId: z.string().min(1) }).safeParse(req.body);
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
    .select({ title: alerts.title, severity: alerts.severity, source: alerts.source, labels: alerts.labels, receivedAt: alerts.receivedAt })
    .from(alerts)
    .where(and(eq(alerts.projectId, b.data.projectId), gt(alerts.receivedAt, new Date(Date.now() - 86_400_000))))
    .all();
  const r = previewRule({ id: 'preview', ...p.rule }, recent.map((a) => ({ title: a.title, labels: alertMatchLabels(a), at: a.receivedAt.getTime() })));
  res.json({ ok: true, considered: recent.length, matched: r.matched, incidents: r.groups.filter((g) => g.visible).length, held: r.groups.filter((g) => !g.visible).length, groups: r.groups.slice(0, 20) });
});

correlationRuleRoutes.post('/', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = ruleBody.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid rule' });
    return;
  }
  const p = parse(b.data);
  if ('error' in p) {
    res.status(400).json({ error: p.error });
    return;
  }
  const last = db.select({ priority: correlationRules.priority }).from(correlationRules).where(eq(correlationRules.projectId, b.data.projectId)).all();
  const row = db
    .insert(correlationRules)
    .values({ ...p.rule, projectId: b.data.projectId, priority: last.length ? Math.max(...last.map((l) => l.priority)) + 10 : 100, createdBy: req.user?.id ?? null })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'correlation_rule', entityId: row.id, action: 'create', after: view(row) });
  res.status(201).json(view(row));
});

correlationRuleRoutes.patch('/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = db.select().from(correlationRules).where(eq(correlationRules.id, req.params.id)).get();
  if (!before) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  const b = ruleBody.partial().extend({ enabled: z.boolean().optional(), priority: z.number().int().min(0).max(100_000).optional() }).safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  let matchers = before.matchers;
  if (b.data.matchers !== undefined) {
    const m = parseMatchers(b.data.matchers);
    if (!m.ok || !m.matchers.length) {
      res.status(400).json({ error: m.ok ? 'Add at least one matcher.' : `Matchers: ${m.error}` });
      return;
    }
    matchers = m.matchers;
  }
  const { matchers: _ignored, ...rest } = b.data;
  const row = db.update(correlationRules).set({ ...rest, matchers }).where(eq(correlationRules.id, before.id)).returning().get();
  if (before.enabled && !row.enabled) releaseHeld(row.id);
  if (row.threshold < before.threshold) {
    // A lower threshold may already be met: release those that now have enough alerts.
    for (const inc of db.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.ruleId, row.id), eq(incidents.held, true), eq(incidents.status, 'open'))).all()) {
      const n = db.select({ id: alerts.id }).from(alerts).where(eq(alerts.incidentId, inc.id)).all().length;
      if (n >= row.threshold) {
        db.update(incidents).set({ held: false }).where(eq(incidents.id, inc.id)).run();
        enqueueTriage(inc.id);
      }
    }
  }
  audit(req.user, { projectId: row.projectId, entity: 'correlation_rule', entityId: row.id, action: 'update', before: view(before), after: view(row) });
  res.json(view(row));
});

/** Removing a rule leaves its incidents as they are; new alerts group the built-in way. */
correlationRuleRoutes.delete('/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.delete(correlationRules).where(eq(correlationRules.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Rule not found' });
    return;
  }
  releaseHeld(row.id);
  audit(req.user, { projectId: row.projectId, entity: 'correlation_rule', entityId: row.id, action: 'delete', before: view(row) });
  res.json({ ok: true });
});
