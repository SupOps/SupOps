import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecContext, ResolvedTarget } from './types.ts';
import { queryTracesTool, spansFromJaeger, spansFromOtlp, summariseTrace } from './traces.ts';

async function fake(routes: Record<string, (u: URL) => unknown>) {
  const seen: Array<{ path: string; query: URLSearchParams; tenant: string | undefined }> = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push({ path: u.pathname, query: u.searchParams, tenant: req.headers['x-scope-orgid'] as string | undefined });
    const h = Object.entries(routes).find(([p]) => u.pathname === p || (p.endsWith('*') && u.pathname.startsWith(p.slice(0, -1))))?.[1];
    if (!h) return res.writeHead(404).end('{"error":"not found"}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(h(u)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ctxFor = (kind: string, baseUrl: string, extra: Record<string, unknown> = {}): ExecContext =>
  ({
    runId: 'r', toolCallId: 'c', timeoutMs: 5000, maxOutputBytes: 16_384, signal: new AbortController().signal,
    target: { id: 't', slug: `${kind}-1`, kind, env: 'prod', sensitivity: 1, description: null, config: { kind, baseUrl, allowPrivateNetwork: true, ...extra }, credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null } as unknown as ResolvedTarget,
  }) as ExecContext;

const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
const T0 = Date.UTC(2026, 9, 18, 9, 0, 0);
/** checkout -> payments -> db, where the db call fails after 900ms of the 1s request. */
const otlp = {
  batches: [
    { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'checkout' } }] }, scopeSpans: [{ spans: [{ spanId: 'a1', name: 'POST /pay', startTimeUnixNano: ns(T0), endTimeUnixNano: ns(T0 + 1000), status: { code: 2 }, attributes: [{ key: 'http.response.status_code', value: { intValue: '502' } }] }] }] },
    { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] }, scopeSpans: [{ spans: [{ spanId: 'b2', parentSpanId: 'a1', name: 'charge', startTimeUnixNano: ns(T0 + 20), endTimeUnixNano: ns(T0 + 980), status: { code: 2 } }] }] },
    { resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] }, scopeSpans: [{ spans: [{ spanId: 'c3', parentSpanId: 'b2', name: 'SELECT cards', startTimeUnixNano: ns(T0 + 50), endTimeUnixNano: ns(T0 + 950), status: { code: 2, message: 'deadline exceeded' }, events: [{ name: 'exception', attributes: [{ key: 'exception.type', value: { stringValue: 'PoolTimeout' } }, { key: 'exception.message', value: { stringValue: 'no free connection in 900ms' } }] }] }] }] },
  ],
};

test('a Tempo trace is summarised: deepest failure first, own time, and the tree', () => {
  const spans = spansFromOtlp(otlp);
  assert.equal(spans.length, 3);
  const text = summariseTrace('abc123abc123abc1', spans);
  assert.match(text, /3 spans, 1\.0s, 2 services \(checkout, payments\), 3 failed spans/);
  const failed = text.split('Failed spans')[1]!.split('\n').filter((l) => l.startsWith('- '));
  assert.match(failed[0]!, /payments SELECT cards \(900ms\): deadline exceeded; PoolTimeout: no free connection in 900ms/, 'the deepest failure, with its reason, comes first');
  assert.match(failed[2]!, /checkout POST \/pay .*HTTP 502/);
  assert.match(text.split('Most time spent in')[1]!, /^[^\n]*\n- 900ms payments SELECT cards/, 'own time puts the query first, not the request that waited for it');
  assert.match(text, /\n {4}\+50ms 900ms payments SELECT cards \[ERROR\]/);
});

test('Jaeger traces map to the same spans', () => {
  const spans = spansFromJaeger({
    spans: [
      { spanID: 's1', operationName: 'GET /', startTime: T0 * 1000, duration: 300_000, processID: 'p1', tags: [{ key: 'http.status_code', value: 500 }, { key: 'error', value: true }] },
      { spanID: 's2', operationName: 'redis GET', startTime: T0 * 1000 + 1000, duration: 250_000, processID: 'p2', references: [{ refType: 'CHILD_OF', spanID: 's1' }], logs: [{ fields: [{ key: 'event', value: 'error' }, { key: 'message', value: 'i/o timeout' }] }] },
    ],
    processes: { p1: { serviceName: 'web' }, p2: { serviceName: 'cache' } },
  });
  assert.deepEqual(spans.map((s) => [s.service, s.parent, s.dur, s.error, s.why ?? null]), [
    ['web', null, 300, true, 'HTTP 500'],
    ['cache', 's1', 250, false, 'i/o timeout'],
  ]);
});

test('Tempo search builds TraceQL from the fields; get and services work; the tenant is sent', async () => {
  const be = await fake({
    '/api/search': () => ({ traces: [{ traceID: 'abc123abc123abc1', rootServiceName: 'checkout', rootTraceName: 'POST /pay', startTimeUnixNano: ns(T0), durationMs: 1000 }] }),
    '/api/traces/*': () => otlp,
    '/api/search/tag/service.name/values': () => ({ tagValues: ['payments', 'checkout'] }),
  });
  try {
    const ctx = ctxFor('tempo', be.base, { tenantId: 'shop' });
    const found = await queryTracesTool.execute({ target: 't', service: 'checkout', errors_only: true, min_duration: '500ms', tags: 'http.response.status_code=502' }, ctx);
    assert.equal(found.ok, true, found.text);
    assert.match(found.text, /abc123abc123abc1 1\.0s checkout POST \/pay/);
    const q = be.seen[0]!.query;
    assert.equal(q.get('q'), '{ resource.service.name = "checkout" && status = error && .http.response.status_code = 502 }');
    assert.equal(q.get('minDuration'), '500ms');
    assert.equal(be.seen[0]!.tenant, 'shop');
    const got = await queryTracesTool.execute({ target: 't', operation: 'get', trace_id: 'abc123abc123abc1' }, ctx);
    assert.match(got.text, /PoolTimeout/);
    assert.match((await queryTracesTool.execute({ target: 't', operation: 'services' }, ctx)).text, /2 services: checkout, payments/);
  } finally {
    await be.close();
  }
});

test('Jaeger search needs a service, sends tags as JSON, and marks failed traces', async () => {
  const be = await fake({
    '/api/traces': () => ({ data: [{ traceID: 'ffff0000ffff0000', spans: [{ spanID: 's1', operationName: 'GET /', startTime: T0 * 1000, duration: 2_000_000, processID: 'p1', tags: [{ key: 'error', value: true }] }], processes: { p1: { serviceName: 'web' } } }] }),
  });
  try {
    const ctx = ctxFor('jaeger', be.base);
    const missing = await queryTracesTool.execute({ target: 't' }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.text, /need a service/);
    const out = await queryTracesTool.execute({ target: 't', service: 'web', errors_only: true, tags: 'http.method=GET' }, ctx);
    assert.match(out.text, /ffff0000ffff0000 2\.0s web GET \/ at .* · 1 failed span/);
    assert.deepEqual(JSON.parse(be.seen[0]!.query.get('tags')!), { 'http.method': 'GET', error: 'true' });
    assert.equal(be.seen[0]!.query.get('start'), String(Number(be.seen[0]!.query.get('end')) - 3_600_000_000));
  } finally {
    await be.close();
  }
});

test('bad input is refused before any request', () => {
  assert.equal(queryTracesTool.argsSchema.safeParse({ target: 't', operation: 'get', trace_id: 'nothex!' }).success, false);
  assert.equal(queryTracesTool.argsSchema.safeParse({ target: 't', min_duration: 'slow' }).success, false);
});

test('SigNoz: v5 raw queries with the API key header; search groups spans by trace; get summarises', async () => {
  const seen: Array<{ key: string | undefined; body: { compositeQuery: { queries: Array<{ spec: { filter?: { expression: string }; limit: number } }> } } }> = [];
  const t = Date.UTC(2026, 9, 18, 10);
  const row = (trace: string, span: string, parent: string, name: string, durMs: number, err: boolean, svc: string) => ({ timestamp: new Date(t).toISOString(), data: { trace_id: trace, span_id: span, parent_span_id: parent, name, duration_nano: durMs * 1e6, has_error: err, 'service.name': svc, ...(err ? { status_message: 'upstream timeout' } : {}) } });
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const body = JSON.parse(b);
      seen.push({ key: req.headers['signoz-api-key'] as string | undefined, body });
      const expr: string = body.compositeQuery.queries[0].spec.filter?.expression ?? '';
      const rows = expr.startsWith('trace_id')
        ? [row('t1', 'a', '', 'POST /pay', 900, true, 'checkout'), row('t1', 'b', 'a', 'charge', 850, true, 'payments')]
        : [row('t1', 'a', '', 'POST /pay', 900, true, 'checkout'), row('t1', 'b', 'a', 'charge', 850, true, 'payments'), row('t2', 'c', '', 'POST /pay', 120, false, 'checkout')];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', data: { type: 'raw', data: { results: [{ queryName: 'A', rows }] } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ctx = ctxFor('signoz', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    ctx.target.secret = JSON.stringify({ type: 'bearer', token: 'sz-key' });
    const found = await queryTracesTool.execute({ target: 't', service: 'checkout', errors_only: true, min_duration: '500ms', tags: "http.method=POST" }, ctx);
    assert.equal(found.ok, true, found.text);
    assert.match(found.text, /^2 traces[\s\S]*t1 900ms checkout POST \/pay[\s\S]*· 2 failed spans[\s\S]*t2 120ms/);
    assert.equal(seen[0]!.key, 'sz-key');
    assert.equal(seen[0]!.body.compositeQuery.queries[0]!.spec.filter!.expression, "service.name = 'checkout' AND has_error = true AND duration_nano >= 500000000 AND http.method = 'POST'");
    const got = await queryTracesTool.execute({ target: 't', operation: 'get', trace_id: 'aaaabbbbccccdddd' }, ctx);
    assert.match(got.text, /2 spans[\s\S]*payments charge \(850ms\): upstream timeout/);
    assert.match((await queryTracesTool.execute({ target: 't', operation: 'services' }, ctx)).text, /2 services seen in the window: checkout, payments/);
  } finally {
    server.close();
  }
});
