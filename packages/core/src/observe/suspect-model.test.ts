import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankChanges } from './changes.ts';
import type { StoredChange } from './changes.ts';
import { blendWeight, describeModel, learnedAdjustment, predictCause, trainSuspectModel } from './suspect-model.ts';
import type { SuspectExample } from './suspect-model.ts';

const MIN = 60_000;
const t0 = new Date('2026-10-19T10:00:00Z');
const change = (id: string, o: Partial<StoredChange> & { verdict?: { overall: string } | null }): StoredChange => ({ id, kind: 'deploy', title: id, service: 'checkout', targetId: null, startedAt: new Date(t0.getTime() - 10 * MIN), source: 'api', ...o });
const incident = { startedAt: t0, services: ['checkout'], targetIds: [], upstream: ['payments'] };

/**
 * A team whose incidents keep being caused by deploys that already looked worse
 * afterwards, even when another change is nearer in time.
 */
function history(n: number): SuspectExample[] {
  const out: SuspectExample[] = [];
  for (let i = 0; i < n; i += 1) {
    const [worse] = rankChanges(incident, [change('w', { startedAt: new Date(t0.getTime() - 50 * MIN), verdict: { overall: 'worse' } })]);
    const [near] = rankChanges(incident, [change('n', { startedAt: new Date(t0.getTime() - 2 * MIN), kind: 'config' })]);
    out.push({ x: worse!.features, y: 1, w: 1 }, { x: near!.features, y: 0, w: 1 });
  }
  return out;
}

test('below three marks there is no model, and the fixed ranking is unchanged', () => {
  assert.equal(trainSuspectModel(history(1)), null);
  assert.equal(blendWeight(null), 0);
  assert.equal(learnedAdjustment(null, [1, 1, 0, 1, 1, 0, 0, 0]), 0);
});

test('the model learns what this team confirmed: a deploy that already looked worse', () => {
  const m = trainSuspectModel(history(10))!;
  assert.equal(m.examples, 20);
  assert.equal(describeModel(m)[0]!.feature, 'deploy looked worse', 'the strongest clue it found');
  const [worse] = rankChanges(incident, [change('w', { verdict: { overall: 'worse' } })]);
  const [plain] = rankChanges(incident, [change('p', {})]);
  assert.ok(predictCause(m, worse!.features) > 0.8);
  assert.ok(predictCause(m, plain!.features) < 0.5);
});

test('with enough marks the learned ranking reorders suspects, and says so', () => {
  const list = [
    change('near-config', { kind: 'config', startedAt: new Date(t0.getTime() - 2 * MIN) }),
    change('older-worse-deploy', { startedAt: new Date(t0.getTime() - 50 * MIN), verdict: { overall: 'worse' } }),
  ];
  assert.equal(rankChanges(incident, list)[0]!.change.id, 'near-config', 'fixed ranking: nearest first');
  const few = trainSuspectModel(history(2))!;
  assert.equal(rankChanges(incident, list, { model: few })[0]!.change.id, 'near-config', 'four marks barely move it');
  const many = trainSuspectModel(history(15))!;
  assert.equal(blendWeight(many), 1.5);
  const ranked = rankChanges(incident, list, { model: many });
  assert.equal(ranked[0]!.change.id, 'older-worse-deploy');
  assert.match(ranked[0]!.reason, /ranked higher by what this team confirmed before/);
  assert.ok(ranked[0]!.learned > 0 && ranked[1]!.learned < 0);
});

test('training is deterministic: the same marks give the same weights', () => {
  assert.deepEqual(trainSuspectModel(history(6)), trainSuspectModel(history(6)));
});
