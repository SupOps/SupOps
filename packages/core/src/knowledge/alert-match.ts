import { alertMatchLabels, matchesAll, parseMatchers } from '@supops/shared';

/**
 * Which alerts a runbook is for. Written either as alert names ("DiskFull, Disk*Filling",
 * case-insensitive, * matches anything) or as Alertmanager matchers
 * (`alertname=~"Disk.*", env="prod"`), the same syntax as silences and maintenance.
 */
export type AlertSpec = { ok: true; test: (a: AlertLike) => boolean } | { ok: false; error: string };

export interface AlertLike {
  title: string;
  severity: string;
  source?: string;
  labels?: Record<string, string> | null;
}

const glob = (name: string) => new RegExp(`^${name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');

export function parseAlertSpec(text: string): AlertSpec {
  const t = text.trim();
  if (!t) return { ok: false, error: 'Name at least one alert.' };
  if (/[=~]/.test(t)) {
    const parsed = parseMatchers(t);
    if (!parsed.ok) return parsed;
    return { ok: true, test: (a) => matchesAll(parsed.matchers, alertMatchLabels(a)) };
  }
  const names = t.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
  if (names.length > 30) return { ok: false, error: 'At most 30 alert names.' };
  if (names.some((n) => n.length > 120)) return { ok: false, error: 'An alert name is too long.' };
  const res = names.map(glob);
  return { ok: true, test: (a) => { const name = alertMatchLabels(a).alertname ?? a.title; return res.some((r) => r.test(name) || r.test(a.title)); } };
}

/** How many of these alerts a runbook's spec matches (0 when it has none or it is invalid). */
export function alertsMatched(spec: string | null | undefined, alerts: AlertLike[]): number {
  if (!spec || !alerts.length) return 0;
  const p = parseAlertSpec(spec);
  return p.ok ? alerts.filter(p.test).length : 0;
}
