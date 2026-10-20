import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchers } from '@supops/shared';
import { previewRule, renderTitle, ruleFor, ruleGroupKey, type CorrelationRule } from './rules.ts';

const m = (s: string) => {
  const r = parseMatchers(s);
  if (!r.ok) throw new Error(r.error);
  return r.matchers;
};
const rule = (over: Partial<CorrelationRule> = {}): CorrelationRule => ({
  id: 'r1', name: 'By service', matchers: m('env="prod"'), groupBy: ['service', 'cluster'], windowMin: 10, threshold: 1, resolveOn: 'all', titleTemplate: '', ...over,
});
const MIN = 60_000;

test('the first matching rule applies; group keys come from the group-by labels', () => {
  const rules = [rule({ id: 'a', matchers: m('team="db"') }), rule({ id: 'b' })];
  assert.equal(ruleFor(rules, { team: 'db', env: 'prod' })?.id, 'a');
  assert.equal(ruleFor(rules, { env: 'prod' })?.id, 'b');
  assert.equal(ruleFor(rules, { env: 'dev' }), null);
  assert.equal(ruleFor([rule({ matchers: [] })], { env: 'prod' }), null, 'a rule with no matchers matches nothing');
  const r = rule();
  assert.equal(ruleGroupKey(r, { service: 'api', cluster: 'eu' }), ruleGroupKey(r, { service: 'api', cluster: 'eu', pod: 'x' }));
  assert.notEqual(ruleGroupKey(r, { service: 'api', cluster: 'eu' }), ruleGroupKey(r, { service: 'api', cluster: 'us' }));
});

test('titles from a template list the values across the alerts', () => {
  assert.equal(renderTitle('{{alertname}} in {{namespace}}', [{ alertname: 'PodCrash', namespace: 'shop' }]), 'PodCrash in shop');
  assert.equal(renderTitle('Errors on {{host}}', [{ host: 'a' }, { host: 'b' }, { host: 'a' }]), 'Errors on a, b');
  assert.equal(renderTitle('Errors on {{host}}', [{ host: '1' }, { host: '2' }, { host: '3' }, { host: '4' }]), 'Errors on 1, 2 and 2 more');
  assert.equal(renderTitle('{{missing}} down', [{ host: 'x' }]), '? down');
});

test('the dry run replays alerts in time: window, groups and threshold', () => {
  const t = 1_000 * MIN;
  const alerts = [
    { title: 'A', labels: { alertname: 'HighLatency', env: 'prod', service: 'api', cluster: 'eu' }, at: t },
    { title: 'B', labels: { alertname: 'ErrorRate', env: 'prod', service: 'api', cluster: 'eu' }, at: t + 5 * MIN },
    { title: 'C', labels: { alertname: 'HighLatency', env: 'prod', service: 'web', cluster: 'eu' }, at: t + 6 * MIN },
    { title: 'D', labels: { alertname: 'HighLatency', env: 'prod', service: 'api', cluster: 'eu' }, at: t + 40 * MIN }, // past the window: a new group
    { title: 'E', labels: { alertname: 'HighLatency', env: 'dev', service: 'api', cluster: 'eu' }, at: t + 7 * MIN }, // not matched
  ];
  const p = previewRule(rule({ threshold: 2, titleTemplate: '{{service}} trouble ({{alertname}})' }), alerts);
  assert.equal(p.matched, 4);
  assert.deepEqual(p.groups.map((g) => [g.title, g.alerts, g.visible]), [
    ['api trouble (HighLatency, ErrorRate)', 2, true],
    ['web trouble (HighLatency)', 1, false],
    ['api trouble (HighLatency)', 1, false],
  ]);
});
