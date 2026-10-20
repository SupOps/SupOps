import type { WatchLimit } from '@supops/db';
import type { ResolvedTarget } from '../tools/types.ts';
import { obsRequest } from '../tools/observability.ts';
import { promInstant } from './checks.ts';
import type { Point } from './anomaly.ts';

/**
 * The signals SupOps watches on its own, discovered from the metrics a backend
 * actually has: host resources (node_exporter), Kubernetes (kube-state-metrics,
 * cAdvisor, kubelet), traffic, certificates (blackbox), databases (the postgres,
 * mysqld and redis exporters), and the monitoring stack itself. Each is one PromQL query with at most a few dozen series, sampled every
 * few minutes; those with a `limit` are forecast ("disk full in 6h").
 */
export interface SignalDef {
  key: string;
  title: string;
  group: 'resources' | 'traffic' | 'kubernetes' | 'databases' | 'stack';
  /** Discovered when this metric exists. */
  requires: string;
  query: string;
  unit: 'percent' | 'bytes' | 'seconds' | 'ratio' | 'count' | 'days' | 'per_second';
  badDirection: 'up' | 'down' | 'both';
  limit: WatchLimit | null;
  /** Smallest change that counts as an anomaly, in the unit. */
  minDelta?: number;
  /** Levels that are a problem whatever the history: warn and critical (above, or below for badDirection down). */
  warn?: number;
  crit?: number;
  /**
   * 'fluctuates': rises and falls through the day (CPU, memory, load), so it is
   * forecast from its daily peaks and judged on a sustained value, never on one
   * sample. Otherwise it accumulates (disk, inodes, certificates) and a recent
   * trend is the right forecast.
   */
  behaviour?: 'fluctuates';
}

const FS = 'fstype!~"tmpfs|overlay|squashfs|ramfs|devtmpfs|nsfs",mountpoint!~"/boot.*|/run.*|/snap.*"';

export const SIGNALS: SignalDef[] = [
  { key: 'cpu', title: 'CPU used', group: 'resources', requires: 'node_cpu_seconds_total', unit: 'percent', badDirection: 'up', limit: null, minDelta: 10, behaviour: 'fluctuates',
    query: '100 * (1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])))' },
  // ~80% sustained is where trouble starts; ~95% means the OOM killer is close.
  { key: 'memory', warn: 80, crit: 95, title: 'Memory used', group: 'resources', requires: 'node_memory_MemAvailable_bytes', unit: 'percent', badDirection: 'up', limit: { value: 100, when: 'above' }, minDelta: 5, behaviour: 'fluctuates',
    query: '100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)' },
  { key: 'disk_free', title: 'Disk free', group: 'resources', requires: 'node_filesystem_avail_bytes', unit: 'bytes', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: `min by (instance, mountpoint) (node_filesystem_avail_bytes{${FS}})` },
  { key: 'inodes_free', title: 'Inodes free', group: 'resources', requires: 'node_filesystem_files_free', unit: 'count', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: `min by (instance, mountpoint) (node_filesystem_files_free{${FS}})` },
  { key: 'load', warn: 1, crit: 1.5, title: 'Load per core', group: 'resources', requires: 'node_load5', unit: 'ratio', badDirection: 'up', limit: null, minDelta: 0.3, behaviour: 'fluctuates',
    query: 'node_load5 / on (instance) count by (instance) (node_cpu_seconds_total{mode="idle"})' },
  // Pressure stall information: the share of time tasks waited for memory, IO or CPU.
  // It rises before utilisation looks alarming, and is what the user actually feels.
  { key: 'psi_memory', warn: 10, crit: 40, title: 'Memory pressure (time stalled)', group: 'resources', requires: 'node_pressure_memory_waiting_seconds_total', unit: 'percent', badDirection: 'up', limit: null, minDelta: 5, behaviour: 'fluctuates',
    query: '100 * rate(node_pressure_memory_waiting_seconds_total[5m])' },
  { key: 'psi_io', warn: 20, crit: 50, title: 'IO pressure (time stalled)', group: 'resources', requires: 'node_pressure_io_waiting_seconds_total', unit: 'percent', badDirection: 'up', limit: null, minDelta: 5, behaviour: 'fluctuates',
    query: '100 * rate(node_pressure_io_waiting_seconds_total[5m])' },
  { key: 'psi_cpu', warn: 20, crit: 50, title: 'CPU pressure (time stalled)', group: 'resources', requires: 'node_pressure_cpu_waiting_seconds_total', unit: 'percent', badDirection: 'up', limit: null, minDelta: 5, behaviour: 'fluctuates',
    query: '100 * rate(node_pressure_cpu_waiting_seconds_total[5m])' },
  { key: 'oom_kills', warn: 1, crit: 3, title: 'OOM kills (15m)', group: 'resources', requires: 'node_vmstat_oom_kill', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum by (instance) (increase(node_vmstat_oom_kill[15m]))' },
  { key: 'tcp_retransmits', warn: 1, crit: 5, title: 'TCP retransmits', group: 'resources', requires: 'node_netstat_Tcp_RetransSegs', unit: 'percent', badDirection: 'up', limit: null, minDelta: 0.5,
    query: '100 * rate(node_netstat_Tcp_RetransSegs[5m]) / rate(node_netstat_Tcp_OutSegs[5m])' },
  { key: 'net_errors', warn: 1, crit: 10, title: 'Network errors', group: 'resources', requires: 'node_network_receive_errs_total', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.1,
    query: 'sum by (instance) (rate(node_network_receive_errs_total[5m]) + rate(node_network_transmit_errs_total[5m]))' },
  { key: 'pod_restarts', warn: 3, crit: 10, title: 'Pod restarts (15m)', group: 'kubernetes', requires: 'kube_pod_container_status_restarts_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 2,
    query: 'sum by (namespace) (increase(kube_pod_container_status_restarts_total[15m]))' },
  { key: 'pvc_free', title: 'Volume free', group: 'kubernetes', requires: 'kubelet_volume_stats_available_bytes', unit: 'bytes', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: 'min by (namespace, persistentvolumeclaim) (kubelet_volume_stats_available_bytes)' },
  { key: 'http_5xx', warn: 0.1, crit: 1, title: 'HTTP 5xx rate', group: 'traffic', requires: 'http_requests_total', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'sum by (job) (rate(http_requests_total{code=~"5.."}[5m]))' },
  { key: 'http_p99', warn: 1, crit: 3, title: 'Latency p99', group: 'traffic', requires: 'http_request_duration_seconds_bucket', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'histogram_quantile(0.99, sum by (job, le) (rate(http_request_duration_seconds_bucket[5m])))' },
  { key: 'ingress_5xx', warn: 0.1, crit: 1, title: 'Ingress 5xx rate', group: 'traffic', requires: 'nginx_ingress_controller_requests', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'sum by (ingress) (rate(nginx_ingress_controller_requests{status=~"5.."}[5m]))' },
  { key: 'cert_days', warn: 14, crit: 3, title: 'Certificate days left', group: 'traffic', requires: 'probe_ssl_earliest_cert_expiry', unit: 'days', badDirection: 'down', limit: { value: 0, when: 'below' },
    query: 'min by (instance) ((probe_ssl_earliest_cert_expiry - time()) / 86400)' },
  // Databases, through the exporters teams already run: connections, replication, cache, contention.
  { key: 'pg_connections', warn: 80, crit: 95, title: 'PostgreSQL connections used', group: 'databases', requires: 'pg_settings_max_connections', unit: 'percent', badDirection: 'up', limit: { value: 100, when: 'above' }, minDelta: 10, behaviour: 'fluctuates',
    query: '100 * sum by (instance) (pg_stat_activity_count) / on (instance) max by (instance) (pg_settings_max_connections)' },
  { key: 'pg_replication_lag', warn: 30, crit: 300, title: 'PostgreSQL replication lag', group: 'databases', requires: 'pg_replication_lag', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 10,
    query: 'max by (instance) (pg_replication_lag)' },
  { key: 'pg_cache_hit', warn: 95, crit: 90, title: 'PostgreSQL cache hit rate', group: 'databases', requires: 'pg_stat_database_blks_hit', unit: 'percent', badDirection: 'down', limit: null, minDelta: 2, behaviour: 'fluctuates',
    query: '100 * sum by (instance) (rate(pg_stat_database_blks_hit[5m])) / (sum by (instance) (rate(pg_stat_database_blks_hit[5m])) + sum by (instance) (rate(pg_stat_database_blks_read[5m])))' },
  { key: 'pg_deadlocks', warn: 1, crit: 5, title: 'PostgreSQL deadlocks (15m)', group: 'databases', requires: 'pg_stat_database_deadlocks', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum by (instance) (increase(pg_stat_database_deadlocks[15m]))' },
  { key: 'pg_oldest_tx', warn: 300, crit: 1800, title: 'PostgreSQL oldest open transaction', group: 'databases', requires: 'pg_stat_activity_max_tx_duration', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 60,
    query: 'max by (instance) (pg_stat_activity_max_tx_duration)' },
  { key: 'mysql_connections', warn: 80, crit: 95, title: 'MySQL connections used', group: 'databases', requires: 'mysql_global_variables_max_connections', unit: 'percent', badDirection: 'up', limit: { value: 100, when: 'above' }, minDelta: 10, behaviour: 'fluctuates',
    query: '100 * max by (instance) (mysql_global_status_threads_connected) / on (instance) max by (instance) (mysql_global_variables_max_connections)' },
  { key: 'mysql_replica_lag', warn: 30, crit: 300, title: 'MySQL replica lag', group: 'databases', requires: 'mysql_slave_status_seconds_behind_master', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 10,
    query: 'max by (instance) (mysql_slave_status_seconds_behind_master)' },
  { key: 'mysql_slow_queries', warn: 0.1, crit: 1, title: 'MySQL slow queries', group: 'databases', requires: 'mysql_global_status_slow_queries', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.05,
    query: 'sum by (instance) (rate(mysql_global_status_slow_queries[5m]))' },
  { key: 'redis_memory', warn: 85, crit: 95, title: 'Redis memory used (of maxmemory)', group: 'databases', requires: 'redis_memory_max_bytes', unit: 'percent', badDirection: 'up', limit: { value: 100, when: 'above' }, minDelta: 5,
    query: '100 * max by (instance) (redis_memory_used_bytes) / on (instance) max by (instance) (redis_memory_max_bytes > 0)' },
  { key: 'redis_evictions', warn: 1, crit: 100, title: 'Redis evictions', group: 'databases', requires: 'redis_evicted_keys_total', unit: 'per_second', badDirection: 'up', limit: null, minDelta: 0.5,
    query: 'sum by (instance) (rate(redis_evicted_keys_total[5m]))' },
  { key: 'redis_hit_rate', warn: 80, crit: 50, title: 'Redis hit rate', group: 'databases', requires: 'redis_keyspace_hits_total', unit: 'percent', badDirection: 'down', limit: null, minDelta: 5, behaviour: 'fluctuates',
    query: '100 * sum by (instance) (rate(redis_keyspace_hits_total[5m])) / (sum by (instance) (rate(redis_keyspace_hits_total[5m])) + sum by (instance) (rate(redis_keyspace_misses_total[5m])))' },
  { key: 'targets_down', warn: 1, crit: 3, title: 'Scrape targets down', group: 'stack', requires: 'up', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum by (job) (1 - up)' },
  { key: 'rule_failures', warn: 1, crit: 10, title: 'Rule evaluation failures', group: 'stack', requires: 'prometheus_rule_evaluation_failures_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum(increase(prometheus_rule_evaluation_failures_total[15m]))' },
  { key: 'notifications_dropped', warn: 1, crit: 10, title: 'Notifications dropped', group: 'stack', requires: 'prometheus_notifications_dropped_total', unit: 'count', badDirection: 'up', limit: null, minDelta: 1,
    query: 'sum(increase(prometheus_notifications_dropped_total[15m]))' },
  { key: 'head_series', title: 'Active series', group: 'stack', requires: 'prometheus_tsdb_head_series', unit: 'count', badDirection: 'up', limit: null,
    query: 'sum(prometheus_tsdb_head_series)' },
  { key: 'scrape_duration', warn: 10, crit: 30, title: 'Slowest scrape', group: 'stack', requires: 'scrape_duration_seconds', unit: 'seconds', badDirection: 'up', limit: null, minDelta: 1,
    query: 'max by (job) (scrape_duration_seconds)' },
];

/**
 * Does a watch rise and fall rather than accumulate? A built-in signal says so; for
 * a custom query the unit decides: utilisation, rates and latencies swing with
 * load, while bytes, counts and days left tend to build up.
 */
export function fluctuates(w: { key: string; unit: string }): boolean {
  const def = SIGNALS.find((s) => s.key === w.key);
  if (def) return def.behaviour === 'fluctuates';
  return ['percent', 'ratio', 'per_second', 'seconds'].includes(w.unit);
}

/** Which signals this backend can serve, one cheap probe each. */
export async function discoverSignals(target: ResolvedTarget, signal?: AbortSignal): Promise<SignalDef[]> {
  const out: SignalDef[] = [];
  for (const s of SIGNALS) {
    const r = await promInstant(target, `count(${s.requires})`, signal);
    if (!('error' in r) && r.samples.length && r.samples[0]!.value > 0) out.push(s);
  }
  return out;
}

/** Canonical series key: `{a="1",b="2"}`, sorted, without __name__. */
export function seriesKey(metric: Record<string, string>): string {
  const keys = Object.keys(metric).filter((k) => k !== '__name__').sort();
  return `{${keys.map((k) => `${k}="${metric[k]}"`).join(',')}}`;
}

export function parseSeriesKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of key.matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** A range query, as points per series. At most `maxSeries` series are kept. */
export async function promRange(
  target: ResolvedTarget,
  query: string,
  start: number,
  end: number,
  stepSec: number,
  opts: { signal?: AbortSignal; maxSeries?: number } = {},
): Promise<{ error: string } | { series: Array<{ key: string; labels: Record<string, string>; points: Point[] }>; dropped: number }> {
  const r = await obsRequest(target, '/api/v1/query_range', {
    query: { query, start: Math.floor(start / 1000), end: Math.floor(end / 1000), step: `${stepSec}s` },
    signal: opts.signal,
    timeoutMs: 30_000,
    maxBytes: 16 * 1024 * 1024,
  });
  if ('error' in r) return r;
  const rows = ((r.json as { data?: { result?: Array<{ metric: Record<string, string>; values: Array<[number, string]> }> } }).data?.result ?? []);
  const max = opts.maxSeries ?? 50;
  return {
    series: rows.slice(0, max).map((x) => ({
      key: seriesKey(x.metric),
      labels: Object.fromEntries(Object.entries(x.metric).filter(([k]) => k !== '__name__')),
      points: x.values.map(([t, v]) => ({ at: Math.round(t * 1000), value: Number(v) })).filter((p) => Number.isFinite(p.value)),
    })),
    dropped: Math.max(0, rows.length - max),
  };
}

/** Labels people name machines by, most specific first. */
const NAME_LABELS = ['vm_name', 'vmname', 'vm', 'name', 'nodename', 'hostname', 'host', 'node', 'server', 'service_name', 'service', 'app'];
/** Scrape jobs that say what was scraped, not which machine. */
const GENERIC_JOB = /^(node|nodes|node[-_]exporter|node[-_]metrics|prometheus|kubelet|cadvisor|kube[-_].*|kubernetes[-_].*|apiserver|blackbox|serviceMonitor\/.*)$/i;

/**
 * A short, human name for a series: the label people actually know the machine by
 * (a VM name, a hostname, a scrape job per VM) before the raw `instance`, which is
 * often a cloud DNS name or an IP -- then whatever tells series of one machine apart
 * (mountpoint, namespace, volume).
 */
export function seriesName(labels: Record<string, string>): string {
  const lower = new Map(Object.entries(labels).map(([k, v]) => [k.toLowerCase(), v]));
  let who = NAME_LABELS.map((k) => lower.get(k)).find((v) => !!v);
  // A per-VM scrape job reads better without its plumbing: "web-1-node-metrics" -> "web-1".
  if (!who && labels.job && !GENERIC_JOB.test(labels.job)) who = labels.job.replace(/[-_](node[-_])?(metrics|exporter)$/i, '') || labels.job;
  if (!who) who = labels.instance;
  const rest = ['mountpoint', 'device', 'persistentvolumeclaim', 'ingress', 'pod']
    .map((k) => labels[k])
    .filter((v): v is string => !!v && v !== who);
  // The namespace only helps when nothing more specific names the series.
  if (!rest.length && labels.namespace && labels.namespace !== who) rest.push(labels.namespace);
  const parts = [who, ...rest].filter(Boolean);
  if (!parts.length && labels.job) parts.push(`job ${labels.job}`);
  return parts.length ? parts.join(' ') : Object.values(labels).join(' ') || 'total';
}

export { formatValue } from '@supops/shared';
