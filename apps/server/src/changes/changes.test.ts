import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-changes-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db, settingsStore } = await import('../context.ts');
const { agents, alertIntegrations, alerts, changes, ciItems, ciLinks, projects, runSteps, runs, targets, toolCalls, users, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { newToken } = await import('../observe/hooks.ts');
const { hookRoutes } = await import('../routes/hooks.ts');
const { changeIngestRoute, changeRoutes } = await import('../routes/changes.ts');
const { ingestAlert } = await import('../observe/ingest.ts');
const { harvestOwnActions, pollGrafana } = await import('./poller.ts');

const projectId = 'p-ch';
db.insert(projects).values({ id: projectId, slug: 'ch', name: 'Changes', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(users).values({ id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin', passwordHash: null }).run();
settingsStore.saveObservability({ autoTriage: false });

let app: Server;
let base = '';
let grafana: Server;
let grafanaUrl = '';
const t = newToken();
const sender = db.insert(alertIntegrations).values({ projectId, kind: 'changes', name: 'CI', tokenHash: t.hash, tokenPrefix: t.prefix }).returning().get();

before(async () => {
  const e = express();
  e.use(express.json());
  e.use('/api/hooks', hookRoutes);
  e.use('/api/changes', changeIngestRoute);
  e.use((req, _res, next) => {
    req.user = { id: 'u-1', email: 'ada@example.test', name: 'Ada', globalRole: 'admin' };
    next();
  });
  e.use('/api/changes', changeRoutes);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
  grafana = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if (u.pathname !== '/api/annotations') return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
      { id: 1, time: Date.now() - 600_000, text: 'Deployed <b>search</b> 3.1', tags: ['deploy', 'service:search'] },
      { id: 2, time: Date.now() - 500_000, text: 'Coffee break', tags: ['note'] },
    ]));
  });
  grafana.listen(0, '127.0.0.1');
  await new Promise((r) => grafana.once('listening', r));
  grafanaUrl = `http://127.0.0.1:${(grafana.address() as AddressInfo).port}`;
});
after(() => {
  app.closeAllConnections();
  app.close();
  grafana.close();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('CI posts a change to its hook URL or to /api/changes with its token; a repeat updates it', async () => {
  const at = new Date(Date.now() - 20 * 60_000).toISOString();
  const r1 = await post(`/hooks/${sender.id}`, { id: 'run-41', service: 'checkout', version: '2.14.0', status: 'in_progress', started_at: at }, { authorization: `Bearer ${t.token}` });
  assert.equal(r1.status, 202);
  assert.deepEqual(await r1.json(), { alerts: 0, created: 0, resolved: 0, repeats: 0, changes: 1 });
  const r2 = await post('/changes', { id: 'run-41', service: 'checkout', version: '2.14.0', status: 'success', started_at: at, finished_at: new Date().toISOString() }, { authorization: `Bearer ${t.token}` });
  assert.equal(r2.status, 202);
  const rows = db.select().from(changes).where(eq(changes.externalId, 'run-41')).all();
  assert.equal(rows.length, 1, 'the same delivery id is one change');
  assert.equal(rows[0]!.status, 'succeeded');
  assert.ok(rows[0]!.finishedAt);
  assert.equal((await post('/changes', { service: 'x' }, { authorization: 'Bearer sup_wrong' })).status, 401);
  // Without a sender token, the signed-in route records it by hand.
  const manual = await post('/changes', { projectId, title: 'Raised the payments pool to 50', kind: 'config', service: 'payments', startedAt: new Date(Date.now() - 60 * 60_000).toISOString() });
  assert.equal(manual.status, 201);
  assert.equal(((await manual.json()) as { author: string }).author, 'Ada');
});

test('suspects for an incident: same service, then what it depends on, nearest first', async () => {
  const a = db.insert(ciItems).values({ projectId, key: 'checkout', name: 'checkout', type: 'service' }).returning().get();
  const b = db.insert(ciItems).values({ projectId, key: 'payments', name: 'payments', type: 'service', aliases: ['payments-api'] }).returning().get();
  db.insert(ciLinks).values({ projectId, fromId: a.id, toId: b.id, kind: 'depends_on' }).run();
  const r = ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'ch-1', title: 'CheckoutErrors', severity: 'critical', summary: null, labels: { alertname: 'CheckoutErrors', service: 'checkout' }, status: 'firing', notification: true });
  const incidentId = db.select().from(alerts).where(eq(alerts.id, r.alertId!)).get()!.incidentId;
  const res = await fetch(`${base}/changes/suspects/${incidentId}`);
  const list = (await res.json()) as Array<{ title: string; relation: string; reason: string }>;
  assert.deepEqual(list.map((c) => [c.title, c.relation]), [
    ['checkout 2.14.0 deployed', 'same'],
    ['Raised the payments pool to 50', 'upstream'],
  ]);
  assert.match(list[0]!.reason, /min before the first failure, on the failing service/);
});

test("SupOps' own changes are recorded once each; read-only checks and plans are not changes", () => {
  const target = db.insert(targets).values({ projectId, slug: 'web-1', name: 'web', kind: 'ssh', env: 'prod', sensitivity: 1, tags: [], config: { kind: 'ssh', host: 'web-1.example.test', port: 22, user: 'ops', sudo: false }, createdAt: new Date() } as never).returning().get();
  const agent = db.insert(agents).values({ projectId, slug: 'a', name: 'A', role: 'triage', systemPrompt: 'x', budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).returning().get();
  const run = db.insert(runs).values({ projectId, agentId: agent.id, trigger: 'chat', title: 'fix', status: 'succeeded', providerBaseUrl: 'x', model: 'm', systemSnapshot: 'x', toolsSnapshot: [], targetsSnapshot: [], policySnapshot: DEFAULT_RISK_POLICY, startedAt: new Date() }).returning().get();
  const step = db.insert(runSteps).values({ runId: run.id, seq: 1, messageJson: { role: 'assistant', content: null }, state: 'committed' } as never).returning().get();
  const call = (id: string, key: string, tier: string, cmd: string) =>
    db.insert(toolCalls).values({ runId: run.id, stepId: step.id, toolCallId: id, callIndex: 0, toolKey: key, argsJson: {}, argsHash: id, tier, state: 'succeeded', renderedCommand: cmd, targetId: target.id, decidedBy: 'u-1', startedAt: new Date(), finishedAt: new Date() } as never).run();
  call('c-restart', 'ssh_exec', 'medium', 'systemctl restart nginx');
  call('c-df', 'ssh_exec', 'read_only', 'df -h');
  call('c-plan', 'update_plan', 'low', 'update_plan 1/2 done');
  assert.equal(harvestOwnActions(Date.now() - 60_000), 1);
  assert.equal(harvestOwnActions(Date.now() - 60_000), 1, 'harvesting again updates, never duplicates');
  const own = db.select().from(changes).where(eq(changes.source, 'supops')).all();
  assert.equal(own.length, 1);
  assert.deepEqual([own[0]!.kind, own[0]!.title, own[0]!.service, own[0]!.author, own[0]!.targetId], ['action', 'systemctl restart nginx', 'web-1', 'Ada (approved in SupOps)', target.id]);
});

test('Grafana annotations tagged deploy become changes, with the service from a tag', async () => {
  const g = db.insert(targets).values({ projectId, slug: 'grafana-1', name: 'Grafana', kind: 'grafana', env: 'prod', sensitivity: 1, tags: [], config: { kind: 'grafana', baseUrl: grafanaUrl, allowPrivateNetwork: true }, createdAt: new Date() } as never).returning().get();
  assert.equal(await pollGrafana(g.id, Date.now() - 3_600_000), 1);
  assert.equal(await pollGrafana(g.id, Date.now() - 3_600_000), 1);
  const rows = db.select().from(changes).where(eq(changes.source, 'grafana')).all();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.title, rows[0]!.service, rows[0]!.kind], ['Deployed search 3.1', 'search', 'deploy']);
});
