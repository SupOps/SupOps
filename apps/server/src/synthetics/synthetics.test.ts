import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-syn-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db, settingsStore } = await import('../context.ts');
const { alerts, projects, syntheticChecks, users, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { syntheticRoutes } = await import('../routes/synthetics.ts');
const { runCheck } = await import('./runner.ts');

const projectId = 'p-syn';
db.insert(projects).values({ id: projectId, slug: 'syn', name: 'Syn', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(users).values({ id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin', passwordHash: null }).run();
settingsStore.saveObservability({ autoTriage: false });

let broken = false;
let site: Server;
let app: Server;
let siteUrl = '';
let base = '';
before(async () => {
  site = createServer((_req, res) => (broken ? res.writeHead(502).end('bad gateway') : res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Shop</h1> checkout ready')));
  site.listen(0, '127.0.0.1');
  await new Promise((r) => site.once('listening', r));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const e = express();
  e.use(express.json());
  e.use((req, _res, next) => {
    req.user = { id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin' };
    next();
  });
  e.use('/api/synthetics', syntheticRoutes);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/synthetics`;
});
after(() => {
  site.closeAllConnections();
  site.close();
  app.closeAllConnections();
  app.close();
});

const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a check runs at once, alerts after two failures in a row, and resolves on the next success', async () => {
  const r = await post('', { projectId, name: 'Shop home', kind: 'http', target: siteUrl, contains: 'checkout ready', allowPrivate: true, failThreshold: 2 });
  assert.equal(r.status, 201);
  const c = (await r.json()) as { id: string; lastStatus: string; uptime: { day: number } };
  assert.equal(c.lastStatus, 'up');
  assert.equal(c.uptime.day, 1);

  broken = true;
  const row = () => db.select().from(syntheticChecks).where(eq(syntheticChecks.id, c.id)).get()!;
  await runCheck(row());
  assert.equal(db.select().from(alerts).all().length, 0, 'one failure is not an outage');
  await runCheck(row());
  const a = db.select().from(alerts).get()!;
  assert.deepEqual([a.title, a.severity, a.status, a.labels!.alertname], ['Shop home is down', 'critical', 'new', 'SyntheticCheckFailed']);
  assert.match(a.summary!, /failed 2 times in a row: HTTP 502/);

  broken = false;
  await runCheck(row());
  assert.equal(db.select().from(alerts).get()!.status, 'resolved');
  const list = (await (await fetch(`${base}?projectId=${projectId}`)).json()) as Array<{ uptime: { day: number }; recent: unknown[] }>;
  assert.equal(list[0]!.uptime.day, 0.5, '2 of 4 runs worked');
  assert.equal(list[0]!.recent.length, 4);
});

test('an SLO can be measured on a check; internal addresses need permission', async () => {
  const c = db.select().from(syntheticChecks).get()!;
  const s = await post(`/${c.id}/slo`, { target: 0.99 });
  assert.equal(s.status, 201);
  const slo = (await s.json()) as { syntheticId: string; status: { sli: number; budgetRemaining: number } };
  assert.equal(slo.syntheticId, c.id);
  assert.equal(slo.status.sli, 0.5);
  assert.ok(slo.status.budgetRemaining < 0);

  const r = await post('', { projectId, name: 'Internal', kind: 'http', target: siteUrl });
  const made = (await r.json()) as { lastStatus: string; lastError: string };
  assert.equal(made.lastStatus, 'down');
  assert.match(made.lastError, /internal address/);
  assert.equal((await post('', { projectId, name: 'x', kind: 'tcp', target: 'db.example.test' })).status, 400, 'tcp needs a port');
});
