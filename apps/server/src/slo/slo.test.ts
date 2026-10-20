import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-slo-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db, settingsStore } = await import('../context.ts');
const { alerts, changes, ciItems, projects, slos, targets, users, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { and, eq } = await import('drizzle-orm');
const { sloRoutes } = await import('../routes/slos.ts');
const { serviceHealthRoutes } = await import('../routes/service-health.ts');
const { evaluateSlo } = await import('./evaluate.ts');
const { computeDueVerdicts } = await import('../servicehealth/signals.ts');

const projectId = 'p-slo';
db.insert(projects).values({ id: projectId, slug: 'slo', name: 'SLO', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(users).values({ id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin', passwordHash: null }).run();
db.insert(ciItems).values({ projectId, key: 'checkout', name: 'checkout', type: 'service', attrs: { owner: 'shop-team', runbook_url: 'https://wiki.example.test/checkout' } }).run();
settingsStore.saveObservability({ autoTriage: false });

/** A fake Prometheus with OpenTelemetry HTTP metrics for checkout: 2% of requests fail until `healthy`. */
let healthy = false;
const deployAt = Date.now() - 40 * 60_000;
let prom: Server;
let app: Server;
let base = '';
before(async () => {
  prom = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', data }));
    if (u.pathname === '/api/v1/label/__name__/values') return json(['up', 'http_server_request_duration_seconds_bucket', 'http_server_request_duration_seconds_count', 'container_cpu_usage_seconds_total']);
    if (u.pathname === '/api/v1/label/service_name/values') return json(['checkout', 'search']);
    const q = u.searchParams.get('query') ?? '';
    const vector = (v: number) => json({ resultType: 'vector', result: [{ metric: {}, value: [Date.now() / 1000, String(v)] }] });
    if (u.pathname === '/api/v1/query') {
      const t = Number(u.searchParams.get('time') ?? Date.now() / 1000) * 1000;
      if (q.startsWith('avg_over_time(')) {
        // Deploy verdict: latency went from 0.3s to 2.5s after the deploy; errors and CPU did not move.
        const after = t > deployAt + 60_000;
        if (q.includes('histogram_quantile(0.95')) return vector(after ? 2.5 : 0.3);
        if (q.includes('5..')) return vector(0.001);
        if (q.includes('container_cpu')) return vector(0.4);
        return vector(100);
      }
      if (q.includes('container_memory') || q.includes('process_')) return json({ resultType: 'vector', result: [] });
      if (q.includes('container_cpu')) return vector(0.4);
      // Good = total - failed: 100 req/s, 2 of them failing (or none once healthy).
      if (q.includes(' - (sum(rate(')) return vector(healthy ? 100 : 98);
      return vector(100);
    }
    if (u.pathname === '/api/v1/query_range') {
      const s = Number(u.searchParams.get('start'));
      return json({ resultType: 'matrix', result: [{ metric: {}, values: [[s, '0.31'], [s + 300, '0.29'], [s + 600, '2.4']] }] });
    }
    res.writeHead(404).end('{}');
  });
  prom.listen(0, '127.0.0.1');
  await new Promise((r) => prom.once('listening', r));
  db.insert(targets).values({ id: 'prom-1', projectId, slug: 'prom-1', name: 'Prometheus', kind: 'prometheus', env: 'prod', sensitivity: 1, tags: [], config: { kind: 'prometheus', baseUrl: `http://127.0.0.1:${(prom.address() as AddressInfo).port}`, allowPrivateNetwork: true, watch: false }, createdAt: new Date() } as never).run();
  db.insert(changes).values({ projectId, source: 'api', kind: 'deploy', title: 'checkout 5.4.0 deployed', service: 'checkout', version: '5.4.0', startedAt: new Date(deployAt) }).run();

  const e = express();
  e.use(express.json());
  e.use((req, _res, next) => {
    req.user = { id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin' };
    next();
  });
  e.use('/api/slos', sloRoutes);
  e.use('/api/service-health', serviceHealthRoutes);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
});
after(() => {
  prom.close();
  app.closeAllConnections();
  app.close();
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('an availability SLO from the service, burning 20x: a critical burn alert, resolved when errors stop', async () => {
  const r = await post('/slos/from-service', { projectId, service: 'checkout', target: 0.999 });
  assert.equal(r.status, 201);
  const slo = (await r.json()) as { id: string; goodQuery: string; status: { sli: number; budgetRemaining: number; firing: Array<{ rule: string; burn: number }> } };
  assert.match(slo.goodQuery, /http_server_request_duration_seconds_count\{service_name="checkout"\}\[\$window\]/);
  assert.equal(slo.status.sli.toFixed(2), '0.98');
  assert.equal(slo.status.budgetRemaining.toFixed(0), '-19', '2% failing against a 0.1% budget');
  assert.deepEqual(slo.status.firing.map((f) => f.rule), ['fast', 'medium', 'slow']);
  const firing = db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.status, 'new'))).all().filter((a) => a.labels?.alertname === 'SLOBurnRate');
  assert.equal(firing.length, 3);
  assert.match(firing.find((a) => a.labels?.burn_window === '1h/5m')!.summary!, /spent 20× faster than sustainable over 1h/);
  assert.equal(firing.find((a) => a.labels?.burn_window === '24h/2h')!.severity, 'warning');

  healthy = true;
  const row = db.select().from(slos).where(eq(slos.id, slo.id)).get()!;
  const status = await evaluateSlo(row);
  assert.equal(status.firing.length, 0);
  const after = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all().filter((a) => a.labels?.alertname === 'SLOBurnRate');
  assert.ok(after.every((a) => a.status === 'resolved'), 'every burn alert resolves when the burn stops');
});

test('queries without $window are refused; preview shows the SLI before saving', async () => {
  const bad = await post('/slos', { projectId, name: 'x', connectionId: 'prom-1', goodQuery: 'sum(rate(x[5m]))', totalQuery: 'sum(rate(y[$window]))', target: 0.99 });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /\$window/);
  const pv = await post('/slos/preview', { projectId, connectionId: 'prom-1', goodQuery: 'sum(rate(good[$window])) - (sum(rate(x{c=~"5.."}[$window])) or vector(0))', totalQuery: 'sum(rate(all[$window]))', windowDays: 30 });
  assert.deepEqual(await pv.json(), { lastHour: 1, window: 1, ok: true });
});

test('a deploy is judged 35 minutes on: latency flagged, the rest unchanged', async () => {
  assert.equal(await computeDueVerdicts(), 1);
  const c = db.select().from(changes).where(eq(changes.service, 'checkout')).get()!;
  assert.equal(c.verdict!.overall, 'worse');
  assert.deepEqual(c.verdict!.signals.filter((s) => s.flag).map((s) => s.name), ['p95 latency']);
  assert.equal(await computeDueVerdicts(), 0, 'judged once');
});

test("the service page: catalogue, metrics found by convention, changes, SLOs", async () => {
  const r = await fetch(`${base}/service-health/checkout?projectId=${projectId}&hours=6`);
  const s = (await r.json()) as { inMap: boolean; catalogue: Record<string, string | null>; metrics: { family: string; label: string; series: Record<string, unknown[]> }; changes: unknown[]; slos: unknown[] };
  assert.equal(s.inMap, true);
  assert.equal(s.catalogue.owner, 'shop-team');
  assert.equal(s.catalogue.runbook, 'https://wiki.example.test/checkout');
  assert.deepEqual([s.metrics.family, s.metrics.label], ['otel-http', 'service_name']);
  assert.equal(s.metrics.series.p95!.length, 3);
  assert.ok(s.metrics.series.cpu, 'CPU from container metrics');
  assert.equal(s.metrics.series.memory, undefined, 'no memory metric: no memory chart');
  assert.equal(s.changes.length, 1);
  assert.equal(s.slos.length, 1);
  const list = (await (await fetch(`${base}/service-health?projectId=${projectId}`)).json()) as Array<{ name: string }>;
  assert.ok(list.some((x) => x.name === 'checkout'));
});
