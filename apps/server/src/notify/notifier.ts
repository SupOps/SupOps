import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { alerts, incidents, notificationChannels, notificationDeliveries, notificationRoutes, projects, runs, settings, users } from '@supops/db';
import type { NotifyEvent } from '@supops/db';
import { alertMatchLabels, matchesAll } from '@supops/shared';
import { inSlot, loadTargets, type IncidentNote, type NotifyEventName } from '@supops/core';
import { db } from '../context.ts';
import { incidentIsFlapping } from '../observe/triage.ts';
import { sendToChannel } from './channels.ts';
import { runWritebacks } from './writeback.ts';

/**
 * Tells channels about incidents. Instead of hooking every place an incident changes,
 * it looks every few seconds at each incident's state and at what each channel has
 * already been told (notification_deliveries), and queues what is missing. So nothing
 * is missed whatever changed the incident, and nothing goes out twice: each event has a
 * key, unique per channel.
 *
 * A channel or route never announces incidents from before it existed.
 */

type IncidentRow = typeof incidents.$inferSelect;
type RouteRow = typeof notificationRoutes.$inferSelect;
type ChannelRow = typeof notificationChannels.$inferSelect;

export const NOTIFICATIONS_SETTINGS_KEY = 'notifications';

/** SupOps' address, for links in messages. The environment wins over the setting. */
export function publicUrl(): string | null {
  const env = process.env.SUPOPS_PUBLIC_URL?.trim();
  if (env) return env.replace(/\/+$/, '');
  const row = db.select().from(settings).where(eq(settings.key, NOTIFICATIONS_SETTINGS_KEY)).get();
  const v = (row?.value as { publicUrl?: string } | undefined)?.publicUrl?.trim();
  return v ? v.replace(/\/+$/, '') : null;
}

const RANK: Record<string, number> = { critical: 3, warning: 2, unknown: 2, info: 1 };
const rank = (s: string) => RANK[s] ?? 0;

/** What a message about this incident says, from its state now. */
export function noteFor(inc: IncidentRow): IncidentNote {
  const slugs = new Map(loadTargets(db, inc.projectId).map((t) => [t.id, t.slug]));
  const n = db.select({ n: sql<number>`count(*)` }).from(alerts).where(eq(alerts.incidentId, inc.id)).get()?.n ?? 0;
  const name = (id: string | null) => (id ? db.select({ name: users.name }).from(users).where(eq(users.id, id)).get()?.name ?? null : null);
  const base = publicUrl();
  return {
    id: inc.id,
    title: inc.title,
    severity: inc.severity,
    status: inc.status,
    targets: (inc.targetIds ?? []).map((id) => slugs.get(id)).filter((s): s is string => !!s),
    alertCount: n,
    rootCause: inc.rootCause,
    confidence: inc.confidence,
    owner: name(inc.assigneeId),
    acknowledgedBy: name(inc.acknowledgedBy),
    url: base ? `${base}/observability/incidents/${inc.id}` : null,
    openedAt: inc.openedAt.getTime(),
  };
}

/** Does the route take this incident? Its matchers must hold for at least one of its alerts. */
function routeTakes(route: RouteRow, inc: IncidentRow, labelSets: Array<Record<string, string>>): boolean {
  if (rank(inc.severity) < rank(route.minSeverity)) return false;
  if (!route.matchers.length) return true;
  return labelSets.some((l) => matchesAll(route.matchers, l));
}

const quiet = (route: RouteRow, at: number) => !!route.quietHours && inSlot(route.quietHours, at);

interface Wanted {
  event: NotifyEventName & NotifyEvent;
  key: string;
  /** When it happened: a channel or route created later does not announce it. */
  at: number;
}

/** Everything that could be said about this incident on one channel, given what that channel was told. */
function wanted(inc: IncidentRow, told: Array<typeof notificationDeliveries.$inferSelect>): Wanted[] {
  const out: Wanted[] = [];
  const announced = told.filter((d) => (d.event === 'opened' || d.event === 'reopened') && d.status === 'sent');
  out.push({ event: 'opened', key: `${inc.id}:opened`, at: inc.openedAt.getTime() });
  if (!announced.length) return out;
  const resolvedSent = told.filter((d) => d.event === 'resolved' && d.status === 'sent');
  if (inc.status === 'open') {
    if (resolvedSent.length) out.push({ event: 'reopened', key: `${inc.id}:reopened:${resolvedSent.length}`, at: inc.lastSeenAt.getTime() });
    const toldSeverity = Math.max(...told.filter((d) => d.status === 'sent').map((d) => rank(String(d.snapshot?.severity ?? 'info'))));
    if (rank(inc.severity) > toldSeverity) out.push({ event: 'escalated', key: `${inc.id}:sev:${inc.severity}`, at: inc.lastSeenAt.getTime() });
  }
  // Said even if it has resolved since: acknowledged and then resolved within moments is still both.
  if (inc.acknowledgedAt) out.push({ event: 'acknowledged', key: `${inc.id}:ack:${inc.acknowledgedAt.getTime()}`, at: inc.acknowledgedAt.getTime() });
  if (inc.status === 'resolved' && inc.resolvedAt) out.push({ event: 'resolved', key: `${inc.id}:resolved:${inc.resolvedAt.getTime()}`, at: inc.resolvedAt.getTime() });
  if (inc.triageState === 'done' && inc.rootCause && inc.runId) out.push({ event: 'diagnosed', key: `${inc.id}:diagnosed:${inc.runId}`, at: inc.lastSeenAt.getTime() });
  return out;
}

/** Queue what each channel has not been told yet. Returns how many deliveries were queued. */
export function plan(now = Date.now()): number {
  let queued = 0;
  for (const p of db.select({ id: projects.id }).from(projects).all()) {
    const routes = db.select().from(notificationRoutes).where(and(eq(notificationRoutes.projectId, p.id), eq(notificationRoutes.enabled, true))).all();
    if (!routes.length) continue;
    const channels = new Map(db.select().from(notificationChannels).where(and(eq(notificationChannels.projectId, p.id), eq(notificationChannels.enabled, true))).all().map((c) => [c.id, c]));
    const recent = new Date(now - 2 * 3_600_000);
    const incs = db
      .select()
      .from(incidents)
      .where(and(eq(incidents.projectId, p.id), isNull(incidents.mergedInto), eq(incidents.held, false), or(eq(incidents.status, 'open'), gt(incidents.resolvedAt, recent))))
      .all();
    for (const inc of incs) {
      const members = db.select({ title: alerts.title, severity: alerts.severity, source: alerts.source, labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
      // A test alert from SupOps is never news.
      if (members.length && members.every((m) => m.labels?.supops_test === 'true')) continue;
      const labelSets = members.map((m) => alertMatchLabels(m));
      const told = db.select().from(notificationDeliveries).where(eq(notificationDeliveries.incidentId, inc.id)).all();
      const flapping = incidentIsFlapping(inc.id);
      for (const route of routes) {
        if (!routeTakes(route, inc, labelSets)) continue;
        for (const chId of route.channelIds) {
          const ch = channels.get(chId);
          if (!ch) continue;
          const since = Math.max(route.createdAt.getTime(), ch.createdAt.getTime());
          const toldHere = told.filter((d) => d.channelId === ch.id);
          for (const w of wanted(inc, toldHere)) {
            if (!(route.events as string[]).includes(w.event)) continue;
            if (w.at < since) continue;
            if (toldHere.some((d) => d.dedupeKey === w.key)) continue;
            const skip =
              flapping && (w.event === 'reopened' || w.event === 'resolved' || w.event === 'escalated')
                ? 'flapping: firing and resolving over and over'
                : quiet(route, now) && inc.severity !== 'critical'
                  ? 'quiet hours'
                  : null;
            const r = db
              .insert(notificationDeliveries)
              .values({
                projectId: p.id,
                channelId: ch.id,
                routeId: route.id,
                incidentId: inc.id,
                event: w.event,
                dedupeKey: w.key,
                status: skip ? 'skipped' : 'pending',
                reason: skip,
                snapshot: { severity: inc.severity, title: inc.title },
                nextAttemptAt: skip ? null : new Date(now),
              })
              .onConflictDoNothing()
              .run();
            if (r.changes) {
              queued++;
              told.push({ channelId: ch.id, dedupeKey: w.key, event: w.event, status: skip ? 'skipped' : 'pending', snapshot: { severity: inc.severity } } as never);
            }
          }
        }
      }
    }
  }
  return queued;
}

const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

/** Send what is due. One at a time, oldest first; a failure is retried with backoff, a few times. */
export async function drain(now = Date.now(), limit = 25): Promise<number> {
  const due = db
    .select()
    .from(notificationDeliveries)
    .where(and(inArray(notificationDeliveries.status, ['pending', 'failed']), lte(notificationDeliveries.nextAttemptAt, new Date(now))))
    .orderBy(notificationDeliveries.createdAt)
    .limit(limit)
    .all();
  let sent = 0;
  for (const d of due) {
    const ch = db.select().from(notificationChannels).where(eq(notificationChannels.id, d.channelId)).get();
    if (!ch || !ch.enabled) {
      db.update(notificationDeliveries).set({ status: 'skipped', reason: 'the channel is off', nextAttemptAt: null }).where(eq(notificationDeliveries.id, d.id)).run();
      continue;
    }
    const inc = d.incidentId ? db.select().from(incidents).where(eq(incidents.id, d.incidentId)).get() : null;
    const note: IncidentNote | null = inc ? noteFor(inc) : (d.snapshot?.note as IncidentNote | undefined) ?? null;
    if (!note) {
      db.update(notificationDeliveries).set({ status: 'skipped', reason: 'nothing to say any more', nextAttemptAt: null }).where(eq(notificationDeliveries.id, d.id)).run();
      continue;
    }
    // Later messages about an incident reply to the first one (a Slack thread).
    const opened = d.incidentId && d.event !== 'opened'
      ? db.select({ ref: notificationDeliveries.threadRef }).from(notificationDeliveries).where(and(eq(notificationDeliveries.channelId, ch.id), eq(notificationDeliveries.incidentId, d.incidentId), eq(notificationDeliveries.event, 'opened'), eq(notificationDeliveries.status, 'sent'))).get()
      : null;
    const r = await sendToChannel(ch, d.event as NotifyEventName, note, { deliveryId: d.id, threadRef: opened?.ref ?? null });
    const attempts = d.attempts + 1;
    if (r.ok) {
      db.update(notificationDeliveries)
        .set(r.notApplicable ? { status: 'skipped', reason: `${ch.kind} has nothing to show for this`, attempts, nextAttemptAt: null } : { status: 'sent', attempts, sentAt: new Date(), responseCode: r.code ?? null, error: null, threadRef: r.threadRef ?? null, nextAttemptAt: null })
        .where(eq(notificationDeliveries.id, d.id))
        .run();
      if (!r.notApplicable) {
        db.update(notificationChannels).set({ sent: sql`${notificationChannels.sent} + 1`, lastSentAt: new Date() }).where(eq(notificationChannels.id, ch.id)).run();
        sent++;
      }
    } else {
      const giveUp = attempts >= MAX_ATTEMPTS;
      db.update(notificationDeliveries)
        .set({ status: 'failed', attempts, error: (r.error ?? 'failed').slice(0, 500), responseCode: r.code ?? null, nextAttemptAt: giveUp ? null : new Date(now + BACKOFF_MS[attempts - 1]!) })
        .where(eq(notificationDeliveries.id, d.id))
        .run();
      db.update(notificationChannels)
        .set({ failed: sql`${notificationChannels.failed} + 1`, lastError: (r.error ?? 'failed').slice(0, 300), lastErrorAt: new Date() })
        .where(eq(notificationChannels.id, ch.id))
        .run();
    }
  }
  return sent;
}

/** The hour and date where the route's digest is kept: its quiet-hours time zone, or UTC. */
function localHourAndDate(at: number, timezone: string): { hour: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { hour: Number(get('hour')), date: `${get('year')}-${get('month')}-${get('day')}` };
}

/** What the last day looked like for a project, as digest lines. */
export function digestLines(projectId: string, now = Date.now()): { title: string; lines: string[] } {
  const since = new Date(now - 86_400_000);
  const opened = db.select().from(incidents).where(and(eq(incidents.projectId, projectId), isNull(incidents.mergedInto), eq(incidents.held, false), gt(incidents.openedAt, since))).all();
  const open = db.select().from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'), eq(incidents.held, false), isNull(incidents.mergedInto))).all();
  const resolved = opened.filter((i) => i.status === 'resolved');
  const skipped = db.select({ n: sql<number>`count(*)` }).from(notificationDeliveries).where(and(eq(notificationDeliveries.projectId, projectId), eq(notificationDeliveries.status, 'skipped'), gt(notificationDeliveries.createdAt, since))).get()?.n ?? 0;
  const bySev = (rows: IncidentRow[], s: string) => rows.filter((i) => i.severity === s).length;
  const diagnosed = db.select({ n: sql<number>`count(*)` }).from(runs).where(and(eq(runs.projectId, projectId), gt(runs.startedAt, since), sql`json_extract(${runs.triggerPayload}, '$.auto') = 1`)).get()?.n ?? 0;
  const lines = [
    `${opened.length} new incident${opened.length === 1 ? '' : 's'} in the last 24 hours (${bySev(opened, 'critical')} critical, ${bySev(opened, 'warning')} warning), ${resolved.length} already resolved.`,
    `${open.length} open now${open.length ? `: ${open.slice(0, 5).map((i) => i.title).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''}` : '.'}`,
    `${diagnosed} diagnosed automatically.`,
    ...(skipped ? [`${skipped} notification${skipped === 1 ? ' was' : 's were'} held back (quiet hours or flapping).`] : []),
  ];
  return { title: `${open.length} open, ${opened.length} new`, lines };
}

/** Queue each route's daily digest at its hour, once a day. */
export function planDigests(now = Date.now()): number {
  let queued = 0;
  for (const route of db.select().from(notificationRoutes).where(eq(notificationRoutes.enabled, true)).all()) {
    if (route.digestHour === null || route.digestHour === undefined) continue;
    const { hour, date } = localHourAndDate(now, route.quietHours?.timezone ?? 'UTC');
    if (hour !== route.digestHour) continue;
    const d = digestLines(route.projectId, now);
    const note: IncidentNote = { id: `digest-${date}`, title: d.title, severity: 'info', status: 'open', targets: [], alertCount: 0, rootCause: null, confidence: null, owner: null, acknowledgedBy: null, url: publicUrl() ? `${publicUrl()}/observability` : null, openedAt: now, lines: d.lines };
    for (const chId of route.channelIds) {
      const r = db
        .insert(notificationDeliveries)
        .values({ projectId: route.projectId, channelId: chId, routeId: route.id, incidentId: null, event: 'digest', dedupeKey: `digest:${route.id}:${date}`, status: 'pending', snapshot: { note }, nextAttemptAt: new Date(now) })
        .onConflictDoNothing()
        .run();
      queued += r.changes;
    }
  }
  return queued;
}

/** Runs plan + digests + drain every few seconds. */
export class Notifier {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start(everyMs = 5000): void {
    this.timer = setInterval(() => void this.tick(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      plan();
      planDigests();
      await drain();
      await runWritebacks();
    } catch (err) {
      console.error('notifier:', err instanceof Error ? err.message : err);
    } finally {
      this.busy = false;
    }
  }
}

export const notifier = new Notifier();
