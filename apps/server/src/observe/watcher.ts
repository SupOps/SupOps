import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { incidents, metricPoints, observations, projects, watchSeries, watches } from '@supops/db';
import type { Assessment, Prediction, ResolvedTarget, ScanSeries } from '@supops/core';
import {
  assessSeries,
  fluctuates,
  predict,
  isExhaustion,
  discoverSignals,
  formatEta,
  MAX_SCAN_SERIES,
  scanSignal,
  formatValue,
  loadTargets,
  scopeAlert,
  promRange,
  seriesFilterQuery,
  seriesFilterQueryMany,
  seriesName,
  SIGNALS,
} from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { projectConnections, watchesMetrics } from './connections.ts';
import { enqueueTriage } from './triage.ts';
import { reopenIncident } from './incidents.ts';
import { checkAdaptive } from './adaptive.ts';

/**
 * The watcher: every few minutes it looks at every series of the signals watched on
 * each metrics connection (the backend computes each one's last day and trend), scores
 * how close each is to trouble, and asks two questions -- is it unlike itself
 * (anomaly), and when will it run out (forecast). What it finds stays open as an
 * observation while it holds and resolves on its own. A forecast that something runs
 * out soon opens an incident, before any alert would have fired. Graphs are read from
 * the backend when shown, so nothing here depends on how much history SupOps keeps.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
type WatchRow = typeof watches.$inferSelect;

// ---- the forecast model, hourly, for the series that could be heading somewhere ----

/** How long a fitted model is used before it is fitted again. */
const MODEL_TTL = HOUR;
/** At most this many series per watch get the full model. */
const MAX_MODELLED = 100;
/** History the model reads (Prometheus keeps 15 days by default). */
const MODEL_HISTORY_DAYS = 15;
/** A forecast must hold this long before it opens an incident (an alert's `for:`). */
const PREDICTION_HOLD = 15 * 60_000;

const modelCache = new Map<string, { at: number; query: string; limit: string; byKey: Map<string, Prediction | null> }>();

/** The model's latest forecast for one series, for the chart. */
export function cachedPrediction(watchId: string, key: string): Prediction | null {
  return modelCache.get(watchId)?.byKey.get(key) ?? null;
}

/**
 * Which series are worth the full model: those near their limit, those the quick
 * trend says are heading there within a month, and those with a forecast open.
 * Everything else is far from trouble and is not modelled at all.
 */
function modelCandidates(w: WatchRow, series: ScanSeries[], fl: boolean, open: Set<string>): ScanSeries[] {
  const limit = w.limit!;
  const toward = (d: number | undefined) => d !== undefined && (limit.when === 'below' ? d < 0 : d > 0);
  const closeness = (s: ScanSeries): number => {
    const v = fl ? (s.avg15m ?? s.value) : s.value;
    // Headroom left, relative to the limit when it is not zero (e.g. 100%).
    const rel = limit.value !== 0 ? Math.abs(limit.value - v) / Math.abs(limit.value) : Infinity;
    const d = toward(s.deriv1d) ? s.deriv1d! : toward(s.deriv6h) ? s.deriv6h! : undefined;
    const etaDays = d !== undefined ? Math.abs(limit.value - v) / Math.abs(d) / 86_400 : Infinity;
    // Within 40% of the limit counts as close (scored like 30 days away at 40%).
    return Math.min(rel * 75, etaDays);
  };
  return series
    .map((s) => ({ s, c: open.has(s.key) ? -1 : closeness(s) }))
    .filter((x) => x.c <= 30 || x.c < 0)
    .sort((a, b) => a.c - b.c)
    .slice(0, MAX_MODELLED)
    .map((x) => x.s);
}

/**
 * Fit the model for the candidates whose fit is missing or older than an hour:
 * hourly means over the last 15 days, read in chunks of 20 series.
 */
async function modelsFor(w: WatchRow, conn: ResolvedTarget, candidates: ScanSeries[], now: number, fl: boolean): Promise<Map<string, Prediction | null>> {
  const limit = w.limit!;
  const limitKey = JSON.stringify(limit);
  let cache = modelCache.get(w.id);
  if (!cache || now - cache.at > MODEL_TTL || cache.query !== w.query || cache.limit !== limitKey) {
    cache = { at: now, query: w.query, limit: limitKey, byKey: new Map() };
    modelCache.set(w.id, cache);
  }
  // A cached fit predates a level shift when the fresh sample has moved far from the level
  // it left off at (e.g. a disk cleaned up from 80% to 35%). Drop it so it refits from the
  // new history -- otherwise a stale "reaches its limit now" keeps being pinned on a series
  // that is no longer anywhere near its limit.
  const freshLevel = (s: ScanSeries) => (fl ? (s.avg15m ?? s.value) : s.value);
  for (const s of candidates) {
    const p = cache.byKey.get(s.key);
    if (!p) continue;
    const scale = Math.max(Math.abs(limit.value - p.level), Math.abs(p.level) * 0.1, 1e-9);
    if (Math.abs(freshLevel(s) - p.level) > 0.25 * scale) cache.byKey.delete(s.key);
  }
  const missing = candidates.filter((s) => !cache!.byKey.has(s.key));
  const minRise = SIGNALS.find((x) => x.key === w.key)?.minDelta ?? 0;
  for (let i = 0; i < missing.length; i += 20) {
    const chunk = missing.slice(i, i + 20);
    const query = `avg_over_time((${seriesFilterQueryMany(w.query, chunk.map((s) => s.labels))})[1h:5m])`;
    const r = await promRange(conn, query, now - MODEL_HISTORY_DAYS * DAY, now, 3600, { signal: AbortSignal.timeout(60_000), maxSeries: 40 });
    if ('error' in r) {
      console.warn(`  ! forecast history for ${w.title}: ${r.error.slice(0, 160)}`);
      break;
    }
    const byKey = new Map(r.series.map((x) => [x.key, x.points]));
    for (const s of chunk) {
      const pts = byKey.get(s.key);
      cache.byKey.set(s.key, pts ? predict(pts, limit, { now, minRise }) : null);
      // A hundred fits must not hold up the server.
      await new Promise((res) => setImmediate(res));
    }
  }
  return new Map(candidates.filter((s) => cache!.byKey.has(s.key)).map((s) => [s.key, cache!.byKey.get(s.key)!]));
}

const MODEL_LABEL: Record<Prediction['model'], string> = { linear: 'steady trend', daily: 'daily pattern', weekly: 'weekly pattern' };

/** Last time built-in signals were discovered per connection. */
const discoveredAt = new Map<string, number>();

/** Create the built-in watches this connection can serve (existing ones are left alone). */
export async function discover(projectId: string, conn: ResolvedTarget): Promise<number> {
  const found = await discoverSignals(conn, AbortSignal.timeout(60_000));
  discoveredAt.set(conn.id, Date.now());
  let added = 0;
  for (const s of found) {
    const r = db
      .insert(watches)
      .values({
        projectId,
        connectionId: conn.id,
        key: s.key,
        title: s.title,
        query: s.query,
        unit: s.unit,
        builtin: true,
        badDirection: s.badDirection,
        limit: s.limit,
        group: s.group,
      })
      .onConflictDoNothing()
      .run();
    added += r.changes;
  }
  return added;
}

function openObservation(watchId: string, series: string, kind: 'anomaly' | 'forecast') {
  return db
    .select()
    .from(observations)
    .where(and(eq(observations.watchId, watchId), eq(observations.series, series), eq(observations.kind, kind), isNull(observations.resolvedAt)))
    .get();
}

export function resolveObservation(o: typeof observations.$inferSelect | undefined): void {
  if (!o) return;
  db.update(observations).set({ resolvedAt: new Date() }).where(eq(observations.id, o.id)).run();
  if (o.incidentId) {
    // A predicted problem that is no longer predicted is over.
    db.update(incidents)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(and(eq(incidents.id, o.incidentId), inArray(incidents.origin, ['prediction', 'threshold']), eq(incidents.status, 'open')))
      .run();
  }
}

/**
 * Look at every series of one watch, score each by how close it is to trouble, keep
 * that as the watch's current picture, and update what it reports: unusual values
 * (after two scans in a row) and forecasts (which can raise incidents).
 */
export async function sampleWatch(w: WatchRow, conn: ResolvedTarget, now = Date.now()): Promise<void> {
  const cfg = settingsStore.observability();
  const fl = fluctuates(w);
  // Rises and falls: read what held for 15 minutes; builds up: read its recent trend.
  const bad = w.limit ? (w.limit.when === 'above' ? 'up' : 'down') : w.badDirection === 'down' ? 'down' : 'up';
  const r = await scanSignal(conn, w.query, { withTrend: !!w.limit, ...(fl ? { sustain: bad } : {}), signal: AbortSignal.timeout(60_000) });
  if ('error' in r) {
    db.update(watches).set({ lastRunAt: new Date(now), lastError: r.error.slice(0, 500) }).where(eq(watches.id, w.id)).run();
    return;
  }

  const available = loadTargets(db, w.projectId);
  const signal = SIGNALS.find((s) => s.key === w.key);
  // Built-in levels apply only while the built-in query is unchanged.
  const own = signal && w.builtin && w.query === signal.query;
  const spec = { unit: w.unit, badDirection: w.badDirection, limit: w.limit, minDelta: signal?.minDelta, fluctuates: fl, ...(own ? { warn: signal.warn, crit: signal.crit } : {}) };
  const peers = r.series.map((s) => (fl ? (s.avg15m ?? s.value) : s.value));

  // The full forecast model, for the series that could be heading for their limit.
  let models = new Map<string, Prediction | null>();
  if (w.limit) {
    const openF = new Set(
      db.select({ series: observations.series }).from(observations)
        .where(and(eq(observations.watchId, w.id), eq(observations.kind, 'forecast'), isNull(observations.resolvedAt))).all().map((o) => o.series),
    );
    try {
      models = await modelsFor(w, conn, modelCandidates(w, r.series, fl, openF), now, fl);
    } catch (err) {
      console.warn(`  ! forecast model for ${w.title}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const assessed = new Map<string, Assessment>(
    r.series.map((s) => [s.key, assessSeries(s, spec, peers, models.has(s.key) ? { model: models.get(s.key)! } : {})]),
  );
  const prior = new Map(db.select({ series: watchSeries.series, streak: watchSeries.anomalyStreak }).from(watchSeries).where(eq(watchSeries.watchId, w.id)).all().map((x) => [x.series, x.streak]));
  const fmt = (v: number) => formatValue(v, w.unit);
  const horizon = (h: number) => h * HOUR;

  db.transaction((tx) => {
    tx.delete(watchSeries).where(eq(watchSeries.watchId, w.id)).run();
    for (const s of r.series) {
      const a = assessed.get(s.key)!;
      const name = seriesName(s.labels);
      const targetId = scopeAlert({ labels: s.labels, title: '', summary: null, channelName: null }, available).matched[0]?.id ?? null;
      tx.insert(watchSeries)
        .values({
          watchId: w.id, series: s.key, labels: s.labels, name, value: s.value, score: a.score, reasons: a.reasons,
          avg1d: s.avg1d ?? null, sd1d: s.sd1d ?? null, slopePerHour: a.forecast?.slopePerHour ?? (s.deriv6h !== undefined ? s.deriv6h * 3600 : null),
          etaMs: a.forecast?.etaMs ?? null, anomalyStreak: a.anomaly ? (prior.get(s.key) ?? 0) + 1 : 0, targetId, updatedAt: new Date(now),
        })
        .run();
    }
    tx.update(watches)
      .set({ lastRunAt: new Date(now), lastError: r.truncated ? `${r.truncated} more series than the ${MAX_SCAN_SERIES} checked; narrow the query` : null, seriesCount: r.series.length })
      .where(eq(watches.id, w.id))
      .run();
  });

  for (const s of r.series) {
    const row = db.select().from(watchSeries).where(and(eq(watchSeries.watchId, w.id), eq(watchSeries.series, s.key))).get()!;
    const a = assessed.get(s.key)!;
    const name = row.name;
    const targetId = row.targetId;

    // ---- unusual: reported once it has held for two scans
    const openA = openObservation(w.id, s.key, 'anomaly');
    if (a.anomaly && row.anomalyStreak >= 2) {
      const message = `${w.title} on ${name} is ${a.anomaly.direction === 'up' ? 'higher' : 'lower'} than usual: ${fmt(s.value)}, usually about ${fmt(a.anomaly.baseline)}`;
      const details = { z: a.anomaly.z, baseline: a.anomaly.baseline, direction: a.anomaly.direction, unit: w.unit, value: s.value, name, signal: w.title };
      if (openA) db.update(observations).set({ lastSeenAt: new Date(now), message, value: s.value, details }).where(eq(observations.id, openA.id)).run();
      else db.insert(observations).values({ projectId: w.projectId, watchId: w.id, series: s.key, labels: s.labels, targetId, kind: 'anomaly', severity: 'warning', message, value: s.value, details }).run();
    } else if (!a.anomaly) {
      resolveObservation(openA);
    }

    // ---- running out
    const openF = openObservation(w.id, s.key, 'forecast');
    const f = a.forecast;
    if (!w.limit || !f || f.etaMs > 7 * DAY) {
      resolveObservation(openF);
      continue;
    }
    const deterministic = w.key === 'cert_days';
    const usable = f.confidence !== 'low' || deterministic || f.etaMs === 0;
    // Over the line already: a warning while it holds steady, critical while it keeps going.
    const severity: 'critical' | 'warning' | 'info' = f.over
      ? f.worsening ? 'critical' : 'warning'
      : !usable
      ? 'info'
      : f.etaMs <= horizon(cfg.predictCriticalHours)
        ? 'critical'
        : f.etaMs <= horizon(cfg.predictWarningHours)
          ? 'warning'
          : 'info';
    const message = deterministic
      ? `Certificate for ${name} expires in ${formatEta(f.etaMs)}`
      : f.over
        ? `${w.title} on ${name} is over its limit (${fmt(s.value)}; limit ${fmt(w.limit.value)})${f.worsening ? ' and still rising' : ''}`
        : f.basis === 'model' && f.model
          ? `${w.title} on ${name} ${isExhaustion(w.limit, w.unit) ? 'runs out' : 'reaches its limit'} in about ${formatEta(f.etaMs)} (${MODEL_LABEL[f.model]}${f.slopePerHour ? `, ${f.slopePerHour >= 0 ? '+' : ''}${fmt(f.slopePerHour * 24)}/day` : ''}; now ${fmt(fl ? (s.avg15m ?? s.value) : s.value)})`
          : `${w.title} on ${name} ${isExhaustion(w.limit, w.unit) ? 'runs out' : 'reaches its limit'} in about ${formatEta(f.etaMs)} (now ${fmt(s.value)}, ${f.slopePerHour >= 0 ? '+' : ''}${fmt(f.slopePerHour)}/h)`;
    const details = {
      etaMs: f.etaMs, limit: w.limit, slopePerHour: f.slopePerHour, confidence: deterministic ? 'high' : f.confidence, over: !!f.over, worsening: !!f.worsening,
      unit: w.unit, value: s.value, name, signal: w.title,
      ...(f.basis ? { basis: f.basis } : {}), ...(f.model ? { model: f.model } : {}), ...(f.earliestMs !== undefined ? { earliestMs: f.earliestMs } : {}),
    };
    let obs = openF;
    if (obs) {
      db.update(observations).set({ lastSeenAt: new Date(now), message, severity, value: s.value, details }).where(eq(observations.id, obs.id)).run();
    } else {
      obs = db
        .insert(observations)
        .values({ projectId: w.projectId, watchId: w.id, series: s.key, labels: s.labels, targetId, kind: 'forecast', severity, message, value: s.value, details })
        .returning()
        .get();
    }
    // Soon enough, sure enough, and for long enough: a forecast must hold for 15
    // minutes (as an alert's `for:` would) before it opens an incident -- or, when an
    // incident is already open about this machine, before it joins it.
    const held = now - obs.startedAt.getTime() >= PREDICTION_HOLD;
    if (severity !== 'info' && held && !obs.incidentId && targetId) {
      const existing = db
        .select({ id: incidents.id, targetIds: incidents.targetIds })
        .from(incidents)
        .where(and(eq(incidents.projectId, w.projectId), eq(incidents.status, 'open'), isNull(incidents.mergedInto)))
        .all()
        .find((i) => (i.targetIds ?? []).includes(targetId));
      if (existing) {
        db.update(observations).set({ incidentId: existing.id }).where(eq(observations.id, obs.id)).run();
        obs = { ...obs, incidentId: existing.id };
      }
    }
    if (severity !== 'info' && held && !obs.incidentId) {
      const inc = db
        .insert(incidents)
        .values({
          projectId: w.projectId,
          title: message.slice(0, 200),
          severity: severity === 'critical' ? 'critical' : 'warning',
          origin: f.over ? 'threshold' : 'prediction',
          groupKey: { signal: w.key, series: name },
          groupReason: f.over ? `${w.title} is over the limit set for it` : 'raised by a forecast from the metric history',
          targetIds: targetId ? [targetId] : [],
        })
        .returning()
        .get();
      db.update(observations).set({ incidentId: inc.id }).where(eq(observations.id, obs.id)).run();
      enqueueTriage(inc.id);
    } else if (obs.incidentId) {
      // A forecast that turned critical breaks through an ignore.
      if (severity === 'critical' && held) {
        const linked = db.select({ status: incidents.status, severity: incidents.severity }).from(incidents).where(eq(incidents.id, obs.incidentId)).get();
        if (linked?.status === 'ignored' && linked.severity !== 'critical') {
          reopenIncident(obs.incidentId);
          enqueueTriage(obs.incidentId);
        }
      }
      // Keep the incident in step with the forecast: its severity can only rise this
      // way, and its title follows when it is the forecast's own wording -- also after
      // an alert joined it.
      const linked = db.select({ origin: incidents.origin, title: incidents.title }).from(incidents).where(eq(incidents.id, obs.incidentId)).get();
      const ownTitle = linked && (linked.origin !== 'alerts' || linked.title.startsWith(`${w.title} on ${name} `) || linked.title.startsWith(`Certificate for ${name} `));
      db.update(incidents)
        .set({ ...(ownTitle ? { title: message.slice(0, 200) } : {}), lastSeenAt: new Date(now), ...(severity === 'critical' ? { severity: 'critical' as const } : {}) })
        .where(and(eq(incidents.id, obs.incidentId), eq(incidents.status, 'open')))
        .run();
    }
  }

  // Series the query no longer returns: whatever was open about them is over.
  const keys = new Set(r.series.map((s) => s.key));
  for (const o of db.select().from(observations).where(and(eq(observations.watchId, w.id), isNull(observations.resolvedAt))).all()) {
    if (!keys.has(o.series)) resolveObservation(o);
  }
}

/** Close everything a watch currently claims (and the predicted incidents it raised). */
export function resolveWatchObservations(watchId: string): number {
  const open = db.select().from(observations).where(and(eq(observations.watchId, watchId), isNull(observations.resolvedAt))).all();
  for (const o of open) resolveObservation(o);
  return open.length;
}

/**
 * Evaluate a watch again after its settings changed. A new query means new data:
 * its samples are dropped and the history reloaded before anything is judged. A new
 * limit or direction is judged against the samples already kept. Either way the
 * anomalies, forecasts and predicted incidents now follow the new settings.
 */
export async function reevaluateWatch(watchId: string, opts: { queryChanged: boolean }): Promise<{ ok: boolean; error?: string }> {
  let w = db.select().from(watches).where(eq(watches.id, watchId)).get();
  if (!w) return { ok: false, error: 'Watch not found' };
  if (opts.queryChanged) {
    resolveWatchObservations(w.id);
    db.delete(watchSeries).where(eq(watchSeries.watchId, w.id)).run();
    w = db.update(watches).set({ lastRunAt: null, lastError: null, seriesCount: 0 }).where(eq(watches.id, w.id)).returning().get()!;
  }
  if (!w.enabled) return { ok: true };
  const conn = projectConnections(w.projectId).find((c) => c.id === w!.connectionId);
  if (!conn) return { ok: false, error: 'The connection is disabled or gone.' };
  await sampleWatch(w, conn);
  const after = db.select({ lastError: watches.lastError }).from(watches).where(eq(watches.id, w.id)).get();
  return after?.lastError && !after.lastError.includes('more series') ? { ok: false, error: after.lastError } : { ok: true };
}

export async function watchConnection(projectId: string, conn: ResolvedTarget): Promise<void> {
  if (Date.now() - (discoveredAt.get(conn.id) ?? 0) > DAY) await discover(projectId, conn);
  const list = db.select().from(watches).where(and(eq(watches.connectionId, conn.id), eq(watches.enabled, true))).all();
  for (const w of list) {
    try {
      await sampleWatch(w, conn);
      if (w.adaptive) await checkAdaptive(w, conn);
    } catch (err) {
      db.update(watches).set({ lastRunAt: new Date(), lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500) }).where(eq(watches.id, w.id)).run();
    }
  }
}

export class Watcher {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private nextAt = 0;

  start(): void {
    this.timer = setInterval(() => void this.tick(), 30_000);
    setTimeout(() => void this.tick(), 20_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run a pass now (e.g. after a connection was added). */
  kick(): void {
    this.nextAt = 0;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.busy || Date.now() < this.nextAt) return;
    this.busy = true;
    this.nextAt = Date.now() + settingsStore.observability().watchIntervalMs;
    try {
      for (const p of db.select({ id: projects.id }).from(projects).all()) {
        const watched = projectConnections(p.id).filter(watchesMetrics);
        for (const conn of watched) {
          try {
            await watchConnection(p.id, conn);
          } catch (err) {
            console.error(`watching ${conn.slug} failed:`, err);
          }
        }
        // A connection no longer watched (switched off, disabled, removed) stops claiming anything.
        const ids = new Set(watched.map((c) => c.id));
        const stale = db
          .select({ o: observations, connectionId: watches.connectionId })
          .from(observations)
          .innerJoin(watches, eq(watches.id, observations.watchId))
          .where(and(eq(observations.projectId, p.id), isNull(observations.resolvedAt)))
          .all()
          .filter((r) => !ids.has(r.connectionId));
        for (const r of stale) resolveObservation(r.o);
      }
    } finally {
      this.busy = false;
    }
  }
}

export const watcher = new Watcher();

/**
 * Several series of a watch over a window, for a combined graph: the worst `max`
 * (or the given ones), in one query. Cached for a minute like single charts.
 */
export async function combinedChart(w: WatchRow, hours: number, max = 10): Promise<{ series: Array<{ key: string; name: string; points: Array<[number, number]> }> } | { error: string }> {
  const conn = projectConnections(w.projectId).find((c) => c.id === w.connectionId);
  if (!conn) return { error: 'The connection is disabled or gone.' };
  const top = watchSeriesList(w.id, max);
  if (!top.length) return { series: [] };
  // All of them: the plain query, which stays short. Only a subset needs the (long) filter.
  const all = top.length >= (w.seriesCount ?? 0);
  const query = all ? w.query : seriesFilterQueryMany(w.query, top.map((t) => t.labels));
  const cacheKey = `combined|${w.id}|${hours}|${query}`;
  const hit = combinedCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return { series: hit.series };
  const end = Date.now();
  const step = Math.max(60, Math.ceil((hours * 3600) / 300));
  const r = await promRange(conn, query, end - hours * HOUR, end, step, { signal: AbortSignal.timeout(30_000), maxSeries: max });
  if ('error' in r) return r;
  const byKey = new Map(top.map((t) => [t.series, t]));
  const series = r.series
    .map((x) => ({ key: x.key, name: byKey.get(x.key)?.name ?? seriesName(x.labels), points: x.points.map((p) => [p.at, p.value] as [number, number]), score: byKey.get(x.key)?.score ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .map(({ score: _s, ...rest }) => rest);
  if (combinedCache.size > 200) combinedCache.clear();
  combinedCache.set(cacheKey, { at: Date.now(), series });
  return { series };
}

const combinedCache = new Map<string, { at: number; series: Array<{ key: string; name: string; points: Array<[number, number]> }> }>();

/** A watch's series, worst first. */
export function watchSeriesList(watchId: string, limit = 2000) {
  return db.select().from(watchSeries).where(eq(watchSeries.watchId, watchId)).orderBy(desc(watchSeries.score)).limit(limit).all();
}

const chartCache = new Map<string, { at: number; points: Array<[number, number]> }>();

/**
 * One series over a window, read from the backend at a resolution that keeps the
 * graph to a few hundred points. Cached for a minute: several people looking at the
 * same graph cost one query.
 */
export async function seriesChart(w: WatchRow, labels: Record<string, string>, hours: number): Promise<{ points: Array<[number, number]> } | { error: string }> {
  const conn = projectConnections(w.projectId).find((c) => c.id === w.connectionId);
  if (!conn) return { error: 'The connection is disabled or gone.' };
  const query = seriesFilterQuery(w.query, labels);
  const cacheKey = `${w.id}|${hours}|${query}`;
  const hit = chartCache.get(cacheKey);
  if (hit && Date.now() - hit.at < 60_000) return { points: hit.points };
  const end = Date.now();
  const step = Math.max(60, Math.ceil((hours * 3600) / 300));
  const r = await promRange(conn, query, end - hours * HOUR, end, step, { signal: AbortSignal.timeout(30_000), maxSeries: 1 });
  if ('error' in r) return r;
  const points = (r.series[0]?.points ?? []).map((p) => [p.at, p.value] as [number, number]);
  if (chartCache.size > 500) chartCache.clear();
  chartCache.set(cacheKey, { at: Date.now(), points });
  return { points };
}
