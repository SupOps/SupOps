import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogueLabels, extractLabels, patternProblem, type ExtractionRule } from './enrich.ts';

const r = (over: Partial<ExtractionRule>): ExtractionRule => ({ id: 'r', matchers: [], field: 'summary', labelName: null, pattern: '', ...over });

test('named groups become labels; the source and earlier rules always win', () => {
  const alert = { title: 'Job failed', summary: 'job=nightly-backup exit=137 region=eu-1', labels: { alertname: 'JobFailed', region: 'us-2' } };
  const out = extractLabels(
    [r({ id: 'a', pattern: 'job=(?<job>[\\w-]+) exit=(?<exit_code>\\d+)' }), r({ id: 'b', pattern: 'region=(?<region>[\\w-]+)' }), r({ id: 'c', pattern: 'exit=(?<exit_code>\\d+)' })],
    alert,
    alert.labels,
  );
  assert.deepEqual(out.added, { job: 'nightly-backup', exit_code: '137' });
  assert.equal(out.labels.region, 'us-2', 'the source said us-2: kept');
  assert.deepEqual(out.byRule.map((b) => [b.id, Object.keys(b.added).length]), [['a', 2], ['b', 0], ['c', 0]]);
});

test('a rule only runs where its matchers hold, on the field it names', () => {
  const alert = { title: 'Disk on db-7 at 93%', summary: null, labels: { alertname: 'Disk', team: 'storage' } };
  const rules = [
    r({ id: 'only-web', matchers: [{ name: 'team', op: '=', value: 'web' }], field: 'title', pattern: 'on (?<host>[\\w-]+)' }),
    r({ id: 'title', field: 'title', pattern: 'at (?<used_pct>\\d+)%' }),
    r({ id: 'label', field: 'label', labelName: 'alertname', pattern: '(?<kind>Disk|Cpu)' }),
  ];
  const out = extractLabels(rules, alert, alert.labels);
  assert.deepEqual(out.added, { used_pct: '93', kind: 'Disk' });
  assert.equal(out.byRule[0]!.seen, false);
});

test('patterns are checked when saved: named group required, nothing that can run forever', () => {
  assert.match(patternProblem('exit=(\\d+)')!, /named group/);
  assert.match(patternProblem('(?<x>a+)+')!, /forever/);
  assert.equal(patternProblem('exit=(?<code>\\d+)'), null);
});

test('the catalogue adds owner, team and runbook, unless the alert already says', () => {
  assert.deepEqual(catalogueLabels({ owner: 'Ana', team: 'payments', runbook: 'https://wiki.example.com/rb', port: '8080' }, { team: 'core' }), { owner: 'Ana', runbook_url: 'https://wiki.example.com/rb' });
  assert.deepEqual(catalogueLabels({ owner: '  ' }, {}), {}, 'blank fields are not labels');
});
