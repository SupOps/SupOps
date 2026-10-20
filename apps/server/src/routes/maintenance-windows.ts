import { Router } from 'express';
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { alerts, maintenanceWindows, users } from '@supops/db';
import { alertMatchLabels, formatMatchers, matchesAll, OPEN_ALERT_STATUSES, parseMatchers } from '@supops/shared';
import { validSlot, windowActive } from '@supops/core';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { asWindow } from '../observe/maintenance.ts';

/**
 * Maintenance windows. Anyone signed in can plan one (it only quiets alerts, it never
 * changes anything), and every change is in the audit log with who made it.
 */
export const maintenanceWindowRoutes = Router();

type Row = typeof maintenanceWindows.$inferSelect;

const slot = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  start: z.string().regex(/^\d{1,2}:\d{2}$/),
  end: z.string().regex(/^\d{1,2}:\d{2}$/),
  timezone: z.string().min(1).max(64),
});

const body = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  reason: z.string().trim().max(500).optional(),
  matchers: z.string().max(4000),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
  recurrence: slot.nullish(),
});

/** Parse and check everything a window needs; an error message a person can act on, or the values. */
function validate(b: z.infer<typeof body>) {
  const parsed = parseMatchers(b.matchers);
  if (!parsed.ok) return { error: `Matchers: ${parsed.error}` };
  if (!parsed.matchers.length) return { error: 'Add at least one matcher, e.g. env="prod": a window never quiets every alert.' };
  if (b.endsAt <= b.startsAt) return { error: 'The end must be after the start.' };
  if (b.endsAt <= Date.now()) return { error: 'The end is in the past.' };
  if (!b.recurrence && b.endsAt - b.startsAt > 31 * 86_400_000) return { error: 'A one-off window can last at most 31 days. For regular work, make it weekly.' };
  if (b.recurrence) {
    const why = validSlot(b.recurrence);
    if (why) return { error: why };
    if (b.endsAt - b.startsAt > 366 * 86_400_000) return { error: 'A weekly window can repeat for at most a year.' };
  }
  return { matchers: parsed.matchers };
}

function view(rows: Row[], now = Date.now()) {
  const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.cancelledBy]).filter((x): x is string => !!x))];
  const names = new Map(ids.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)).all().map((u) => [u.id, u.name]) : []);
  const muted = rows.length
    ? db
        .select({ id: alerts.maintenanceId, n: sql<number>`count(*)` })
        .from(alerts)
        .where(inArray(alerts.maintenanceId, rows.map((r) => r.id)))
        .groupBy(alerts.maintenanceId)
        .all()
    : [];
  return rows.map((r) => {
    const w = asWindow(r);
    const state = r.cancelledAt ? (r.cancelledAt.getTime() <= r.startsAt.getTime() ? 'cancelled' : 'ended') : now >= w.endsAt ? 'ended' : windowActive(w, now) ? 'active' : now < w.startsAt ? 'scheduled' : 'waiting';
    return {
      ...r,
      matcherText: formatMatchers(r.matchers),
      state,
      alertsMuted: muted.find((m) => m.id === r.id)?.n ?? 0,
      createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
      cancelledByName: r.cancelledBy ? names.get(r.cancelledBy) ?? null : null,
    };
  });
}

maintenanceWindowRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  // Current and future windows, and those that ended in the last 14 days.
  const since = new Date(Date.now() - 14 * 86_400_000);
  res.json(view(db.select().from(maintenanceWindows).where(and(eq(maintenanceWindows.projectId, projectId), gt(maintenanceWindows.endsAt, since))).orderBy(desc(maintenanceWindows.startsAt)).all()));
});

/** Which alerts these matchers catch: open ones now, and how many fired in the last day. Nothing is stored. */
maintenanceWindowRoutes.post('/preview', (req, res) => {
  const b = z.object({ projectId: z.string().min(1), matchers: z.string().max(4000) }).safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: 'projectId and matchers are required' });
    return;
  }
  const parsed = parseMatchers(b.data.matchers);
  if (!parsed.ok) {
    res.json({ ok: false, error: parsed.error });
    return;
  }
  if (!parsed.matchers.length) {
    res.json({ ok: false, error: 'Add at least one matcher.' });
    return;
  }
  const recent = db
    .select({ id: alerts.id, title: alerts.title, severity: alerts.severity, source: alerts.source, labels: alerts.labels, status: alerts.status, resolvedAt: alerts.resolvedAt })
    .from(alerts)
    .where(and(eq(alerts.projectId, b.data.projectId), gt(alerts.receivedAt, new Date(Date.now() - 86_400_000))))
    .all()
    .filter((a) => matchesAll(parsed.matchers, alertMatchLabels(a)));
  const open = recent.filter((a) => (OPEN_ALERT_STATUSES as readonly string[]).includes(a.status) && !a.resolvedAt);
  res.json({ ok: true, lastDay: recent.length, openNow: open.length, sample: [...new Set(recent.map((a) => a.title))].slice(0, 8) });
});

maintenanceWindowRoutes.post('/', (req, res) => {
  const b = body.safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid maintenance window' });
    return;
  }
  const v = validate(b.data);
  if ('error' in v) {
    res.status(400).json({ error: v.error });
    return;
  }
  const row = db
    .insert(maintenanceWindows)
    .values({
      projectId: b.data.projectId,
      name: b.data.name,
      reason: b.data.reason || null,
      matchers: v.matchers,
      startsAt: new Date(b.data.startsAt),
      endsAt: new Date(b.data.endsAt),
      recurrence: b.data.recurrence ?? null,
      createdBy: req.user?.id ?? null,
    })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'maintenance_window', entityId: row.id, action: 'create', after: { name: row.name, matchers: formatMatchers(row.matchers), startsAt: row.startsAt, endsAt: row.endsAt, recurrence: row.recurrence } });
  res.status(201).json(view([row])[0]);
});

/** End a window now (or cancel one that has not started). Its muted alerts that still fire are processed at the next tick. */
maintenanceWindowRoutes.post('/:id/end', (req, res) => {
  const row = db
    .update(maintenanceWindows)
    .set({ cancelledAt: new Date(), cancelledBy: req.user?.id ?? null })
    .where(and(eq(maintenanceWindows.id, req.params.id), isNull(maintenanceWindows.cancelledAt)))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'No running or planned window with that id.' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'maintenance_window', entityId: row.id, action: 'end', after: { name: row.name } });
  res.json(view([row])[0]);
});

/** Alerts this window is muting right now. */
maintenanceWindowRoutes.get('/:id/alerts', (req, res) => {
  res.json(
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.maintenanceId, req.params.id), isNotNull(alerts.maintenanceId)))
      .orderBy(desc(alerts.receivedAt))
      .limit(200)
      .all(),
  );
});
