import { Router } from 'express';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { alerts, incidents, metricPoints, runAttachments, runs, runSteps, toolCalls } from '@supops/db';
import { previewObservabilityCleanup, storageStats } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { config } from '../config.ts';
import { db, settingsStore, sqlite } from '../context.ts';
import { previewHistoryCleanup, runHistoryCleanup } from '../services/retention.ts';
import { audit } from '../services/audit.ts';
import { backupNow, backupScheduler, backupSettings, listBackups } from '../backup.ts';

/**
 * Storage and history retention. Reading the numbers is open to any signed-in user
 * (it explains a full disk); changing the policy or deleting history is admin-only.
 */
export const maintenanceRoutes = Router();

const count = (table: typeof runs | typeof runSteps | typeof toolCalls) =>
  db.select({ n: sql<number>`count(*)` }).from(table).get()?.n ?? 0;

maintenanceRoutes.get('/storage', (_req, res) => {
  const att = db
    .select({ n: sql<number>`count(*)`, b: sql<number>`coalesce(sum(${runAttachments.bytes}), 0)` })
    .from(runAttachments)
    .get();
  res.json({
    ...storageStats(sqlite, config.databasePath),
    runs: count(runs),
    steps: count(runSteps),
    toolCalls: count(toolCalls),
    images: att?.n ?? 0,
    imageBytes: att?.b ?? 0,
    retention: settingsStore.retention(),
    observability: {
      metricPoints: db.select({ n: sql<number>`count(*)` }).from(metricPoints).get()?.n ?? 0,
      alerts: db.select({ n: sql<number>`count(*)` }).from(alerts).get()?.n ?? 0,
      incidents: db.select({ n: sql<number>`count(*)` }).from(incidents).get()?.n ?? 0,
      due: previewObservabilityCleanup(db, { days: settingsStore.retention().observabilityDays ?? 15 }),
    },
  });
});

const DAYS = z.number().int().min(1).max(3650).nullable();
const retentionBody = z.object({ days: DAYS, dropImagesAfterDays: DAYS, observabilityDays: z.number().int().min(1).max(365).optional() });

maintenanceRoutes.put('/retention', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change history retention.' });
    return;
  }
  const parsed = retentionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid retention policy' });
    return;
  }
  const before = settingsStore.retention();
  // A policy change takes effect on the next scheduler tick rather than tomorrow.
  const saved = settingsStore.saveRetention({ ...parsed.data, nextRunAt: Date.now() + 60_000 });
  audit(req.user, { entity: 'settings.retention', action: 'update', before: { days: before.days, dropImagesAfterDays: before.dropImagesAfterDays, observabilityDays: before.observabilityDays }, after: parsed.data });
  res.json(saved);
});

const cleanupBody = z.object({
  olderThanDays: DAYS,
  dropImagesAfterDays: DAYS.optional(),
  projectId: z.string().optional(),
});

maintenanceRoutes.post('/cleanup/preview', (req, res) => {
  const parsed = cleanupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid clean-up' });
    return;
  }
  res.json(previewHistoryCleanup(parsed.data));
});

maintenanceRoutes.post('/cleanup', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can delete history.' });
    return;
  }
  const parsed = cleanupBody.extend({ confirm: z.literal('DELETE') }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Type DELETE to confirm the clean-up.' });
    return;
  }
  const { confirm: _c, ...request } = parsed.data;
  runHistoryCleanup(request)
    .then((r) => {
      audit(req.user, { projectId: request.projectId ?? null, entity: 'history', action: 'cleanup', after: { ...request, ...r } });
      res.json(r);
    })
    .catch((err: unknown) => res.status(409).json({ error: err instanceof Error ? err.message : 'Clean-up failed' }));
});

/** The database's backups, and a backup on demand. Admins only: a backup holds everything. */
maintenanceRoutes.get('/backups', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can see backups.' });
    return;
  }
  const s = backupSettings();
  res.json({ ...s, backups: listBackups(s.dir), last: backupScheduler.last });
});

maintenanceRoutes.post('/backups', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can make a backup.' });
    return;
  }
  backupNow()
    .then((r) => {
      audit(req.user, { entity: 'backup', action: 'create', after: { file: r.file, bytes: r.bytes } });
      res.status(201).json(r);
    })
    .catch((err: unknown) => res.status(500).json({ error: err instanceof Error ? err.message : 'The backup failed' }));
});
