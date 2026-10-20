import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-notify-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';
process.env.SUPOPS_PUBLIC_URL = 'https://supops.example.com';

const { db, settingsStore } = await import('../context.ts');
const { incidents, notificationChannels, notificationDeliveries, notificationRoutes, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('../observe/ingest.ts');
const { drain, plan } = await import('./notifier.ts');
const { packSecrets } = await import('./channels.ts');

const projectId = 'p-notify';
db.insert(projects).values({ id: projectId, slug: 'notify', name: 'Notify', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

// A local receiver standing in for a team's webhook endpoint.
const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
let failNext = 0;
let server: Server;
let url = '';
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext > 0) {
        failNext--;
        res.writeHead(503).end('busy');
        return;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
});
after(() => server.close());

const fire = (fp: string, severity: 'warning' | 'critical', status: 'firing' | 'resolved' = 'firing') =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title: 'QueueBacklog', severity, summary: null, labels: { alertname: 'QueueBacklog', team: 'shop', instance: 'mq-1:9100' }, status, notification: true });

test('a route sends opened, escalated, acknowledged and resolved once each, signed, with a link', async () => {
  const ch = db.insert(notificationChannels).values({ projectId, kind: 'webhook', name: 'Shop hook', config: { allowPrivateNetwork: true }, secretEnc: packSecrets({ url, secret: 's3cret' }) }).returning().get();
  db.insert(notificationRoutes).values({ projectId, name: 'Shop', matchers: [{ name: 'team', op: '=', value: 'shop' }], minSeverity: 'warning', events: ['opened', 'escalated', 'acknowledged', 'resolved'], channelIds: [ch.id] }).run();
  await new Promise((r) => setTimeout(r, 5)); // the incident opens after the route exists

  fire('n1', 'warning');
  assert.equal(plan(), 1);
  assert.equal(plan(), 0, 'looking again queues nothing new');
  await drain();
  assert.equal(received.length, 1);
  const first = received[0]!;
  const body = JSON.parse(first.body);
  assert.equal(body.event, 'opened');
  assert.equal(body.incident.url, `https://supops.example.com/observability/incidents/${body.incident.id}`);
  const ts = String(first.headers['x-supops-timestamp']);
  assert.equal(first.headers['x-supops-signature'], `sha256=${createHmac('sha256', 's3cret').update(`${ts}.${first.body}`).digest('hex')}`);

  fire('n1', 'critical'); // gets worse
  plan();
  await drain();
  assert.equal(JSON.parse(received[1]!.body).event, 'escalated');

  const inc = db.select().from(incidents).where(eq(incidents.id, body.incident.id)).get()!;
  db.update(incidents).set({ acknowledgedAt: new Date() }).where(eq(incidents.id, inc.id)).run();
  plan();
  await drain();
  assert.equal(JSON.parse(received[2]!.body).event, 'acknowledged');

  fire('n1', 'critical', 'resolved');
  plan();
  await drain();
  assert.deepEqual(received.map((r) => JSON.parse(r.body).event), ['opened', 'escalated', 'acknowledged', 'resolved']);
  plan();
  await drain();
  assert.equal(received.length, 4, 'nothing goes out twice');
});

test('a failed send is retried with backoff, and counted', async () => {
  received.length = 0;
  failNext = 1;
  fire('n2', 'warning');
  // a different machine, so a separate incident
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n3', title: 'DiskFull', severity: 'warning', summary: null, labels: { alertname: 'DiskFull', team: 'shop', instance: 'db-7:9100' }, status: 'firing', notification: true });
  plan();
  await drain();
  const failed = db.select().from(notificationDeliveries).where(eq(notificationDeliveries.status, 'failed')).all();
  assert.equal(failed.length, 1);
  assert.match(failed[0]!.error!, /503/);
  assert.ok(failed[0]!.nextAttemptAt!.getTime() > Date.now(), 'not retried at once');
  await drain(Date.now() + 61_000);
  assert.equal(db.select().from(notificationDeliveries).where(eq(notificationDeliveries.id, failed[0]!.id)).get()!.status, 'sent');
});

test('quiet hours hold back everything but critical, and say why', () => {
  const ch = db.insert(notificationChannels).values({ projectId, kind: 'webhook', name: 'Night', config: { allowPrivateNetwork: true }, secretEnc: packSecrets({ url }) }).returning().get();
  db.insert(notificationRoutes).values({ projectId, name: 'Night', matchers: [], minSeverity: 'info', events: ['opened'], channelIds: [ch.id], quietHours: { days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59', timezone: 'UTC' } }).run();
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n4', title: 'SlowQuery', severity: 'warning', summary: null, labels: { alertname: 'SlowQuery', instance: 'db-3:9100' }, status: 'firing', notification: true });
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n5', title: 'NodeDown', severity: 'critical', summary: null, labels: { alertname: 'NodeDown', instance: 'node-9:9100' }, status: 'firing', notification: true });
  plan();
  const mine = db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id)).all();
  const bySev = (s: string) => mine.find((d) => d.snapshot?.severity === s)!;
  assert.equal(bySev('warning').status, 'skipped');
  assert.equal(bySev('warning').reason, 'quiet hours');
  assert.equal(bySev('critical').status, 'pending', 'critical still goes out at night');
});

test('incidents from before a route existed are never announced', () => {
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n6', title: 'OldNews', severity: 'critical', summary: null, labels: { alertname: 'OldNews', team: 'late', instance: 'x-1:9100' }, status: 'firing', notification: true });
  const ch = db.insert(notificationChannels).values({ projectId, kind: 'webhook', name: 'Late', config: { allowPrivateNetwork: true }, secretEnc: packSecrets({ url }) }).returning().get();
  db.insert(notificationRoutes).values({ projectId, name: 'Late', matchers: [{ name: 'team', op: '=', value: 'late' }], minSeverity: 'info', events: ['opened'], channelIds: [ch.id], createdAt: new Date(Date.now() + 1000) }).run();
  plan();
  assert.equal(db.select().from(notificationDeliveries).where(eq(notificationDeliveries.channelId, ch.id)).all().length, 0);
});

test('acknowledged and resolved before the notifier looks: both are said, in order', async () => {
  received.length = 0;
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n7', title: 'CartErrors', severity: 'warning', summary: null, labels: { alertname: 'CartErrors', team: 'shop', instance: 'cart-1:9100' }, status: 'firing', notification: true });
  plan();
  await drain();
  const id = JSON.parse(received.at(-1)!.body).incident.id;
  db.update(incidents).set({ acknowledgedAt: new Date() }).where(eq(incidents.id, id)).run();
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'n7', title: 'CartErrors', severity: 'warning', summary: null, labels: { alertname: 'CartErrors', team: 'shop', instance: 'cart-1:9100' }, status: 'resolved', notification: true });
  plan();
  await drain();
  assert.deepEqual(received.filter((r) => JSON.parse(r.body).incident.id === id).map((r) => JSON.parse(r.body).event), ['opened', 'acknowledged', 'resolved']);
});
