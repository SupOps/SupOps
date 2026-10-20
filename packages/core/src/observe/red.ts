import { promString } from './checks.ts';

/**
 * RED signals (rate, errors, duration) for a service, from metrics a Prometheus already
 * has. SupOps collects nothing itself: it recognises the usual conventions (OpenTelemetry
 * HTTP, Micrometer, ingress-nginx, Istio, Tempo/OTel span metrics) and which label names
 * the service, and builds the queries from those.
 */

export interface RedFamily {
  id: string;
  /** A histogram: `<metric>_bucket`, `<metric>_count`. */
  metric: string;
  /** Multiply by this to get seconds (0.001 for millisecond histograms). */
  toSeconds: number;
  /** Labels that may hold the service name, in order of preference. */
  serviceLabels: string[];
  /** Selects the failed requests. */
  errors: string;
  /** Some families count calls in a separate counter. */
  calls?: string;
}

export const RED_FAMILIES: RedFamily[] = [
  { id: 'otel-http', metric: 'http_server_request_duration_seconds', toSeconds: 1, serviceLabels: ['service_name', 'job', 'service'], errors: 'http_response_status_code=~"5.."' },
  { id: 'otel-http-ms', metric: 'http_server_duration_milliseconds', toSeconds: 0.001, serviceLabels: ['service_name', 'job', 'service'], errors: 'http_status_code=~"5.."' },
  { id: 'micrometer', metric: 'http_server_requests_seconds', toSeconds: 1, serviceLabels: ['application', 'service', 'job'], errors: 'status=~"5.."' },
  { id: 'ingress-nginx', metric: 'nginx_ingress_controller_request_duration_seconds', toSeconds: 1, serviceLabels: ['service', 'ingress'], errors: 'status=~"5.."' },
  { id: 'istio', metric: 'istio_request_duration_milliseconds', toSeconds: 0.001, serviceLabels: ['destination_service_name', 'destination_workload'], errors: 'response_code=~"5.."' },
  { id: 'spanmetrics', metric: 'traces_span_metrics_duration_milliseconds', toSeconds: 0.001, serviceLabels: ['service_name', 'service'], errors: 'status_code="STATUS_CODE_ERROR"', calls: 'traces_span_metrics_calls_total' },
  { id: 'spanmetrics-s', metric: 'traces_spanmetrics_latency', toSeconds: 0.001, serviceLabels: ['service_name', 'service'], errors: 'status_code="STATUS_CODE_ERROR"', calls: 'traces_spanmetrics_calls_total' },
];

/** The families this Prometheus has, from its metric names. */
export function familiesIn(metricNames: Iterable<string>): RedFamily[] {
  const names = new Set(metricNames);
  return RED_FAMILIES.filter((f) => names.has(`${f.metric}_bucket`));
}

/** A label value, quoted for PromQL. */
const quoted = (v: string) => `"${promString(v)}"`;

export interface RedQueries {
  family: string;
  label: string;
  rate: string;
  /** Failed share of requests, 0..1. */
  errorRatio: string;
  p50: string;
  p95: string;
  p99: string;
}

export function redQueries(f: RedFamily, label: string, service: string, window = '5m'): RedQueries {
  const sel = `${label}=${quoted(service)}`;
  const count = f.calls ? `${f.calls}{${sel}}` : `${f.metric}_count{${sel}}`;
  const failed = f.calls ? `${f.calls}{${sel},${f.errors}}` : `${f.metric}_count{${sel},${f.errors}}`;
  const q = (p: number) => `histogram_quantile(${p}, sum by (le) (rate(${f.metric}_bucket{${sel}}[${window}])))${f.toSeconds !== 1 ? ` * ${f.toSeconds}` : ''}`;
  return {
    family: f.id,
    label,
    rate: `sum(rate(${count}[${window}]))`,
    errorRatio: `(sum(rate(${failed}[${window}])) or vector(0)) / sum(rate(${count}[${window}]))`,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
  };
}

/** CPU (cores) and memory (bytes) of a service: its containers when there are any, else its process metrics. */
export function resourceQueries(service: string, window = '5m'): { cpu: string[]; memory: string[] } {
  const s = quoted(service);
  return {
    cpu: [`sum(rate(container_cpu_usage_seconds_total{container=${s}}[${window}]))`, `sum(rate(process_cpu_seconds_total{job=${s}}[${window}]))`],
    memory: [`sum(container_memory_working_set_bytes{container=${s}})`, `sum(process_resident_memory_bytes{job=${s}})`],
  };
}

// ---------------------------------------------------------------------------
// Deploy verdicts
// ---------------------------------------------------------------------------

export interface SignalComparison {
  name: string;
  /** latency: seconds; errors: ratio 0..1; rate: per second; cpu: cores; memory: bytes. */
  kind: 'latency' | 'errors' | 'rate' | 'cpu' | 'memory';
  before: number | null;
  after: number | null;
}

export interface VerdictSignal {
  name: string;
  before: number | null;
  after: number | null;
  unit: string;
  /** Relative change, e.g. 0.32 for +32%. */
  change: number | null;
  flag: boolean;
  note?: string;
}

const UNIT: Record<SignalComparison['kind'], string> = { latency: 'seconds', errors: 'ratio', rate: 'per_second', cpu: 'count', memory: 'bytes' };
const pct = (x: number) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;

/**
 * Was the deploy worse? Only what changed meaningfully is flagged, so a clean release reads
 * as clean: latency up 20% and 50 ms, errors up a point and half again, CPU or memory up
 * 15%. Traffic is shown, never flagged (it is not the deploy's doing).
 */
export function deployVerdict(signals: SignalComparison[]): { overall: 'better' | 'worse' | 'same' | 'unknown'; signals: VerdictSignal[] } {
  const out: VerdictSignal[] = [];
  let worse = false;
  let better = false;
  let known = false;
  for (const s of signals) {
    const { before, after } = s;
    const change = before !== null && after !== null && before > 0 ? (after - before) / before : null;
    let flag = false;
    let note: string | undefined;
    if (before !== null && after !== null) {
      known = true;
      if (s.kind === 'latency') {
        flag = after > before * 1.2 && after - before > 0.05;
        if (flag) note = `${pct(change ?? 0)} (${Math.round(before * 1000)} ms → ${Math.round(after * 1000)} ms)`;
        if (after < before * 0.8 && before - after > 0.05) better = true;
      } else if (s.kind === 'errors') {
        flag = after - before > 0.01 && after > before * 1.5;
        if (flag) note = `${(before * 100).toFixed(1)}% → ${(after * 100).toFixed(1)}% of requests`;
        if (before - after > 0.01 && after < before * 0.5) better = true;
      } else if (s.kind === 'cpu' || s.kind === 'memory') {
        flag = before > 0 && after > before * 1.15;
        if (flag) note = pct(change ?? 0);
      }
    }
    if (flag) worse = true;
    out.push({ name: s.name, before, after, unit: UNIT[s.kind], change: change === null ? null : Number(change.toFixed(3)), flag, ...(note ? { note } : {}) });
  }
  return { overall: !known ? 'unknown' : worse ? 'worse' : better ? 'better' : 'same', signals: out };
}
