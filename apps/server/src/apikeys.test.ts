import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-keys-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db, settingsStore } = await import('./context.ts');
const { agents, projects, users, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { HttpTransport, McpClient, TRIAGE_AGENT_PROMPT } = await import('@supops/core');
const { signToken } = await import('./auth.ts');
const { api } = await import('./routes/index.ts');
const { ingestAlert } = await import('./observe/ingest.ts');

const admin = { id: 'u-admin', email: 'admin@example.test', name: 'Ada', globalRole: 'admin' as const };
db.insert(users).values({ ...admin, passwordHash: null }).run();
const project = db.insert(projects).values({ slug: 'shop', name: 'Shop', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
db.insert(agents).values({ projectId: project.id, slug: 'triage', name: 'Triage', role: 'triage', systemPrompt: TRIAGE_AGENT_PROMPT, budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false, triageGatherSeconds: 0 });
ingestAlert({ projectId: project.id, source: 'alertmanager', fingerprint: 'k-1', title: 'CheckoutErrors', severity: 'critical', summary: null, labels: { alertname: 'CheckoutErrors', service: 'checkout' }, status: 'firing', notification: true });

let app: Server;
let base = '';
const session = { authorization: `Bearer ${signToken(admin)}` };
before(async () => {
  const e = express();
  e.use(express.json());
  e.use('/api', api);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
});
after(() => {
  app.closeAllConnections();
  app.close();
});

const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const makeKey = async (scopes: string[]) => {
  const r = await call('POST', '/api-keys', session, { name: `key ${scopes.join('+')}`, scopes });
  assert.equal(r.status, 201);
  return (await r.json()) as { key: { id: string; prefix: string }; token: string };
};

test('a read key reads, and nothing else; a revoked key stops working; keys never manage keys', async () => {
  const k = await makeKey(['read']);
  assert.match(k.token, /^sok_[A-Za-z0-9_-]{40}$/);
  const bearer = { authorization: `Bearer ${k.token}` };
  assert.equal((await call('GET', `/observability/incidents?projectId=${project.id}`, bearer)).status, 200);
  const denied = await call('POST', '/runs', bearer, { projectId: project.id, agentId: 'x', task: 'x' });
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /its scopes: read/);
  assert.equal((await call('GET', '/settings', bearer)).status, 403, 'settings are not in the read scope');
  assert.equal((await call('GET', '/api-keys', bearer)).status, 403);
  const listed = await (await call('GET', '/api-keys', session)).text();
  assert.doesNotMatch(listed, new RegExp(k.token), 'the token is never listed');
  const ci = await makeKey(['changes']);
  const recorded = await call('POST', '/changes', { authorization: `Bearer ${ci.token}` }, { projectId: project.id, kind: 'deploy', title: 'checkout v2.4.1', service: 'checkout' });
  assert.equal(recorded.status, 201);
  assert.match(((await recorded.json()) as { author: string }).author, /API key "key changes" \(made by Ada\)/);
  assert.equal((await call('GET', `/changes?projectId=${project.id}`, { authorization: `Bearer ${ci.token}` })).status, 403, 'changes records; it does not read');
  assert.equal((await call('POST', `/api-keys/${k.key.id}/revoke`, session)).status, 200);
  assert.equal((await call('GET', `/observability/incidents?projectId=${project.id}`, bearer)).status, 401);
});

test('an expired key, or one whose maker is disabled, stops working', async () => {
  const { apiKeys } = await import('@supops/db');
  const { eq } = await import('drizzle-orm');
  const { verifyApiKey } = await import('./apikeys.ts');
  const k = await makeKey(['read']);
  assert.ok(verifyApiKey(k.token));
  db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, k.key.id)).run();
  assert.equal(verifyApiKey(k.token), null);

  db.insert(users).values({ id: 'u-bob', email: 'bob@example.test', name: 'Bob', globalRole: 'admin', passwordHash: null }).run();
  const bobs = await (await call('POST', '/api-keys', { authorization: `Bearer ${signToken({ id: 'u-bob', email: 'bob@example.test', name: 'Bob', globalRole: 'admin' })}` }, { name: 'ci', scopes: ['read'] })).json() as { token: string };
  assert.match(verifyApiKey(bobs.token)!.user.name, /made by Bob/);
  db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, 'u-bob')).run();
  assert.equal(verifyApiKey(bobs.token), null);
});

test('/metrics: an admin or a metrics key; the Prometheus text format', async () => {
  const k = await makeKey(['metrics']);
  const r = await call('GET', '/metrics', { authorization: `Bearer ${k.token}` });
  assert.equal(r.status, 200);
  const body = await r.text();
  assert.match(body, /^# HELP supops_up/m);
  assert.match(body, /^supops_incidents_open\{severity="critical"\} 1$/m);
  assert.match(body, /^supops_llm_request_seconds_bucket\{le="\+Inf"\} 0$/m);
  const read = await makeKey(['read']);
  assert.equal((await call('GET', '/metrics', { authorization: `Bearer ${read.token}` })).status, 403);
});

test("another agent uses SupOps as an MCP server: reads incidents, and starts only read-only investigations with the scope", async () => {
  const mcpOnly = await makeKey(['mcp']);
  const client = (token: string) => new McpClient(new HttpTransport({ url: `${base}/mcp`, headers: { authorization: `Bearer ${token}` }, allowPrivateNetwork: true }));
  const c = client(mcpOnly.token);
  assert.equal((await c.connect()).name, 'SupOps');
  const tools = (await c.listTools()).map((t) => t.name);
  assert.ok(tools.includes('get_incident') && !tools.includes('start_investigation'), 'no investigate scope, no tool for it');
  const list = await c.callTool('list_incidents', {}, 5_000);
  assert.ok(list.ok);
  const incidents = JSON.parse(list.text) as Array<{ id: string; title: string }>;
  assert.equal(incidents[0]!.title, 'CheckoutErrors');
  const one = JSON.parse((await c.callTool('get_incident', { id: incidents[0]!.id }, 5_000)).text) as { alerts: unknown[]; suspectedChanges: unknown[] };
  assert.equal(one.alerts.length, 1);
  assert.equal((await c.callTool('start_investigation', { task: 'why?' }, 5_000)).ok, false);
  c.close();

  const both = await makeKey(['mcp', 'investigate']);
  const c2 = client(both.token);
  await c2.connect();
  const started = await c2.callTool('start_investigation', { task: 'Is checkout healthy?' }, 5_000);
  assert.ok(started.ok, started.text);
  const { runId } = JSON.parse(started.text) as { runId: string };
  // No model is reachable here, so the run may already have failed; get_run still reports it.
  const run = JSON.parse((await c2.callTool('get_run', { id: runId }, 5_000)).text) as { id: string; status: string };
  assert.equal(run.id, runId);
  assert.ok(run.status);
  const { runs } = await import('@supops/db');
  const { eq } = await import('drizzle-orm');
  const row = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  assert.equal(row.policySnapshot.unattended, true, 'read-only: never more than an automatic diagnosis');
  assert.equal(row.startedBy, admin.id, "in the key maker's name");
  c2.close();
});
