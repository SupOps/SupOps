import { z } from 'zod';
import type { RiskContribution } from '@supops/shared';
import type { ObservabilityConfig } from '@supops/db';
import type { ToolDef } from './types.ts';
import { errOutput } from './output.ts';
import { done, obsRequest, timeWindow } from './observability.ts';

/**
 * Read traces from Tempo or Jaeger: find slow or failing requests, then read one trace
 * as a short summary (where the time went, which spans failed and why) rather than
 * pages of span JSON. Read-only.
 */

const READ: RiskContribution[] = [{ stage: 'arguments', tier: 'read_only', ruleId: 'traces.query', reason: 'a read-only query against a tracing API' }];

const TRACE_ID = /^[0-9a-fA-F]{16,32}$/;
const DURATION = /^\d+(\.\d+)?(us|µs|ms|s|m)$/;

const args = z.object({
  target: z.string(),
  operation: z.enum(['search', 'get', 'services']).optional(),
  service: z.string().max(200).optional(),
  span_name: z.string().max(300).optional(),
  min_duration: z.string().max(20).regex(DURATION, 'like 500ms, 2s or 1m').optional(),
  errors_only: z.boolean().optional(),
  /** key=value pairs, comma-separated: http.status_code=500,k8s.namespace.name=shop */
  tags: z.string().max(500).optional(),
  /** Tempo only: a TraceQL query, used instead of the fields above. */
  traceql: z.string().max(1000).optional(),
  trace_id: z.string().regex(TRACE_ID, 'a trace id is 16 or 32 hex characters').optional(),
  start: z.string().max(40).optional(),
  end: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof args>;

/** One span, whichever backend it came from. Times in ms. */
export interface Span {
  id: string;
  parent: string | null;
  service: string;
  name: string;
  start: number;
  dur: number;
  error: boolean;
  /** Why it failed, when the span says: status message, exception message, HTTP status. */
  why?: string;
}

const attrValue = (v: Record<string, unknown> | undefined): string => {
  if (!v) return '';
  for (const k of ['stringValue', 'intValue', 'doubleValue', 'boolValue']) if (v[k] !== undefined) return String(v[k]);
  return '';
};
const b64hex = (s: string) => (/^[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : Buffer.from(s, 'base64').toString('hex'));

/** Tempo returns OTLP JSON: `batches` (v1) or `trace.resourceSpans` / `resourceSpans` (v2). */
export function spansFromOtlp(json: unknown): Span[] {
  const j = json as { batches?: unknown[]; resourceSpans?: unknown[]; trace?: { resourceSpans?: unknown[] } };
  const batches = (j.batches ?? j.resourceSpans ?? j.trace?.resourceSpans ?? []) as Array<{
    resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> };
    scopeSpans?: Array<{ spans?: unknown[] }>;
    instrumentationLibrarySpans?: Array<{ spans?: unknown[] }>;
  }>;
  const out: Span[] = [];
  for (const b of batches) {
    const service = attrValue(b.resource?.attributes?.find((a) => a.key === 'service.name')?.value) || 'unknown';
    for (const scope of [...(b.scopeSpans ?? []), ...(b.instrumentationLibrarySpans ?? [])]) {
      for (const raw of (scope.spans ?? []) as Array<Record<string, unknown>>) {
        const attrs = (raw.attributes ?? []) as Array<{ key: string; value: Record<string, unknown> }>;
        const attr = (k: string) => attrValue(attrs.find((a) => a.key === k)?.value);
        const events = (raw.events ?? []) as Array<{ name?: string; attributes?: Array<{ key: string; value: Record<string, unknown> }> }>;
        const exception = events.find((e) => e.name === 'exception');
        const exMsg = exception ? attrValue(exception.attributes?.find((a) => a.key === 'exception.message')?.value) : '';
        const exType = exception ? attrValue(exception.attributes?.find((a) => a.key === 'exception.type')?.value) : '';
        const status = (raw.status ?? {}) as { code?: number | string; message?: string };
        const error = status.code === 2 || status.code === 'STATUS_CODE_ERROR';
        const http = attr('http.response.status_code') || attr('http.status_code');
        const start = Number(BigInt(String(raw.startTimeUnixNano ?? 0)) / 1_000_000n);
        const end = Number(BigInt(String(raw.endTimeUnixNano ?? 0)) / 1_000_000n);
        const why = [status.message, exType && exMsg ? `${exType}: ${exMsg}` : exMsg || exType, http && Number(http) >= 400 ? `HTTP ${http}` : ''].filter(Boolean).join('; ');
        out.push({
          id: b64hex(String(raw.spanId ?? '')),
          parent: raw.parentSpanId ? b64hex(String(raw.parentSpanId)) : null,
          service,
          name: String(raw.name ?? ''),
          start,
          dur: Math.max(0, end - start),
          error,
          ...(why ? { why } : {}),
        });
      }
    }
  }
  return out;
}

/** Jaeger's query API: microseconds, `references` for parents, `processes` for services. */
export function spansFromJaeger(trace: unknown): Span[] {
  const t = trace as {
    spans?: Array<{ spanID: string; operationName: string; startTime: number; duration: number; processID: string; references?: Array<{ refType: string; spanID: string }>; tags?: Array<{ key: string; value: unknown }>; logs?: Array<{ fields?: Array<{ key: string; value: unknown }> }> }>;
    processes?: Record<string, { serviceName: string }>;
  };
  return (t.spans ?? []).map((s) => {
    const tag = (k: string) => s.tags?.find((x) => x.key === k)?.value;
    const error = tag('error') === true || tag('error') === 'true' || tag('otel.status_code') === 'ERROR';
    const fields = (s.logs ?? []).flatMap((l) => l.fields ?? []);
    const field = (k: string) => fields.find((f) => f.key === k)?.value;
    const http = tag('http.status_code') ?? tag('http.response.status_code');
    const why = [tag('otel.status_description'), field('exception.type') && field('exception.message') ? `${String(field('exception.type'))}: ${String(field('exception.message'))}` : field('exception.message') ?? field('message'), http && Number(http) >= 400 ? `HTTP ${String(http)}` : '']
      .filter(Boolean)
      .map(String)
      .join('; ');
    const parent = s.references?.find((r) => r.refType === 'CHILD_OF')?.spanID ?? s.references?.[0]?.spanID ?? null;
    return { id: s.spanID, parent, service: t.processes?.[s.processID]?.serviceName ?? 'unknown', name: s.operationName, start: s.startTime / 1000, dur: s.duration / 1000, error, ...(why ? { why } : {}) };
  });
}

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${v >= 10 ? Math.round(v) : v.toFixed(1)}ms`);

/**
 * A trace in a few dozen lines: totals, the services involved, failing spans with the
 * reason, the spans whose own time (not counting their children) is largest, and the
 * tree, trimmed.
 */
export function summariseTrace(traceId: string, spans: Span[]): string {
  if (!spans.length) return `Trace ${traceId}: no spans (it may have aged out of the backend).`;
  const t0 = Math.min(...spans.map((s) => s.start));
  const t1 = Math.max(...spans.map((s) => s.start + s.dur));
  const byId = new Map(spans.map((s) => [s.id, s]));
  const kids = new Map<string, Span[]>();
  for (const s of spans) if (s.parent && byId.has(s.parent)) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
  const roots = spans.filter((s) => !s.parent || !byId.has(s.parent)).sort((a, b) => a.start - b.start);
  const own = (s: Span) => Math.max(0, s.dur - (kids.get(s.id) ?? []).reduce((n, c) => n + c.dur, 0));
  const services = [...new Set(spans.map((s) => s.service))];
  const errors = spans.filter((s) => s.error);
  const lines = [
    `Trace ${traceId}: ${spans.length} spans, ${ms(t1 - t0)}, ${services.length} service${services.length === 1 ? '' : 's'} (${services.join(', ')}), ${errors.length} failed span${errors.length === 1 ? '' : 's'}.`,
    `Started ${new Date(t0).toISOString()}${roots[0] ? `; root: ${roots[0].service} ${roots[0].name}` : ''}.`,
  ];
  if (errors.length) {
    lines.push('', 'Failed spans (deepest first: the first is the likeliest origin):');
    const depth = (s: Span) => { let d = 0; let p = s.parent; while (p && byId.has(p) && d < 100) { d++; p = byId.get(p)!.parent; } return d; };
    for (const s of [...errors].sort((a, b) => depth(b) - depth(a)).slice(0, 10)) lines.push(`- ${s.service} ${s.name} (${ms(s.dur)})${s.why ? `: ${s.why.slice(0, 300)}` : ''}`);
  }
  lines.push('', 'Most time spent in (own time, children excluded):');
  for (const s of [...spans].sort((a, b) => own(b) - own(a)).slice(0, 8)) lines.push(`- ${ms(own(s))} ${s.service} ${s.name} (whole span ${ms(s.dur)})`);
  lines.push('', 'Tree (start offset, duration):');
  let shown = 0;
  const walk = (s: Span, d: number) => {
    if (shown >= 60) return;
    shown++;
    lines.push(`${'  '.repeat(Math.min(d, 12))}+${ms(s.start - t0)} ${ms(s.dur)} ${s.service} ${s.name}${s.error ? ' [ERROR]' : ''}`);
    for (const c of (kids.get(s.id) ?? []).sort((a, b) => a.start - b.start)) walk(c, d + 1);
  };
  for (const r of roots) walk(r, 0);
  if (shown < spans.length) lines.push(`… ${spans.length - shown} more spans not shown.`);
  return lines.join('\n');
}

function parseTags(s: string | undefined): Array<[string, string]> | { error: string } {
  if (!s?.trim()) return [];
  const out: Array<[string, string]> = [];
  for (const part of s.split(',')) {
    const m = /^\s*([A-Za-z0-9_.\-/]+)\s*=\s*"?([^"]*)"?\s*$/.exec(part);
    if (!m) return { error: `tags must be key=value pairs separated by commas; "${part.trim()}" is not` };
    out.push([m[1]!, m[2]!]);
  }
  return out;
}

const cfgOf = (t: { config: unknown }) => t.config as ObservabilityConfig;

// ---- SigNoz (query API v5) -------------------------------------------------------

const SIGNOZ_FIELDS = ['trace_id', 'span_id', 'parent_span_id', 'name', 'duration_nano', 'has_error', 'status_message', 'timestamp'];
const sq = (v: string) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Rows of a raw v5 response, whichever envelope it comes in; each row's fields flattened. */
export function signozRows(json: unknown): Array<Record<string, unknown>> {
  const j = json as { data?: { data?: { results?: unknown[] }; results?: unknown[] } };
  const results = (j.data?.data?.results ?? j.data?.results ?? []) as Array<{ rows?: Array<Record<string, unknown>> }>;
  return results.flatMap((r) => r.rows ?? []).map((row) => ({ ...(row.data && typeof row.data === 'object' ? (row.data as Record<string, unknown>) : row), ...(row.timestamp !== undefined ? { timestamp: row.timestamp } : {}) }));
}

const pick = (r: Record<string, unknown>, ...keys: string[]) => keys.map((k) => r[k]).find((v) => v !== undefined && v !== null);
function toMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e15 ? v / 1e6 : v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') return /^\d+$/.test(v) ? toMs(Number(v)) : Date.parse(v);
  return 0;
}

/** SigNoz rows as spans. */
export function spansFromSignoz(rows: Array<Record<string, unknown>>): Span[] {
  return rows.map((r) => {
    const err = pick(r, 'has_error', 'hasError');
    const why = pick(r, 'status_message', 'statusMessage');
    return {
      id: String(pick(r, 'span_id', 'spanID', 'spanId') ?? ''),
      parent: (pick(r, 'parent_span_id', 'parentSpanID', 'parentSpanId') as string | undefined) || null,
      service: String(pick(r, 'service.name', 'serviceName', 'service_name') ?? 'unknown'),
      name: String(pick(r, 'name') ?? ''),
      start: toMs(pick(r, 'timestamp')),
      dur: Number(pick(r, 'duration_nano', 'durationNano') ?? 0) / 1e6,
      error: err === true || err === 'true' || err === 1,
      ...(why ? { why: String(why) } : {}),
    };
  });
}

function signozQuery(expression: string, start: number, end: number, limit: number) {
  return {
    start,
    end,
    requestType: 'raw',
    variables: {},
    compositeQuery: {
      queries: [{
        type: 'builder_query',
        spec: {
          name: 'A',
          signal: 'traces',
          ...(expression ? { filter: { expression } } : {}),
          selectFields: [...SIGNOZ_FIELDS.map((name) => ({ name, fieldContext: 'span' })), { name: 'service.name', fieldContext: 'resource' }],
          order: [{ key: { name: 'timestamp' }, direction: 'desc' }],
          limit,
          offset: 0,
          disabled: false,
        },
      }],
    },
  };
}

async function signoz(a: Args, ctx: Parameters<ToolDef<Args>['execute']>[1]) {
  const cfg = cfgOf(ctx.target);
  const post = (body: unknown) => obsRequest(ctx.target, '/api/v5/query_range', { jsonBody: body, timeoutMs: ctx.timeoutMs, signal: ctx.signal, maxBytes: 16 * 1024 * 1024 });
  if (a.operation === 'get') {
    if (!a.trace_id) return errOutput('get needs a trace_id (from a search)');
    const now = Date.now();
    // A trace id carries no time: look back over the connection's window.
    const r = await post(signozQuery(`trace_id = ${sq(a.trace_id)}`, now - (cfg.maxRangeHours ?? 24) * 3_600_000, now, 10_000));
    if ('error' in r) return errOutput(r.error);
    return done(ctx, summariseTrace(a.trace_id, spansFromSignoz(signozRows(r.json))));
  }
  const w = timeWindow(a.start, a.end, 'now-1h', cfg.maxRangeHours ?? 24);
  if ('error' in w) return errOutput(w.error);
  if (a.operation === 'services') {
    const r = await post(signozQuery('', w.start, w.end, 2000));
    if ('error' in r) return errOutput(r.error);
    const names = [...new Set(spansFromSignoz(signozRows(r.json)).map((s) => s.service))].sort();
    return done(ctx, names.length ? `${names.length} services seen in the window: ${names.join(', ')}` : 'No spans in the window.');
  }
  const tags = parseTags(a.tags);
  if ('error' in tags) return errOutput(tags.error);
  const parts = [
    a.service && `service.name = ${sq(a.service)}`,
    a.span_name && `name = ${sq(a.span_name)}`,
    a.errors_only && 'has_error = true',
    a.min_duration && `duration_nano >= ${Math.round(durationMs(a.min_duration) * 1e6)}`,
    ...tags.map(([k, v]) => `${k} = ${/^-?\d+(\.\d+)?$/.test(v) ? v : sq(v)}`),
  ].filter(Boolean);
  const r = await post(signozQuery(a.traceql ?? parts.join(' AND '), w.start, w.end, 500));
  if ('error' in r) return errOutput(r.error);
  const rows0 = signozRows(r.json);
  const spans = spansFromSignoz(rows0);
  const byTrace = new Map<string, Span[]>();
  rows0.forEach((row, i) => {
    const id = String(pick(row, 'trace_id', 'traceID', 'traceId') ?? '');
    if (id) byTrace.set(id, [...(byTrace.get(id) ?? []), spans[i]!]);
  });
  if (!byTrace.size) return done(ctx, 'No traces matched.');
  const rows = [...byTrace].slice(0, a.limit ?? 20).map(([id, ss]) => {
    const worst = ss.reduce((x, y) => (y.dur > x.dur ? y : x));
    const errs = ss.filter((x) => x.error).length;
    return `${id} ${ms(worst.dur)} ${worst.service} ${worst.name} at ${new Date(worst.start).toISOString()}${errs ? ` · ${errs} failed span${errs === 1 ? '' : 's'}` : ''}`;
  });
  return done(ctx, [`${rows.length} trace${rows.length === 1 ? '' : 's'} (matching spans; slowest shown):`, ...rows].join('\n'));
}

const durationMs = (d: string) => {
  const m = /^(\d+(?:\.\d+)?)(us|µs|ms|s|m)$/.exec(d)!;
  return Number(m[1]) * { us: 0.001, µs: 0.001, ms: 1, s: 1000, m: 60_000 }[m[2] as 'ms'];
};

export const queryTracesTool: ToolDef<Args> = {
  key: 'query_traces',
  kind: 'http',
  description:
    'Read distributed traces from Tempo or Jaeger (read-only). services: list the services that report traces. ' +
    'search: find traces in a window (default the last hour), filtered by service, span_name, min_duration (e.g. 500ms), ' +
    'errors_only, and tags (key=value, comma-separated, e.g. http.status_code=500); on Tempo, traceql may be given instead. ' +
    'get: one trace by trace_id, summarised: the services, failed spans with the reason (deepest first), where the time went, and the span tree. ' +
    'Typical use: search for slow or failing requests of a service, then get the worst one.',
  parameters: {
    operation: { type: 'string', enum: ['search', 'get', 'services'], description: 'search (default), get or services.' },
    service: { type: 'string', description: 'service.name to search in (required on Jaeger).' },
    span_name: { type: 'string', description: 'search: span (operation) name.' },
    min_duration: { type: 'string', description: 'search: only traces at least this long, e.g. 500ms, 2s.' },
    errors_only: { type: 'boolean', description: 'search: only traces with a failed span.' },
    tags: { type: 'string', description: 'search: key=value pairs, comma-separated.' },
    traceql: { type: 'string', description: 'Tempo only: a TraceQL query, e.g. { resource.service.name = "checkout" && status = error }.' },
    trace_id: { type: 'string', description: 'get: the trace id.' },
    start: { type: 'string', description: 'Default now-1h.' },
    end: { type: 'string', description: 'Default now.' },
    limit: { type: 'integer', description: 'search: most traces (default 20, max 50).' },
  },
  required: [],
  argsSchema: args,
  baselineRisk: 'read_only',
  targetKinds: ['tempo', 'jaeger', 'signoz'],
  mutating: false,
  timeoutMs: 30_000,
  render: (a, t) =>
    a.operation === 'get'
      ? `[${t.slug}] trace ${a.trace_id ?? '?'}`
      : a.operation === 'services'
        ? `[${t.slug}] services`
        : `[${t.slug}] ${a.traceql ?? [a.service, a.span_name, a.min_duration && `>=${a.min_duration}`, a.errors_only && 'errors', a.tags].filter(Boolean).join(' ')} · ${a.start ?? 'now-1h'} → ${a.end ?? 'now'}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    const cfg = cfgOf(ctx.target);
    if (cfg.kind === 'signoz') return signoz(a, ctx);
    const tempo = cfg.kind === 'tempo';
    const req = (path: string, query: Record<string, string | number | undefined> = {}) =>
      obsRequest(ctx.target, path, { query, timeoutMs: ctx.timeoutMs, signal: ctx.signal, maxBytes: 16 * 1024 * 1024 });

    if (a.operation === 'services') {
      if (tempo) {
        const r = await req('/api/search/tag/service.name/values');
        if ('error' in r) return errOutput(r.error);
        const v = ((r.json as { tagValues?: Array<string | { value: string }> }).tagValues ?? []).map((x) => (typeof x === 'string' ? x : x.value));
        return done(ctx, v.length ? `${v.length} services: ${v.sort().join(', ')}` : 'No services have reported traces recently.');
      }
      const r = await req('/api/services');
      if ('error' in r) return errOutput(r.error);
      const v = ((r.json as { data?: string[] }).data ?? []).sort();
      return done(ctx, v.length ? `${v.length} services: ${v.join(', ')}` : 'No services have reported traces.');
    }

    if (a.operation === 'get') {
      if (!a.trace_id) return errOutput('get needs a trace_id (from a search)');
      const r = await req(`/api/traces/${a.trace_id}`);
      if ('error' in r) return errOutput(r.error.startsWith('HTTP 404') ? `No trace ${a.trace_id} (it may have aged out).` : r.error);
      const spans = tempo ? spansFromOtlp(r.json) : spansFromJaeger(((r.json as { data?: unknown[] }).data ?? [])[0] ?? {});
      return done(ctx, summariseTrace(a.trace_id, spans));
    }

    const w = timeWindow(a.start, a.end, 'now-1h', cfg.maxRangeHours ?? 24);
    if ('error' in w) return errOutput(w.error);
    const tags = parseTags(a.tags);
    if ('error' in tags) return errOutput(tags.error);
    const limit = a.limit ?? 20;

    if (tempo) {
      let q: Record<string, string | number | undefined>;
      if (a.traceql) q = { q: a.traceql };
      else {
        const conds = [
          a.service && `resource.service.name = "${a.service.replace(/"/g, '\\"')}"`,
          a.span_name && `name = "${a.span_name.replace(/"/g, '\\"')}"`,
          a.errors_only && 'status = error',
          ...tags.map(([k, v]) => `.${k} = ${/^-?\d+(\.\d+)?$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`}`),
        ].filter(Boolean);
        q = { q: `{ ${conds.join(' && ') || 'true'} }`, ...(a.min_duration ? { minDuration: a.min_duration } : {}) };
      }
      const r = await req('/api/search', { ...q, limit, start: Math.floor(w.start / 1000), end: Math.ceil(w.end / 1000) });
      if ('error' in r) return errOutput(r.error);
      const traces = (r.json as { traces?: Array<{ traceID: string; rootServiceName?: string; rootTraceName?: string; startTimeUnixNano?: string; durationMs?: number }> }).traces ?? [];
      if (!traces.length) return done(ctx, 'No traces matched.');
      return done(ctx, [`${traces.length} trace${traces.length === 1 ? '' : 's'} (${q.q}):`, ...traces.map((t) => `${t.traceID} ${ms(t.durationMs ?? 0)} ${t.rootServiceName ?? '?'} ${t.rootTraceName ?? ''} at ${t.startTimeUnixNano ? new Date(Number(BigInt(t.startTimeUnixNano) / 1_000_000n)).toISOString() : '?'}`)].join('\n'));
    }

    if (!a.service) return errOutput('Jaeger searches need a service (list them with operation services)');
    const jtags = Object.fromEntries([...tags, ...(a.errors_only ? [['error', 'true'] as [string, string]] : [])]);
    const r = await req('/api/traces', {
      service: a.service,
      operation: a.span_name,
      minDuration: a.min_duration,
      tags: Object.keys(jtags).length ? JSON.stringify(jtags) : undefined,
      limit,
      start: w.start * 1000,
      end: w.end * 1000,
    });
    if ('error' in r) return errOutput(r.error);
    const traces = (r.json as { data?: Array<{ traceID: string }> }).data ?? [];
    if (!traces.length) return done(ctx, 'No traces matched.');
    const rows = traces.slice(0, limit).map((t) => {
      const spans = spansFromJaeger(t);
      const root = spans.find((s) => !s.parent) ?? spans[0];
      const t0 = Math.min(...spans.map((s) => s.start));
      const t1 = Math.max(...spans.map((s) => s.start + s.dur));
      const errs = spans.filter((s) => s.error).length;
      return `${t.traceID} ${ms(t1 - t0)} ${root?.service ?? '?'} ${root?.name ?? ''} at ${new Date(t0).toISOString()}${errs ? ` · ${errs} failed span${errs === 1 ? '' : 's'}` : ''}`;
    });
    return done(ctx, [`${rows.length} trace${rows.length === 1 ? '' : 's'}:`, ...rows].join('\n'));
  },
};

/** Connection test path for each tracing backend. */
export const TRACE_PROBE: Record<'tempo' | 'jaeger' | 'signoz', string> = { tempo: '/api/echo', jaeger: '/api/services', signoz: '/api/v1/health' };

/** Exceptions recorded on spans (OTLP `exception` events), with their service and time. */
export function exceptionsFromOtlp(json: unknown): Array<{ service: string; at: number; type?: string; message?: string; stacktrace?: string }> {
  const j = json as { batches?: unknown[]; resourceSpans?: unknown[]; trace?: { resourceSpans?: unknown[] } };
  const batches = (j.batches ?? j.resourceSpans ?? j.trace?.resourceSpans ?? []) as Array<{
    resource?: { attributes?: Array<{ key: string; value: Record<string, unknown> }> };
    scopeSpans?: Array<{ spans?: unknown[] }>;
    instrumentationLibrarySpans?: Array<{ spans?: unknown[] }>;
  }>;
  const val = (v: Record<string, unknown> | undefined) => (v ? String(v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? '') : '');
  const out: Array<{ service: string; at: number; type?: string; message?: string; stacktrace?: string }> = [];
  for (const b of batches) {
    const service = val(b.resource?.attributes?.find((a) => a.key === 'service.name')?.value) || 'unknown';
    for (const scope of [...(b.scopeSpans ?? []), ...(b.instrumentationLibrarySpans ?? [])]) {
      for (const raw of (scope.spans ?? []) as Array<Record<string, unknown>>) {
        for (const ev of (raw.events ?? []) as Array<{ name?: string; timeUnixNano?: string; attributes?: Array<{ key: string; value: Record<string, unknown> }> }>) {
          if (ev.name !== 'exception') continue;
          const a = (k: string) => val(ev.attributes?.find((x) => x.key === k)?.value) || undefined;
          const at = ev.timeUnixNano ? Number(BigInt(ev.timeUnixNano) / 1_000_000n) : Number(BigInt(String(raw.startTimeUnixNano ?? 0)) / 1_000_000n);
          out.push({ service, at, ...(a('exception.type') ? { type: a('exception.type')! } : {}), ...(a('exception.message') ? { message: a('exception.message')! } : {}), ...(a('exception.stacktrace') ? { stacktrace: a('exception.stacktrace')! } : {}) });
        }
      }
    }
  }
  return out;
}
