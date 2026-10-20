import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { alerts, correlationRules, incidents, observations, incidentDismissals } from '@supops/db';
import type { AlertSeverity } from '@supops/shared';
import { alertMatchLabels, OPEN_ALERT_STATUSES } from '@supops/shared';
import { chooseIncident, groupKeyOf, serviceOf, loadTargets, renderTitle, ruleFor, ruleGroupKey, scopeAlert, worstSeverity } from '@supops/core';
import { db } from '../context.ts';
import type { AuthUser } from '../auth.ts';
import { mapRelation, serviceMapRelation } from '../servicemap/context.ts';
import { lapseAcknowledgement, recordIncidentEvent } from './incident-events.ts';
import { enqueueTriage } from './triage.ts';

type AlertRow = typeof alerts.$inferSelect;
type IncidentRow = typeof incidents.$inferSelect;

const hostOf = (l: Record<string, string>) => l.instance || l.host || l.hostname || l.node || '';

/**
 * Targets an alert is about: by its host labels, then names in its text, then its
 * channel (see scopeAlert) -- the machines it names, not the jumps added for reach.
 */
export function alertTargets(projectId: string, a: Pick<AlertRow, 'labels' | 'title' | 'summary' | 'channelName'>): string[] {
  return scopeAlert({ labels: a.labels ?? {}, title: a.title, summary: a.summary, channelName: a.channelName }, loadTargets(db, projectId)).matched.map((t) => t.id);
}

/** A title for an incident from its alerts: "HighCPU on 3 machines", "DiskFull and 2 more on db-1". */
export function incidentTitle(rows: Array<Pick<AlertRow, 'title' | 'labels'>>): string {
  if (!rows.length) return 'Incident';
  const names = [...new Set(rows.map((r) => r.title))];
  const hosts = [...new Set(rows.map((r) => hostOf(r.labels ?? {}).replace(/:\d+$/, '')).filter(Boolean))];
  const what = names.length === 1 ? names[0]! : `${names[0]} and ${names.length - 1} more`;
  const where = hosts.length === 1 ? ` on ${hosts[0]}` : hosts.length > 1 ? ` on ${hosts.length} machines` : '';
  return `${what}${where}`.slice(0, 200);
}

/**
 * Put a new open alert into an incident: an open one it belongs with (see
 * chooseIncident), or a new one. Returns the incident and whether it was created.
 */
export function attachToIncident(alert: AlertRow): { incident: IncidentRow; created: boolean } {
  const labels = alert.labels ?? {};
  const targetIds = alertTargets(alert.projectId, alert);
  // A person's rule comes first; the built-in grouping handles everything else.
  const rule = ruleFor(enabledRules(alert.projectId), alertMatchLabels(alert));
  if (rule) return attachByRule(alert, rule, targetIds);
  const open = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, alert.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto), isNull(incidents.ruleId)))
    .all();
  const now = alert.receivedAt.getTime();
  // Each open incident's services, from its alerts: a new alert may connect to any of them.
  const svc = new Map<string, Set<string>>();
  if (open.length) {
    for (const m of db.select({ incidentId: alerts.incidentId, labels: alerts.labels }).from(alerts).where(inArray(alerts.incidentId, open.map((i) => i.id))).all()) {
      const s = serviceOf(m.labels ?? {});
      if (s && m.incidentId) svc.set(m.incidentId, (svc.get(m.incidentId) ?? new Set()).add(s));
    }
  }
  const pick = chooseIncident(
    { title: alert.title, labels, targetIds, at: now },
    open.map((i) => ({ id: i.id, title: i.title, groupKey: i.groupKey ?? {}, targetIds: i.targetIds ?? [], lastSeenAt: i.lastSeenAt.getTime(), openedAt: i.openedAt.getTime(), services: [...(svc.get(i.id) ?? [])] })),
    15 * 60_000,
    (a, b) => mapRelation(alert.projectId, a, b),
    (a, b) => serviceMapRelation(alert.projectId, a, b),
  );

  if (pick) {
    const inc = open.find((i) => i.id === pick.incidentId)!;
    db.update(alerts).set({ incidentId: inc.id }).where(eq(alerts.id, alert.id)).run();
    const members = db.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
    const updated = db
      .update(incidents)
      .set({
        lastSeenAt: new Date(),
        // A forecast that is now also an alert: it resolves with its alerts from here on.
        origin: 'alerts',
        severity: inc.severityPinned ? inc.severity : (worstSeverity(inc.severity, alert.severity) as AlertSeverity),
        targetIds: [...new Set([...(inc.targetIds ?? []), ...targetIds])],
        title: inc.origin !== 'alerts' ? inc.title : incidentTitle(members),
        groupReason: inc.groupReason ? (inc.groupReason.includes(pick.reason) ? inc.groupReason : `${inc.groupReason}; ${pick.reason}`).slice(0, 1000) : pick.reason,
      })
      .where(eq(incidents.id, inc.id))
      .returning()
      .get();
    lapseAcknowledgement(inc.id, `a new alert joined: ${alert.title}`);
    return { incident: updated, created: false };
  }

  const created = db
    .insert(incidents)
    .values({
      projectId: alert.projectId,
      title: incidentTitle([alert]),
      severity: alert.severity,
      groupKey: groupKeyOf({ title: alert.title, labels }),
      targetIds,
      openedAt: alert.receivedAt,
      lastSeenAt: new Date(),
    })
    .returning()
    .get();
  db.update(alerts).set({ incidentId: created.id }).where(eq(alerts.id, alert.id)).run();
  return { incident: created, created: true };
}

type RuleRow = typeof correlationRules.$inferSelect;

export const enabledRules = (projectId: string): RuleRow[] =>
  db.select().from(correlationRules).where(and(eq(correlationRules.projectId, projectId), eq(correlationRules.enabled, true))).orderBy(asc(correlationRules.priority), asc(correlationRules.createdAt)).all();

const titleFor = (rule: RuleRow, members: Array<Pick<AlertRow, 'title' | 'labels' | 'severity' | 'source'>>) =>
  rule.titleTemplate.trim() ? renderTitle(rule.titleTemplate, members.map((m) => alertMatchLabels(m))) : incidentTitle(members);

/**
 * Group by a person's rule: the open incident this rule made for the same group-by
 * values, active within the rule's window -- or a new one. Below the rule's threshold
 * the incident is held: not listed and not diagnosed until enough alerts join.
 */
function attachByRule(alert: AlertRow, rule: RuleRow, targetIds: string[]): { incident: IncidentRow; created: boolean } {
  const key = ruleGroupKey(rule, alertMatchLabels(alert));
  const since = alert.receivedAt.getTime() - rule.windowMin * 60_000;
  const inc = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, alert.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto), eq(incidents.ruleId, rule.id), eq(incidents.ruleGroupKey, key)))
    .orderBy(desc(incidents.lastSeenAt))
    .all()
    .find((i) => i.lastSeenAt.getTime() >= since);
  // Read after "Grouped because", like the built-in reasons.
  const groupBy = rule.groupBy.length ? `they share ${rule.groupBy.join(', ')}` : 'it groups all the alerts it matches';
  const reason = `the rule "${rule.name}" says so: ${groupBy}, within ${rule.windowMin} minutes`;
  db.update(correlationRules)
    .set({ alertsGrouped: sql`${correlationRules.alertsGrouped} + 1`, lastMatchedAt: new Date(), ...(inc ? {} : { incidentsMade: sql`${correlationRules.incidentsMade} + 1` }) })
    .where(eq(correlationRules.id, rule.id))
    .run();

  if (inc) {
    db.update(alerts).set({ incidentId: inc.id }).where(eq(alerts.id, alert.id)).run();
    const members = db.select({ title: alerts.title, labels: alerts.labels, severity: alerts.severity, source: alerts.source }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
    const release = inc.held && members.length >= rule.threshold;
    const updated = db
      .update(incidents)
      .set({
        lastSeenAt: new Date(),
        severity: inc.severityPinned ? inc.severity : (worstSeverity(inc.severity, alert.severity) as AlertSeverity),
        targetIds: [...new Set([...(inc.targetIds ?? []), ...targetIds])],
        title: titleFor(rule, members),
        held: inc.held && !release,
        // Released from the hold: it is news from now, not from when the first alert came.
        ...(release ? { openedAt: new Date() } : {}),
      })
      .where(eq(incidents.id, inc.id))
      .returning()
      .get();
    if (release) enqueueTriage(inc.id);
    else if (!inc.held) lapseAcknowledgement(inc.id, `a new alert joined: ${alert.title}`);
    return { incident: updated, created: false };
  }

  const created = db
    .insert(incidents)
    .values({
      projectId: alert.projectId,
      title: titleFor(rule, [alert]),
      severity: alert.severity,
      groupKey: groupKeyOf({ title: alert.title, labels: alert.labels ?? {} }),
      groupReason: reason,
      targetIds,
      ruleId: rule.id,
      ruleGroupKey: key,
      held: rule.threshold > 1,
      openedAt: alert.receivedAt,
      lastSeenAt: new Date(),
    })
    .returning()
    .get();
  db.update(alerts).set({ incidentId: created.id }).where(eq(alerts.id, alert.id)).run();
  return { incident: created, created: true };
}

/**
 * An alert that fires again soon after resolving goes back to the incident it was in,
 * instead of opening a new one: a flapping alert is one problem, not ten. The incident
 * reopens with its diagnosis intact; an ignored one stays ignored, and so does the alert.
 */
export function reattachRecurring(alert: AlertRow, windowMs: number): IncidentRow | null {
  const prev = db
    .select({ incidentId: alerts.incidentId, resolvedAt: alerts.resolvedAt })
    .from(alerts)
    .where(and(eq(alerts.projectId, alert.projectId), eq(alerts.fingerprint, alert.fingerprint), ne(alerts.id, alert.id)))
    .orderBy(desc(alerts.receivedAt))
    .get();
  if (!prev?.incidentId || !prev.resolvedAt || alert.receivedAt.getTime() - prev.resolvedAt.getTime() > windowMs) return null;
  const inc = db.select().from(incidents).where(eq(incidents.id, prev.incidentId)).get();
  if (!inc || inc.mergedInto || inc.origin !== 'alerts') return null;
  const ignored = inc.status === 'ignored' && (!inc.ignoredUntil || inc.ignoredUntil.getTime() > Date.now());
  if (!ignored && inc.status !== 'open' && inc.status !== 'resolved') return null;
  db.update(alerts)
    .set({ incidentId: inc.id, ...(ignored ? { status: 'ignored' as const, decidedAt: new Date() } : {}) })
    .where(eq(alerts.id, alert.id))
    .run();
  const reason = 'the same alert fired again soon after resolving';
  if (!ignored) lapseAcknowledgement(inc.id, `${alert.title} fired again`);
  return db
    .update(incidents)
    .set({
      lastSeenAt: new Date(),
      severity: inc.severityPinned ? inc.severity : (worstSeverity(inc.severity, alert.severity) as AlertSeverity),
      groupReason: inc.groupReason?.includes(reason) ? inc.groupReason : [inc.groupReason, reason].filter(Boolean).join('; ').slice(0, 1000),
      ...(ignored ? {} : { status: 'open' as const, resolvedAt: null }),
    })
    .where(eq(incidents.id, inc.id))
    .returning()
    .get();
}

/** Resolve an alert-made incident once none of its alerts is still open. */
export function refreshIncident(incidentId: string | null): void {
  if (!incidentId) return;
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || inc.origin !== 'alerts') return;
  const stillOpen = db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.incidentId, incidentId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .get();
  const resolveOn = inc.ruleId ? db.select({ v: correlationRules.resolveOn }).from(correlationRules).where(eq(correlationRules.id, inc.ruleId)).get()?.v ?? 'all' : 'all';
  // The rule says: resolved as soon as one alert is, or only by a person.
  if (resolveOn === 'never') return;
  if (resolveOn === 'first') {
    if (inc.status !== 'open') return;
    const anyResolved = db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.incidentId, incidentId), eq(alerts.status, 'resolved'))).get();
    if (anyResolved) {
      // One resolved is the incident resolved: the rest close with it, as a person's resolve does.
      const now = new Date();
      db.update(alerts).set({ status: 'resolved', resolvedAt: now }).where(and(eq(alerts.incidentId, incidentId), inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).run();
      db.update(incidents).set({ status: 'resolved', resolvedAt: now }).where(eq(incidents.id, incidentId)).run();
    }
    return;
  }
  if (!stillOpen && inc.status === 'open') {
    db.update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, incidentId)).run();
  } else if (stillOpen && inc.status === 'resolved') {
    db.update(incidents).set({ status: 'open', resolvedAt: null }).where(eq(incidents.id, incidentId)).run();
  }
}

/** Move every alert of `fromId` into `intoId` and close `fromId` as merged. */
export function mergeIncidents(fromId: string, intoId: string, actor?: AuthUser | null): IncidentRow | null {
  if (fromId === intoId) return null;
  const from = db.select().from(incidents).where(eq(incidents.id, fromId)).get();
  const into = db.select().from(incidents).where(eq(incidents.id, intoId)).get();
  if (!from || !into || from.projectId !== into.projectId) return null;
  const merged = db.transaction((tx) => {
    tx.update(alerts).set({ incidentId: intoId }).where(eq(alerts.incidentId, fromId)).run();
    tx.update(incidents)
      .set({ status: 'resolved', resolvedAt: new Date(), mergedInto: intoId })
      .where(eq(incidents.id, fromId))
      .run();
    const members = tx.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, intoId)).all();
    return tx
      .update(incidents)
      .set({
        title: incidentTitle(members),
        severity: into.severityPinned ? into.severity : (worstSeverity(into.severity, from.severity) as AlertSeverity),
        targetIds: [...new Set([...(into.targetIds ?? []), ...(from.targetIds ?? [])])],
        status: 'open',
        resolvedAt: null,
        groupReason: [into.groupReason, 'merged by a person'].filter(Boolean).join('; '),
        lastSeenAt: new Date(),
      })
      .where(eq(incidents.id, intoId))
      .returning()
      .get();
  });
  if (merged) recordIncidentEvent(intoId, 'merged_in', actor, { from: fromId, fromTitle: from.title });
  return merged;
}

/** Move some alerts out of an incident into a new one of their own. */
export function splitIncident(incidentId: string, alertIds: string[], actor?: AuthUser | null): IncidentRow | null {
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || !alertIds.length) return null;
  const moving = db.select().from(alerts).where(and(eq(alerts.incidentId, incidentId), inArray(alerts.id, alertIds))).all();
  const staying = db.select({ id: alerts.id }).from(alerts).where(eq(alerts.incidentId, incidentId)).all().length - moving.length;
  if (!moving.length || staying <= 0) return null;
  const created = db.transaction((tx) => {
    const n = tx
      .insert(incidents)
      .values({
        projectId: inc.projectId,
        title: incidentTitle(moving),
        severity: moving.reduce<AlertSeverity>((s, a) => worstSeverity(s, a.severity), 'unknown'),
        groupKey: groupKeyOf({ title: moving[0]!.title, labels: moving[0]!.labels ?? {} }),
        groupReason: 'split out by a person',
        targetIds: [...new Set(moving.flatMap((a) => alertTargets(inc.projectId, a)))],
      })
      .returning()
      .get();
    tx.update(alerts).set({ incidentId: n.id }).where(inArray(alerts.id, moving.map((a) => a.id))).run();
    const rest = tx.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, incidentId)).all();
    tx.update(incidents).set({ title: incidentTitle(rest) }).where(eq(incidents.id, incidentId)).run();
    return n;
  });
  recordIncidentEvent(incidentId, 'split_out', actor, { to: created.id, toTitle: created.title, alerts: moving.length });
  refreshIncident(created.id);
  refreshIncident(incidentId);
  return created;
}

/** Severity order: is `next` worse than `prev`? Unknown counts as warning. */
const rank = (s: string) => ({ critical: 3, warning: 2, unknown: 2, info: 1 } as Record<string, number>)[s] ?? 0;
export const worse = (next: string, prev: string) => rank(next) > rank(prev);

/**
 * Open an ignored (or resolved) incident again, with its still-firing alerts back
 * in the queue. Used when an ignore ends, when something escalates, and by a person.
 */
export function reopenIncident(incidentId: string): IncidentRow | null {
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || inc.mergedInto) return null;
  db.update(alerts)
    .set({ status: 'new', decidedAt: null, decidedBy: null })
    .where(and(eq(alerts.incidentId, inc.id), eq(alerts.status, 'ignored'), isNull(alerts.resolvedAt)))
    .run();
  return db
    .update(incidents)
    // Reopened is news: an old acknowledgement does not carry over.
    .set({ status: 'open', resolvedAt: null, lastSeenAt: new Date(), ignoredUntil: null, acknowledgedAt: null, acknowledgedBy: null })
    .where(eq(incidents.id, inc.id))
    .returning()
    .get();
}

/**
 * Ignores that have run out: reopen what is still happening (and get it diagnosed if
 * it never was), resolve what has stopped. Returns the ids reopened.
 */
export function expireIgnores(now = new Date()): string[] {
  const due = db.select().from(incidents).where(and(eq(incidents.status, 'ignored'), lt(incidents.ignoredUntil, now))).all();
  const reopened: string[] = [];
  for (const inc of due) {
    const firing = db
      .select({ id: alerts.id })
      .from(alerts)
      .where(and(eq(alerts.incidentId, inc.id), isNull(alerts.resolvedAt), inArray(alerts.status, ['new', 'investigating', 'ignored'])))
      .get();
    const predicted = db.select({ id: observations.id }).from(observations).where(and(eq(observations.incidentId, inc.id), isNull(observations.resolvedAt))).get();
    if (firing || predicted) {
      reopenIncident(inc.id);
      reopened.push(inc.id);
    } else {
      db.update(incidents).set({ status: 'resolved', resolvedAt: now, ignoredUntil: null }).where(eq(incidents.id, inc.id)).run();
    }
  }
  return reopened;
}

/**
 * Open incidents that may be the same problem as this one, by looser ties than automatic
 * grouping uses: opened within an hour, and connected on the service map (by service or
 * machine), the same alert, or the same namespace. A person decides; a pair they said is
 * unrelated is never suggested again.
 */
export function suggestMerges(inc: IncidentRow): Array<{ id: string; title: string; reason: string }> {
  const others = db
    .select()
    .from(incidents)
    .where(and(eq(incidents.projectId, inc.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto), ne(incidents.id, inc.id)))
    .all()
    .filter((o) => Math.abs(o.openedAt.getTime() - inc.openedAt.getTime()) <= 60 * 60_000);
  if (!others.length) return [];
  const dismissed = new Set(
    db.select().from(incidentDismissals).where(eq(incidentDismissals.projectId, inc.projectId)).all().map((d) => `${d.a}|${d.b}`),
  );
  const pair = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`);
  const facts = (id: string) => {
    const ms = db.select({ title: alerts.title, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, id)).all();
    return {
      services: [...new Set(ms.map((m) => serviceOf(m.labels ?? {})).filter((s): s is string => !!s))],
      names: new Set(ms.map((m) => m.labels?.alertname || m.title)),
      namespaces: new Set(ms.map((m) => m.labels?.namespace).filter((n): n is string => !!n && n !== 'default')),
    };
  };
  const mine = facts(inc.id);
  const out: Array<{ id: string; title: string; reason: string }> = [];
  for (const o of others) {
    if (dismissed.has(pair(inc.id, o.id))) continue;
    const theirs = facts(o.id);
    let reason: string | null = null;
    for (const a of mine.services) for (const b of theirs.services) reason ??= a !== b ? serviceMapRelation(inc.projectId, a, b) : `both are about the ${a} service`;
    reason ??= mapRelation(inc.projectId, inc.targetIds ?? [], o.targetIds ?? []);
    reason ??= [...mine.names].find((n) => theirs.names.has(n)) ? `the same alert (${[...mine.names].find((n) => theirs.names.has(n))}) is in both` : null;
    reason ??= [...mine.namespaces].find((n) => theirs.namespaces.has(n)) ? `both are in the ${[...mine.namespaces].find((n) => theirs.namespaces.has(n))} namespace` : null;
    if (reason) out.push({ id: o.id, title: o.title, reason: `${reason}; opened ${Math.round(Math.abs(o.openedAt.getTime() - inc.openedAt.getTime()) / 60_000)} min apart` });
  }
  return out.slice(0, 5);
}

export function dismissSuggestion(projectId: string, a: string, b: string, userId: string | null): void {
  const [x, y] = a < b ? [a, b] : [b, a];
  db.insert(incidentDismissals).values({ projectId, a: x, b: y, by: userId }).onConflictDoNothing().run();
}
