/**
 * Grouping alerts into incidents, by rules a person can read and check -- the way
 * Keep and PagerDuty start before any learning. A new alert joins an open incident
 * that saw activity in the last `windowMs` when they are about the same machine,
 * the same service, the same alert on several machines, or the same namespace.
 * Otherwise it starts its own incident. Every join says why.
 */

export interface CorrelatableAlert {
  title: string;
  labels: Record<string, string>;
  targetIds: string[];
  at: number;
}

export interface OpenIncidentRef {
  id: string;
  title: string;
  groupKey: Record<string, string>;
  targetIds: string[];
  lastSeenAt: number;
  /** When it opened: an incident older than MAX_INCIDENT_AGE takes no new alerts. */
  openedAt?: number;
  /** Every service its alerts are about (the group key holds only the first). */
  services?: string[];
}

/** A link on the service map groups alerts only when they start this close together. */
export const TOPOLOGY_WINDOW_MS = 5 * 60_000;
/** After this, an incident is closed to new alerts: a later problem is a new incident. */
export const MAX_INCIDENT_AGE_MS = 90 * 60_000;

/** Labels that name a service, most specific first. */
export const SERVICE_KEYS = ['service', 'app', 'app_kubernetes_io_name', 'deployment', 'statefulset', 'daemonset', 'container'];
/** Namespaces too broad to group by on their own. */
const BROAD_NAMESPACES = new Set(['default']);

const hostOf = (labels: Record<string, string>) =>
  (labels.instance || labels.host || labels.hostname || labels.node || '').toLowerCase().replace(/:\d+$/, '');

/** The labels an incident is grouped by. */
/** The service an alert is about, if its labels say. */
export function serviceOf(labels: Record<string, string>): string | undefined {
  for (const k of SERVICE_KEYS) if (labels[k]) return labels[k];
  return undefined;
}

export function groupKeyOf(alert: Pick<CorrelatableAlert, 'title' | 'labels'>): Record<string, string> {
  const l = alert.labels;
  const key: Record<string, string> = { alertname: l.alertname || alert.title };
  const host = hostOf(l);
  if (host) key.host = host;
  for (const k of SERVICE_KEYS) if (l[k]) { key.service = l[k]!; break; }
  if (l.namespace) key.namespace = l.namespace;
  if (l.cluster) key.cluster = l.cluster;
  return key;
}

export function chooseIncident(
  alert: CorrelatableAlert,
  open: OpenIncidentRef[],
  windowMs = 15 * 60_000,
  /** Are these machines connected (e.g. by the service map)? The reason, or null. */
  related?: (alertTargets: string[], incidentTargets: string[]) => string | null,
  /** Are these services connected on the service map? The reason, or null. */
  relatedServices?: (alertService: string, incidentService: string) => string | null,
): { incidentId: string; reason: string } | null {
  const key = groupKeyOf(alert);
  const recent = open
    .filter((i) => alert.at - i.lastSeenAt <= windowMs && i.lastSeenAt - alert.at <= windowMs)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  // Different clusters are different problems, whatever else they share.
  const sameCluster = (i: OpenIncidentRef) => !key.cluster || !i.groupKey.cluster || key.cluster === i.groupKey.cluster;
  const open90 = (i: OpenIncidentRef) => i.openedAt === undefined || alert.at - i.openedAt <= MAX_INCIDENT_AGE_MS;
  const candidates = recent.filter(sameCluster).filter(open90);
  // Connected on the map is a looser tie than the same machine or service: only when they start together.
  const close = (i: OpenIncidentRef) => Math.abs(alert.at - i.lastSeenAt) <= TOPOLOGY_WINDOW_MS;

  const rules: Array<(i: OpenIncidentRef) => string | null> = [
    (i) => (alert.targetIds.length && i.targetIds.some((t) => alert.targetIds.includes(t)) ? 'both are about the same machine' : null),
    (i) => (key.host && i.groupKey.host === key.host ? `both are about ${key.host}` : null),
    (i) => (related && close(i) && alert.targetIds.length && i.targetIds.length ? related(alert.targetIds, i.targetIds) : null),
    (i) => {
      if (!relatedServices || !close(i) || !key.service) return null;
      const theirs = (i.services ?? [i.groupKey.service]).filter((s): s is string => !!s && s !== key.service);
      for (const s of theirs) {
        const r = relatedServices(key.service, s);
        if (r) return r;
      }
      return null;
    },
    (i) => (key.service && i.groupKey.service === key.service && (!key.namespace || !i.groupKey.namespace || key.namespace === i.groupKey.namespace)
      ? `both are about the ${key.service} service` : null),
    (i) => (i.groupKey.alertname === key.alertname ? `the same alert (${key.alertname}) is firing on several machines` : null),
    (i) => (key.namespace && !BROAD_NAMESPACES.has(key.namespace) && i.groupKey.namespace === key.namespace ? `both are in the ${key.namespace} namespace` : null),
  ];
  for (const rule of rules) {
    for (const i of candidates) {
      const reason = rule(i);
      if (reason) return { incidentId: i.id, reason: `${reason}, within ${Math.round((reason.includes('(service map)') ? TOPOLOGY_WINDOW_MS : windowMs) / 60_000)} minutes` };
    }
  }
  return null;
}

/** Severity order, for an incident's severity (its worst alert). */
export const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1, unknown: 0 };
export const worstSeverity = <T extends string>(a: T, b: T): T => ((SEVERITY_RANK[b] ?? 0) > (SEVERITY_RANK[a] ?? 0) ? b : a);
