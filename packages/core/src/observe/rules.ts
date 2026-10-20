import { matchesAll, type Matcher } from '@supops/shared';

/**
 * Correlation rules a person writes: "alerts like these, with the same values for
 * these labels, within this long, are one incident". They run before SupOps' built-in
 * grouping (correlate.ts), in priority order; an alert no rule matches is grouped the
 * built-in way.
 *
 * Unlike Keep's, a rule is data, not a string of CEL to be split on `") || ("`, and its
 * effect can be previewed on real alerts before it is saved.
 */
export interface CorrelationRule {
  id: string;
  name: string;
  /** Which alerts the rule is about. At least one matcher. */
  matchers: Matcher[];
  /** Alerts with the same values for these labels group together. Empty: all matching alerts are one group. */
  groupBy: string[];
  /** An alert joins an open group incident that saw activity this recently. */
  windowMin: number;
  /** The incident stays held (not listed, not diagnosed) until it has this many alerts. */
  threshold: number;
  /** all: when every alert resolved (the default); first: when any does; never: a person closes it. */
  resolveOn: 'all' | 'first' | 'never';
  /** `{{label}}` placeholders, e.g. "{{alertname}} in {{namespace}}". Empty: SupOps' usual title. */
  titleTemplate: string;
}

export const ruleMatches = (rule: Pick<CorrelationRule, 'matchers'>, labels: Record<string, string>): boolean =>
  rule.matchers.length > 0 && matchesAll(rule.matchers, labels);

/** The first rule (in the order given) that applies to this alert. */
export const ruleFor = <R extends Pick<CorrelationRule, 'matchers'>>(rules: R[], labels: Record<string, string>): R | null => rules.find((r) => ruleMatches(r, labels)) ?? null;

/** Which group of the rule the alert is in: its values for the group-by labels. */
export const ruleGroupKey = (rule: Pick<CorrelationRule, 'groupBy'>, labels: Record<string, string>): string =>
  JSON.stringify(rule.groupBy.map((k) => labels[k] ?? ''));

/**
 * The incident's title from the template: each `{{label}}` becomes that label's
 * values across the incident's alerts ("web-1, web-2 and 3 more").
 */
export function renderTitle(template: string, alertLabels: Array<Record<string, string>>): string {
  return template
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.\-]*)\s*\}\}/g, (_m, key: string) => {
      const values = [...new Set(alertLabels.map((l) => l[key]).filter((v): v is string => !!v))];
      if (!values.length) return '?';
      return values.length <= 3 ? values.join(', ') : `${values.slice(0, 2).join(', ')} and ${values.length - 2} more`;
    })
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export interface PreviewAlert {
  title: string;
  labels: Record<string, string>;
  at: number;
}

export interface PreviewGroup {
  title: string;
  key: string;
  alerts: number;
  /** Would have reached the threshold and become a listed, diagnosed incident. */
  visible: boolean;
  first: number;
  last: number;
}

/**
 * What the rule would have made of these alerts: replayed in time order, grouping as
 * it would have live. Nothing is stored -- this is the dry run shown before saving.
 */
export function previewRule(rule: CorrelationRule, alerts: PreviewAlert[]): { matched: number; groups: PreviewGroup[] } {
  const windowMs = rule.windowMin * 60_000;
  const groups: Array<PreviewGroup & { labels: Array<Record<string, string>> }> = [];
  const open = new Map<string, (typeof groups)[number]>();
  let matched = 0;
  for (const a of [...alerts].sort((x, y) => x.at - y.at)) {
    if (!ruleMatches(rule, a.labels)) continue;
    matched++;
    const key = ruleGroupKey(rule, a.labels);
    let g = open.get(key);
    if (g && a.at - g.last > windowMs) g = undefined;
    if (!g) {
      g = { title: '', key, alerts: 0, visible: false, first: a.at, last: a.at, labels: [] };
      groups.push(g);
      open.set(key, g);
    }
    g.alerts++;
    g.last = a.at;
    g.labels.push(a.labels);
    g.visible = g.alerts >= rule.threshold;
  }
  return {
    matched,
    groups: groups.map(({ labels, ...g }) => ({ ...g, title: rule.titleTemplate.trim() ? renderTitle(rule.titleTemplate, labels) : `${labels[0]?.alertname ?? 'Alerts'}${labels.length > 1 ? ` and ${labels.length - 1} more` : ''}` })),
  };
}
