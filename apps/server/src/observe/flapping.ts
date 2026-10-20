import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { alerts, incidents } from '@supops/db';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { hasSettled, isFlapping, type AlertOccurrence } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { enqueueTriage, FLAPPING_NOTE, incidentIsFlapping } from './triage.ts';

type AlertRow = typeof alerts.$inferSelect;

/** Every occurrence of this alert (same fingerprint) that could fall in the window. */
function history(projectId: string, fingerprint: string, since: Date): AlertOccurrence[] {
  return db
    .select({ receivedAt: alerts.receivedAt, resolvedAt: alerts.resolvedAt })
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), eq(alerts.fingerprint, fingerprint), or(gt(alerts.receivedAt, since), gt(alerts.resolvedAt, since), isNull(alerts.resolvedAt))))
    .all()
    .map((r) => ({ firedAt: r.receivedAt.getTime(), resolvedAt: r.resolvedAt?.getTime() ?? null }));
}

const opts = () => {
  const cfg = settingsStore.observability();
  return { changes: cfg.flapChanges, windowMs: cfg.flapWindowMin * 60_000 };
};

/** After an alert fires again: is it flapping now? Marks it, and returns the answer. */
export function markIfFlapping(row: AlertRow, now = Date.now()): boolean {
  const o = opts();
  if (!isFlapping(history(row.projectId, row.fingerprint, new Date(now - o.windowMs)), now, o)) return false;
  db.update(alerts).set({ flapping: true, flappingSince: row.flappingSince ?? new Date(now) }).where(eq(alerts.id, row.id)).run();
  return true;
}

/**
 * Alerts that stopped flapping: quiet for the whole window. Clears the mark, and an
 * incident whose diagnosis was held for it is diagnosed now, once. Run every tick.
 */
export function settleFlapping(now = Date.now()): string[] {
  const o = opts();
  const flapping = db.select().from(alerts).where(eq(alerts.flapping, true)).all();
  const settled: string[] = [];
  for (const row of flapping) {
    const open = (OPEN_ALERT_STATUSES as readonly string[]).includes(row.status);
    if (open && !hasSettled(history(row.projectId, row.fingerprint, new Date(now - o.windowMs)), now, o.windowMs)) continue;
    db.update(alerts).set({ flapping: false, flappingSince: null }).where(eq(alerts.id, row.id)).run();
    settled.push(row.id);
    if (!open || !row.incidentId || incidentIsFlapping(row.incidentId)) continue;
    const inc = db.select().from(incidents).where(eq(incidents.id, row.incidentId)).get();
    if (inc?.status === 'open' && inc.triageState === 'skipped' && inc.triageNote === FLAPPING_NOTE) {
      db.update(incidents).set({ triageState: 'none', triageNote: null }).where(eq(incidents.id, inc.id)).run();
      enqueueTriage(inc.id);
    }
  }
  return settled;
}
