import { and, eq, inArray } from 'drizzle-orm';
import { alerts, projects } from '@supops/db';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { fetchConnectionAlerts } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { importsAlerts, projectConnections } from './connections.ts';
import { ingestAlert } from './ingest.ts';
import { refreshIncident } from './incidents.ts';
import { settleFlapping } from './flapping.ts';
import { releaseEndedWindows } from './maintenance.ts';

/**
 * Reads firing alerts from every connection that imports them (Alertmanager by
 * default; Prometheus and Grafana when switched on). Nothing has to be configured
 * on the Alertmanager side: SupOps asks, every minute. An alert that is no longer
 * returned has resolved. A failed read changes nothing, so an outage of the
 * backend never "resolves" every alert.
 */

export interface PollStatus {
  at: number;
  ok: boolean;
  firing: number;
  error?: string;
}

/** Last poll per connection, for the UI. */
export const pollStatus = new Map<string, PollStatus>();

const identity = (title: string, labels: Record<string, string>) =>
  `${(labels.alertname || title).toLowerCase()}|${(labels.instance || labels.host || labels.hostname || labels.node || '').toLowerCase().replace(/:\d+$/, '')}`;

export async function pollConnection(projectId: string, conn: Parameters<typeof fetchConnectionAlerts>[0]): Promise<PollStatus> {
  const r = await fetchConnectionAlerts(conn, AbortSignal.timeout(30_000));
  if ('error' in r) {
    const st = { at: Date.now(), ok: false, firing: 0, error: r.error };
    pollStatus.set(conn.id, st);
    return st;
  }
  const source = conn.kind === 'alertmanager' ? 'alertmanager' : conn.kind === 'grafana' ? 'grafana' : 'prometheus';
  for (const a of r.alerts) {
    ingestAlert({
      projectId,
      source,
      connectionId: conn.id,
      fingerprint: `${conn.id}:${a.fingerprint}`,
      title: a.title,
      severity: a.severity,
      summary: a.summary,
      labels: a.link ? { ...a.labels, _link: a.link } : a.labels,
      status: 'firing',
      startsAt: a.startsAt,
      notification: false,
    });
  }
  // Resolve what this connection reported before and no longer does.
  const fps = new Set(r.alerts.map((a) => `${conn.id}:${a.fingerprint}`));
  const ids = new Set(r.alerts.map((a) => identity(a.title, a.labels)));
  const open = db
    .select()
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), eq(alerts.connectionId, conn.id), inArray(alerts.status, [...OPEN_ALERT_STATUSES, 'ignored'])))
    .all();
  const now = new Date();
  for (const row of open) {
    if (fps.has(row.fingerprint) || ids.has(identity(row.title, row.labels ?? {}))) continue;
    db.update(alerts).set({ status: 'resolved', resolvedAt: now, lastSeenAt: now }).where(eq(alerts.id, row.id)).run();
    refreshIncident(row.incidentId);
  }
  const st = { at: Date.now(), ok: true, firing: r.alerts.length };
  pollStatus.set(conn.id, st);
  return st;
}

export class AlertPoller {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private nextAt = 0;

  start(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
    setTimeout(() => void this.tick(), 5_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    // Every tick, not every poll: flapping settles and maintenance ends on time, whatever the poll interval.
    try {
      settleFlapping();
      releaseEndedWindows();
    } catch (err) {
      console.error('alert housekeeping failed:', err);
    }
    if (this.busy || Date.now() < this.nextAt) return;
    this.busy = true;
    this.nextAt = Date.now() + settingsStore.observability().alertPollMs;
    try {
      for (const p of db.select({ id: projects.id }).from(projects).all()) {
        for (const conn of projectConnections(p.id).filter(importsAlerts)) {
          try {
            await pollConnection(p.id, conn);
          } catch (err) {
            console.error(`alert poll of ${conn.slug} failed:`, err);
          }
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export const alertPoller = new AlertPoller();
