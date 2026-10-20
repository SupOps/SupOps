import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertsMatched, parseAlertSpec } from './alert-match.ts';

const disk = { title: 'DiskFilling', severity: 'warning', labels: { alertname: 'DiskFilling', env: 'prod', instance: 'web-1:9100' } };
const cpu = { title: 'High CPU on api-2', severity: 'critical', labels: { env: 'staging' } };

test('alert names match the alertname or title, case-insensitive, with * as a wildcard', () => {
  assert.equal(alertsMatched('diskfilling', [disk, cpu]), 1);
  assert.equal(alertsMatched('Disk*, High CPU*', [disk, cpu]), 2);
  assert.equal(alertsMatched('Memory*', [disk, cpu]), 0);
  assert.equal(alertsMatched('Disk.Filling', [disk]), 0, 'a dot is a dot, not any character');
});

test('Alertmanager matchers use the alert labels, with alertname and severity filled in', () => {
  assert.equal(alertsMatched('alertname=~"Disk.*", env="prod"', [disk, cpu]), 1);
  assert.equal(alertsMatched('severity="critical"', [disk, cpu]), 1);
  assert.equal(alertsMatched('env="dev"', [disk, cpu]), 0);
});

test('a bad spec is refused with a reason, and never matches', () => {
  const bad = parseAlertSpec('alertname=~"("');
  assert.equal(bad.ok, false);
  assert.equal(parseAlertSpec('  ').ok, false);
  assert.equal(alertsMatched('alertname=~"("', [disk]), 0);
  assert.equal(alertsMatched(null, [disk]), 0);
});
