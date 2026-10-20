import { and, eq, inArray } from 'drizzle-orm';
import { alerts, incidents } from '@supops/db';
import type { AlertSeverity, AlertSource } from '@supops/shared';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db, settingsStore } from '../context.ts';
import { alertTargets, attachToIncident, reattachRecurring, refreshIncident, reopenIncident, worse } from './incidents.ts';
import { markIfFlapping } from './flapping.ts';
import { muteIfInMaintenance } from './maintenance.ts';
import { lapseAcknowledgement } from './incident-events.ts';
import { applyCatalogue, applyExtraction } from './enrich.ts';
import { enqueueTriage } from './triage.ts';

/**
 * Every alert enters SupOps here, whatever brought it: a Slack message, a poll of an
 * Alertmanager/Prometheus/Grafana connection, or a forecast. One place decides what
 * is new, what is a repeat, what resolved, and which incident it belongs to.
 */
export interface IncomingAlert {
  projectId: string;
  source: AlertSource;
  fingerprint: string;
  title: string;
  severity: AlertSeverity;
  summary: string | null;
  labels: Record<string, string>;
  status: 'firing' | 'resolved';
  startsAt?: number | null;
  rawPayload?: unknown;
  /** Set for alerts read from a connection. */
  connectionId?: string | null;
  /** Set for alerts pushed by a webhook sender. */
  integrationId?: string | null;
  /** What the alert says (see contentHash): an identical repeat is counted, not stored. */
  contentHash?: string | null;
  slack?: { channelId: string; channelName: string; ts?: string | null; permalink?: string | null };
  /** A repeat notification (Slack) bumps the count; a poll that still sees it does not. */
  notification: boolean;
}

type AlertRow = typeof alerts.$inferSelect;

/** Same alert seen through two routes (Slack, a connection, a webhook): its name and host. */
const identity = (title: string, labels: Record<string, string>) =>
  `${(labels.alertname || title).toLowerCase()}|${(labels.instance || labels.host || labels.hostname || labels.node || '').toLowerCase().replace(/:\d+$/, '')}`;

/** Is this alert's incident ignored right now (and not yet due to be checked again)? */
function underIgnore(row: AlertRow): boolean {
  if (!row.incidentId) return false;
  const inc = db.select({ status: incidents.status, until: incidents.ignoredUntil }).from(incidents).where(eq(incidents.id, row.incidentId)).get();
  return inc?.status === 'ignored' && (!inc.until || inc.until.getTime() > Date.now());
}

/** Which way an alert arrives: each connection and each webhook sender is its own route. */
const routeOf = (r: { connectionId?: string | null; integrationId?: string | null }) =>
  r.connectionId ? `conn:${r.connectionId}` : r.integrationId ? `hook:${r.integrationId}` : 'slack';

function findExisting(a: IncomingAlert): AlertRow | undefined {
  const exact = db
    .select()
    .from(alerts)
    .where(and(eq(alerts.projectId, a.projectId), eq(alerts.fingerprint, a.fingerprint), inArray(alerts.status, [...OPEN_ALERT_STATUSES, 'ignored'])))
    .get();
  // An ignored alert stays the same alert while its connection still reports it, or
  // while its incident's ignore lasts; after that a repeat is news again.
  if (exact && (exact.status !== 'ignored' || a.connectionId || underIgnore(exact))) return exact;
  // The other route's copy: an open alert that arrived another way with the same name and host.
  const id = identity(a.title, a.labels);
  if (id.endsWith('|')) return undefined;
  const route = routeOf(a);
  return db
    .select()
    .from(alerts)
    .where(and(eq(alerts.projectId, a.projectId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .all()
    // Two connections each report their own alerts (and resolve them by not reporting
    // them), so they are never merged with each other; Slack and webhooks join either.
    .find((r) => routeOf(r) !== route && !(r.connectionId && a.connectionId) && identity(r.title, r.labels ?? {}) === id);
}

export function ingestAlert(incoming: IncomingAlert): { alertId: string | null; created: boolean; resolved: boolean; repeat?: boolean } {
  // Labels pulled out of the alert's own text (extraction rules), before anything
  // looks at its labels. A resolve needs none: it only has to find its alert.
  const extracted = incoming.status === 'firing' ? applyExtraction(incoming.projectId, incoming) : { labels: incoming.labels, origin: {} };
  const a: IncomingAlert = { ...incoming, labels: extracted.labels };
  const existing = findExisting(a);
  const now = new Date();

  if (a.status === 'resolved') {
    if (!existing) return { alertId: null, created: false, resolved: false };
    // A connection is the better witness: a "resolved" from Slack or a webhook does not
    // close an alert the connection still reports, the next poll decides.
    if (!a.connectionId && existing.connectionId) return { alertId: existing.id, created: false, resolved: false };
    db.update(alerts).set({ status: 'resolved', resolvedAt: now, lastSeenAt: now }).where(eq(alerts.id, existing.id)).run();
    refreshIncident(existing.incidentId);
    return { alertId: existing.id, created: false, resolved: true };
  }

  if (existing) {
    // Worse than when it was ignored: an ignore never hides an escalation.
    if (existing.status === 'ignored' && existing.incidentId && underIgnore(existing) && worse(a.severity, existing.severity)) {
      reopenIncident(existing.incidentId);
      enqueueTriage(existing.incidentId);
    }
    // Worse than before: the incident is worse too, and an acknowledgement no longer covers it.
    if (existing.incidentId && existing.status !== 'ignored' && worse(a.severity, existing.severity)) {
      const inc = db.select({ severity: incidents.severity, pinned: incidents.severityPinned }).from(incidents).where(eq(incidents.id, existing.incidentId)).get();
      if (inc && !inc.pinned && worse(a.severity, inc.severity)) db.update(incidents).set({ severity: a.severity }).where(eq(incidents.id, existing.incidentId)).run();
      lapseAcknowledgement(existing.incidentId, `${a.title} became ${a.severity}`);
    }
    // An exact repeat (same alert, same content): counted, nothing else changes.
    if (a.contentHash && existing.contentHash === a.contentHash) {
      db.update(alerts)
        .set({ count: a.notification ? existing.count + 1 : existing.count, lastSeenAt: now })
        .where(eq(alerts.id, existing.id))
        .run();
      return { alertId: existing.id, created: false, resolved: false, repeat: true };
    }
    db.update(alerts)
      .set({
        count: a.notification ? existing.count + 1 : existing.count,
        lastSeenAt: now,
        severity: a.severity,
        summary: a.summary ?? existing.summary,
        // Keep the richer label set: a connection's labels are complete, Slack's parsed.
        labels: a.connectionId || a.integrationId || !existing.connectionId ? { ...(existing.labels ?? {}), ...a.labels } : existing.labels,
        ...(a.contentHash ? { contentHash: a.contentHash } : {}),
        ...(a.integrationId && !existing.integrationId ? { integrationId: a.integrationId } : {}),
        ...(a.connectionId && !existing.connectionId ? { connectionId: a.connectionId, startsAt: a.startsAt ? new Date(a.startsAt) : existing.startsAt } : {}),
        ...(a.slack && !existing.slackPermalink ? { channelId: a.slack.channelId, channelName: a.slack.channelName, slackTs: a.slack.ts ?? null, slackPermalink: a.slack.permalink ?? null } : {}),
        ...(a.rawPayload !== undefined && a.notification ? { rawPayload: a.rawPayload } : {}),
      })
      .where(eq(alerts.id, existing.id))
      .run();
    return { alertId: existing.id, created: false, resolved: false };
  }

  // Who owns it, from the service catalogue.
  const catalogue = applyCatalogue(a.projectId, a.labels, alertTargets(a.projectId, { labels: a.labels, title: a.title, summary: a.summary, channelName: a.slack?.channelName ?? null }));
  const enriched = { ...extracted.origin, ...catalogue.origin };
  const row = db
    .insert(alerts)
    .values({
      enriched: Object.keys(enriched).length ? enriched : null,
      projectId: a.projectId,
      source: a.source,
      connectionId: a.connectionId ?? null,
      integrationId: a.integrationId ?? null,
      contentHash: a.contentHash ?? null,
      channelId: a.slack?.channelId ?? null,
      channelName: a.slack?.channelName ?? null,
      fingerprint: a.fingerprint,
      title: a.title,
      severity: a.severity,
      status: 'new',
      summary: a.summary,
      labels: catalogue.labels,
      rawPayload: a.rawPayload ?? null,
      slackTs: a.slack?.ts ?? null,
      slackPermalink: a.slack?.permalink ?? null,
      startsAt: a.startsAt ? new Date(a.startsAt) : null,
      receivedAt: now,
      lastSeenAt: now,
    })
    .returning()
    .get();
  markIfFlapping(row);
  // Planned work: stored and shown, but no incident or diagnosis until the window ends.
  if (muteIfInMaintenance(row)) return { alertId: row.id, created: true, resolved: false };
  // Fired again soon after resolving: the same problem as before, in the same incident.
  if (reattachRecurring(row, settingsStore.observability().flapWindowMin * 60_000)) return { alertId: row.id, created: true, resolved: false };
  const { incident, created } = attachToIncident(row);
  if (created) enqueueTriage(incident.id);
  return { alertId: row.id, created: true, resolved: false };
}
