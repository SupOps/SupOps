import type { EvidenceStatus } from '@supops/shared';
import type { ObservabilityConfig } from '@supops/db';
import type { ResolvedTarget } from '../tools/types.ts';
import { indexAllowed, obsRequest } from '../tools/observability.ts';
import { formatValue } from '@supops/shared';
import { clusterLogLines, drainPatterns, patternLine } from './logs.ts';

/**
 * The evidence pack: a fixed set of read-only checks run against an incident's
 * metrics and logs before any model looks at it (the approach of Grafana Sift and
 * Coroot). Each check is a known query filled from the incident's labels, says
 * whether what it found is interesting, and is skipped as `unavailable` when the
 * metric it needs does not exist. The investigation starts from these findings
 * instead of from a blank page, and cites them.
 */

export interface CheckScope {
  /** Host (instance) the incident is about, without a port. */
  host?: string;
  namespace?: string;
  pod?: string;
  service?: string;
  job?: string;
  /** Alert names in the incident, so related firing alerts can be told apart. */
  alertnames?: string[];
}

export interface CheckOutcome {
  status: EvidenceStatus;
  summary: string;
  query?: string;
  data?: unknown;
}

export interface CheckDef {
  key: string;
  title: string;
  group: 'alerts' | 'resources' | 'kubernetes' | 'traffic' | 'databases' | 'logs' | 'stack';
  kinds: Array<ResolvedTarget['kind']>;
  /** Skip unless the scope has what the check needs (e.g. a namespace). */
  applies?: (s: CheckScope) => boolean;
  run: (target: ResolvedTarget, scope: CheckScope, signal?: AbortSignal) => Promise<CheckOutcome>;
}

// ---- PromQL helpers ----------------------------------------------------------

/** A label value inside a PromQL string literal. */
export const promString = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
/** A literal inside a PromQL regex (=~), escaped for both the regex and the string. */
const promRegexLiteral = (v: string) => promString(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Matchers for the scope: `instance=~"web-1(:\\d+)?"`, `namespace="shop"`. */
export function scopeMatchers(s: CheckScope, keys: Array<'host' | 'namespace' | 'pod'> = ['host', 'namespace', 'pod']): string[] {
  const out: string[] = [];
  if (keys.includes('host') && s.host) out.push(`instance=~"${promRegexLiteral(s.host)}(:[0-9]+)?"`);
  if (keys.includes('namespace') && s.namespace) out.push(`namespace="${promString(s.namespace)}"`);
  if (keys.includes('pod') && s.pod) out.push(`pod="${promString(s.pod)}"`);
  return out;
}

/** Add matchers to a selector's braces: sel('up', ['a="1"']) -> up{a="1"}. */
export const sel = (metric: string, matchers: string[]) => (matchers.length ? `${metric}{${matchers.join(',')}}` : metric);

interface Sample {
  metric: Record<string, string>;
  value: number;
}

export async function promInstant(target: ResolvedTarget, query: string, signal?: AbortSignal): Promise<{ error: string } | { samples: Sample[] }> {
  const r = await obsRequest(target, '/api/v1/query', { query: { query }, signal, timeoutMs: 15_000 });
  if ('error' in r) return r;
  const data = (r.json as { data?: { resultType?: string; result?: unknown } }).data;
  if (data?.resultType === 'scalar') {
    const v = (data.result as [number, string])?.[1];
    return { samples: [{ metric: {}, value: Number(v) }] };
  }
  const rows = Array.isArray(data?.result) ? (data!.result as Array<{ metric: Record<string, string>; value: [number, string] }>) : [];
  return { samples: rows.map((x) => ({ metric: x.metric, value: Number(x.value[1]) })).filter((x) => Number.isFinite(x.value)) };
}

/** Does a metric exist at all on this backend? Distinguishes "fine" from "not measured". */
async function exists(target: ResolvedTarget, metric: string, signal?: AbortSignal): Promise<boolean> {
  const r = await promInstant(target, `count(${metric})`, signal);
  return !('error' in r) && r.samples.length > 0 && r.samples[0]!.value > 0;
}

const fmt = (v: number, unit = '') => {
  if (unit === ' bytes') return formatValue(v, 'bytes');
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(3);
  return `${Number(n)}${unit}`;
};
const lbl = (m: Record<string, string>, keys: string[]) => keys.map((k) => m[k]).filter(Boolean).join(' ') || '(all)';

/**
 * A threshold check on one PromQL query: rows above (or below) `limit` are
 * interesting. `requires` is probed only when the query returns nothing.
 */
function threshold(def: {
  key: string;
  title: string;
  group: CheckDef['group'];
  requires: string;
  query: (s: CheckScope) => string;
  limit: number;
  below?: boolean;
  unit?: string;
  labels: string[];
  describe: (n: number, worst: string) => string;
  /** What an empty answer means, when the metric exists. */
  ok?: string;
  applies?: (s: CheckScope) => boolean;
}): CheckDef {
  return {
    key: def.key,
    title: def.title,
    group: def.group,
    kinds: ['prometheus', 'grafana'],
    ...(def.applies ? { applies: def.applies } : {}),
    run: async (target, scope, signal) => {
      const query = def.query(scope);
      const r = await promInstant(target, query, signal);
      if ('error' in r) return { status: 'error', summary: r.error, query };
      if (!r.samples.length) {
        return (await exists(target, def.requires, signal))
          ? { status: 'normal', summary: def.ok ?? 'Nothing matched for this scope.', query }
          : { status: 'unavailable', summary: `${def.requires} is not collected here.`, query };
      }
      const rows = r.samples.sort((a, b) => (def.below ? a.value - b.value : b.value - a.value));
      const bad = rows.filter((x) => (def.below ? x.value <= def.limit : x.value >= def.limit));
      const show = (bad.length ? bad : rows).slice(0, 8).map((x) => `${lbl(x.metric, def.labels)}: ${fmt(x.value, def.unit)}`);
      return {
        status: bad.length ? 'interesting' : 'normal',
        summary: bad.length ? `${def.describe(bad.length, show[0]!)}\n${show.join('\n')}` : `All within limits. Highest: ${show.slice(0, 3).join('; ')}`,
        query,
        data: rows.slice(0, 20).map((x) => ({ labels: x.metric, value: x.value })),
      };
    },
  };
}

/** A check that lists whatever a query returns: any row is interesting. */
function listing(def: {
  key: string;
  title: string;
  group: CheckDef['group'];
  requires: string;
  query: (s: CheckScope) => string;
  labels: string[];
  unit?: string;
  describe: (n: number) => string;
  ok: string;
  applies?: (s: CheckScope) => boolean;
}): CheckDef {
  return threshold({ ...def, limit: -Infinity, describe: (n) => def.describe(n) });
}

// ---- the checks --------------------------------------------------------------

const FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|devtmpfs|nsfs"';
const hostOrAll = (s: CheckScope) => scopeMatchers(s, ['host']);
const nsOrAll = (s: CheckScope) => scopeMatchers(s, ['namespace', 'pod']);
const hasHostOrNs = (s: CheckScope) => !!(s.host || s.namespace || s.pod);

export const METRIC_CHECKS: CheckDef[] = [
  {
    key: 'related_alerts',
    title: 'Other alerts firing',
    group: 'alerts',
    kinds: ['prometheus', 'grafana'],
    run: async (target, scope, signal) => {
      const query = 'count by (alertname, severity) (ALERTS{alertstate="firing"})';
      const r = await promInstant(target, query, signal);
      if ('error' in r) return { status: 'error', summary: r.error, query };
      const others = r.samples.filter((x) => !(scope.alertnames ?? []).includes(x.metric.alertname ?? ''));
      if (!others.length) return { status: 'normal', summary: r.samples.length ? 'No other alerts are firing.' : 'No alerts are firing in Prometheus.', query };
      return {
        status: 'interesting',
        summary: `${others.length} other alert${others.length > 1 ? 's are' : ' is'} firing:\n${others.slice(0, 10).map((x) => `${x.metric.alertname}${x.metric.severity ? ` (${x.metric.severity})` : ''} x${x.value}`).join('\n')}`,
        query,
        data: others.slice(0, 20),
      };
    },
  },
  listing({
    key: 'targets_down',
    title: 'Scrape targets down',
    group: 'stack',
    requires: 'up',
    query: (s) => `${sel('up', hostOrAll(s))} == 0`,
    labels: ['job', 'instance'],
    ok: 'All scrape targets are up.',
    describe: (n) => `${n} scrape target${n > 1 ? 's are' : ' is'} down (Prometheus cannot reach ${n > 1 ? 'them' : 'it'}):`,
  }),
  threshold({
    key: 'cpu',
    title: 'CPU used',
    group: 'resources',
    requires: 'node_cpu_seconds_total',
    query: (s) => `100 * (1 - avg by (instance) (rate(${sel('node_cpu_seconds_total', ['mode="idle"', ...hostOrAll(s)])}[5m])))`,
    limit: 85,
    unit: '%',
    labels: ['instance'],
    describe: (n) => `CPU above 85% on ${n} host${n > 1 ? 's' : ''}:`,
  }),
  threshold({
    key: 'load',
    title: 'Load per core',
    group: 'resources',
    requires: 'node_load5',
    query: (s) => `${sel('node_load5', hostOrAll(s))} / on (instance) count by (instance) (${sel('node_cpu_seconds_total', ['mode="idle"', ...hostOrAll(s)])})`,
    limit: 1.5,
    labels: ['instance'],
    describe: (n) => `Load is above 1.5x the core count on ${n} host${n > 1 ? 's' : ''} (work is queueing):`,
  }),
  threshold({
    key: 'memory',
    title: 'Memory used',
    group: 'resources',
    requires: 'node_memory_MemAvailable_bytes',
    query: (s) => `100 * (1 - ${sel('node_memory_MemAvailable_bytes', hostOrAll(s))} / ${sel('node_memory_MemTotal_bytes', hostOrAll(s))})`,
    limit: 90,
    unit: '%',
    labels: ['instance'],
    describe: (n) => `Memory above 90% on ${n} host${n > 1 ? 's' : ''}:`,
  }),
  threshold({
    key: 'disk',
    title: 'Disk used',
    group: 'resources',
    requires: 'node_filesystem_avail_bytes',
    query: (s) => `max by (instance, mountpoint) (100 * (1 - ${sel('node_filesystem_avail_bytes', [FS, ...hostOrAll(s)])} / ${sel('node_filesystem_size_bytes', [FS, ...hostOrAll(s)])}))`,
    limit: 90,
    unit: '%',
    labels: ['instance', 'mountpoint'],
    describe: (n) => `${n} filesystem${n > 1 ? 's are' : ' is'} over 90% full:`,
  }),
  listing({
    key: 'disk_forecast',
    title: 'Disks predicted to fill within 24h',
    group: 'resources',
    requires: 'node_filesystem_avail_bytes',
    query: (s) => `predict_linear(${sel('node_filesystem_avail_bytes', [FS, ...hostOrAll(s)])}[6h], 24 * 3600) < 0`,
    labels: ['instance', 'mountpoint'],
    unit: ' bytes',
    ok: 'No filesystem is on course to fill within 24 hours.',
    describe: (n) => `At the last 6 hours' rate, ${n} filesystem${n > 1 ? 's' : ''} will be full within 24 hours (projected free space in 24h):`,
  }),
  listing({
    key: 'oom_kills',
    title: 'Containers killed for memory (OOM)',
    group: 'kubernetes',
    requires: 'kube_pod_container_status_last_terminated_reason',
    query: (s) => `${sel('kube_pod_container_status_last_terminated_reason', ['reason="OOMKilled"', ...nsOrAll(s)])} == 1`,
    labels: ['namespace', 'pod', 'container'],
    ok: 'No container was last killed for memory.',
    describe: (n) => `${n} container${n > 1 ? 's were' : ' was'} last killed for running out of memory:`,
  }),
  threshold({
    key: 'restarts',
    ok: 'No pod restarted in the last hour.',
    title: 'Container restarts (1h)',
    group: 'kubernetes',
    requires: 'kube_pod_container_status_restarts_total',
    query: (s) => `sum by (namespace, pod) (increase(${sel('kube_pod_container_status_restarts_total', nsOrAll(s))}[1h])) > 0`,
    limit: 1,
    labels: ['namespace', 'pod'],
    describe: (n) => `${n} pod${n > 1 ? 's' : ''} restarted in the last hour:`,
  }),
  listing({
    key: 'crashloops',
    title: 'Pods stuck crashing or pulling',
    group: 'kubernetes',
    requires: 'kube_pod_container_status_waiting_reason',
    query: (s) => `${sel('kube_pod_container_status_waiting_reason', ['reason=~"CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError"', ...nsOrAll(s)])} == 1`,
    labels: ['namespace', 'pod', 'reason'],
    ok: 'No container is stuck crashing or pulling its image.',
    describe: (n) => `${n} container${n > 1 ? 's are' : ' is'} stuck waiting:`,
  }),
  threshold({
    key: 'throttling',
    title: 'CPU throttling',
    group: 'kubernetes',
    requires: 'container_cpu_cfs_throttled_periods_total',
    query: (s) =>
      `sum by (namespace, pod) (rate(${sel('container_cpu_cfs_throttled_periods_total', nsOrAll(s))}[5m])) / sum by (namespace, pod) (rate(${sel('container_cpu_cfs_periods_total', nsOrAll(s))}[5m]))`,
    limit: 0.25,
    labels: ['namespace', 'pod'],
    describe: (n) => `${n} pod${n > 1 ? 's are' : ' is'} throttled more than 25% of the time (CPU limit too low for the load):`,
  }),
  listing({
    key: 'deploys',
    title: 'Recent deploys (2h)',
    group: 'kubernetes',
    requires: 'kube_deployment_status_observed_generation',
    query: (s) => `changes(${sel('kube_deployment_status_observed_generation', scopeMatchers(s, ['namespace']))}[2h]) > 0`,
    labels: ['namespace', 'deployment'],
    ok: 'No deployment changed in the last 2 hours.',
    describe: (n) => `${n} deployment${n > 1 ? 's were' : ' was'} changed in the last 2 hours -- a common cause:`,
  }),
  {
    key: 'http_errors',
    title: 'HTTP 5xx error rate',
    group: 'traffic',
    kinds: ['prometheus', 'grafana'],
    run: async (target, scope, signal) => {
      // The two most common shapes: client_golang style and ingress-nginx.
      const shapes = [
        { metric: 'http_requests_total', code: 'code', by: 'job' },
        { metric: 'nginx_ingress_controller_requests', code: 'status', by: 'ingress' },
      ];
      for (const sh of shapes) {
        if (!(await exists(target, sh.metric, signal))) continue;
        const m = scopeMatchers(scope, ['namespace']);
        const ratio = (off: string) =>
          `sum by (${sh.by}) (rate(${sel(sh.metric, [`${sh.code}=~"5.."`, ...m])}[5m]${off})) / sum by (${sh.by}) (rate(${sel(sh.metric, m)}[5m]${off}))`;
        const query = ratio('');
        const [now, week] = await Promise.all([promInstant(target, query, signal), promInstant(target, ratio(' offset 1w'), signal)]);
        if ('error' in now) return { status: 'error', summary: now.error, query };
        const before = new Map(('error' in week ? [] : week.samples).map((x) => [x.metric[sh.by], x.value]));
        const rows = now.samples.sort((a, b) => b.value - a.value);
        const bad = rows.filter((x) => x.value >= 0.01);
        const line = (x: Sample) => {
          const b = before.get(x.metric[sh.by]);
          return `${x.metric[sh.by] ?? '(all)'}: ${fmt(x.value * 100, '%')}${b !== undefined ? ` (same time last week ${fmt(b * 100, '%')})` : ''}`;
        };
        return {
          status: bad.length ? 'interesting' : 'normal',
          summary: bad.length ? `5xx errors above 1% of requests:\n${bad.slice(0, 8).map(line).join('\n')}` : rows.length ? 'Error rate below 1% everywhere.' : 'No requests in the last 5 minutes.',
          query,
          data: rows.slice(0, 20),
        };
      }
      return { status: 'unavailable', summary: 'No HTTP request metrics (http_requests_total or ingress-nginx) are collected here.' };
    },
  },
  {
    key: 'anomalies',
    title: 'Unusual compared with yesterday',
    group: 'resources',
    kinds: ['prometheus', 'grafana'],
    applies: hasHostOrNs,
    run: async (target, scope, signal) => {
      // How far the last 10 minutes are from the previous day, in standard deviations.
      const base: Array<{ name: string; expr: string }> = [];
      if (scope.host) {
        base.push({ name: 'CPU', expr: `1 - avg by (instance) (rate(${sel('node_cpu_seconds_total', ['mode="idle"', ...hostOrAll(scope)])}[5m]))` });
        base.push({ name: 'memory', expr: `1 - ${sel('node_memory_MemAvailable_bytes', hostOrAll(scope))} / ${sel('node_memory_MemTotal_bytes', hostOrAll(scope))}` });
      }
      if (scope.namespace) {
        base.push({ name: 'container CPU', expr: `sum by (namespace) (rate(${sel('container_cpu_usage_seconds_total', scopeMatchers(scope, ['namespace']))}[5m]))` });
        base.push({ name: 'container memory', expr: `sum by (namespace) (${sel('container_memory_working_set_bytes', scopeMatchers(scope, ['namespace']))})` });
      }
      const z = (e: string) => `(avg_over_time((${e})[10m:1m]) - avg_over_time((${e})[1d:5m] offset 10m)) / stddev_over_time((${e})[1d:5m] offset 10m)`;
      const found: string[] = [];
      let any = false;
      for (const b of base) {
        const r = await promInstant(target, z(b.expr), signal);
        if ('error' in r) continue;
        for (const x of r.samples) {
          any = true;
          if (Math.abs(x.value) >= 3) found.push(`${b.name} ${lbl(x.metric, ['instance', 'namespace'])}: ${x.value > 0 ? '+' : ''}${fmt(x.value)} standard deviations from the last day`);
        }
      }
      if (!any) return { status: 'unavailable', summary: 'Not enough history or metrics to compare with yesterday.' };
      return found.length
        ? { status: 'interesting', summary: found.join('\n'), query: z(base[0]!.expr) }
        : { status: 'normal', summary: 'CPU and memory are within their usual range for the last day.', query: z(base[0]!.expr) };
    },
  },
];

/** The observability stack's own health: is monitoring itself working? */
export const STACK_CHECKS: CheckDef[] = [
  listing({
    key: 'rule_failures',
    title: 'Alert rules failing to evaluate',
    group: 'stack',
    requires: 'prometheus_rule_evaluation_failures_total',
    query: () => 'sum by (rule_group) (increase(prometheus_rule_evaluation_failures_total[1h])) > 0',
    labels: ['rule_group'],
    ok: 'All alert rules evaluated cleanly in the last hour.',
    describe: (n) => `${n} rule group${n > 1 ? 's' : ''} failed to evaluate in the last hour (their alerts cannot fire):`,
  }),
  listing({
    key: 'notifications_failing',
    title: 'Alert notifications failing',
    group: 'stack',
    requires: 'prometheus_notifications_dropped_total',
    query: () =>
      'sum by (job) (increase(prometheus_notifications_dropped_total[1h])) > 0 or sum by (job, integration) (increase(alertmanager_notifications_failed_total[1h])) > 0',
    labels: ['job', 'integration'],
    ok: 'No notifications were dropped or failed in the last hour.',
    describe: (n) => `Notifications were dropped or failed in ${n} place${n > 1 ? 's' : ''} in the last hour (alerts may not reach anyone):`,
  }),
  listing({
    key: 'config_reload',
    title: 'Configuration failed to reload',
    group: 'stack',
    requires: 'prometheus_config_last_reload_successful',
    query: () => 'prometheus_config_last_reload_successful == 0 or alertmanager_config_last_reload_successful == 0',
    labels: ['job', 'instance'],
    ok: 'All configuration reloads succeeded.',
    describe: (n) => `${n} component${n > 1 ? 's are' : ' is'} running an old configuration because the last reload failed:`,
  }),
  threshold({
    key: 'slow_scrapes',
    title: 'Slow scrapes',
    group: 'stack',
    requires: 'scrape_duration_seconds',
    query: () => 'max by (job) (scrape_duration_seconds)',
    limit: 10,
    unit: 's',
    labels: ['job'],
    describe: (n) => `${n} job${n > 1 ? 's take' : ' takes'} over 10s to scrape (close to timing out):`,
  }),
  threshold({
    key: 'series_growth',
    title: 'Active series growth (1h)',
    group: 'stack',
    requires: 'prometheus_tsdb_head_series',
    query: () => '100 * (sum(prometheus_tsdb_head_series) / sum(prometheus_tsdb_head_series offset 1h) - 1)',
    limit: 20,
    unit: '%',
    labels: [],
    describe: () => 'Active series grew over 20% in an hour (a cardinality explosion uses memory fast):',
  }),
  listing({
    key: 'compactions_failed',
    title: 'Storage compactions failing',
    group: 'stack',
    requires: 'prometheus_tsdb_compactions_failed_total',
    query: () => 'increase(prometheus_tsdb_compactions_failed_total[6h]) > 0',
    labels: ['instance'],
    ok: 'No compaction failures in the last 6 hours.',
    describe: () => 'Prometheus storage compactions failed in the last 6 hours:',
  }),
];

/** Log lines that look like errors, compared with the window before. */
/**
 * Checks that only apply when an optional collector is there: databases through their
 * exporters, and node pressure (PSI, OOM kills) from node_exporter's newer collectors.
 * The few numbers that explain most incidents of their kind.
 */
export const DATABASE_CHECKS: CheckDef[] = [
  threshold({
    key: 'psi_memory', title: 'Memory pressure (time stalled)', group: 'resources', requires: 'node_pressure_memory_waiting_seconds_total',
    query: (s) => `100 * rate(${sel('node_pressure_memory_waiting_seconds_total', hostOrAll(s))}[5m])`, limit: 10, unit: '%', labels: ['instance'],
    describe: (n) => `Tasks waited for memory over 10% of the time on ${n} host${n > 1 ? 's' : ''} (reclaim or swap is slowing everything down):`,
  }),
  threshold({
    key: 'node_oom_kills', title: 'OOM kills (1h)', group: 'resources', requires: 'node_vmstat_oom_kill',
    query: (s) => `sum by (instance) (increase(${sel('node_vmstat_oom_kill', hostOrAll(s))}[1h]))`, limit: 0.5, labels: ['instance'],
    describe: (n) => `The kernel killed processes for running out of memory on ${n} host${n > 1 ? 's' : ''} in the last hour:`,
  }),
  threshold({
    key: 'pg_connections', title: 'PostgreSQL connections used', group: 'databases', requires: 'pg_settings_max_connections',
    query: (s) => `100 * sum by (instance) (${sel('pg_stat_activity_count', hostOrAll(s))}) / on (instance) max by (instance) (${sel('pg_settings_max_connections', hostOrAll(s))})`,
    limit: 80, unit: '%', labels: ['instance'], describe: (n) => `PostgreSQL above 80% of its connection slots on ${n} server${n > 1 ? 's' : ''}:`,
  }),
  threshold({
    key: 'pg_replication_lag', title: 'PostgreSQL replication lag', group: 'databases', requires: 'pg_replication_lag',
    query: (s) => `max by (instance) (${sel('pg_replication_lag', hostOrAll(s))})`, limit: 30, unit: 's', labels: ['instance'],
    describe: (n) => `${n} PostgreSQL replica${n > 1 ? 's are' : ' is'} more than 30 s behind:`,
  }),
  threshold({
    key: 'pg_oldest_tx', title: 'PostgreSQL oldest open transaction', group: 'databases', requires: 'pg_stat_activity_max_tx_duration',
    query: (s) => `max by (instance) (${sel('pg_stat_activity_max_tx_duration', hostOrAll(s))})`, limit: 300, unit: 's', labels: ['instance'],
    describe: (n) => `A transaction has been open for over 5 minutes on ${n} PostgreSQL server${n > 1 ? 's' : ''} (it holds locks and blocks vacuum):`,
  }),
  threshold({
    key: 'pg_top_queries', title: 'PostgreSQL queries taking the most time', group: 'databases', requires: 'pg_stat_statements_seconds_total',
    query: (s) => `topk(5, sum by (instance, datname, queryid) (rate(${sel('pg_stat_statements_seconds_total', hostOrAll(s))}[15m])))`,
    limit: 0.05, unit: 's/s', labels: ['instance', 'datname', 'queryid'],
    describe: (n) => `${n} quer${n > 1 ? 'ies take' : 'y takes'} most of the database's time (seconds of execution per second, last 15 min; queryid is pg_stat_statements'):`,
  }),
  threshold({
    key: 'mysql_connections', title: 'MySQL connections used', group: 'databases', requires: 'mysql_global_variables_max_connections',
    query: (s) => `100 * max by (instance) (${sel('mysql_global_status_threads_connected', hostOrAll(s))}) / on (instance) max by (instance) (${sel('mysql_global_variables_max_connections', hostOrAll(s))})`,
    limit: 80, unit: '%', labels: ['instance'], describe: (n) => `MySQL above 80% of max_connections on ${n} server${n > 1 ? 's' : ''}:`,
  }),
  threshold({
    key: 'mysql_replica_lag', title: 'MySQL replica lag', group: 'databases', requires: 'mysql_slave_status_seconds_behind_master',
    query: (s) => `max by (instance) (${sel('mysql_slave_status_seconds_behind_master', hostOrAll(s))})`, limit: 30, unit: 's', labels: ['instance'],
    describe: (n) => `${n} MySQL replica${n > 1 ? 's are' : ' is'} more than 30 s behind:`,
  }),
  threshold({
    key: 'redis_memory', title: 'Redis memory used (of maxmemory)', group: 'databases', requires: 'redis_memory_max_bytes',
    query: (s) => `100 * max by (instance) (${sel('redis_memory_used_bytes', hostOrAll(s))}) / on (instance) max by (instance) (${sel('redis_memory_max_bytes', hostOrAll(s))} > 0)`,
    limit: 85, unit: '%', labels: ['instance'], describe: (n) => `Redis above 85% of maxmemory on ${n} server${n > 1 ? 's' : ''} (it evicts keys or refuses writes at 100%):`,
  }),
  threshold({
    key: 'redis_evictions', title: 'Redis evictions', group: 'databases', requires: 'redis_evicted_keys_total',
    query: (s) => `sum by (instance) (rate(${sel('redis_evicted_keys_total', hostOrAll(s))}[5m]))`, limit: 1, unit: '/s', labels: ['instance'],
    describe: (n) => `Redis evicting keys on ${n} server${n > 1 ? 's' : ''} (lookups miss and fall through to the database):`,
  }),
];

export const LOG_CHECKS: CheckDef[] = [
  {
    key: 'log_errors',
    title: 'Error log lines (15m)',
    group: 'logs',
    kinds: ['loki'],
    applies: hasHostOrNs,
    run: async (target, scope, signal) => {
      const m: string[] = [];
      if (scope.namespace) m.push(`namespace="${promString(scope.namespace)}"`);
      if (scope.pod) m.push(`pod="${promString(scope.pod)}"`);
      if (!m.length && scope.host) m.push(`instance=~"${promRegexLiteral(scope.host)}.*"`);
      const stream = `{${m.join(',')}} |~ "(?i)(error|exception|fatal|panic|timeout|refused)"`;
      const count = (off: string) => `sum(count_over_time(${stream} [15m]${off}))`;
      const q = async (query: string) => {
        const r = await obsRequest(target, '/loki/api/v1/query', { query: { query }, signal, timeoutMs: 15_000 });
        if ('error' in r) return null;
        const v = (r.json as { data?: { result?: Array<{ value: [number, string] }> } }).data?.result?.[0]?.value?.[1];
        return v === undefined ? 0 : Number(v);
      };
      const [now, before] = await Promise.all([q(count('')), q(count(' offset 15m'))]);
      if (now === null) return { status: 'unavailable', summary: 'No logs could be read for this scope.', query: stream };
      if (!now) return { status: 'normal', summary: 'No error lines in the last 15 minutes.', query: stream };
      const end = Date.now();
      const r = await obsRequest(target, '/loki/api/v1/query_range', {
        query: { query: stream, start: `${end - 15 * 60_000}000000`, end: `${end}000000`, limit: 300, direction: 'backward' },
        signal,
        timeoutMs: 15_000,
      });
      const lines = 'error' in r ? [] : ((r.json as { data?: { result?: Array<{ values: Array<[string, string]> }> } }).data?.result ?? []).flatMap((s) => s.values.map((v) => ({ line: v[1], ts: Number(v[0].slice(0, 13)) })));
      // Five 3-minute buckets: a pattern only in the last one is new, one far above its own average is spiking.
      const groups = drainPatterns(lines, { buckets: 5, start: end - 15 * 60_000, end }).slice(0, 6);
      const jump = before ? now / before : Infinity;
      return {
        status: jump >= 2 || !before || groups.some((g) => g.isNew || g.spiking) ? 'interesting' : 'normal',
        summary:
          `${now} error lines in the last 15 minutes (${before ? `${fmt(jump)}x the 15 minutes before` : 'none in the 15 minutes before'}). Most telling patterns (counts per 3 minutes):\n` +
          groups.map(patternLine).join('\n'),
        query: stream,
        data: groups,
      };
    },
  },
  {
    key: 'log_errors_es',
    title: 'Error log lines (15m)',
    group: 'logs',
    kinds: ['elasticsearch'],
    run: async (target, scope, signal) => {
      const cfg = target.config as unknown as ObservabilityConfig;
      const index = cfg.indices?.[0] ?? '*';
      if (!indexAllowed(index, cfg.indices)) return { status: 'unavailable', summary: 'No index pattern is allowed on this connection.' };
      const terms = ['level:(error OR fatal OR ERROR)', 'log.level:(error OR fatal)', 'message:(error OR exception OR fatal OR panic)'];
      const scoped = [scope.host && `host.name:"${scope.host}"`, scope.namespace && `kubernetes.namespace:"${scope.namespace}"`].filter(Boolean);
      const query = `(${terms.join(' OR ')})${scoped.length ? ` AND (${scoped.join(' OR ')})` : ''}`;
      const end = Date.now();
      const search = (from: number, to: number, size: number) =>
        obsRequest(target, `/${index}/_search`, {
          jsonBody: {
            size,
            track_total_hits: true,
            sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }],
            query: { bool: { must: [{ query_string: { query } }], filter: [{ range: { '@timestamp': { gte: new Date(from).toISOString(), lte: new Date(to).toISOString() } } }] } },
          },
          signal,
          timeoutMs: 15_000,
        });
      const [now, before] = await Promise.all([search(end - 15 * 60_000, end, 200), search(end - 30 * 60_000, end - 15 * 60_000, 0)]);
      if ('error' in now) return { status: 'unavailable', summary: now.error, query };
      type Hits = { hits?: { total?: { value?: number }; hits?: Array<{ _source: Record<string, unknown> }> } };
      const total = (now.json as Hits).hits?.total?.value ?? 0;
      const prev = 'error' in before ? 0 : ((before.json as Hits).hits?.total?.value ?? 0);
      if (!total) return { status: 'normal', summary: 'No error lines in the last 15 minutes.', query };
      const lines = ((now.json as Hits).hits?.hits ?? []).map((h) => String(h._source.message ?? h._source.msg ?? h._source.log ?? ''));
      const groups = clusterLogLines(lines).slice(0, 6);
      const jump = prev ? total / prev : Infinity;
      return {
        status: jump >= 2 || !prev ? 'interesting' : 'normal',
        summary: `${total} error lines in the last 15 minutes (${prev ? `${fmt(jump)}x the 15 minutes before` : 'none in the 15 minutes before'}). Most common:\n${groups.map((g) => `${g.count}x ${g.template}`).join('\n')}`,
        query,
        data: groups,
      };
    },
  },
];

export const ALL_CHECKS: CheckDef[] = [...METRIC_CHECKS, ...DATABASE_CHECKS, ...STACK_CHECKS, ...LOG_CHECKS];

export interface EvidenceItem extends CheckOutcome {
  check: string;
  title: string;
  connectionId: string;
  connectionSlug: string;
}

/**
 * Run the applicable checks against every connection, a few at a time. `stack`
 * selects the monitoring-health checks instead of the incident checks (plus scrape
 * targets down, which matters for both).
 */
export async function runChecks(
  connections: ResolvedTarget[],
  scope: CheckScope,
  opts: { stack?: boolean; signal?: AbortSignal; concurrency?: number } = {},
): Promise<EvidenceItem[]> {
  const defs = opts.stack
    ? [...STACK_CHECKS, ...METRIC_CHECKS.filter((c) => c.key === 'targets_down' || c.key === 'related_alerts')]
    : [...METRIC_CHECKS, ...DATABASE_CHECKS, ...LOG_CHECKS];
  const jobs: Array<() => Promise<EvidenceItem>> = [];
  for (const conn of connections) {
    for (const def of defs) {
      if (!def.kinds.includes(conn.kind) || (def.applies && !def.applies(scope))) continue;
      jobs.push(async () => {
        let out: CheckOutcome;
        try {
          out = await def.run(conn, scope, opts.signal);
        } catch (err) {
          out = { status: 'error', summary: err instanceof Error ? err.message : String(err) };
        }
        return { ...out, check: def.key, title: def.title, connectionId: conn.id, connectionSlug: conn.slug };
      });
    }
  }
  const results: EvidenceItem[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(opts.concurrency ?? 4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]!();
      }
    }),
  );
  // Interesting first, then normal; unavailable last. What an optional collector would
  // measure, when the collector is not there at all, is not news: left out, not listed as missing.
  const dbKeys = new Set(DATABASE_CHECKS.map((c) => c.key));
  const order: Record<EvidenceStatus, number> = { interesting: 0, error: 1, normal: 2, unavailable: 3 };
  return results.filter((r) => !(dbKeys.has(r.check) && r.status === 'unavailable')).sort((a, b) => order[a.status] - order[b.status]);
}

/** The scope of an incident, from its alerts' labels. */
export function scopeFromLabels(all: Array<Record<string, string>>, alertnames: string[] = []): CheckScope {
  const pick = (keys: string[]) => {
    for (const l of all) for (const k of keys) if (l[k]) return l[k];
    return undefined;
  };
  const host = pick(['instance', 'host', 'hostname', 'node'])?.toLowerCase().replace(/:\d+$/, '');
  return {
    ...(host ? { host } : {}),
    ...(pick(['namespace']) ? { namespace: pick(['namespace']) } : {}),
    ...(pick(['pod']) ? { pod: pick(['pod']) } : {}),
    ...(pick(['service', 'app', 'deployment']) ? { service: pick(['service', 'app', 'deployment']) } : {}),
    ...(pick(['job']) ? { job: pick(['job']) } : {}),
    alertnames,
  };
}
