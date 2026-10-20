import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-wb-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const calls: Array<{ method: string; url: string; auth: string; from: string; body: string }> = [];
let server: Server;
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ method: req.method!, url: req.url!, auth: String(req.headers.authorization ?? ''), from: String(req.headers.from ?? ''), body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.SUPOPS_PAGERDUTY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const { db, settingsStore } = await import('../context.ts');
const { alertIntegrations, incidents, projects, users, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { receive, newToken } = await import('../observe/hooks.ts');
const { packSecrets } = await import('./channels.ts');
const { recordIncidentEvent } = await import('../observe/incident-events.ts');
const { runWritebacks } = await import('./writeback.ts');

const projectId = 'p-wb';
db.insert(projects).values({ id: projectId, slug: 'wb', name: 'WB', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });
const ana = { id: 'u1', email: 'ana@example.com', name: 'Ana', globalRole: 'admin' };
db.insert(users).values({ id: ana.id, email: ana.email, name: ana.name, globalRole: 'admin', passwordHash: null }).run();

test('acknowledged, diagnosed and resolved in SupOps: the PagerDuty incident it came from follows, once each', async () => {
  const t = newToken();
  const src = db
    .insert(alertIntegrations)
    .values({ projectId, kind: 'pagerduty', name: 'PD', tokenHash: t.hash, tokenPrefix: t.prefix, writebackEnc: packSecrets({ apiKey: 'pd-token-1234' }), writebackConfig: { fromEmail: 'ops@example.com' } })
    .returning()
    .get();
  receive(src, { event: { event_type: 'incident.triggered', data: { id: 'PDX1', type: 'incident', title: 'Checkout down', urgency: 'high' } } });
  const inc = db.select().from(incidents).where(eq(incidents.projectId, projectId)).get()!;

  db.update(incidents).set({ acknowledgedAt: new Date(), acknowledgedBy: ana.id }).where(eq(incidents.id, inc.id)).run();
  recordIncidentEvent(inc.id, 'acknowledged', ana);
  await runWritebacks();
  await runWritebacks();
  assert.equal(calls.length, 1, 'once, however often it looks');
  assert.equal(calls[0]!.method, 'PUT');
  assert.equal(calls[0]!.url, '/incidents/PDX1');
  assert.equal(calls[0]!.auth, 'Token token=pd-token-1234');
  assert.equal(calls[0]!.from, 'ops@example.com');
  assert.equal(JSON.parse(calls[0]!.body).incident.status, 'acknowledged');

  db.update(incidents).set({ triageState: 'done', rootCause: 'The payment provider timed out.', confidence: 'high', runId: null }).where(eq(incidents.id, inc.id)).run();
  await runWritebacks();
  assert.equal(calls.length, 1, 'no note without a diagnosis run');

  db.update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, inc.id)).run();
  recordIncidentEvent(inc.id, 'resolved', ana);
  await runWritebacks();
  assert.equal(calls.at(-1)!.url, '/incidents/PDX1');
  assert.equal(JSON.parse(calls.at(-1)!.body).incident.status, 'resolved');
});

test('an acknowledgement that came from PagerDuty is not sent back to it', async () => {
  calls.length = 0;
  const t = newToken();
  const src = db
    .insert(alertIntegrations)
    .values({ projectId, kind: 'pagerduty', name: 'PD2', tokenHash: t.hash, tokenPrefix: t.prefix, writebackEnc: packSecrets({ apiKey: 'pd-token-5678' }), writebackConfig: { fromEmail: 'ops@example.com' } })
    .returning()
    .get();
  const ev = (event_type: string) => ({ event: { event_type, agent: { summary: 'Bob' }, data: { id: 'PDX2', type: 'incident', title: 'Search slow', urgency: 'low' } } });
  receive(src, ev('incident.triggered'));
  receive(src, ev('incident.acknowledged'));
  await runWritebacks();
  assert.equal(calls.filter((c) => c.url === '/incidents/PDX2').length, 0);
});
