import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { slos } from '@supops/db';
import { atWindow, availabilityQueries, budgetRemaining } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { projectConnections } from '../observe/connections.ts';
import { findService, range } from '../servicehealth/signals.ts';
import { connectionOf, errorRatio, evaluateSlo, syntheticErrorRatio } from '../slo/evaluate.ts';

/** Service level objectives: everyone can see them; admins define them. */
export const sloRoutes = Router();

type Res = import('express').Response;
const safe =
  (fn: (req: import('express').Request<{ id: string }>, res: Res) => Promise<void>) =>
  (req: import('express').Request<{ id: string }>, res: Res) =>
    fn(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
    });

function adminOnly(req: { user?: Parameters<typeof isAdmin>[0] }, res: Res): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change SLOs.' });
  return false;
}

const query = z.string().trim().min(1).max(2000).refine((q) => q.includes('$window'), 'The query must contain $window (e.g. rate(x[$window])), where each window is filled in');
const body = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  service: z.string().trim().max(200).optional(),
  connectionId: z.string().min(1),
  goodQuery: query,
  totalQuery: query,
  target: z.number().min(0.5).max(0.99999),
  windowDays: z.number().int().min(1).max(90).default(30),
  alerting: z.boolean().default(true),
});

function metricsConnection(projectId: string, id: string) {
  return projectConnections(projectId, ['prometheus', 'grafana']).find((c) => c.id === id) ?? null;
}

sloRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(slos).where(eq(slos.projectId, projectId)).all());
});

/** Try the queries before saving: the current SLI over the last hour and over the window. */
sloRoutes.post('/preview', safe(async (req, res) => {
  const p = body.pick({ projectId: true, connectionId: true, goodQuery: true, totalQuery: true, windowDays: true }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid queries' });
    return;
  }
  const conn = metricsConnection(p.data.projectId, p.data.connectionId);
  if (!conn) {
    res.status(400).json({ error: 'Choose a Prometheus or Grafana connection of this project.' });
    return;
  }
  const hour = await errorRatio(conn, p.data, '1h');
  const whole = await errorRatio(conn, p.data, `${p.data.windowDays}d`);
  res.json({ lastHour: hour === null ? null : 1 - hour, window: whole === null ? null : 1 - whole, ok: hour !== null || whole !== null });
}));

sloRoutes.post('/', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const p = body.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid SLO' });
    return;
  }
  if (!metricsConnection(p.data.projectId, p.data.connectionId)) {
    res.status(400).json({ error: 'Choose a Prometheus or Grafana connection of this project.' });
    return;
  }
  const row = db.insert(slos).values({ ...p.data, service: p.data.service || null, createdBy: req.user?.id ?? null }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'slo', entityId: row.id, action: 'create', after: { name: row.name, target: row.target } });
  const status = await evaluateSlo(row);
  res.status(201).json({ ...row, status });
}));

/** An availability SLO for a service, from the request metrics SupOps found for it. */
sloRoutes.post('/from-service', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const p = z.object({ projectId: z.string().min(1), service: z.string().trim().min(1).max(200), target: z.number().min(0.5).max(0.99999).default(0.999), windowDays: z.number().int().min(1).max(90).default(30) }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid request' });
    return;
  }
  const src = await findService(p.data.projectId, p.data.service);
  const q = src ? availabilityQueries(src.red) : null;
  if (!src || !q) {
    res.status(400).json({ error: `No request metrics found for ${p.data.service}. Write the good and total queries yourself.` });
    return;
  }
  const row = db
    .insert(slos)
    .values({ projectId: p.data.projectId, name: `${p.data.service} availability`, service: p.data.service, connectionId: src.conn.id, goodQuery: q.good, totalQuery: q.total, target: p.data.target, windowDays: p.data.windowDays, createdBy: req.user?.id ?? null })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'slo', entityId: row.id, action: 'create', after: { name: row.name, target: row.target } });
  res.status(201).json({ ...row, status: await evaluateSlo(row) });
}));

sloRoutes.patch('/:id', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(slos).where(eq(slos.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'SLO not found' });
    return;
  }
  const p = body.omit({ projectId: true }).partial().extend({ enabled: z.boolean().optional() }).safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid SLO' });
    return;
  }
  const updated = db.update(slos).set(p.data).where(eq(slos.id, row.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'slo', entityId: row.id, action: 'update', before: { target: row.target, windowDays: row.windowDays }, after: { target: updated.target, windowDays: updated.windowDays } });
  res.json({ ...updated, status: updated.enabled ? await evaluateSlo(updated) : updated.status });
}));

sloRoutes.delete('/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(slos).where(eq(slos.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'SLO not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'slo', entityId: row.id, action: 'delete', before: { name: row.name } });
  res.status(204).end();
});

/** The budget left over the window, as it moved: each point is the rolling window ending then. */
sloRoutes.get('/:id/budget', safe(async (req, res) => {
  const row = db.select().from(slos).where(eq(slos.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'SLO not found' });
    return;
  }
  const end = Date.now();
  if (row.syntheticId) {
    // The rolling window ending at each of 48 moments, from the check's own results.
    const pts: Array<[number, number]> = [];
    for (let i = 47; i >= 0; i--) {
      const at = end - (i * row.windowDays * 86_400_000) / 48;
      const r = syntheticErrorRatio(row.syntheticId, `${row.windowDays}d`, at);
      const b = budgetRemaining(r, row.target);
      if (b !== null) pts.push([at, b]);
    }
    res.json({ points: pts });
    return;
  }
  const conn = connectionOf(row);
  if (!conn) {
    res.json({ points: [] });
    return;
  }
  const start = end - row.windowDays * 86_400_000;
  const w = `${row.windowDays}d`;
  const ratio = `1 - ((${atWindow(row.goodQuery, w)}) / (${atWindow(row.totalQuery, w)}))`;
  const points = await range(conn, ratio, start, end, Math.max(300, Math.round((row.windowDays * 86_400) / 60)));
  res.json({ points: points.map(([t, v]) => [t, budgetRemaining(v, row.target)] as [number, number | null]).filter(([, v]) => v !== null) });
}));
