import { matchesAll, unsafeRegex, type Matcher } from '@supops/shared';

/**
 * Enrichment: labels SupOps adds to an alert so it can be routed, grouped and
 * understood -- never replacing what the source sent.
 *
 * 1. Extraction rules pull labels out of the alert's own text.
 * 2. The service catalogue (fields on service-map components) adds who owns it.
 */
export interface ExtractionRule {
  id: string;
  matchers: Matcher[];
  field: 'title' | 'summary' | 'label';
  labelName: string | null;
  pattern: string;
}

/** The text a pattern runs on is cut to this, so a huge message cannot slow ingest. */
export const MAX_EXTRACT_INPUT = 2000;

/** Why a pattern cannot be used, or null. It needs a named group: that is the label it makes. */
export function patternProblem(pattern: string): string | null {
  const unsafe = unsafeRegex(pattern);
  if (unsafe) return `The pattern ${unsafe}.`;
  if (!/\(\?<[A-Za-z_][A-Za-z0-9_]*>/.test(pattern)) return 'Add a named group, e.g. (?<error_code>\\d+): its name becomes the label.';
  return null;
}

export interface AlertText {
  title: string;
  summary: string | null;
  labels: Record<string, string>;
}

/** Run each rule whose matchers hold; returns the labels added (by rule) and the alert's new labels. */
export function extractLabels(rules: ExtractionRule[], alert: AlertText, matchLabels: Record<string, string>): { labels: Record<string, string>; added: Record<string, string>; byRule: Array<{ id: string; seen: boolean; added: Record<string, string> }> } {
  const labels = { ...alert.labels };
  const added: Record<string, string> = {};
  const byRule: Array<{ id: string; seen: boolean; added: Record<string, string> }> = [];
  for (const r of rules) {
    if (!matchesAll(r.matchers, matchLabels)) {
      byRule.push({ id: r.id, seen: false, added: {} });
      continue;
    }
    const text = (r.field === 'title' ? alert.title : r.field === 'summary' ? alert.summary ?? '' : alert.labels[r.labelName ?? ''] ?? '').slice(0, MAX_EXTRACT_INPUT);
    const mine: Record<string, string> = {};
    let m: RegExpExecArray | null = null;
    try {
      m = new RegExp(r.pattern).exec(text);
    } catch {
      m = null;
    }
    for (const [k, v] of Object.entries(m?.groups ?? {})) {
      // Never overwrite what the source said, or what an earlier rule found.
      if (v && labels[k] === undefined) {
        labels[k] = v.slice(0, 200);
        mine[k] = labels[k]!;
      }
    }
    Object.assign(added, mine);
    byRule.push({ id: r.id, seen: true, added: mine });
  }
  return { labels, added, byRule };
}

/** Catalogue fields on a service-map component, and the alert labels they become. */
export const CATALOGUE_FIELDS = { owner: 'owner', team: 'team', runbook: 'runbook_url', repo: 'repo', tier: 'tier' } as const;
export type CatalogueField = keyof typeof CATALOGUE_FIELDS;

export function catalogueLabels(attrs: Record<string, string>, have: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, label] of Object.entries(CATALOGUE_FIELDS)) {
    const v = attrs[field]?.trim();
    if (v && have[label] === undefined) out[label] = v.slice(0, 300);
  }
  return out;
}
