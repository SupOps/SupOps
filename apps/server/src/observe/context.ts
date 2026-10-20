import { and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { alertIntegrations, observations, targets, watches } from '@supops/db';
import { coverageBlock } from '@supops/core';
import { isObservabilityKind } from '@supops/shared';
import { db } from '../context.ts';
import { pollStatus } from './alert-poller.ts';

/**
 * What the watcher sees right now about a run's targets: open anomalies and
 * forecasts, in a few lines for the opening message. Observations about a machine
 * in scope, and about anything measured by a connection in scope.
 */
export function observationContext(projectId: string, targetIds: string[]): string | null {
  if (!targetIds.length) return null;
  const rows = db
    .select({ message: observations.message, kind: observations.kind, severity: observations.severity })
    .from(observations)
    .innerJoin(watches, eq(watches.id, observations.watchId))
    .where(
      and(
        eq(observations.projectId, projectId),
        isNull(observations.resolvedAt),
        or(inArray(observations.targetId, targetIds), and(isNull(observations.targetId), inArray(watches.connectionId, targetIds))),
      ),
    )
    .orderBy(desc(observations.severity), desc(observations.lastSeenAt))
    .limit(12)
    .all();
  if (!rows.length) return null;
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  rows.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return [
    "SupOps' metric watcher currently sees (computed from Prometheus history, not verified by you yet):",
    ...rows.map((r) => `- ${r.kind === 'forecast' ? 'Forecast' : 'Unusual'} (${r.severity}): ${r.message}`),
  ].join('\n');
}

/**
 * What the run can see, and what is missing or failing: its observability connections
 * with their current trouble (a failed health check, the last alert poll, a metric
 * query that errors), the machines and clusters in scope, and webhook senders.
 */
export function coverageContext(projectId: string, targetIds: string[]): string {
  const rows = targetIds.length
    ? db.select({ id: targets.id, slug: targets.slug, kind: targets.kind, enabled: targets.enabled, health: targets.healthState }).from(targets).where(inArray(targets.id, targetIds)).all()
    : [];
  const live = rows.filter((r) => r.enabled);
  const obs = live.filter((r) => isObservabilityKind(r.kind));
  const failing = new Map<string, string>();
  if (obs.length) {
    for (const w of db
      .select({ conn: watches.connectionId, error: watches.lastError, title: watches.title })
      .from(watches)
      .where(and(inArray(watches.connectionId, obs.map((o) => o.id)), eq(watches.enabled, true), isNotNull(watches.lastError)))
      .all()) {
      // "More series than checked" is a note about scope, not a failure.
      if (w.error && !w.error.includes('more series') && !failing.has(w.conn)) failing.set(w.conn, `queries fail (${w.title}: ${w.error})`);
    }
  }
  const sources = obs.map((o) => {
    const poll = pollStatus.get(o.id);
    const problem =
      o.health === 'unreachable' ? 'unreachable at the last connection test'
      : poll && !poll.ok ? `the last alert read failed: ${poll.error ?? 'unknown error'}`
      : failing.get(o.id) ?? null;
    return { slug: o.slug, kind: o.kind, problem };
  });
  const alertSenders = db.select({ id: alertIntegrations.id }).from(alertIntegrations).where(and(eq(alertIntegrations.projectId, projectId), eq(alertIntegrations.enabled, true))).all().length;
  return coverageBlock({
    sources,
    machines: live.filter((r) => r.kind === 'ssh').length,
    clusters: live.filter((r) => r.kind === 'k8s').length,
    alertSenders,
  });
}
