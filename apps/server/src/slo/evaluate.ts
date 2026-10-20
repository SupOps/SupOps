import { and, eq, gte } from 'drizzle-orm';
import { slos, syntheticResults } from '@supops/db';
import type { SloStatus } from '@supops/db';
import { BURN_RULES, BURN_WINDOWS, atWindow, availability, budgetRemaining, burnSummary, evaluateBurn, type BurnWindow, type ResolvedTarget } from '@supops/core';
import { db } from '../context.ts';
import { projectConnections } from '../observe/connections.ts';
import { ingestAlert } from '../observe/ingest.ts';
import { instant } from '../servicehealth/signals.ts';

type SloRow = typeof slos.$inferSelect;

/** Failed share over a window: 1 - good/total. Null when there were no events, or no data. */
export async function errorRatio(conn: ResolvedTarget, slo: Pick<SloRow, 'goodQuery' | 'totalQuery'>, window: string, atMs?: number): Promise<number | null> {
  const good = await instant(conn, atWindow(slo.goodQuery, window), atMs);
  const total = await instant(conn, atWindow(slo.totalQuery, window), atMs);
  if (good === null || total === null || total <= 0) return null;
  return Math.min(1, Math.max(0, 1 - good / total));
}

export function connectionOf(slo: SloRow): ResolvedTarget | null {
  return slo.connectionId ? (projectConnections(slo.projectId).find((c) => c.id === slo.connectionId) ?? null) : null;
}

/** "5m", "6h", "30d" in milliseconds. */
const windowMs = (w: string) => Number(w.slice(0, -1)) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[w.slice(-1) as 'm']!;

/** A synthetic check's failed share over a window, from its stored results. */
export function syntheticErrorRatio(checkId: string, window: string, now = Date.now()): number | null {
  const rows = db.select({ ok: syntheticResults.ok }).from(syntheticResults).where(and(eq(syntheticResults.checkId, checkId), gte(syntheticResults.at, new Date(now - windowMs(window))))).all();
  const a = availability(rows);
  return a === null ? null : 1 - a;
}

/**
 * Evaluate one SLO: the SLI and budget over its window, burn rates over the alerting
 * windows, and burn alerts raised or resolved to match.
 */
export async function evaluateSlo(slo: SloRow): Promise<SloStatus> {
  const conn = connectionOf(slo);
  const ratioAt = (w: string) => (slo.syntheticId ? Promise.resolve(syntheticErrorRatio(slo.syntheticId, w)) : errorRatio(conn!, slo, w));
  if (!conn && !slo.syntheticId) {
    const status: SloStatus = { at: Date.now(), sli: null, budgetRemaining: null, rates: {}, firing: [], error: 'Its metrics connection is gone or switched off.' };
    db.update(slos).set({ status }).where(eq(slos.id, slo.id)).run();
    return status;
  }
  const ratios: Partial<Record<BurnWindow, number | null>> = {};
  for (const w of BURN_WINDOWS) ratios[w] = await ratioAt(w);
  const whole = await ratioAt(`${slo.windowDays}d`);
  const burn = evaluateBurn(ratios, slo.target);
  const remaining = budgetRemaining(whole, slo.target);
  const status: SloStatus = {
    at: Date.now(),
    sli: whole === null ? null : 1 - whole,
    budgetRemaining: remaining,
    rates: burn.rates as Record<string, number | null>,
    firing: burn.firing,
    ...(whole === null && Object.values(ratios).every((r) => r === null) ? { error: slo.syntheticId ? 'The check has no results yet.' : 'The queries return no data: check the good and total expressions.' } : {}),
  };
  const was = new Set((slo.status?.firing ?? []).map((f) => f.rule));
  db.update(slos).set({ status }).where(eq(slos.id, slo.id)).run();

  if (slo.alerting) {
    const now = new Set(status.firing.map((f) => f.rule));
    for (const r of BURN_RULES) {
      const f = burn.firing.find((x) => x.rule === r.id);
      if (!f && !was.has(r.id)) continue;
      ingestAlert({
        projectId: slo.projectId,
        source: 'supops',
        fingerprint: `slo:${slo.id}:${r.id}`,
        title: `SLO burn: ${slo.name}`,
        severity: r.severity,
        summary: f ? burnSummary(slo, f, remaining) : `${slo.name}: back within budget over ${r.long} and ${r.short}.`,
        labels: {
          alertname: 'SLOBurnRate',
          slo: slo.name,
          burn_window: `${r.long}/${r.short}`,
          ...(slo.service ? { service: slo.service } : {}),
          ...(f ? { burn_rate: String(f.burn) } : {}),
        },
        status: now.has(r.id) ? 'firing' : 'resolved',
        notification: false,
      });
    }
  }
  return status;
}

class SloEvaluator {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const s of db.select().from(slos).where(eq(slos.enabled, true)).all()) {
        try {
          await evaluateSlo(s);
        } catch (err) {
          console.error(`SLO ${s.id} evaluation failed:`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    setTimeout(() => void this.tick(), 20_000);
    this.timer = setInterval(() => void this.tick(), 2 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const sloEvaluator = new SloEvaluator();
