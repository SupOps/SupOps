import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-err-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db } = await import('../context.ts');
const { changes, errorGroups, projects, targets, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { collectErrors, newErrorsBlock } = await import('./collector.ts');

const projectId = 'p-err';
db.insert(projects).values({ id: projectId, slug: 'err', name: 'Err', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
const now = Date.now();
const ns = (ms: number) => `${ms}000000`;

let backend: Server;
before(async () => {
  backend = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (u.pathname === '/loki/api/v1/query_range') {
      return json({ status: 'success', data: { result: [
        { stream: { service_name: 'orders' }, values: [
          [ns(now - 60_000), 'java.lang.IllegalStateException: pool exhausted after 30000ms\n\tat com.shop.orders.Pool.take(Pool.java:88)'],
          [ns(now - 50_000), 'java.lang.IllegalStateException: pool exhausted after 30012ms\n\tat com.shop.orders.Pool.take(Pool.java:88)'],
          [ns(now - 40_000), 'GET /health 200 2ms'],
        ] },
      ] } });
    }
    if (u.pathname === '/api/search') return json({ traces: [{ traceID: 'aaaabbbbccccdddd' }] });
    if (u.pathname.startsWith('/api/traces/')) {
      return json({ batches: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'payments' } }] }, scopeSpans: [{ spans: [{ spanId: 'a', name: 'charge', startTimeUnixNano: String(BigInt(now - 30_000) * 1_000_000n), endTimeUnixNano: String(BigInt(now - 29_000) * 1_000_000n), status: { code: 2 }, events: [{ name: 'exception', timeUnixNano: String(BigInt(now - 29_500) * 1_000_000n), attributes: [{ key: 'exception.type', value: { stringValue: 'TimeoutError' } }, { key: 'exception.message', value: { stringValue: 'provider did not answer in 5000ms' } }] }] }] }] }] });
    }
    res.writeHead(404).end('{}');
  });
  backend.listen(0, '127.0.0.1');
  await new Promise((r) => backend.once('listening', r));
  const base = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  for (const kind of ['loki', 'tempo']) db.insert(targets).values({ projectId, slug: `${kind}-1`, name: kind, kind, env: 'prod', sensitivity: 1, tags: [], config: { kind, baseUrl: base, allowPrivateNetwork: true }, createdAt: new Date() } as never).run();
  db.insert(changes).values({ projectId, source: 'api', kind: 'deploy', title: 'orders 3.2.0 deployed', service: 'orders', startedAt: new Date(now - 10 * 60_000) }).run();
});
after(() => backend.close());

test('errors from logs and traces are grouped; a new group after a change to its service is marked', async () => {
  assert.deepEqual(await collectErrors(projectId, now - 5 * 60_000, now), { groups: 2, created: 2 });
  const rows = db.select().from(errorGroups).all();
  const orders = rows.find((g) => g.service === 'orders')!;
  assert.deepEqual([orders.type, orders.count, orders.frame, orders.source], ['java.lang.IllegalStateException', 2, 'Pool.java com.shop.orders.Pool.take', 'logs']);
  assert.equal(orders.newAfterChange!.title, 'orders 3.2.0 deployed');
  const payments = rows.find((g) => g.service === 'payments')!;
  assert.deepEqual([payments.type, payments.traceId, payments.newAfterChange], ['TimeoutError', 'aaaabbbbccccdddd', null]);

  assert.deepEqual(await collectErrors(projectId, now - 5 * 60_000, now), { groups: 2, created: 0 }, 'seen again: counted, not new');
  assert.equal(db.select().from(errorGroups).all().find((g) => g.service === 'orders')!.count, 4);

  const block = newErrorsBlock(projectId, ['orders'], new Date(now));
  assert.match(block!, /^NEW ERRORS[\s\S]*orders: java\.lang\.IllegalStateException: pool exhausted after 30000ms \(at Pool\.java com\.shop\.orders\.Pool\.take\)[\s\S]*first seen after the change "orders 3\.2\.0 deployed"/);
  assert.doesNotMatch(block!, /payments/, 'only the incident\'s services');
});

test('the log patterns view groups a search into patterns with counts over the window', async () => {
  const express = (await import('express')).default;
  const { observabilityRoutes } = await import('../routes/observability.ts');
  const e = express();
  e.use((req, _res, next) => { req.user = { id: 'u', email: 'a@example.test', name: 'A', globalRole: 'admin' }; next(); });
  e.use('/api/observability', observabilityRoutes);
  const app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  try {
    const loki = db.select().from(targets).all().find((t) => t.kind === 'loki')!;
    const r = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/api/observability/log-patterns?projectId=${projectId}&connectionId=${loki.id}&hours=1`);
    const body = (await r.json()) as { lines: number; patterns: Array<{ template: string; count: number; buckets: number[] }> };
    assert.equal(body.lines, 3);
    assert.equal(body.patterns.length, 2);
    const pool = body.patterns.find((p) => p.template.startsWith('java.lang.IllegalStateException'))!;
    assert.equal(pool.count, 2);
    assert.equal(pool.buckets.length, 12);
  } finally {
    app.close();
  }
});
