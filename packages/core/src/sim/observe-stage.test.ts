import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RiskAssessment, RiskContribution } from '@supops/shared';
import { withObservations } from '../risk/index.ts';

const base: RiskAssessment = {
  tier: 'medium',
  contributions: [{ stage: 'arguments', tier: 'medium', reason: 'apt-get remove' }],
  decision: 'approve',
  ceiling: 'low',
  ceilingReason: 'this project acts alone only up to low',
};
const obs = (tier: RiskContribution['tier']): RiskContribution => ({ stage: 'observed', tier, ruleId: 'sim.x', reason: 'simulated' });

test('observations only raise: a lower or equal observed tier changes nothing', () => {
  assert.equal(withObservations(base, [obs('read_only')]), base);
  assert.equal(withObservations(base, [obs('low')]).tier, 'medium', 'below the current tier: unchanged');
  assert.equal(withObservations(base, []).tier, 'medium');
});

test('a higher observed tier raises the tier and re-derives the decision against the same ceiling', () => {
  const r = withObservations(base, [obs('high')]);
  assert.equal(r.tier, 'high');
  assert.equal(r.decision, 'approve'); // still above the low ceiling, so still needs a person
  assert.equal(r.contributions.length, 2);
  assert.equal(r.ceiling, 'low', 'the ceiling is unchanged');
});

test('an observed forbidden blocks the action outright', () => {
  const autoBase: RiskAssessment = { ...base, tier: 'low', decision: 'auto', contributions: [{ stage: 'arguments', tier: 'low', reason: 'x' }] };
  const r = withObservations(autoBase, [obs('forbidden')]);
  assert.equal(r.tier, 'forbidden');
  assert.equal(r.decision, 'block');
});

test('an auto action stays auto only while nothing raises it past the ceiling', () => {
  const autoBase: RiskAssessment = { tier: 'read_only', decision: 'auto', ceiling: 'medium', contributions: [{ stage: 'baseline', tier: 'read_only', reason: 'x' }] };
  assert.equal(withObservations(autoBase, [obs('low')]).decision, 'auto');
  assert.equal(withObservations(autoBase, [obs('high')]).decision, 'approve');
});
