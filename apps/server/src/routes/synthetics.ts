import { Router } from 'express';
import { and, asc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
import { slos, syntheticChecks, syntheticResults } from '@supops/db';
import { availability } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { runCheck } from '../synthetics/runner.ts';
import { evaluateSlo } from '../slo/evaluate.ts';

/** Synthetic checks: everyone can see them and their results; admins define them. */
export const syntheticRoutes = Router();

type Res = import('express').Response;
const safe =
  (fn: (req: import('express').Request<{ id: string }>, res: Res) => Promise<void>) =>
  (req: import('express').Request<{ id: string }>, res: Res) =>
    fn(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
    });

function adminOnly(req: { user?: Parameters<typeof isAdmin>[0] }, res: Res): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change synthetic checks.' });
  return false;
}

const body = z
  .object({
    projectId: z.string().min(1),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['http', 'tcp', 'dns', 'tls']),
    target: z.string().trim().min(1).max(2000),
    port: z.number().int().min(1).max(65535).nullable().optional(),
    method: z.enum(['GET', 'HEAD']).nullable().optional(),
    expectStatus: z.string().trim().regex(/^\d{3}(-\d{3})?(,\d{3}(-\d{3})?)*$/, 'Status codes like 200-399 or 200,204').nullable().optional(),
    contains: z.string().max(500).nullable().optional(),
    maxLatencyMs: z.number().int().min(10).max(120_000).nullable().optional(),
    certDaysWarn: z.number().int().min(0).max(365).default(14),
    intervalSec: z.number().int().min(30).max(86_400).default(300),
    failThreshold: z.number().int().min(1).max(20).default(2),
    allowPrivate: z.boolean().default(false),
    enabled: z.boolean().default(true),
  })
  .superRefine((b, ctx) => {
    if (b.kind === 'http' && !/^https?:\/\//.test(b.target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'An HTTP check needs an http:// or https:// URL' });
    if (b.kind !== 'http' && !/^[A-Za-z0-9_.:\[\]-]+$/.test(b.target)) ctx.addIssue({ code: 'custom', path: ['target'], message: 'A host name or address' });
    if (b.kind === 'tcp' && !b.port) ctx.addIssue({ code: 'custom', path: ['port'], message: 'A TCP check needs a port' });
  });

type CheckRow = typeof syntheticChecks.$inferSelect;
function withUptime(c: CheckRow, now = Date.now()) {
  const rows = db.select({ at: syntheticResults.at, ok: syntheticResults.ok, latencyMs: syntheticResults.latencyMs }).from(syntheticResults).where(and(eq(syntheticResults.checkId, c.id), gte(syntheticResults.at, new Date(now - 30 * 86_400_000)))).all();
  const since = (ms: number) => rows.filter((r) => r.at.getTime() >= now - ms);
  const day = since(86_400_000);
  const lat = day.map((r) => r.latencyMs).filter((v): v is number => v !== null).sort((a, b) => a - b);
  return {
    ...c,
    uptime: { day: availability(day), week: availability(since(7 * 86_400_000)), month: availability(rows) },
    latencyP50: lat.length ? lat[Math.floor(lat.length / 2)]! : null,
    recent: day.slice(-48).map((r) => ({ at: r.at.getTime(), ok: r.ok, latencyMs: r.latencyMs })),
  };
}

syntheticRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(syntheticChecks).where(eq(syntheticChecks.projectId, projectId)).orderBy(asc(syntheticChecks.name)).all().map((c) => withUptime(c)));
});

syntheticRoutes.post('/', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const p = body.safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid check' });
    return;
  }
  const row = db.insert(syntheticChecks).values({ ...p.data, createdBy: req.user?.id ?? null }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'synthetic', entityId: row.id, action: 'create', after: { name: row.name, kind: row.kind, target: row.target, allowPrivate: row.allowPrivate } });
  // The first result straight away, so the person sees whether it works.
  if (row.enabled) await runCheck(row);
  res.status(201).json(withUptime(db.select().from(syntheticChecks).where(eq(syntheticChecks.id, row.id)).get()!));
}));

syntheticRoutes.patch('/:id', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(syntheticChecks).where(eq(syntheticChecks.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }
  const merged = body.safeParse({ ...row, ...req.body, projectId: row.projectId });
  if (!merged.success) {
    res.status(400).json({ error: merged.error.issues[0]?.message ?? 'Invalid check' });
    return;
  }
  const { projectId: _p, ...fields } = merged.data;
  const updated = db.update(syntheticChecks).set({ ...fields, failStreak: 0 }).where(eq(syntheticChecks.id, row.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'synthetic', entityId: row.id, action: 'update', before: { target: row.target, enabled: row.enabled }, after: { target: updated.target, enabled: updated.enabled } });
  res.json(withUptime(updated));
}));

syntheticRoutes.post('/:id/run', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(syntheticChecks).where(eq(syntheticChecks.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }
  res.json({ result: await runCheck(row), check: withUptime(db.select().from(syntheticChecks).where(eq(syntheticChecks.id, row.id)).get()!) });
}));

syntheticRoutes.get('/:id/results', (req, res) => {
  const hours = Math.min(30 * 24, Math.max(1, Number(req.query.hours ?? 24)));
  res.json(db.select().from(syntheticResults).where(and(eq(syntheticResults.checkId, req.params.id), gte(syntheticResults.at, new Date(Date.now() - hours * 3_600_000)))).orderBy(asc(syntheticResults.at)).all());
});

syntheticRoutes.delete('/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(syntheticChecks).where(eq(syntheticChecks.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'synthetic', entityId: row.id, action: 'delete', before: { name: row.name } });
  res.status(204).end();
});

/** An availability SLO on a check: its share of successful runs over the window. */
syntheticRoutes.post('/:id/slo', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(syntheticChecks).where(eq(syntheticChecks.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Check not found' });
    return;
  }
  const p = z.object({ target: z.number().min(0.5).max(0.99999).default(0.999), windowDays: z.number().int().min(1).max(30).default(30) }).safeParse(req.body ?? {});
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid SLO' });
    return;
  }
  const slo = db.insert(slos).values({ projectId: row.projectId, name: `${row.name} availability`, syntheticId: row.id, target: p.data.target, windowDays: p.data.windowDays, createdBy: req.user?.id ?? null }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'slo', entityId: slo.id, action: 'create', after: { name: slo.name, target: slo.target } });
  res.status(201).json({ ...slo, status: await evaluateSlo(slo) });
}));
