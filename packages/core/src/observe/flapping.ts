/**
 * Flapping: an alert that keeps firing and resolving. Each refire is a new alert row
 * (an alert is closed when it resolves), so the history of one alert is every row with
 * its fingerprint: each row fired once, and resolved once if it has.
 *
 * Counting those changes in a window is the whole test. Nagios and Zabbix use the
 * same idea; Keep has none, so a flapping alert there opens incident after incident.
 */
export interface AlertOccurrence {
  firedAt: number;
  resolvedAt: number | null;
}

/** Fire and resolve changes since `since`. */
export function stateChanges(history: AlertOccurrence[], since: number): number {
  let n = 0;
  for (const h of history) {
    if (h.firedAt >= since) n++;
    if (h.resolvedAt !== null && h.resolvedAt >= since) n++;
  }
  return n;
}

export function isFlapping(history: AlertOccurrence[], now: number, opts: { changes: number; windowMs: number }): boolean {
  return stateChanges(history, now - opts.windowMs) >= opts.changes;
}

/** Quiet for the whole window: no change at all. A flapping alert that is quiet has settled. */
export const hasSettled = (history: AlertOccurrence[], now: number, windowMs: number): boolean => stateChanges(history, now - windowMs) === 0;
