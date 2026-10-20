import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-hooks-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db } = await import('../context.ts');
const { alertIntegrations, alerts, incidents, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { and, eq } = await import('drizzle-orm');
const { hashToken, newToken, overRate, presentedToken, receive, tokenMatches, RATE_PER_MINUTE } = await import('./hooks.ts');
const { hookRoutes } = await import('../routes/hooks.ts');

const projectId = 'p-hooks';
let server: Server;
let base = '';

function addSender(kind: 'alertmanager' | 'pagerduty' | 'generic', mapping: Record<string, unknown> | null = null) {
  const t = newToken();
  const row = db
    .insert(alertIntegrations)
    .values({ projectId, kind, name: `${kind} sender`, tokenHash: t.hash, tokenPrefix: t.prefix, mapping })
    .returning()
    .get();
  return { row, token: t.token };
}

const amBatch = (status: 'firing' | 'resolved', extra: Record<string, string> = {}) => ({
  version: '4',
  status,
  alerts: [
    { status, labels: { alertname: 'DiskFilling', severity: 'warning', instance: 'web-1:9100', ...extra }, annotations: { summary: '/var fills in 6h' }, startsAt: '2026-10-16T08:00:00Z', fingerprint: 'fp-disk' },
  ],
});

before(async () => {
  db.insert(projects).values({ id: projectId, slug: 'hooks', name: 'Hooks', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
  const app = express();
  app.use('/api/hooks', express.json({ limit: '5mb' }));
  app.use('/api/hooks', hookRoutes);
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/hooks`;
});
after(() => server.close());

test('tokens: shown once, stored as a hash, the old one works for a day after rotation', () => {
  const t = newToken();
  assert.match(t.token, /^sup_[A-Za-z0-9_-]{40,}$/);
  assert.equal(t.hash, hashToken(t.token));
  assert.ok(!t.hash.includes(t.token));
  const now = Date.now();
  const rotated = { tokenHash: hashToken('new'), previousTokenHash: t.hash, previousTokenUntil: new Date(now + 86_400_000) };
  assert.equal(tokenMatches(rotated, 'new', now), true);
  assert.equal(tokenMatches(rotated, t.token, now), true, 'the old token still works during the overlap');
  assert.equal(tokenMatches(rotated, t.token, now + 2 * 86_400_000), false, 'and stops after it');
  assert.equal(tokenMatches(rotated, 'guess', now), false);
});

test('the token is read from Bearer, Basic (as the password) or X-SupOps-Token; never the URL', () => {
  assert.equal(presentedToken({ authorization: 'Bearer sup_abc' }), 'sup_abc');
  assert.equal(presentedToken({ authorization: `Basic ${Buffer.from('alertmanager:sup_xyz').toString('base64')}` }), 'sup_xyz');
  assert.equal(presentedToken({ 'x-supops-token': 'sup_hdr' }), 'sup_hdr');
  assert.equal(presentedToken({}), null);
});

test('an Alertmanager push: stored, repeats counted not stored, resolved by its resolve', () => {
  const { row } = addSender('alertmanager');
  const first = receive(row, amBatch('firing'));
  assert.deepEqual(first.ok && first.result, { alerts: 1, created: 1, resolved: 0, repeats: 0 });
  const stored = db.select().from(alerts).where(eq(alerts.integrationId, row.id)).all();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.source, 'alertmanager');
  assert.equal(stored[0]!.status, 'new');
  assert.ok(stored[0]!.incidentId, 'grouped into an incident like any alert');

  // Alertmanager resends firing alerts every repeat_interval: identical content is a repeat.
  const again = receive(row, amBatch('firing'));
  assert.equal(again.ok && again.result.repeats, 1);
  const afterRepeat = db.select().from(alerts).where(eq(alerts.integrationId, row.id)).all();
  assert.equal(afterRepeat.length, 1);
  assert.equal(afterRepeat[0]!.count, 2, 'the repeat is counted');

  // Changed content updates the same alert.
  const changed = receive(row, amBatch('firing', { severity: 'critical' }));
  assert.equal(changed.ok && changed.result.repeats, 0);
  assert.equal(db.select().from(alerts).where(eq(alerts.integrationId, row.id)).get()!.severity, 'critical');

  const resolved = receive(row, amBatch('resolved', { severity: 'critical' }));
  assert.equal(resolved.ok && resolved.result.resolved, 1);
  const end = db.select().from(alerts).where(eq(alerts.integrationId, row.id)).get()!;
  assert.equal(end.status, 'resolved');
  assert.equal(db.select().from(incidents).where(eq(incidents.id, end.incidentId!)).get()!.status, 'resolved');

  const counters = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, row.id)).get()!;
  assert.deepEqual([counters.received, counters.alertsIn, counters.repeats], [4, 4, 1]);
});

test('two senders with the same alert fingerprint stay apart', () => {
  const a = addSender('alertmanager');
  const b = addSender('alertmanager');
  receive(a.row, amBatch('firing', { instance: 'api-1:9100' }));
  receive(b.row, amBatch('firing', { instance: 'api-2:9100' }));
  const rows = db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, 'DiskFilling'), eq(alerts.status, 'new'))).all();
  assert.ok(rows.some((r) => r.integrationId === a.row.id) && rows.some((r) => r.integrationId === b.row.id));
});

test('a payload the sender kind does not understand is refused and recorded', () => {
  const { row } = addSender('pagerduty');
  const r = receive(row, { hello: 'world' });
  assert.equal(r.ok, false);
  const after = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, row.id)).get()!;
  assert.equal(after.rejected, 1);
  assert.match(after.lastError!, /PagerDuty/);
});

test('HTTP: the right token is accepted; no token, a wrong token and an unknown id are all 401', async () => {
  const { row, token } = addSender('generic');
  const post = (id: string, headers: Record<string, string>, body: unknown = { title: 'Queue backlog', severity: 'critical', host: 'worker-3' }) =>
    fetch(`${base}/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  const good = await post(row.id, { authorization: `Bearer ${token}` });
  assert.equal(good.status, 202);
  assert.deepEqual(await good.json(), { alerts: 1, created: 1, resolved: 0, repeats: 0 });

  assert.equal((await post(row.id, {})).status, 401);
  assert.equal((await post(row.id, { authorization: 'Bearer sup_wrong' })).status, 401);
  const unknown = await post('no-such-id', { authorization: `Bearer ${token}` });
  assert.equal(unknown.status, 401, 'an unknown id looks the same as a wrong token');

  const refused = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, row.id)).get()!;
  assert.equal(refused.rejected, 2);
  assert.equal(refused.lastError, 'Wrong token');

  db.update(alertIntegrations).set({ enabled: false }).where(eq(alertIntegrations.id, row.id)).run();
  assert.equal((await post(row.id, { authorization: `Bearer ${token}` })).status, 403);
  db.update(alertIntegrations).set({ enabled: true }).where(eq(alertIntegrations.id, row.id)).run();

  assert.equal((await post(row.id, { authorization: `Bearer ${token}` }, { nothing: 'useful' })).status, 400);
});

test('a sender over its rate is refused for the rest of the minute', () => {
  const id = 'rate-test';
  const t0 = 1_000_000;
  for (let i = 0; i < RATE_PER_MINUTE; i++) assert.equal(overRate(id, t0), false);
  assert.equal(overRate(id, t0 + 10), true);
  assert.equal(overRate(id, t0 + 60_001), false, 'a new minute starts fresh');
});

test('acknowledged in PagerDuty: the SupOps incident is acknowledged too, saying where and by whom', async () => {
  const { incidentEvents } = await import('@supops/db');
  const { row } = addSender('pagerduty');
  const ev = (event_type: string) => ({ event: { event_type, agent: { summary: 'Bob' }, data: { id: 'PD42', type: 'incident', title: 'Checkout down', urgency: 'high', service: { summary: 'checkout' } } } });
  receive(row, ev('incident.triggered'));
  const a = db.select().from(alerts).where(eq(alerts.integrationId, row.id)).get()!;
  assert.equal(db.select().from(incidents).where(eq(incidents.id, a.incidentId!)).get()!.acknowledgedAt, null);
  receive(row, ev('incident.acknowledged'));
  const inc = db.select().from(incidents).where(eq(incidents.id, a.incidentId!)).get()!;
  assert.ok(inc.acknowledgedAt);
  const e = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id)).all().find((x) => x.kind === 'acknowledged')!;
  assert.deepEqual(e.data, { via: 'PagerDuty', by: 'Bob' });
});
