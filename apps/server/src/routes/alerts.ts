import { Router } from 'express';
import { and, desc, eq, inArray, isNotNull, isNull, not, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alertIntegrations, alerts, incidents, maintenanceWindows } from '@supops/db';
import type { AlertStatus } from '@supops/shared';
import { loadTargets, scopeAlert } from '@supops/core';
import { db } from '../context.ts';
import { startRun } from '../services/start-run.ts';
import { refreshIncident } from '../observe/incidents.ts';
import { startIncidentRun } from '../observe/triage.ts';

export const alertRoutes = Router();

/** List a project's alerts, newest first, with the facets the UI filters on. */
alertRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const status = typeof req.query.status === 'string' ? (req.query.status as AlertStatus) : null;
  const channel = typeof req.query.channel === 'string' ? req.query.channel : null;

  const where = [eq(alerts.projectId, projectId)];
  // Default view: what still needs a decision. `status=all` shows history too.
  // Alerts muted by a maintenance window have their own view; they are not news.
  const muted = and(isNotNull(alerts.maintenanceId), isNull(alerts.incidentId), isNull(alerts.resolvedAt));
  if ((status as string) === 'maintenance') where.push(muted!);
  else if (status && (status as string) !== 'all') where.push(eq(alerts.status, status));
  else if (!status) where.push(inArray(alerts.status, ['new', 'investigating']));
  if (status === 'new' || status === 'investigating' || !status) where.push(not(muted!));
  if (channel) where.push(eq(alerts.channelId, channel));

  const rows = db
    .select()
    .from(alerts)
    .where(and(...where))
    .orderBy(desc(alerts.receivedAt))
    .limit(200)
    .all();

  // Facets are computed over the whole project, not the filtered view, so the chips
  // keep showing their counts after you click one.
  const byStatus = db
    .select({ status: alerts.status, n: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), not(muted!)))
    .groupBy(alerts.status)
    .all();
  const mutedCount = db.select({ n: sql<number>`count(*)` }).from(alerts).where(and(eq(alerts.projectId, projectId), muted!)).get()?.n ?? 0;
  const windowIds = [...new Set(rows.map((r) => r.maintenanceId).filter((x): x is string => !!x))];
  const windowNames = new Map(
    (windowIds.length ? db.select({ id: maintenanceWindows.id, name: maintenanceWindows.name }).from(maintenanceWindows).where(inArray(maintenanceWindows.id, windowIds)).all() : []).map((w) => [w.id, w.name]),
  );
  const channels = db
    .selectDistinct({ channelId: alerts.channelId, channelName: alerts.channelName })
    .from(alerts)
    .where(eq(alerts.projectId, projectId))
    .all();

  // The automatic diagnosis of each alert's incident, so the list shows what is known.
  const incIds = [...new Set(rows.map((r) => r.incidentId).filter((x): x is string => !!x))];
  const diag = new Map(
    (incIds.length ? db.select({ id: incidents.id, triageState: incidents.triageState, triageNote: incidents.triageNote, rootCause: incidents.rootCause, confidence: incidents.confidence, runId: incidents.runId }).from(incidents).where(inArray(incidents.id, incIds)).all() : [])
      .map((d) => [d.id, d]),
  );

  const senderIds = [...new Set(rows.map((r) => r.integrationId).filter((x): x is string => !!x))];
  const senders = new Map(
    (senderIds.length ? db.select({ id: alertIntegrations.id, name: alertIntegrations.name }).from(alertIntegrations).where(inArray(alertIntegrations.id, senderIds)).all() : []).map((s) => [s.id, s.name]),
  );

  res.json({
    alerts: rows.map((r) => ({
      ...r,
      sourceName: r.integrationId ? senders.get(r.integrationId) ?? null : null,
      maintenanceName: r.maintenanceId ? windowNames.get(r.maintenanceId) ?? null : null,
      diagnosis: r.incidentId ? diag.get(r.incidentId) ?? null : null,
    })),
    statusCounts: { ...Object.fromEntries(byStatus.map((r) => [r.status, r.n])), maintenance: mutedCount },
    channels: channels.filter((c) => c.channelId),
  });
});

/** Badge count: how many alerts are waiting on a decision. */
alertRoutes.get('/count', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), eq(alerts.status, 'new'), isNull(alerts.maintenanceId)))
    .get();
  res.json({ new: row?.n ?? 0 });
});

interface ScopeNote {
  slugs: string[];
  reason: string;
  by: 'label' | 'text' | 'channel' | null;
}

/**
 * The run's task. `scope` names the machine(s) the alert resolved to and how, so
 * the agent starts there instead of rediscovering it -- the rest of the scope (the
 * jump, the machines behind it) is there so it can reach them, not to be swept.
 */
function buildAlertTask(alert: typeof alerts.$inferSelect, scope?: ScopeNote): string {
  const labels = (alert.labels as Record<string, string> | null) ?? {};
  const notable = Object.entries(labels)
    .filter(([k]) => !k.startsWith('_') && !['summary', 'description'].includes(k))
    .slice(0, 12)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    `An alert fired${alert.channelName ? ` in Slack ${alert.channelName}` : ''} (severity: ${alert.severity}).`,
    `Alert: ${alert.title}`,
    alert.summary ? `Details: ${alert.summary}` : '',
    notable ? `Labels: ${notable}` : '',
    scope?.by === 'channel'
      ? `SupOps narrowed this run using ${scope.reason}; the alert does not name a machine, so work out which one it is about from the alert before checking anything.`
      : scope
        ? `SupOps matched this alert to ${scope.slugs.join(', ')} using ${scope.reason}. Start there; if the evidence points to another machine in scope, say so and confirm it first.`
        : '',
    'Investigate the root cause on the affected host and remediate where it is safe to do so. If remediation is risky, stop and explain what you would do.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Start a triage investigation from an alert, scoped to the matched host if we can find one. */
alertRoutes.post('/:id/investigate', (req, res) => {
  const alert = db.select().from(alerts).where(eq(alerts.id, req.params.id)).get();
  if (!alert) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }

  // The read-only diagnosis starts by itself when the alert arrives. Investigate
  // builds on it: while it is still running, open it; once it is done, start the fix,
  // where every change waits for a person's approval.
  const inc = alert.incidentId ? db.select().from(incidents).where(eq(incidents.id, alert.incidentId)).get() : undefined;
  if (inc) {
    if (inc.triageState === 'evidence' || (inc.triageState === 'running' && inc.runId)) {
      res.json({ diagnosing: true, incidentId: inc.id, run: inc.runId ? { id: inc.runId } : null });
      return;
    }
    const r = startIncidentRun(inc, { mode: 'fix', startedBy: req.user?.id ?? null });
    if (!r.ok) {
      res.status(r.code).json({ error: r.error });
      return;
    }
    res.status(201).json({ run: { id: r.runId }, incidentId: inc.id });
    return;
  }

  const triage =
    db.select().from(agents).where(and(eq(agents.projectId, alert.projectId), eq(agents.slug, 'triage'))).get() ??
    db.select().from(agents).where(eq(agents.projectId, alert.projectId)).get();
  if (!triage) {
    res.status(409).json({ error: 'This project has no agent to run the investigation.' });
    return;
  }

  // Scope the run the way a person would in Investigate (see scopeAlert): the machine
  // the alert names, plus its jump or the machines behind it so they are reachable.
  // No match leaves the scope empty, which gives the run every target.
  const available = loadTargets(db, alert.projectId);
  const scope = scopeAlert(
    { labels: alert.labels as Record<string, string> | null, title: alert.title, summary: alert.summary, channelName: alert.channelName },
    available,
  );
  const matches = scope.targets;
  const targetIds = matches.length > 0 ? matches.map((t) => t.id) : undefined;
  // Name what the alert itself pointed at, not the jump or siblings added for reach.
  const named = scope.matched.slice(0, 6).map((t) => t.slug);

  const result = startRun({
    projectId: alert.projectId,
    agentId: triage.id,
    task: buildAlertTask(alert, scope.reason ? { slugs: named, reason: scope.reason, by: scope.by } : undefined),
    targetIds,
    trigger: 'alert',
    triggerPayload: { alertId: alert.id, fingerprint: alert.fingerprint },
    startedBy: req.user?.id ?? null,
  });
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }

  db.update(alerts)
    .set({ status: 'investigating', runId: result.run.id, decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(eq(alerts.id, alert.id))
    .run();
  // The incident it belongs to shows this investigation too, unless it has its own.
  if (alert.incidentId) {
    db.update(incidents)
      .set({ runId: result.run.id, triageState: 'running', triageNote: null })
      .where(and(eq(incidents.id, alert.incidentId), isNull(incidents.runId)))
      .run();
  }

  res.status(201).json({ run: result.run, scopedTo: matches.map((t) => t.slug) });
});

const decisionBody = z.object({ projectId: z.string().optional() });

/**
 * Ignore: out of the queue, kept as history (cleaned up with the rest after the
 * observability retention). An alert read from a connection stays ignored while
 * that connection still reports it.
 */
alertRoutes.post('/:id/ignore', (req, res) => {
  decisionBody.safeParse(req.body);
  const row = db
    .update(alerts)
    .set({ status: 'ignored', decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(eq(alerts.id, req.params.id))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  refreshIncident(row.incidentId);
  res.json({ ok: true });
});
