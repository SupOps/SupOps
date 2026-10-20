import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertMatchLabels, formatMatchers, matchesAll, parseMatchers, unsafeRegex } from './matchers.ts';

const parse = (s: string) => {
  const r = parseMatchers(s);
  if (!r.ok) throw new Error(r.error);
  return r.matchers;
};

test('the four Alertmanager operators, quoted and bare values, optional braces', () => {
  assert.deepEqual(parse('{env="prod", service=~"api|web", severity!=info, team!~"core.*"}'), [
    { name: 'env', op: '=', value: 'prod' },
    { name: 'service', op: '=~', value: 'api|web' },
    { name: 'severity', op: '!=', value: 'info' },
    { name: 'team', op: '!~', value: 'core.*' },
  ]);
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse('  '), []);
  assert.deepEqual(parse('msg="say \\"hi\\", then a\\\\b"'), [{ name: 'msg', op: '=', value: 'say "hi", then a\\b' }]);
});

test('matching: regex is anchored, a missing label is the empty string', () => {
  const ms = parse('env="prod", service=~"api|web"');
  assert.equal(matchesAll(ms, { env: 'prod', service: 'api' }), true);
  assert.equal(matchesAll(ms, { env: 'prod', service: 'api-gateway' }), false, 'anchored at both ends');
  assert.equal(matchesAll(ms, { env: 'staging', service: 'web' }), false);
  assert.equal(matchesAll(parse('team=""'), { env: 'prod' }), true, 'no team label counts as empty');
  assert.equal(matchesAll(parse('team!=""'), { env: 'prod' }), false);
  assert.equal(matchesAll([], { anything: 'x' }), true);
});

test('round trip through formatMatchers', () => {
  const text = 'a="1", b=~"x|y", c!="say \\"hi\\""';
  assert.deepEqual(parse(formatMatchers(parse(text))), parse(text));
});

test('mistakes are explained, not guessed at', () => {
  for (const [bad, why] of [
    ['env', /expected =/],
    ['env="prod" team="x"', /expected a comma/],
    ['env="prod', /closing quote/],
    ['="x"', /label name/],
    ['9env="x"', /not a valid label name/],
    ['svc=~"(a"', /not a valid regular expression/],
  ] as const) {
    const r = parseMatchers(bad);
    assert.equal(r.ok, false, bad);
    assert.match((r as { error: string }).error, why, bad);
  }
});

test('patterns that can take forever are refused when saved', () => {
  for (const evil of ['(a+)+', '(\\w*)*b', '(x{2,})+', '(a|aa)*(b+)+', '(.)\\1', '(?=a)a', '(a|aa)*', '(x|xy)+z']) {
    assert.ok(unsafeRegex(evil), evil);
    assert.equal(parseMatchers(`x=~"${evil.replace(/\\/g, '\\\\')}"`).ok, false, evil);
  }
  for (const fine of ['api|web', 'db-[0-9]+', '.*prod.*', '(api|web)-[a-z]+', 'node-(1|2|3)']) assert.equal(unsafeRegex(fine), null, fine);
});

test('alerts are matched on their labels plus alertname, severity and source', () => {
  const l = alertMatchLabels({ title: 'DiskFull', severity: 'critical', source: 'alertmanager', labels: { instance: 'db-1' } });
  assert.deepEqual(l, { instance: 'db-1', alertname: 'DiskFull', severity: 'critical', source: 'alertmanager' });
  assert.equal(alertMatchLabels({ title: 'X', severity: 'warning', labels: { alertname: 'Real', severity: 'page' } }).alertname, 'Real');
});
