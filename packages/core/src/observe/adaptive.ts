/**
 * Self-adjusting thresholds (the idea behind Dynatrace's auto-adaptive baselines): each
 * series learns its own limit from its last 7 days, the 99th percentile plus n times its
 * interquartile range (or, where falling is bad, the 1st percentile minus that), relearned
 * daily. It fires when 3 of the last 5 minutes are past the limit, so one spike does not.
 */

export interface AdaptiveSpec {
  /** n in P99 + n x IQR. Default 2. */
  iqrs: number;
}

export interface LearnedLimit {
  /** Rising past `upper` is bad (null: not watched upward). */
  upper: number | null;
  /** Falling past `lower` is bad. */
  lower: number | null;
}

export function learnLimit(q: { p01?: number | null; p25?: number | null; p75?: number | null; p99?: number | null }, direction: 'up' | 'down' | 'both', spec: AdaptiveSpec): LearnedLimit | null {
  if (q.p25 == null || q.p75 == null) return null;
  const iqr = Math.max(0, q.p75 - q.p25);
  // A flat series has no spread: allow a small margin so ordinary noise does not fire.
  const margin = spec.iqrs * (iqr || Math.abs(q.p75) * 0.05 || 1e-9);
  const upper = direction !== 'down' && q.p99 != null ? q.p99 + margin : null;
  const lower = direction !== 'up' && q.p01 != null ? q.p01 - margin : null;
  return upper === null && lower === null ? null : { upper, lower };
}

/** How many of the latest `of` points are past the limit, and whether that fires (`need` of them). */
export function adaptiveBreach(points: number[], limit: LearnedLimit, need = 3, of = 5): { over: number; firing: boolean; side: 'above' | 'below' | null } {
  const last = points.slice(-of);
  const above = last.filter((v) => limit.upper !== null && v > limit.upper).length;
  const below = last.filter((v) => limit.lower !== null && v < limit.lower).length;
  const over = Math.max(above, below);
  return { over, firing: last.length >= Math.min(need, of) && over >= need, side: over === 0 ? null : above >= below ? 'above' : 'below' };
}
