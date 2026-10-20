/**
 * Service level objectives: a share of good events over a window (99.9% of requests not
 * failing, over 30 days), the error budget that leaves (0.1%), and how fast it is being
 * spent. Alerts use the multi-window burn rates from the Google SRE workbook: a fast burn
 * pages within minutes, a slow one within hours, and a short window confirms each, so an
 * alert stops soon after the problem does.
 */

export const BURN_WINDOWS = ['5m', '30m', '1h', '2h', '6h', '24h'] as const;
export type BurnWindow = (typeof BURN_WINDOWS)[number];

export interface BurnRule {
  id: string;
  /** Both windows must burn faster than this. */
  rate: number;
  long: BurnWindow;
  short: BurnWindow;
  severity: 'critical' | 'warning';
  /** At this rate, a 30-day budget lasts... (for the alert text). */
}

export const BURN_RULES: BurnRule[] = [
  { id: 'fast', rate: 14.4, long: '1h', short: '5m', severity: 'critical' },
  { id: 'medium', rate: 6, long: '6h', short: '30m', severity: 'critical' },
  { id: 'slow', rate: 3, long: '24h', short: '2h', severity: 'warning' },
];

/** `$window` in a query becomes the window being evaluated (`[$window]` -> `[1h]`). */
export const atWindow = (expr: string, window: string) => expr.replaceAll('$window', window);

/** How many times faster than sustainable the budget is being spent: 1 = exactly on budget. */
export function burnRate(errorRatio: number | null, target: number): number | null {
  if (errorRatio === null || !Number.isFinite(errorRatio)) return null;
  const budget = 1 - target;
  return budget > 0 ? Math.max(0, errorRatio) / budget : null;
}

/** The share of the window's budget still unspent (negative when overspent). */
export function budgetRemaining(windowErrorRatio: number | null, target: number): number | null {
  const b = burnRate(windowErrorRatio, target);
  return b === null ? null : 1 - b;
}

export interface BurnStatus {
  rates: Partial<Record<BurnWindow, number | null>>;
  firing: Array<{ rule: string; severity: 'critical' | 'warning'; long: BurnWindow; short: BurnWindow; rate: number; burn: number }>;
}

/** Which burn rules fire, given each window's error ratio. A missing window never fires. */
export function evaluateBurn(errorRatios: Partial<Record<BurnWindow, number | null>>, target: number): BurnStatus {
  const rates: BurnStatus['rates'] = {};
  for (const w of BURN_WINDOWS) rates[w] = burnRate(errorRatios[w] ?? null, target);
  const firing: BurnStatus['firing'] = [];
  for (const r of BURN_RULES) {
    const long = rates[r.long];
    const short = rates[r.short];
    if (long != null && short != null && long > r.rate && short > r.rate) firing.push({ rule: r.id, severity: r.severity, long: r.long, short: r.short, rate: r.rate, burn: Number(long.toFixed(2)) });
  }
  return { rates, firing };
}

/** Days until the budget is gone at this burn rate (null when not burning). */
export function daysToExhaustion(remaining: number | null, burn: number | null, windowDays: number): number | null {
  if (remaining === null || burn === null || burn <= 0) return null;
  if (remaining <= 0) return 0;
  return (remaining * windowDays) / burn;
}

/** The alert text for a firing rule. */
export function burnSummary(slo: { name: string; target: number; windowDays: number }, f: BurnStatus['firing'][number], remaining: number | null): string {
  const days = daysToExhaustion(remaining ?? 1, f.burn, slo.windowDays);
  return (
    `${slo.name}: the error budget is being spent ${f.burn}× faster than sustainable over ${f.long} (and over ${f.short}). ` +
    `Objective ${(slo.target * 100).toFixed(slo.target >= 0.999 ? 2 : 1)}% over ${slo.windowDays} days` +
    (remaining !== null ? `; ${Math.max(0, Math.round(remaining * 100))}% of the budget is left` : '') +
    (days !== null ? `, gone in ${days < 1 ? `${Math.max(1, Math.round(days * 24))} h` : `${days.toFixed(1)} days`} at this rate.` : '.')
  );
}

/** Good and total for a service's requests, from its RED queries: good = all minus failed. */
export function availabilityQueries(red: { rate: string; errorRatio: string }): { good: string; total: string } | null {
  // The RED rate is sum(rate(<count>{sel}[5m])); the error ratio's numerator names the failed ones.
  const total = red.rate.replace(/\[5m\]/g, '[$window]');
  const failed = /^\(sum\(rate\((.+?)\[5m\]\)\) or vector\(0\)\)/.exec(red.errorRatio)?.[1];
  if (!failed) return null;
  return { total, good: `${total} - (sum(rate(${failed}[$window])) or vector(0))` };
}
