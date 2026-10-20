import { createHash } from 'node:crypto';
import type { AlertSeverity } from '@supops/shared';
import { normalizeSeverity } from './sources.ts';

/**
 * Alerts pushed to SupOps by webhook, in one shape whatever sent them. Each kind of
 * sender has a parser; all of them are pure (payload in, alerts out), so they are
 * tested against real payload shapes and never touch the database.
 */
export const INTEGRATION_KINDS = ['alertmanager', 'grafana', 'pagerduty', 'opsgenie', 'generic', 'changes'] as const;
export type IntegrationKind = (typeof INTEGRATION_KINDS)[number];

export interface HookAlert {
  fingerprint: string;
  title: string;
  severity: AlertSeverity;
  summary: string | null;
  labels: Record<string, string>;
  status: 'firing' | 'resolved';
  startsAt: number | null;
  link: string | null;
  /** Someone acknowledged it at the source (PagerDuty, Opsgenie), and who, if known. */
  acknowledged?: { by: string | null };
  /** The source's own id for it, for writing back (the PagerDuty incident id, the Opsgenie alias). */
  externalId?: string;
}

/** For a generic sender: where each field is in its JSON, as dotted paths (`alert.labels.host`, `items[0].name`). */
export interface GenericMapping {
  /** Path to an array of alerts; empty means the payload is one alert. */
  alertsPath?: string;
  titlePath?: string;
  severityPath?: string;
  statusPath?: string;
  /** Values of the status field that mean "resolved" (case-insensitive). */
  resolvedValues?: string[];
  fingerprintPath?: string;
  summaryPath?: string;
  /** Path to an object whose string values become labels. */
  labelsPath?: string;
  hostPath?: string;
  servicePath?: string;
  linkPath?: string;
}

export type ParseOutcome = { ok: true; alerts: HookAlert[] } | { ok: false; error: string };

const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null);
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? (v > 1e12 ? v : v * 1000) : NaN;
  return Number.isFinite(t) ? t : null;
};
const clip = (s: string | null | undefined, n: number) => (s ? s.slice(0, n) : null);
/** Labels are strings, kept to a sane size: a sender cannot store megabytes per alert. */
function stringLabels(obj: unknown, max = 64): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (Object.keys(out).length >= max) break;
    const s = str(v);
    if (s !== null && /^[A-Za-z_][A-Za-z0-9_.\-]{0,63}$/.test(k)) out[k] = s.slice(0, 512);
  }
  return out;
}
const hash = (parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const labelHash = (labels: Record<string, string>) => hash(Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`));

/** `a.b[2].c` out of a parsed payload; undefined when any step is missing. */
export function pathGet(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.').flatMap((p) => p.split(/\[(\d+)\]/).filter(Boolean))) {
    if (cur === null || cur === undefined) return undefined;
    if (/^\d+$/.test(part) && Array.isArray(cur)) cur = cur[Number(part)];
    else if (typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, part)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

// ---- Alertmanager (and Grafana, which sends the same shape) -------------------------

interface AmHookAlert {
  status?: string;
  labels?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  startsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
  dashboardURL?: string;
  panelURL?: string;
}

function parseAlertmanagerLike(payload: unknown, kind: 'alertmanager' | 'grafana'): ParseOutcome {
  const list = (payload as { alerts?: unknown })?.alerts;
  if (!Array.isArray(list)) return { ok: false, error: `This does not look like a ${kind === 'grafana' ? 'Grafana' : 'Alertmanager'} webhook: there is no "alerts" list.` };
  const alerts: HookAlert[] = [];
  for (const raw of list.slice(0, 500) as AmHookAlert[]) {
    const labels = stringLabels(raw?.labels);
    if (!Object.keys(labels).length) continue;
    const ann = stringLabels(raw.annotations);
    alerts.push({
      fingerprint: clip(str(raw.fingerprint), 64) || labelHash(labels),
      title: (labels.alertname ?? 'Alert').slice(0, 200),
      severity: normalizeSeverity(labels.severity ?? labels.priority ?? labels.level),
      summary: clip(ann.summary ?? ann.description ?? ann.message ?? null, 2000),
      labels,
      status: raw.status === 'resolved' ? 'resolved' : 'firing',
      startsAt: time(raw.startsAt),
      link: clip(str(raw.panelURL) || str(raw.dashboardURL) || str(raw.generatorURL), 1000),
    });
  }
  return { ok: true, alerts };
}

// ---- PagerDuty (v3 webhooks) --------------------------------------------------------

/** PagerDuty v3: one event per request, about one incident. */
function parsePagerDuty(payload: unknown): ParseOutcome {
  const event = (payload as { event?: Record<string, unknown> })?.event;
  const type = str(event?.event_type);
  const data = event?.data as Record<string, unknown> | undefined;
  if (!event || !type || !data) return { ok: false, error: 'This does not look like a PagerDuty v3 webhook: there is no "event" with an "event_type".' };
  if (!type.startsWith('incident.') || str(data.type) !== 'incident') return { ok: true, alerts: [] };
  const id = str(data.id);
  if (!id) return { ok: false, error: 'The PagerDuty incident has no id.' };
  // SupOps' own incident, sent to PagerDuty by a notification channel: not news coming back.
  if ((str(data.incident_key) ?? '').startsWith('supops-')) return { ok: true, alerts: [] };
  const urgency = str(data.urgency) ?? '';
  const priority = str((data.priority as Record<string, unknown> | undefined)?.summary) ?? '';
  const service = str((data.service as Record<string, unknown> | undefined)?.summary) ?? '';
  const labels: Record<string, string> = { source_system: 'pagerduty', pagerduty_incident: id };
  if (service) labels.service = service.slice(0, 200);
  if (urgency) labels.urgency = urgency;
  if (priority) labels.priority = priority;
  const number = str(data.number);
  if (number) labels.pagerduty_number = number;
  // PagerDuty has no free-form labels, so SupOps' own test payload says so in a field.
  if (data.supops_test === true) labels.supops_test = 'true';
  const severity: AlertSeverity = /^p1$|^sev-?1$/i.test(priority) || urgency === 'high' ? 'critical' : urgency === 'low' ? 'warning' : normalizeSeverity(priority);
  return {
    ok: true,
    alerts: [
      {
        fingerprint: `pagerduty:${id}`.slice(0, 64),
        title: (str(data.title) ?? `PagerDuty incident ${number ?? id}`).slice(0, 200),
        severity,
        summary: null,
        labels,
        status: type === 'incident.resolved' ? 'resolved' : 'firing',
        startsAt: time(data.created_at) ?? time(event.occurred_at),
        link: clip(str(data.html_url), 1000),
        externalId: id,
        ...(type === 'incident.acknowledged' ? { acknowledged: { by: str((event.agent as Record<string, unknown> | undefined)?.summary) } } : {}),
      },
    ],
  };
}

// ---- Opsgenie (outgoing webhook integration) ----------------------------------------

function parseOpsgenie(payload: unknown): ParseOutcome {
  const p = payload as { action?: unknown; alert?: Record<string, unknown> };
  const action = str(p?.action);
  const alert = p?.alert;
  if (!action || !alert) return { ok: false, error: 'This does not look like an Opsgenie webhook: there is no "action" and "alert".' };
  const id = str(alert.alias) || str(alert.alertId);
  if (!id) return { ok: false, error: 'The Opsgenie alert has no alias or id.' };
  if (id.startsWith('supops-')) return { ok: true, alerts: [] };
  const labels: Record<string, string> = { source_system: 'opsgenie', ...stringLabels(alert.details, 40), opsgenie_alias: id.slice(0, 200) };
  for (const tag of Array.isArray(alert.tags) ? alert.tags.slice(0, 20) : []) {
    const t = str(tag);
    const m = t ? /^([A-Za-z_][A-Za-z0-9_.\-]{0,63})[:=](.+)$/.exec(t) : null;
    if (m) labels[m[1]!] ??= m[2]!.slice(0, 200);
  }
  const entity = str(alert.entity);
  if (entity && !labels.host) labels.host = entity.slice(0, 200);
  const priority = str(alert.priority) ?? '';
  if (priority) labels.priority = priority;
  const severity: AlertSeverity = /^P[12]$/.test(priority) ? 'critical' : priority === 'P3' ? 'warning' : /^P[45]$/.test(priority) ? 'info' : 'unknown';
  const closed = /^(close|delete)$/i.test(action);
  return {
    ok: true,
    alerts: [
      {
        fingerprint: `opsgenie:${id}`.slice(0, 64),
        title: (str(alert.message) ?? 'Opsgenie alert').slice(0, 200),
        severity,
        summary: clip(str(alert.description), 2000),
        labels,
        status: closed ? 'resolved' : 'firing',
        startsAt: time(alert.createdAt),
        link: null,
        externalId: id,
        ...(/^acknowledge$/i.test(action) ? { acknowledged: { by: str(alert.username) ?? str((p as { username?: unknown }).username) } } : {}),
      },
    ],
  };
}

// ---- Anything else, by field paths --------------------------------------------------

const FIRST = (...paths: string[]) => paths;
const GUESS = {
  title: FIRST('title', 'name', 'alertname', 'alert_name', 'summary', 'message', 'subject'),
  severity: FIRST('severity', 'priority', 'level', 'urgency'),
  status: FIRST('status', 'state'),
  summary: FIRST('description', 'summary', 'message', 'text', 'details'),
  host: FIRST('host', 'hostname', 'instance', 'node', 'server'),
  service: FIRST('service', 'app', 'application', 'component'),
  fingerprint: FIRST('fingerprint', 'id', 'alert_id', 'dedup_key', 'key'),
  link: FIRST('url', 'link', 'html_url'),
};
const RESOLVED = ['resolved', 'ok', 'closed', 'recovered', 'normal', 'inactive', 'cleared'];

function parseGeneric(payload: unknown, m: GenericMapping): ParseOutcome {
  const listAt = m.alertsPath ? pathGet(payload, m.alertsPath) : undefined;
  if (m.alertsPath && !Array.isArray(listAt)) return { ok: false, error: `Nothing is a list at "${m.alertsPath}".` };
  const items: unknown[] = Array.isArray(listAt) ? listAt.slice(0, 500) : Array.isArray(payload) ? payload.slice(0, 500) : [payload];
  const pick = (item: unknown, path: string | undefined, guesses: string[]): string | null => {
    if (path) return str(pathGet(item, path));
    for (const g of guesses) {
      const v = str(pathGet(item, g));
      if (v) return v;
    }
    return null;
  };
  const resolvedValues = (m.resolvedValues?.length ? m.resolvedValues : RESOLVED).map((v) => v.toLowerCase());
  const alerts: HookAlert[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const title = pick(item, m.titlePath, GUESS.title);
    if (!title) continue;
    const labels = stringLabels(m.labelsPath ? pathGet(item, m.labelsPath) : (item as Record<string, unknown>).labels ?? (item as Record<string, unknown>).tags);
    const host = pick(item, m.hostPath, GUESS.host);
    const service = pick(item, m.servicePath, GUESS.service);
    if (host && !labels.host && !labels.instance) labels.host = host.slice(0, 200);
    if (service && !labels.service) labels.service = service.slice(0, 200);
    labels.alertname ??= title.slice(0, 200);
    const status = (pick(item, m.statusPath, GUESS.status) ?? '').toLowerCase();
    const fp = pick(item, m.fingerprintPath, GUESS.fingerprint);
    alerts.push({
      fingerprint: fp ? `generic:${fp}`.slice(0, 64) : labelHash(labels),
      title: title.slice(0, 200),
      severity: normalizeSeverity(pick(item, m.severityPath, GUESS.severity) ?? undefined),
      summary: clip(pick(item, m.summaryPath, GUESS.summary), 2000),
      labels,
      status: resolvedValues.includes(status) ? 'resolved' : 'firing',
      startsAt: null,
      link: clip(pick(item, m.linkPath, GUESS.link), 1000),
    });
  }
  if (!alerts.length) return { ok: false, error: 'No alert with a title was found. Set the title path for this sender.' };
  return { ok: true, alerts };
}

export function parseWebhook(kind: IntegrationKind, payload: unknown, mapping: GenericMapping = {}): ParseOutcome {
  switch (kind) {
    case 'alertmanager':
    case 'grafana':
      return parseAlertmanagerLike(payload, kind);
    case 'pagerduty':
      return parsePagerDuty(payload);
    case 'opsgenie':
      return parseOpsgenie(payload);
    case 'generic':
      return parseGeneric(payload, mapping);
    case 'changes':
      return { ok: false, error: 'A changes sender posts changes, not alerts.' };
  }
}

/** A payload of the sender's own shape, for "Send a test alert". */
export function sampleWebhook(kind: IntegrationKind, status: 'firing' | 'resolved' = 'firing'): unknown {
  const now = new Date().toISOString();
  const labels = { alertname: 'SupOpsTestAlert', severity: 'info', instance: 'test-host', supops_test: 'true' };
  switch (kind) {
    case 'alertmanager':
    case 'grafana':
      return {
        version: '4',
        status,
        alerts: [{ status, labels, annotations: { summary: 'A test alert sent from SupOps. Nothing is wrong.' }, startsAt: now, fingerprint: 'supops-test' }],
      };
    case 'pagerduty':
      return {
        event: {
          event_type: status === 'resolved' ? 'incident.resolved' : 'incident.triggered',
          occurred_at: now,
          data: { id: 'SUPOPSTEST', type: 'incident', title: 'SupOps test alert', urgency: 'low', number: 0, service: { summary: 'supops-test' }, supops_test: true },
        },
      };
    case 'opsgenie':
      return {
        action: status === 'resolved' ? 'Close' : 'Create',
        alert: { alias: 'test-from-supops', message: 'SupOps test alert', priority: 'P5', tags: ['supops_test:true'], entity: 'test-host', description: 'Nothing is wrong.' },
      };
    case 'generic':
      return { title: 'SupOps test alert', severity: 'info', status, host: 'test-host', id: 'supops-test', labels: { supops_test: 'true' } };
    case 'changes':
      return { id: 'supops-test', service: 'test-service', version: '1.0.0', title: 'SupOps test change', kind: 'deploy', status: 'success', started_at: now, labels: { supops_test: 'true' } };
  }
}

/**
 * What an alert says, apart from the fields that change on every resend (timestamps,
 * counters). Two notifications with the same fingerprint and the same content are an
 * exact repeat: counted, not stored again.
 */
export function contentHash(a: { title: string; severity: string; summary: string | null; labels: Record<string, string>; status: string }): string {
  return hash([a.title, a.severity, a.summary ?? '', a.status, ...Object.keys(a.labels).sort().map((k) => `${k}=${a.labels[k]}`)]);
}
