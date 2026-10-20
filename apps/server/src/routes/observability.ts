import { Router } from 'express';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts, correlationRules, evidence, incidentEvents, incidents, observations, runs, targets, toolCalls, users, watchSeries, watches } from '@supops/db';
import { loadTargets, parseSeriesKey, runChecks, SIGNALS, drainPatterns, obsRequest } from '@supops/core';
import { formatValue } from '@supops/shared';
import { isAdmin } from '../auth.ts';
import { db, settingsStore } from '../context.ts';
import { audit } from '../services/audit.ts';
import { startRun } from '../services/start-run.ts';
import { importsAlerts, projectConnections, watchesMetrics } from '../observe/connections.ts';
import { forgetAdaptive } from '../observe/adaptive.ts';
import { pollConnection, pollStatus } from '../observe/alert-poller.ts';
import { dismissSuggestion, mergeIncidents, reopenIncident, splitIncident, suggestMerges } from '../observe/incidents.ts';
import { incidentMapView } from '../servicemap/context.ts';
import { recordIncidentEvent } from '../observe/incident-events.ts';
import { enqueueTriage, gatherEvidence, latestFixRun, startIncidentRun } from '../observe/triage.ts';
import { cachedPrediction, combinedChart, discover, reevaluateWatch, resolveWatchObservations, seriesChart, watchConnection, watcher, watchSeriesList } from '../observe/watcher.ts';

/**
 * Observability: incidents (grouped alerts and predictions), their evidence and
 * investigations, the signals SupOps watches, and what it currently notices.
 */
export const observabilityRoutes = Router();

const projectOf = (req: { query: Record<string, unknown> }) => (typeof req.query.projectId === 'string' ? req.query.projectId : '');

function requireProject(req: Parameters<Parameters<typeof observabilityRoutes.get>[1]>[0], res: Parameters<Parameters<typeof observabilityRoutes.get>[1]>[1]): string | null {
  const p = projectOf(req as never);
  if (!p) {
    res.status(400).json({ error: 'projectId is required' });
    return null;
  }
  return p;
}

const SEV = sql`case ${incidents.severity} when 'critical' then 0 when 'warning' then 1 when 'info' then 2 else 3 end`;

/** Everything the Overview tab shows, in one request. */
observabilityRoutes.get('/overview', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const open = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'), eq(incidents.held, false)))
    .orderBy(SEV, desc(incidents.lastSeenAt))
    .limit(20)
    .all();
  const counts = db
    .select({ incidentId: alerts.incidentId, n: sql<number>`count(*)` })
    .from(alerts)
    .where(inArray(alerts.incidentId, open.map((i) => i.id).concat('-')))
    .groupBy(alerts.incidentId)
    .all();
  const obs = db
    .select({
      id: observations.id, kind: observations.kind, severity: observations.severity, message: observations.message,
      targetId: observations.targetId, watchId: observations.watchId, series: observations.series, details: observations.details,
      startedAt: observations.startedAt, incidentId: observations.incidentId, unit: watches.unit, title: watches.title,
    })
    .from(observations)
    .innerJoin(watches, eq(watches.id, observations.watchId))
    .where(and(eq(observations.projectId, projectId), isNull(observations.resolvedAt)))
    .orderBy(desc(observations.lastSeenAt))
    .limit(100)
    .all();
  const conns = projectConnections(projectId);
  const ws = db.select().from(watches).where(eq(watches.projectId, projectId)).all();
  const owners = userNames(open.map((i) => i.assigneeId));
  res.json({
    incidents: open.map((i) => ({ ...i, alertCount: counts.find((c) => c.incidentId === i.id)?.n ?? 0, assigneeName: i.assigneeId ? owners.get(i.assigneeId) ?? null : null })),
    observations: obs,
    connections: conns.map((c) => ({
      id: c.id, slug: c.slug, kind: c.kind,
      importsAlerts: importsAlerts(c), watches: watchesMetrics(c),
      poll: pollStatus.get(c.id) ?? null,
      watchCount: ws.filter((w) => w.connectionId === c.id && w.enabled).length,
      watchErrors: ws.filter((w) => w.connectionId === c.id && w.enabled && w.lastError && !w.lastError.includes('more series')).length,
      lastSampledAt: ws.filter((w) => w.connectionId === c.id).reduce<number | null>((m, w) => (w.lastRunAt && (!m || w.lastRunAt.getTime() > m) ? w.lastRunAt.getTime() : m), null),
    })),
    settings: settingsStore.observability(),
    watched: db
      .select({ n: sql<number>`count(*)` })
      .from(watchSeries)
      .innerJoin(watches, eq(watches.id, watchSeries.watchId))
      .where(and(eq(watches.projectId, projectId), eq(watches.enabled, true)))
      .get()?.n ?? 0,
  });
});

observabilityRoutes.get('/count', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const n = db.select({ n: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'), eq(incidents.held, false))).get()?.n ?? 0;
  res.json({ open: n });
});

observabilityRoutes.get('/incidents', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const status = req.query.status === 'resolved' ? 'resolved' : req.query.status === 'ignored' ? 'ignored' : req.query.status === 'all' ? null : 'open';
  const rows = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, projectId), isNull(incidents.mergedInto), eq(incidents.held, false), ...(status ? [eq(incidents.status, status)] : [])))
    .orderBy(desc(incidents.openedAt))
    .limit(200)
    .all();
  const counts = db
    .select({ incidentId: alerts.incidentId, n: sql<number>`count(*)` })
    .from(alerts)
    .where(inArray(alerts.incidentId, rows.map((i) => i.id).concat('-')))
    .groupBy(alerts.incidentId)
    .all();
  const names = userNames(rows.flatMap((i) => [i.assigneeId, i.acknowledgedBy]));
  res.json(
    rows.map((i) => ({
      ...i,
      alertCount: counts.find((c) => c.incidentId === i.id)?.n ?? 0,
      assigneeName: i.assigneeId ? names.get(i.assigneeId) ?? null : null,
      acknowledgedByName: i.acknowledgedBy ? names.get(i.acknowledgedBy) ?? null : null,
    })),
  );
});

function userNames(ids: Array<string | null | undefined>): Map<string, string> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  return new Map(want.length ? db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want)).all().map((u) => [u.id, u.name]) : []);
}

/** Who an incident can be assigned to: every active user, by name. */
observabilityRoutes.get('/assignees', (_req, res) => {
  res.json(db.select({ id: users.id, name: users.name }).from(users).where(isNull(users.disabledAt)).orderBy(asc(users.name)).all());
});

observabilityRoutes.get('/incidents/:id', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).orderBy(asc(alerts.receivedAt)).all();
  const ev = db.select().from(evidence).where(eq(evidence.incidentId, inc.id)).all();
  ev.sort((a, b) => (a.ref === '-' ? 1 : b.ref === '-' ? -1 : Number(a.ref.slice(1)) - Number(b.ref.slice(1))));
  const obs = db.select().from(observations).where(eq(observations.incidentId, inc.id)).all();
  const run = inc.runId ? db.select({ id: runs.id, status: runs.status, title: runs.title, startedAt: runs.startedAt, endedAt: runs.endedAt, policySnapshot: runs.policySnapshot }).from(runs).where(eq(runs.id, inc.runId)).get() : null;
  const slugs = new Map(loadTargets(db, inc.projectId).map((t) => [t.id, t.slug]));

  // Timeline: alerts firing and resolving, the investigation, and SupOps' own changes.
  const timeline: Array<{ at: number; kind: string; text: string }> = [];
  timeline.push({ at: inc.openedAt.getTime(), kind: 'opened', text: inc.origin === 'prediction' ? 'Predicted by the watcher' : inc.origin === 'threshold' ? 'Went over the limit set for it' : 'Incident opened' });
  for (const a of members) {
    timeline.push({ at: (a.startsAt ?? a.receivedAt).getTime(), kind: 'alert', text: `${a.title} fired${a.labels?.instance ? ` on ${a.labels.instance}` : ''}` });
    if (a.resolvedAt) timeline.push({ at: a.resolvedAt.getTime(), kind: 'resolved', text: `${a.title} resolved` });
  }
  if (run) {
    timeline.push({ at: run.startedAt.getTime(), kind: 'run', text: (run.policySnapshot as { unattended?: boolean }).unattended ? 'Read-only diagnosis started automatically' : 'Investigation started' });
    const changes = db
      .select({ at: toolCalls.createdAt, toolKey: toolCalls.toolKey, tier: toolCalls.tier, state: toolCalls.state })
      .from(toolCalls)
      .where(and(eq(toolCalls.runId, run.id), inArray(toolCalls.tier, ['low', 'medium', 'high']), eq(toolCalls.state, 'succeeded')))
      .all();
    for (const c of changes) timeline.push({ at: c.at.getTime(), kind: 'change', text: `Change made: ${c.toolKey} (${c.tier})` });
  }
  for (const e of ev.filter((x) => x.check === 'deploys' && x.status === 'interesting')) {
    timeline.push({ at: e.createdAt.getTime(), kind: 'deploy', text: e.summary.split('\n')[0]! });
  }
  if (inc.status === 'ignored' && inc.resolvedAt) {
    timeline.push({ at: inc.resolvedAt.getTime(), kind: 'ignored', text: `Ignored${inc.ignoredBy ? ` by ${inc.ignoredBy}` : ''}${inc.ignoreReason ? `: ${inc.ignoreReason}` : ''}` });
    if (inc.ignoredUntil) timeline.push({ at: inc.ignoredUntil.getTime(), kind: 'pending', text: 'Checked again: reopens if still firing' });
  } else if (inc.resolvedAt) timeline.push({ at: inc.resolvedAt.getTime(), kind: 'closed', text: inc.mergedInto ? 'Merged into another incident' : 'Incident resolved' });
  // What people did, from the incident's own record.
  const events = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id)).orderBy(asc(incidentEvents.at)).all();
  const who = (e: (typeof events)[number]) => e.actorName ?? 'SupOps';
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, string | number | undefined>;
    const text =
      e.kind === 'acknowledged' ? (d.via ? `Acknowledged in ${d.via}${d.by ? ` by ${d.by}` : ''}` : `Acknowledged by ${who(e)}`)
      : e.kind === 'unacknowledged' ? `${who(e)} took back the acknowledgement`
      : e.kind === 'ack_lapsed' ? `Acknowledgement lapsed: ${d.reason ?? 'it got worse'}`
      : e.kind === 'assigned' ? (d.to ? `${who(e)} assigned it to ${d.toName ?? 'someone'}` : `${who(e)} unassigned it`)
      : e.kind === 'comment' ? `${who(e)}: ${d.text ?? ''}`
      : e.kind === 'severity' ? `${who(e)} set the severity to ${d.to}`
      : e.kind === 'merged_in' ? `${who(e)} merged in "${d.fromTitle ?? 'another incident'}"`
      : e.kind === 'split_out' ? `${who(e)} split ${d.alerts ?? 'some'} alert${d.alerts === 1 ? '' : 's'} into "${d.toTitle ?? 'a new incident'}"`
      : e.kind === 'resolved' ? `Marked resolved by ${who(e)}`
      : `Reopened by ${who(e)}`;
    timeline.push({ at: e.at.getTime(), kind: e.kind === 'comment' ? 'comment' : 'person', text });
  }
  timeline.sort((a, b) => a.at - b.at);

  const others = db
    .select({ id: incidents.id, title: incidents.title })
    .from(incidents)
    .where(and(eq(incidents.projectId, inc.projectId), eq(incidents.status, 'open')))
    .all()
    .filter((o) => o.id !== inc.id);

  const names = userNames([inc.assigneeId, inc.acknowledgedBy]);
  res.json({
    incident: {
      ...inc,
      targets: (inc.targetIds ?? []).map((id) => slugs.get(id)).filter(Boolean),
      assigneeName: inc.assigneeId ? names.get(inc.assigneeId) ?? null : null,
      acknowledgedByName: inc.acknowledgedBy ? names.get(inc.acknowledgedBy) ?? null : null,
    },
    alerts: members,
    evidence: ev.map((e) => ({ ...e, connection: e.connectionId ? slugs.get(e.connectionId) ?? null : null })),
    observations: obs,
    run,
    fixRun: latestFixRun(inc.id),
    map: incidentMapView(inc.projectId, inc.targetIds ?? [], inc.id),
    timeline,
    mergeCandidates: others,
    suggestions: inc.status === 'open' ? suggestMerges(inc) : [],
    rule: inc.ruleId ? db.select({ id: correlationRules.id, name: correlationRules.name, threshold: correlationRules.threshold, resolveOn: correlationRules.resolveOn }).from(correlationRules).where(eq(correlationRules.id, inc.ruleId)).get() ?? null : null,
  });
});

observabilityRoutes.post('/incidents/:id/investigate', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const r = startIncidentRun(inc, { mode: 'fix', startedBy: req.user?.id ?? null });
  if (!r.ok) {
    res.status(r.code).json({ error: r.error });
    return;
  }
  res.status(201).json({ runId: r.runId });
});

observabilityRoutes.post('/incidents/:id/evidence', async (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const ev = await gatherEvidence(inc);
  res.json({ count: ev.length });
});

observabilityRoutes.post('/incidents/:id/resolve', (req, res) => {
  const row = db
    .update(incidents)
    .set({ status: 'resolved', resolvedAt: new Date() })
    .where(eq(incidents.id, req.params.id))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  // Its open alerts are closed as resolved, not ignored: one that is in fact still
  // firing comes back as a new alert (and incident) on the next read.
  db.update(alerts)
    .set({ status: 'resolved', resolvedAt: new Date(), decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(and(eq(alerts.incidentId, row.id), inArray(alerts.status, ['new', 'investigating'])))
    .run();
  recordIncidentEvent(row.id, 'resolved', req.user);
  res.json(row);
});

/**
 * Ignore: not worth acting on for now. Always for a limited time (at most 7 days):
 * when it ends, the incident reopens if its alerts still fire or its forecast still
 * holds, and an escalation (worse severity) reopens it at once. So a mistaken ignore
 * cannot hide a real problem for good.
 */
const IGNORE_HOURS = [1, 4, 24, 168] as const;
observabilityRoutes.post('/incidents/:id/ignore', (req, res) => {
  const body = z
    .object({ hours: z.number().refine((h) => (IGNORE_HOURS as readonly number[]).includes(h), 'Choose 1, 4, 24 or 168 hours'), reason: z.string().max(300).optional() })
    .safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid ignore' });
    return;
  }
  const until = new Date(Date.now() + body.data.hours * 3_600_000);
  const row = db
    .update(incidents)
    .set({ status: 'ignored', resolvedAt: new Date(), ignoredUntil: until, ignoredBy: req.user?.name ?? req.user?.email ?? null, ignoreReason: body.data.reason?.trim() || null })
    .where(and(eq(incidents.id, req.params.id), eq(incidents.status, 'open')))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'No open incident with that id.' });
    return;
  }
  db.update(alerts)
    .set({ status: 'ignored', decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(and(eq(alerts.incidentId, row.id), inArray(alerts.status, ['new', 'investigating'])))
    .run();
  audit(req.user, { projectId: row.projectId, entity: 'incident', entityId: row.id, action: 'ignore', after: { title: row.title, until: until.toISOString(), reason: row.ignoreReason } });
  res.json(row);
});

/** Undo an ignore (or a manual resolve): the incident and its still-firing alerts are open again. */
observabilityRoutes.post('/incidents/:id/reopen', (req, res) => {
  const row = reopenIncident(req.params.id);
  if (!row) {
    res.status(404).json({ error: 'Incident not found, or merged into another.' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'incident', entityId: row.id, action: 'reopen' });
  recordIncidentEvent(row.id, 'reopened', req.user);
  if (row.triageState !== 'done' && row.triageState !== 'running') enqueueTriage(row.id);
  res.json(row);
});

/** "Not the same problem": never suggest merging these two again. */
observabilityRoutes.post('/incidents/:id/not-related', (req, res) => {
  const inc = db.select().from(incidents).where(eq(incidents.id, req.params.id)).get();
  const other = typeof req.body?.other === 'string' ? db.select().from(incidents).where(eq(incidents.id, req.body.other)).get() : undefined;
  if (!inc || !other || other.projectId !== inc.projectId) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  dismissSuggestion(inc.projectId, inc.id, other.id, req.user?.id ?? null);
  audit(req.user, { projectId: inc.projectId, entity: 'incident', entityId: inc.id, action: 'not_related', after: { other: other.id } });
  res.json({ ok: true });
});

observabilityRoutes.post('/incidents/:id/merge', (req, res) => {
  const body = z.object({ into: z.string() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'into is required' });
    return;
  }
  const r = mergeIncidents(req.params.id, body.data.into, req.user);
  if (!r) {
    res.status(400).json({ error: 'Those incidents cannot be merged.' });
    return;
  }
  res.json(r);
});

observabilityRoutes.post('/incidents/:id/split', (req, res) => {
  const body = z.object({ alertIds: z.array(z.string()).min(1) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'alertIds is required' });
    return;
  }
  const r = splitIncident(req.params.id, body.data.alertIds, req.user);
  if (!r) {
    res.status(400).json({ error: 'Choose some, but not all, of the incident\'s alerts.' });
    return;
  }
  enqueueTriage(r.id);
  res.json(r);
});

/** Someone is on it. Lapses by itself if the incident gets worse. */
observabilityRoutes.post('/incidents/:id/acknowledge', (req, res) => {
  const row = db
    .update(incidents)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: req.user?.id ?? null })
    .where(and(eq(incidents.id, req.params.id), eq(incidents.status, 'open')))
    .returning()
    .get();
  if (!row) {
    res.status(404).json({ error: 'No open incident with that id.' });
    return;
  }
  recordIncidentEvent(row.id, 'acknowledged', req.user);
  res.json(row);
});

observabilityRoutes.post('/incidents/:id/unacknowledge', (req, res) => {
  const row = db.update(incidents).set({ acknowledgedAt: null, acknowledgedBy: null }).where(eq(incidents.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  recordIncidentEvent(row.id, 'unacknowledged', req.user);
  res.json(row);
});

observabilityRoutes.post('/incidents/:id/assign', (req, res) => {
  const body = z.object({ userId: z.string().nullable() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'userId is required (null to unassign)' });
    return;
  }
  const to = body.data.userId ? db.select({ id: users.id, name: users.name, disabledAt: users.disabledAt }).from(users).where(eq(users.id, body.data.userId)).get() : null;
  if (body.data.userId && (!to || to.disabledAt)) {
    res.status(400).json({ error: 'No active user with that id.' });
    return;
  }
  const row = db.update(incidents).set({ assigneeId: to?.id ?? null }).where(eq(incidents.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  recordIncidentEvent(row.id, 'assigned', req.user, { to: to?.id ?? null, toName: to?.name ?? null });
  res.json(row);
});

observabilityRoutes.post('/incidents/:id/comments', (req, res) => {
  const body = z.object({ text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'Write something first (at most 4,000 characters).' });
    return;
  }
  const inc = db.select({ id: incidents.id }).from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!inc) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  recordIncidentEvent(inc.id, 'comment', req.user, { text: body.data.text });
  res.status(201).json({ ok: true });
});

/** A person sets the severity: from then on, new alerts no longer change it. */
observabilityRoutes.post('/incidents/:id/severity', (req, res) => {
  const body = z.object({ severity: z.enum(['critical', 'warning', 'info']) }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'severity must be critical, warning or info' });
    return;
  }
  const before = db.select({ severity: incidents.severity }).from(incidents).where(eq(incidents.id, req.params.id)).get();
  if (!before) {
    res.status(404).json({ error: 'Incident not found' });
    return;
  }
  const row = db.update(incidents).set({ severity: body.data.severity, severityPinned: true }).where(eq(incidents.id, req.params.id)).returning().get();
  recordIncidentEvent(row.id, 'severity', req.user, { from: before.severity, to: body.data.severity });
  res.json(row);
});

// ---- watches -----------------------------------------------------------------------

/** Every watch with every one of its series, worst first. */
observabilityRoutes.get('/watches', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const rows = db.select().from(watches).where(eq(watches.projectId, projectId)).orderBy(asc(watches.group), asc(watches.title)).all();
  const slugs = new Map(loadTargets(db, projectId).map((t) => [t.id, t.slug]));
  const open = db
    .select({ watchId: observations.watchId, series: observations.series, kind: observations.kind, severity: observations.severity })
    .from(observations)
    .where(and(eq(observations.projectId, projectId), isNull(observations.resolvedAt)))
    .all();
  res.json(
    rows.map((w) => ({
      ...w,
      connection: slugs.get(w.connectionId) ?? null,
      series: (w.enabled ? watchSeriesList(w.id) : []).map((x) => ({
        key: x.series,
        name: x.name,
        labels: x.labels,
        value: x.value,
        score: x.score,
        reasons: x.reasons,
        etaMs: x.etaMs,
        target: x.targetId ? slugs.get(x.targetId) ?? null : null,
        flags: open.filter((o) => o.watchId === w.id && o.series === x.series).map((o) => `${o.kind}:${o.severity}`),
      })),
    })),
  );
});

/** The worst series across every watch of a project. */
observabilityRoutes.get('/at-risk', (req, res) => {
  const projectId = requireProject(req, res);
  if (!projectId) return;
  const rows = db
    .select({ watchId: watchSeries.watchId, key: watchSeries.series, name: watchSeries.name, value: watchSeries.value, score: watchSeries.score, reasons: watchSeries.reasons, title: watches.title, unit: watches.unit, group: watches.group })
    .from(watchSeries)
    .innerJoin(watches, eq(watches.id, watchSeries.watchId))
    .where(and(eq(watches.projectId, projectId), eq(watches.enabled, true), gt(watchSeries.score, 0)))
    .orderBy(desc(watchSeries.score))
    .limit(Math.min(20, Number(req.query.limit) || 6))
    .all();
  res.json(rows);
});

/**
 * The forecast to draw: the model's own path (its daily pattern carried forward, with
 * the 90% band) when it ran on this series, else the straight trend to the limit.
 */
function chartForecast(watchId: string, key: string, row: { etaMs: number | null; slopePerHour: number | null } | undefined) {
  const eta = row?.etaMs != null && row.etaMs <= 7 * 86_400_000 ? row.etaMs : null;
  const m = cachedPrediction(watchId, key);
  if (m && (m.perDay !== 0 || m.seasonality >= 0.3 || eta !== null)) {
    // A week ahead at most, every hour.
    const path = m.path.filter(([t]) => t <= Date.now() + 7 * 86_400_000).map(([t, mid, lo, hi]) => [t, mid, lo, hi].map((v) => Number(v.toPrecision(6))) as [number, number, number, number]);
    return { slopePerHour: m.perDay / 24, etaMs: eta, path, model: m.model, confidence: m.confidence };
  }
  return eta !== null && row?.slopePerHour != null ? { slopePerHour: row.slopePerHour, etaMs: eta } : null;
}

/** One series over a window, read live from the backend, with its usual range and trend. */
observabilityRoutes.get('/watches/:id/chart', async (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  const key = typeof req.query.key === 'string' ? req.query.key : '';
  if (!w || !key) {
    res.status(404).json({ error: 'Watch or series not found' });
    return;
  }
  const row = db.select().from(watchSeries).where(and(eq(watchSeries.watchId, w.id), eq(watchSeries.series, key))).get();
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  const r = await seriesChart(w, row?.labels ?? parseSeriesKey(key), hours);
  if ('error' in r) {
    res.status(502).json({ error: r.error });
    return;
  }
  res.json({
    points: r.points,
    unit: w.unit,
    limit: w.limit,
    // Quantities that cannot go below zero do not get a band below zero.
    band: row?.avg1d != null && row.sd1d != null
      ? { low: row.value >= 0 && row.avg1d >= 0 ? Math.max(0, row.avg1d - 3 * row.sd1d) : row.avg1d - 3 * row.sd1d, high: row.avg1d + 3 * row.sd1d }
      : null,
    forecast: chartForecast(w.id, key, row),
  });
});

/** The worst series of a watch together, read live: a combined graph. */
observabilityRoutes.get('/watches/:id/combined', async (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  if (!w) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  const hours = Math.min(168, Math.max(1, Number(req.query.hours) || 24));
  // Up to every series a watch keeps (50): the page draws them all together.
  const r = await combinedChart(w, hours, Math.min(50, Math.max(2, Number(req.query.max) || 10)));
  if ('error' in r) {
    res.status(502).json({ error: r.error });
    return;
  }
  res.json({ unit: w.unit, limit: w.limit, total: w.seriesCount, series: r.series });
});

/**
 * Investigate one series, as a person asked: diagnose from what the watcher sees and
 * fix it, on the machine it belongs to when known. Like Investigate on an incident,
 * every change waits for a person's approval (only automatic runs are read-only).
 */
observabilityRoutes.post('/watches/:id/investigate', (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  const key = typeof req.body?.key === 'string' ? req.body.key : '';
  const row = w && key ? db.select().from(watchSeries).where(and(eq(watchSeries.watchId, w.id), eq(watchSeries.series, key))).get() : undefined;
  if (!w || !row) {
    res.status(404).json({ error: 'Watch or series not found' });
    return;
  }
  const agentId =
    db.select().from(agents).where(and(eq(agents.projectId, w.projectId), eq(agents.slug, 'triage'))).get()?.id ??
    db.select().from(agents).where(eq(agents.projectId, w.projectId)).get()?.id;
  if (!agentId) {
    res.status(409).json({ error: 'This project has no agent.' });
    return;
  }
  const conn = db.select({ slug: targets.slug }).from(targets).where(eq(targets.id, w.connectionId)).get();
  const fmt = (v: number) => formatValue(v, w.unit);
  const facts = [
    `${w.title} on ${row.name} is ${fmt(row.value)}${row.reasons.length ? ` (${row.reasons.join('; ')})` : ''}.`,
    row.avg1d != null ? `Its average over the last day is ${fmt(row.avg1d)}.` : '',
    `It comes from ${conn?.slug ?? 'the metrics connection'} with: ${w.query}`,
    `Series labels: ${row.series}`,
  ].filter(Boolean).join('\n');
  const r = startRun({
    projectId: w.projectId,
    agentId,
    task: `${w.title} on ${row.name}: ${row.reasons[0] ?? fmt(row.value)}. Find out why and fix it; if nothing needs fixing, say so and why.`,
    ...(row.targetId ? { targetIds: [row.targetId] } : {}),
    trigger: 'chat',
    triggerPayload: { watchId: w.id, series: row.series },
    startedBy: req.user?.id ?? null,
    // Diagnose, then fix through approvals: the incident fix prompt, with what the watcher sees as evidence.
    incident: { evidence: `WHAT THE WATCHER SEES (cite as [E1]):\n[E1] ${facts.replace(/\n/g, '\n    ')}`, mode: 'fix' },
  });
  if (!r.ok) {
    res.status(r.code).json({ error: r.error });
    return;
  }
  res.status(201).json({ runId: r.run.id });
});

const watchBody = z.object({
  projectId: z.string(),
  connectionId: z.string(),
  title: z.string().min(1).max(120),
  query: z.string().min(1).max(2000),
  unit: z.enum(['percent', 'bytes', 'seconds', 'ratio', 'count', 'days', 'per_second']).default('count'),
  badDirection: z.enum(['up', 'down', 'both']).default('both'),
  limit: z.object({ value: z.number(), when: z.enum(['below', 'above']) }).nullable().default(null),
  /** Self-adjusting threshold: P99 (or P1) of the last 7 days, plus (or minus) iqrs x IQR. */
  adaptive: z.object({ iqrs: z.number().min(0.5).max(10) }).nullable().default(null),
});

observabilityRoutes.post('/watches', (req, res) => {
  const body = watchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid watch' });
    return;
  }
  const conn = db.select().from(targets).where(eq(targets.id, body.data.connectionId)).get();
  if (!conn || conn.projectId !== body.data.projectId || !['prometheus', 'grafana'].includes(conn.kind)) {
    res.status(400).json({ error: 'Choose a Prometheus or Grafana connection in this project.' });
    return;
  }
  const slug = body.data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'watch';
  const row = db
    .insert(watches)
    .values({ ...body.data, key: `custom:${slug}-${Date.now().toString(36)}`, builtin: false, group: 'custom' })
    .returning()
    .get();
  audit(req.user, { entity: 'watch', entityId: row.id, action: 'create', after: { title: row.title, query: row.query } });
  watcher.kick();
  res.status(201).json(row);
});

/**
 * Edit a watch. What it finds is worked out again from the new settings straight
 * away (see reevaluateWatch), so its anomalies, forecasts and predicted incidents
 * never reflect a configuration that no longer exists.
 */
observabilityRoutes.patch('/watches/:id', async (req, res) => {
  const body = z
    .object({
      enabled: z.boolean().optional(),
      title: watchBody.shape.title.optional(),
      query: watchBody.shape.query.optional(),
      unit: z.enum(['percent', 'bytes', 'seconds', 'ratio', 'count', 'days', 'per_second']).optional(),
      limit: watchBody.shape.limit.optional(),
      badDirection: z.enum(['up', 'down', 'both']).optional(),
      adaptive: watchBody.shape.adaptive.optional(),
      /** Built-in signals: back to SupOps' own definition. */
      reset: z.literal(true).optional(),
    })
    .safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  const before = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  if (!before) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  const { reset, ...fields } = body.data;
  let patch: Partial<typeof watches.$inferInsert> = fields;
  if (reset) {
    const spec = SIGNALS.find((x) => x.key === before.key);
    if (!before.builtin || !spec) {
      res.status(400).json({ error: 'Only built-in signals can be reset.' });
      return;
    }
    patch = { title: spec.title, query: spec.query, unit: spec.unit, badDirection: spec.badDirection, limit: spec.limit };
  }
  const row = db.update(watches).set(patch).where(eq(watches.id, before.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'watch', entityId: row.id, action: reset ? 'reset' : 'update', before: { title: before.title, query: before.query, limit: before.limit, badDirection: before.badDirection, enabled: before.enabled, adaptive: before.adaptive }, after: patch });
  // Learned limits belong to the query, direction and margin they were learned with.
  if (['query', 'badDirection', 'adaptive', 'enabled'].some((k) => k in patch && JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((before as Record<string, unknown>)[k]))) {
    forgetAdaptive(row, !row.adaptive || row.enabled === false);
  }

  if (row.enabled === false) {
    resolveWatchObservations(row.id);
    res.json({ watch: row, reevaluated: false });
    return;
  }
  const judged = ['query', 'unit', 'limit', 'badDirection', 'enabled'].some((k) => k in patch && JSON.stringify((patch as Record<string, unknown>)[k]) !== JSON.stringify((before as Record<string, unknown>)[k]));
  if (!judged) {
    res.json({ watch: row, reevaluated: false });
    return;
  }
  const r = await reevaluateWatch(row.id, { queryChanged: patch.query !== undefined && patch.query !== before.query });
  res.json({ watch: db.select().from(watches).where(eq(watches.id, row.id)).get(), reevaluated: true, ...(r.ok ? {} : { error: r.error }) });
});

observabilityRoutes.delete('/watches/:id', (req, res) => {
  const w = db.select().from(watches).where(eq(watches.id, req.params.id)).get();
  if (!w) {
    res.status(404).json({ error: 'Watch not found' });
    return;
  }
  if (w.builtin) {
    res.status(400).json({ error: 'Built-in signals can be switched off, not deleted.' });
    return;
  }
  resolveWatchObservations(w.id);
  db.delete(watches).where(eq(watches.id, w.id)).run();
  res.json({ ok: true });
});

/** Re-discover a connection's signals and sample them now; read its alerts now. */
observabilityRoutes.post('/connections/:id/refresh', async (req, res) => {
  const t = db.select().from(targets).where(eq(targets.id, req.params.id)).get();
  if (!t) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const conn = projectConnections(t.projectId).find((c) => c.id === t.id);
  if (!conn) {
    res.status(400).json({ error: 'Not an enabled observability connection.' });
    return;
  }
  const out: { added?: number; poll?: unknown } = {};
  if (watchesMetrics(conn)) {
    out.added = await discover(t.projectId, conn);
    await watchConnection(t.projectId, conn);
  }
  if (importsAlerts(conn)) out.poll = await pollConnection(t.projectId, conn);
  res.json(out);
});

// ---- the stack itself ----------------------------------------------------------------

/**
 * Investigate the observability stack itself: run the stack checks first (is
 * Prometheus scraping, are rules evaluating, are notifications getting out), then
 * start a run on the connections with that evidence.
 */
observabilityRoutes.post('/stack-investigate', async (req, res) => {
  const body = z.object({ projectId: z.string(), task: z.string().max(20_000).optional(), agentId: z.string().optional() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const conns = projectConnections(body.data.projectId);
  if (!conns.length) {
    res.status(400).json({ error: 'This project has no observability connections.' });
    return;
  }
  const items = await runChecks(conns, {}, { stack: true, signal: AbortSignal.timeout(60_000) });
  let n = 0;
  const cited = items.filter((i) => i.status !== 'unavailable');
  const lines = [
    'OBSERVABILITY STACK CHECK',
    'EVIDENCE PACK (read-only checks of the monitoring itself; cite as [E1], [E2]...):',
    ...cited.flatMap((i) => [`[E${++n}] ${i.title} (${i.connectionSlug}) -- ${i.status}`, ...i.summary.split('\n').slice(0, i.status === 'interesting' ? 10 : 2).map((l) => `    ${l}`)]),
  ];
  const missing = items.filter((i) => i.status === 'unavailable');
  if (missing.length) lines.push(`Not measured here: ${[...new Set(missing.map((i) => i.title))].join(', ')}.`);

  const agentId =
    body.data.agentId ??
    db.select().from(agents).where(and(eq(agents.projectId, body.data.projectId), eq(agents.slug, 'triage'))).get()?.id ??
    db.select().from(agents).where(eq(agents.projectId, body.data.projectId)).get()?.id;
  if (!agentId) {
    res.status(409).json({ error: 'This project has no agent.' });
    return;
  }
  const r = startRun({
    projectId: body.data.projectId,
    agentId,
    task:
      body.data.task?.trim() ||
      'Check the health of our observability stack: is Prometheus scraping every target, are alert rules evaluating, are notifications reaching Alertmanager and its receivers, are logs being ingested, and is anything about to break (storage, series growth). Use the status operations of the tools.',
    targetIds: conns.map((c) => c.id),
    trigger: 'chat',
    startedBy: req.user?.id ?? null,
    incident: { evidence: lines.join('\n') },
  });
  if (!r.ok) {
    res.status(r.code).json({ error: r.error });
    return;
  }
  res.status(201).json({ run: r.run });
});

// ---- settings ------------------------------------------------------------------------

observabilityRoutes.get('/settings', (_req, res) => res.json(settingsStore.observability()));

const settingsBody = z.object({
  alertPollMs: z.number().int().min(15_000).max(3_600_000).optional(),
  watchIntervalMs: z.number().int().min(60_000).max(3_600_000).optional(),
  autoTriage: z.boolean().optional(),
  triageMinSeverity: z.enum(['critical', 'warning', 'info']).optional(),
  triageGatherSeconds: z.number().int().min(0).max(1800).optional(),
  triageMaxPerHour: z.number().int().min(0).max(100).optional(),
  predictWarningHours: z.number().min(1).max(24 * 7).optional(),
  predictCriticalHours: z.number().min(0.5).max(72).optional(),
  flapChanges: z.number().int().min(2).max(50).optional(),
  flapWindowMin: z.number().int().min(5).max(24 * 60).optional(),
  slackThreadReplies: z.boolean().optional(),
});

observabilityRoutes.put('/settings', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can change observability settings.' });
    return;
  }
  const body = settingsBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid settings' });
    return;
  }
  const before = settingsStore.observability();
  const saved = settingsStore.saveObservability(body.data);
  audit(req.user, { entity: 'settings.observability', action: 'update', before, after: saved });
  res.json(saved);
});

// ---- log patterns --------------------------------------------------------------------

/** Lines matching a query, grouped into patterns with counts over the window (new and spiking first). */
observabilityRoutes.get('/log-patterns', async (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const conn = projectConnections(projectId, ['loki', 'elasticsearch']).find((c) => c.id === String(req.query.connectionId ?? ''));
  if (!conn) {
    res.status(400).json({ error: 'Choose a Loki or Elasticsearch connection of this project.' });
    return;
  }
  const hours = Math.min(24, Math.max(0.25, Number(req.query.hours ?? 1)));
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const query = String(req.query.query ?? '').slice(0, 2000);
  let lines: Array<{ line: string; ts: number }> = [];
  if (conn.kind === 'loki') {
    const r = await obsRequest(conn, '/loki/api/v1/query_range', { query: { query: query || '{job=~".+"} |~ "(?i)(error|exception|fatal|panic)"', start: `${start}000000`, end: `${end}000000`, limit: 2000, direction: 'backward' }, timeoutMs: 30_000 });
    if ('error' in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    lines = ((r.json as { data?: { result?: Array<{ values: Array<[string, string]> }> } }).data?.result ?? []).flatMap((s) => s.values.map(([ts, line]) => ({ line, ts: Number(ts.slice(0, 13)) })));
  } else {
    const index = (conn.config as { indices?: string[] }).indices?.[0] ?? '*';
    const r = await obsRequest(conn, `/${index}/_search`, { jsonBody: { size: 2000, sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }], query: { bool: { must: [{ query_string: { query: query || 'level:(error OR fatal) OR message:(error OR exception)' } }], filter: [{ range: { '@timestamp': { gte: new Date(start).toISOString(), lte: new Date(end).toISOString() } } }] } } }, timeoutMs: 30_000 });
    if ('error' in r) {
      res.status(400).json({ error: r.error });
      return;
    }
    lines = (((r.json as { hits?: { hits?: Array<{ _source: Record<string, unknown> }> } }).hits?.hits) ?? []).map((h) => ({ line: String(h._source.message ?? h._source.log ?? JSON.stringify(h._source)), ts: Date.parse(String(h._source['@timestamp'] ?? '')) || end }));
  }
  res.json({ lines: lines.length, start, end, patterns: drainPatterns(lines, { buckets: 12, start, end }).slice(0, 100) });
});
