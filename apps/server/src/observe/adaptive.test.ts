import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-adaptive-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { adaptiveLimits, alerts, projects, targets, watches, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { loadTargets } = await import('@supops/core');
const { checkAdaptive, forgetAdaptive } = await import('./adaptive.ts');

const projectId = 'p-ad';
db.insert(projects).values({ id: projectId, slug: 'ad', name: 'Adaptive', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

/** Two queues: their week sits between 40 and 60 (P99 90); "orders" is now at 200 for three minutes. */
let recent = [50, 55, 200, 210, 220];
let prom: Server;
before(async () => {
  prom = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const q = u.searchParams.get('query') ?? '';
    const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', data }));
    const series = ['orders', 'emails'];
    if (u.pathname === '/api/v1/query') {
      const p = Number(/quantile_over_time\(([\d.]+)/.exec(q)?.[1]);
      const v = p === 0.99 ? 90 : p === 0.75 ? 60 : p === 0.25 ? 40 : 10;
      return json({ resultType: 'vector', result: series.map((queue) => ({ metric: { queue }, value: [0, String(v)] })) });
    }
    if (u.pathname === '/api/v1/query_range') {
      const s = Number(u.searchParams.get('start'));
      return json({ resultType: 'matrix', result: series.map((queue) => ({ metric: { queue }, values: (queue === 'orders' ? recent : [50, 50, 50, 50, 50]).map((v, i) => [s + i * 60, String(v)]) })) });
    }
    res.writeHead(404).end('{}');
  });
  prom.listen(0, '127.0.0.1');
  await new Promise((r) => prom.once('listening', r));
  db.insert(targets).values({ id: 'prom-a', projectId, slug: 'prom-a', name: 'Prometheus', kind: 'prometheus', env: 'prod', sensitivity: 1, tags: [], config: { kind: 'prometheus', baseUrl: `http://127.0.0.1:${(prom.address() as AddressInfo).port}`, allowPrivateNetwork: true, watch: false }, createdAt: new Date() } as never).run();
});
after(() => prom.close());

test('limits are learned per series; 3 of 5 minutes past one raise an alert, which resolves when it calms', async () => {
  const w = db.insert(watches).values({ projectId, connectionId: 'prom-a', key: 'custom:queue', title: 'Queue depth', query: 'sum by (queue) (queue_ready)', unit: 'count', badDirection: 'up', adaptive: { iqrs: 2 } }).returning().get();
  const conn = loadTargets(db, projectId).find((t) => t.id === 'prom-a')!;
  assert.deepEqual(await checkAdaptive(w, conn), { firing: 1 });
  const limits = db.select().from(adaptiveLimits).where(eq(adaptiveLimits.watchId, w.id)).all();
  assert.deepEqual(limits.map((l) => [l.labels.queue, l.upper, l.lower]).sort(), [['emails', 130, null], ['orders', 130, null]], '90 + 2 x (60 - 40)');
  const a = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(a.length, 1);
  assert.equal(a[0]!.title, 'Queue depth unusually high');
  assert.equal(a[0]!.labels!.queue, 'orders');
  assert.match(a[0]!.summary!, /above its learned limit \(130\) for 3 of the last 5 minutes; now 220/);

  recent = [220, 210, 60, 55, 50];
  assert.deepEqual(await checkAdaptive(w, conn), { firing: 0 });
  assert.equal(db.select().from(alerts).where(eq(alerts.id, a[0]!.id)).get()!.status, 'resolved');
});

test('switching it off forgets the limits and closes what it raised', async () => {
  recent = [200, 200, 200, 200, 200];
  const w = db.select().from(watches).get()!;
  const conn = loadTargets(db, projectId).find((t) => t.id === 'prom-a')!;
  await checkAdaptive(w, conn);
  forgetAdaptive({ ...w, adaptive: null }, true);
  assert.equal(db.select().from(adaptiveLimits).all().length, 0);
  assert.ok(db.select().from(alerts).all().every((x) => x.status === 'resolved'));
});
