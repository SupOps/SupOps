import { and, eq, inArray } from 'drizzle-orm';
import { adaptiveLimits, alerts, watches } from '@supops/db';
import { adaptiveBreach, learnLimit, obsRequest, promInstant, seriesKey, seriesName, type ResolvedTarget } from '@supops/core';
import { formatValue, OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from '../context.ts';
import { ingestAlert } from './ingest.ts';

type WatchRow = typeof watches.$inferSelect;

const RELEARN_MS = 24 * 3_600_000;

/** Learn each series' limit from its last 7 days: quantiles computed by the backend. */
export async function learnLimits(w: WatchRow, conn: ResolvedTarget, now = Date.now()): Promise<number> {
  const spec = { iqrs: w.adaptive?.iqrs ?? 2 };
  const dir = w.badDirection === 'down' ? 'down' : w.badDirection === 'both' ? 'both' : 'up';
  const q = (p: number) => promInstant(conn, `quantile_over_time(${p}, (${w.query})[7d:5m])`, AbortSignal.timeout(60_000));
  const [p01, p25, p75, p99] = await Promise.all([dir === 'up' ? null : q(0.01), q(0.25), q(0.75), dir === 'down' ? null : q(0.99)]);
  const by = (r: Awaited<ReturnType<typeof q>> | null) => new Map(r && !('error' in r) ? r.samples.map((s) => [seriesKey(s.metric), s] as const) : []);
  const m01 = by(p01), m25 = by(p25), m75 = by(p75), m99 = by(p99);
  let n = 0;
  db.transaction((tx) => {
    tx.delete(adaptiveLimits).where(eq(adaptiveLimits.watchId, w.id)).run();
    for (const [key, s] of m75) {
      const lim = learnLimit({ p01: m01.get(key)?.value ?? null, p25: m25.get(key)?.value ?? null, p75: s.value, p99: m99.get(key)?.value ?? null }, dir, spec);
      if (!lim) continue;
      tx.insert(adaptiveLimits).values({ watchId: w.id, series: key, labels: s.metric, upper: lim.upper, lower: lim.lower, computedAt: new Date(now) }).run();
      n++;
    }
  });
  return n;
}

/**
 * Compare the last five minutes of every series with its learned limit; three minutes past
 * it raise an alert (one per series), which resolves when that no longer holds.
 */
export async function checkAdaptive(w: WatchRow, conn: ResolvedTarget, now = Date.now()): Promise<{ firing: number }> {
  if (!w.adaptive) return { firing: 0 };
  let limits = db.select().from(adaptiveLimits).where(eq(adaptiveLimits.watchId, w.id)).all();
  if (!limits.length || now - Math.min(...limits.map((l) => l.computedAt.getTime())) > RELEARN_MS) {
    await learnLimits(w, conn, now);
    limits = db.select().from(adaptiveLimits).where(eq(adaptiveLimits.watchId, w.id)).all();
  }
  if (!limits.length) return { firing: 0 };
  const r = await obsRequest(conn, '/api/v1/query_range', { query: { query: w.query, start: Math.floor((now - 5 * 60_000) / 1000), end: Math.floor(now / 1000), step: 60 }, timeoutMs: 30_000 });
  if ('error' in r) return { firing: 0 };
  const rows = ((r.json as { data?: { result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> } }).data?.result ?? []);
  const points = new Map(rows.map((x) => [seriesKey(x.metric), x.values.map((v) => Number(v[1])).filter(Number.isFinite)] as const));
  const fp = (series: string) => `adaptive:${w.id}:${series}`;
  const open = new Set(
    db.select({ fingerprint: alerts.fingerprint }).from(alerts)
      .where(and(eq(alerts.projectId, w.projectId), inArray(alerts.status, [...OPEN_ALERT_STATUSES]), inArray(alerts.fingerprint, limits.map((l) => fp(l.series)))))
      .all().map((a) => a.fingerprint),
  );
  const fmt = (v: number) => formatValue(v, w.unit);
  let firing = 0;
  for (const l of limits) {
    const pts = points.get(l.series) ?? [];
    const b = adaptiveBreach(pts, { upper: l.upper, lower: l.lower });
    const name = seriesName(l.labels);
    if (!b.firing && !open.has(fp(l.series))) continue;
    if (b.firing) firing++;
    const limit = b.side === 'below' ? l.lower! : l.upper!;
    ingestAlert({
      projectId: w.projectId,
      source: 'supops',
      fingerprint: fp(l.series),
      title: `${w.title} unusually ${b.side === 'below' ? 'low' : 'high'}`,
      severity: 'warning',
      summary: b.firing
        ? `${w.title} on ${name} has been ${b.side} its learned limit (${fmt(limit)}) for ${b.over} of the last 5 minutes; now ${fmt(pts.at(-1)!)}. The limit is this series' own last 7 days: the ${b.side === 'below' ? '1st' : '99th'} percentile ${b.side === 'below' ? 'minus' : 'plus'} ${w.adaptive.iqrs}x its usual spread.`
        : `${w.title} on ${name} is back within its learned limit.`,
      labels: { ...l.labels, alertname: 'AdaptiveThreshold', signal: w.key },
      status: b.firing ? 'firing' : 'resolved',
      notification: false,
    });
  }
  return { firing };
}

/** Forget what a watch learned (it is relearned on the next pass); when switched off, close its alerts. */
export function forgetAdaptive(w: WatchRow, closeAlerts: boolean): void {
  db.delete(adaptiveLimits).where(eq(adaptiveLimits.watchId, w.id)).run();
  if (!closeAlerts) return;
  const open = db.select().from(alerts).where(and(eq(alerts.projectId, w.projectId), inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).all().filter((a) => a.fingerprint.startsWith(`adaptive:${w.id}:`));
  for (const a of open) {
    ingestAlert({ projectId: w.projectId, source: 'supops', fingerprint: a.fingerprint, title: a.title, severity: a.severity, summary: `${w.title}: the self-adjusting threshold was switched off.`, labels: a.labels ?? {}, status: 'resolved', notification: false });
  }
}
