import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-learn-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db } = await import('./context.ts');
const { agents, projects, runSteps, runs, targets, toolCalls, users, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { signatureOf } = await import('@supops/core');
const { signToken } = await import('./auth.ts');
const { api } = await import('./routes/index.ts');

const ada = { id: 'u-ada', email: 'ada@example.test', name: 'Ada', globalRole: 'admin' as const };
const bo = { id: 'u-bo', email: 'bo@example.test', name: 'Bo', globalRole: 'admin' as const };
const cy = { id: 'u-cy', email: 'cy@example.test', name: 'Cy', globalRole: 'member' as const };
for (const u of [ada, bo, cy]) db.insert(users).values({ ...u, passwordHash: null }).run();
const project = db.insert(projects).values({ slug: 'shop', name: 'Shop', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
const target = db.insert(targets).values({ projectId: project.id, slug: 'web-1', name: 'web', kind: 'ssh', env: 'staging', sensitivity: 1, description: null, tags: [], config: { kind: 'ssh', host: '10.0.0.5', port: 22, user: 'ops', sudo: false }, createdAt: new Date() } as never).returning().get();
const agent = db.insert(agents).values({ projectId: project.id, slug: 'a', name: 'A', role: 'triage', systemPrompt: 'x', budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).returning().get();

const CMD = 'systemctl restart nginx';
let n = 0;
/** A run parked on one action waiting for approval, as the engine leaves it. */
function waitingCall(): string {
  n += 1;
  const run = db.insert(runs).values({ projectId: project.id, agentId: agent.id, trigger: 'chat', title: `r${n}`, status: 'awaiting_approval', providerBaseUrl: 'http://test', model: 'm', systemSnapshot: 'x', toolsSnapshot: [], targetsSnapshot: [], policySnapshot: DEFAULT_RISK_POLICY, startedAt: new Date() } as never).returning().get();
  const step = db.insert(runSteps).values({ runId: run.id, seq: 0, messageJson: { role: 'user', content: 'x' }, state: 'committed' }).returning().get();
  return db.insert(toolCalls).values({
    runId: run.id, stepId: step.id, toolCallId: `c${n}`, callIndex: 0, toolKey: 'ssh_exec', targetId: target.id,
    argsJson: { command: CMD }, argsHash: `h${n}`, renderedCommand: CMD, signature: signatureOf('ssh_exec', { command: CMD }),
    tier: 'medium', state: 'awaiting_approval', riskJson: { tier: 'medium', contributions: [], decision: 'approve' },
  } as never).returning().get().id;
}

let app: Server;
let base = '';
const as = (u: { id: string; email: string; name: string; globalRole: 'admin' | 'member' }) => ({ authorization: `Bearer ${signToken(u)}` });
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
const deny = async (who: typeof ada, comment?: string) => assert.equal((await call('POST', `/runs/tool-calls/${waitingCall()}/decision`, as(who), { decision: 'deny', ...(comment ? { comment } : {}) })).status, 200);
const rules = async (who: typeof ada | typeof cy = ada) => ((await (await call('GET', `/learning/rules?projectId=${project.id}`, as(who))).json()) as { undoableReset: string | null; rules: Array<{ id: string; effect: string; minTier: string; status: string; targetSlug: string; evidenceJson: unknown[] }> });

test('denials through the approval route become a rule, then a block', async () => {
  await deny(ada);
  assert.equal((await rules()).rules.length, 0);
  await deny(ada);
  let r = (await rules()).rules;
  assert.equal(r.length, 1);
  assert.equal(r[0]!.effect, 'raise');
  assert.equal(r[0]!.minTier, 'high');
  assert.equal(r[0]!.targetSlug, 'web-1');
  await deny(bo, 'never restart nginx during the sale');
  r = (await rules(cy)).rules; // members can read it
  assert.equal(r[0]!.effect, 'block');
  assert.equal(r[0]!.evidenceJson.length, 3);
});

test('admins switch rules off and on, reset them all, and undo the reset; members cannot', async () => {
  const id = (await rules()).rules[0]!.id;
  assert.equal((await call('PATCH', `/learning/rules/${id}`, as(cy), { status: 'disabled' })).status, 403);
  assert.equal((await call('PATCH', `/learning/rules/${id}`, as(ada), { status: 'disabled' })).status, 200);
  assert.equal((await rules()).rules[0]!.status, 'disabled');
  await call('PATCH', `/learning/rules/${id}`, as(ada), { status: 'active' });

  const reset = (await (await call('POST', '/learning/reset', as(ada), { projectId: project.id })).json()) as { batch: string; rules: number };
  assert.equal(reset.rules, 1);
  const after = await rules();
  assert.equal(after.rules[0]!.status, 'disabled');
  assert.equal(after.undoableReset, reset.batch);
  assert.equal((await call('POST', `/learning/reset/${reset.batch}/undo`, as(ada))).status, 200);
  assert.equal((await rules()).rules[0]!.status, 'active');
  assert.equal((await call('POST', `/learning/reset/${reset.batch}/undo`, as(ada))).status, 404, 'once');

  assert.equal((await call('DELETE', `/learning/rules/${id}`, as(ada))).status, 200);
  assert.equal((await rules()).rules.length, 0);
  await deny(ada);
  assert.equal((await rules()).rules.length, 0, 'deleted evidence is not counted again; one new denial is not a rule');
});

test('marking a suspected change: shown on the incident, one cause per incident, learned from, and undoable', async () => {
  const { settingsStore } = await import('./context.ts');
  const { ingestAlert } = await import('./observe/ingest.ts');
  const { recordChanges } = await import('./changes/store.ts');
  const { incidents } = await import('@supops/db');
  settingsStore.saveObservability({ autoTriage: false, triageGatherSeconds: 0 });
  ingestAlert({ projectId: project.id, source: 'alertmanager', fingerprint: 'f-1', title: 'CheckoutErrors', severity: 'critical', summary: null, labels: { alertname: 'CheckoutErrors', service: 'checkout' }, status: 'firing', notification: true });
  const inc = db.select().from(incidents).get()!;
  const [a, b] = recordChanges(project.id, 'manual', [
    { kind: 'deploy', title: 'checkout v2', service: 'checkout', author: 'ci', startedAt: new Date(Date.now() - 10 * 60_000) },
    { kind: 'config', title: 'checkout flags', service: 'checkout', author: 'ci', startedAt: new Date(Date.now() - 3 * 60_000) },
  ]) as Array<{ id: string }>;
  const mark = (changeId: string, verdict: string | null, who: typeof ada | typeof cy = cy) => call('POST', `/changes/suspects/${inc.id}/feedback`, as(who), { changeId, verdict });
  type S = Array<{ id: string; feedback: string | null }>;
  const suspects = async () => (await (await call('GET', `/changes/suspects/${inc.id}`, as(ada))).json()) as S;

  assert.equal((await mark(a!.id, 'cause')).status, 200, 'any signed-in person can mark');
  assert.equal((await suspects()).find((s) => s.id === a!.id)!.feedback, 'cause');
  await mark(b!.id, 'cause');
  const now = await suspects();
  assert.equal(now.find((s) => s.id === b!.id)!.feedback, 'cause');
  assert.equal(now.find((s) => s.id === a!.id)!.feedback, null, 'one cause per incident');
  await mark(a!.id, 'not_cause');
  const ranking = (await (await call('GET', `/learning/ranking?projectId=${project.id}`, as(ada))).json()) as { model: unknown; marks: unknown[] };
  assert.equal(ranking.marks.length, 2);
  assert.equal(ranking.model, null, 'two marks are not enough to learn from');
  await mark(a!.id, null);
  assert.equal((await suspects()).find((s) => s.id === a!.id)!.feedback, null, 'taken back');
  assert.equal((await mark('nope', 'cause')).status, 404);
});

test('a confirmed cause exports as an eval case that replays the real outputs, secrets masked', async () => {
  const { incidents, changes } = await import('@supops/db');
  const inc = db.select().from(incidents).get()!;
  const change = db.select().from(changes).where(eq(changes.title, 'checkout v2')).get()!;
  await call('POST', `/changes/suspects/${inc.id}/feedback`, as(ada), { changeId: change.id, verdict: 'cause' });
  assert.equal((await call('GET', `/learning/eval-case/${inc.id}`, as(ada))).status, 409, 'no diagnosis run yet');

  const callId = waitingCall();
  const c = db.select().from(toolCalls).where(eq(toolCalls.id, callId)).get()!;
  db.update(toolCalls).set({ state: 'succeeded', renderedCommand: 'journalctl -u checkout -n 50', resultJson: { ok: true, text: 'error: token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected after v2' } }).where(eq(toolCalls.id, callId)).run();
  db.update(runs).set({ targetsSnapshot: [{ slug: 'web-1', kind: 'ssh', env: 'staging', description: null }] } as never).where(eq(runs.id, c.runId)).run();
  db.update(incidents).set({ runId: c.runId }).where(eq(incidents.id, inc.id)).run();

  const r = await call('GET', `/learning/eval-case/${inc.id}`, as(ada));
  assert.equal(r.status, 200);
  const ec = (await r.json()) as { mode: string; targets: Array<{ slug: string }>; replay: Array<{ match: string; output: string; target?: string }>; expect: { elements: Array<{ text: string }> } };
  assert.equal(ec.mode, 'incident');
  assert.deepEqual(ec.targets.map((t) => t.slug), ['web-1']);
  assert.equal(ec.replay[0]!.match, 'journalctl -u checkout -n 50');
  assert.equal(ec.replay[0]!.target, 'web-1');
  assert.doesNotMatch(ec.replay[0]!.output, /ghp_/, 'secrets are masked');
  assert.match(ec.expect.elements[0]!.text, /checkout v2/);
});
