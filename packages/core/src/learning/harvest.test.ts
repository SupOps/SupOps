import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { DEFAULT_RISK_POLICY, learnedRules, runSteps, runs, targets, toolCalls, users } from '@supops/db';
import type { Db } from '@supops/db';
import type { RiskTier } from '@supops/shared';
import { freshDb, seedRun } from '../engine/harness.test-util.ts';
import { assessRisk } from '../risk/index.ts';
import { STAGING } from '../risk/corpus.ts';
import { sshExecTool } from '../tools/builtin.ts';
import type { ToolDef } from '../tools/types.ts';
import { decide, harvest } from './harvest.ts';
import { signatureOf } from './signature.ts';

const CMD = 'systemctl restart nginx';
const SIG = signatureOf('ssh_exec', { command: CMD })!;

function setup() {
  const db = freshDb();
  const runId = seedRun(db, []);
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  const target = db.select().from(targets).get()!;
  for (const [id, name] of [['u1', 'Ada'], ['u2', 'Bo']] as const) db.insert(users).values({ id, email: `${id}@example.test`, name, globalRole: 'admin', passwordHash: null }).run();
  const step = db.insert(runSteps).values({ runId, seq: 0, messageJson: { role: 'user', content: 'x' }, state: 'committed' }).returning().get();
  let n = 0;
  const call = (o: { state: 'denied' | 'failed' | 'succeeded'; by?: string; comment?: string; tier?: RiskTier; auto?: boolean }) => {
    n += 1;
    db.insert(toolCalls).values({
      runId, stepId: step.id, toolCallId: `c${n}`, callIndex: n, toolKey: 'ssh_exec', targetId: target.id,
      argsJson: { command: CMD }, argsHash: `h${n}`, renderedCommand: CMD, signature: SIG,
      tier: o.tier ?? 'medium', state: o.state,
      riskJson: { tier: o.tier ?? 'medium', contributions: [], decision: o.auto ? 'auto' : 'approve', ceiling: 'medium' },
      decidedBy: o.by ?? null, decidedAt: o.by ? new Date() : null, decisionComment: o.comment ?? null,
    } as never).run();
  };
  return { db, projectId: run.projectId, targetId: target.id, call };
}
const rules = (db: Db) => db.select().from(learnedRules).all();

test('one denial teaches nothing; two raise the tier; three by two people block', () => {
  const { db, projectId, call } = setup();
  call({ state: 'denied', by: 'u1' });
  assert.deepEqual(harvest(db, projectId, SIG), []);
  assert.equal(rules(db).length, 0, 'one denial is not a pattern');

  call({ state: 'denied', by: 'u1' });
  const [r] = harvest(db, projectId, SIG);
  assert.ok(r?.created);
  assert.equal(r.effect, 'raise');
  assert.equal(r.minTier, 'high', 'medium, denied twice, needs high next time');
  assert.equal(rules(db)[0]!.evidenceJson.length, 2);
  assert.deepEqual(harvest(db, projectId, SIG), [], 'each call counts once');

  call({ state: 'denied', by: 'u2', comment: 'not during business hours' });
  const [b] = harvest(db, projectId, SIG);
  assert.equal(b!.effect, 'block');
  assert.equal(rules(db).length, 1, 'the same rule, strengthened');
  assert.match(rules(db)[0]!.reason, /denied 3 times by 2 people/);
});

test('three denials by one person with no comments raise, but do not block', () => {
  assert.equal(decide('denied', [1, 2, 3].map(() => ({ runId: null, at: 0, by: 'Ada', comment: null, state: 'denied' })), ['medium'], [])!.effect, 'raise');
  assert.equal(decide('denied', [1, 2, 3].map((i) => ({ runId: null, at: 0, by: 'Ada', comment: `no ${i}`, state: 'denied' })), ['medium'], [])!.effect, 'block', 'or with two comments');
});

test('an automatic change that fails twice waits for a person next time; approved failures do not count', () => {
  const { db, projectId, call } = setup();
  call({ state: 'failed', auto: true, tier: 'low' });
  call({ state: 'failed', tier: 'low', by: 'u1' }); // approved by a person: not the engine's call
  assert.deepEqual(harvest(db, projectId, SIG), []);
  call({ state: 'failed', auto: true, tier: 'low' });
  const [r] = harvest(db, projectId, SIG);
  assert.equal(r!.effect, 'raise');
  assert.equal(r!.minTier, 'high', 'one above what could run alone (medium here)');
  assert.equal(rules(db)[0]!.trigger, 'failed_change');
});

test('a rule someone switched off stays off, and never gets weaker', () => {
  const { db, projectId, call } = setup();
  call({ state: 'denied', by: 'u1' });
  call({ state: 'denied', by: 'u1' });
  harvest(db, projectId, SIG);
  db.update(learnedRules).set({ status: 'disabled' }).run();
  call({ state: 'denied', by: 'u1', tier: 'low' });
  harvest(db, projectId, SIG);
  const r = rules(db)[0]!;
  assert.equal(r.status, 'disabled');
  assert.equal(r.minTier, 'high', 'a lower tier seen later does not weaken it');
});

test('the risk engine applies a learned rule, only on its own target, and only upward', () => {
  const { db, projectId, call, targetId } = setup();
  call({ state: 'denied', by: 'u1' });
  call({ state: 'denied', by: 'u1' });
  harvest(db, projectId, SIG);
  const view = rules(db).map((r) => ({ id: r.id, signature: r.signature, targetId: r.targetId, effect: r.effect, minTier: r.minTier, reason: r.reason }));
  const def = sshExecTool as unknown as ToolDef<never>;
  const policy = { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' as const };
  const here = { ...STAGING, id: targetId };
  const assess = (t = here, command = CMD) => assessRisk({ def, args: { command }, rendered: command, target: t, policy, learned: { signature: signatureOf('ssh_exec', { command }), rules: view } });
  assert.equal(assess().tier, 'high');
  assert.ok(assess().contributions.some((c) => c.stage === 'learned'));
  assert.equal(assess({ ...STAGING, id: 'another' }).tier, 'medium', 'another machine is not affected');
  assert.equal(assess(here, 'systemctl status nginx').tier, 'read_only', 'a different action is not affected');
});
