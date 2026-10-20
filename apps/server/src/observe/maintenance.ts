import { and, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { alerts, maintenanceWindows } from '@supops/db';
import { alertMatchLabels, OPEN_ALERT_STATUSES } from '@supops/shared';
import { mutingWindow, windowActive, type WindowLike } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { attachToIncident, reattachRecurring } from './incidents.ts';
import { enqueueTriage } from './triage.ts';

type AlertRow = typeof alerts.$inferSelect;
type WindowRow = typeof maintenanceWindows.$inferSelect;

export const asWindow = (w: WindowRow): WindowLike & { id: string; name: string } => ({
  id: w.id,
  name: w.name,
  matchers: w.matchers,
  startsAt: w.startsAt.getTime(),
  endsAt: w.endsAt.getTime(),
  recurrence: w.recurrence ?? null,
  cancelledAt: w.cancelledAt?.getTime() ?? null,
});

/** Windows that could be active now: started, not ended, not cancelled. */
export function currentWindows(projectId: string, at = Date.now()): ReturnType<typeof asWindow>[] {
  const now = new Date(at);
  return db
    .select()
    .from(maintenanceWindows)
    .where(and(eq(maintenanceWindows.projectId, projectId), lte(maintenanceWindows.startsAt, now), gt(maintenanceWindows.endsAt, now), isNull(maintenanceWindows.cancelledAt)))
    .all()
    .map(asWindow)
    .filter((w) => windowActive(w, at));
}

/** A new alert during planned work: stored, marked, and kept out of incidents. Returns the window. */
export function muteIfInMaintenance(row: AlertRow, at = Date.now()): { id: string; name: string } | null {
  const w = mutingWindow(currentWindows(row.projectId, at), alertMatchLabels(row), at);
  if (!w) return null;
  db.update(alerts).set({ maintenanceId: w.id }).where(eq(alerts.id, row.id)).run();
  return { id: w.id, name: w.name };
}

/**
 * Windows that ended (or were ended early, or whose weekly slot is over): their alerts
 * that are still firing are processed now, as if they had just arrived -- grouped into
 * an incident and diagnosed. Those that resolved during the window stay as history.
 * Run every tick.
 */
export function releaseEndedWindows(at = Date.now()): string[] {
  const muted = db
    .select()
    .from(alerts)
    .where(and(isNotNull(alerts.maintenanceId), isNull(alerts.incidentId), isNull(alerts.resolvedAt), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .all();
  if (!muted.length) return [];
  const windowIds = [...new Set(muted.map((a) => a.maintenanceId!))];
  const windows = new Map(db.select().from(maintenanceWindows).where(inArray(maintenanceWindows.id, windowIds)).all().map((w) => [w.id, asWindow(w)]));
  const released: string[] = [];
  const recurWindow = settingsStore.observability().flapWindowMin * 60_000;
  for (const a of muted) {
    const w = windows.get(a.maintenanceId!);
    if (w && windowActive(w, at)) continue;
    // Muted by another window that is still active? It stays muted, under that one.
    const other = mutingWindow(currentWindows(a.projectId, at), alertMatchLabels(a), at);
    if (other) {
      db.update(alerts).set({ maintenanceId: other.id }).where(eq(alerts.id, a.id)).run();
      continue;
    }
    db.update(alerts).set({ maintenanceId: null }).where(eq(alerts.id, a.id)).run();
    const row = { ...a, maintenanceId: null };
    released.push(a.id);
    if (reattachRecurring(row, recurWindow)) continue;
    const { incident, created } = attachToIncident(row);
    if (created) enqueueTriage(incident.id);
  }
  return released;
}
