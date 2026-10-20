import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleReport, notRun, parseDns, parseDockerDiff, parseTcp } from './detonate-report.ts';
import { judgeDetonation } from './detonate.ts';

test('docker diff is split into created/modified/deleted, dropping container noise', () => {
  const diff = `A /root/.ssh/authorized_keys
C /etc/passwd
D /var/log/auth.log
A /tmp/scratch
C /proc/1/stat
A /opt/app/new.conf`;
  const f = parseDockerDiff(diff);
  assert.deepEqual(f.filesCreated, ['/root/.ssh/authorized_keys', '/opt/app/new.conf']);
  assert.deepEqual(f.filesModified, ['/etc/passwd']);
  assert.deepEqual(f.filesDeleted, ['/var/log/auth.log']);
});

test('DNS and TCP sink logs are parsed into names and connection attempts', () => {
  assert.deepEqual(parseDns('A example.com\nquery AAAA pool.supportxmr.com.\nnonsense line'), ['example.com', 'pool.supportxmr.com']);
  const c = parseTcp('203.0.113.5:443 GET /steal\n198.51.100.9:4444 sh\ngarbage');
  assert.deepEqual(c, [{ host: '203.0.113.5', port: 443, preview: 'GET /steal' }, { host: '198.51.100.9', port: 4444, preview: 'sh' }]);
});

test('a canary marker seen on the wire is detected as exfiltration', () => {
  const raw = {
    engine: 'gvisor' as const, exitCode: 0, durationMs: 120, stdout: 'done',
    dockerDiff: 'A /tmp/x', dnsLog: '', tcpLog: '203.0.113.5:443 CANARY-9f8e7d6c5b4a',
    canaryOpened: ['/root/.ssh/id_rsa'], canaryTokens: ['CANARY-9f8e7d6c5b4a'],
  };
  const report = assembleReport(raw);
  assert.equal(report.canaryExfil, true);
  assert.deepEqual(report.canaryReads, ['/root/.ssh/id_rsa']);
  // and the judge turns that into a forbidden verdict
  assert.equal(judgeDetonation(report).observations.find((o) => o.kind === 'exfil')?.raise?.tier, 'forbidden');
});

test('no canary token on the wire means no exfil flag, even if a canary was opened', () => {
  const report = assembleReport({ engine: 'runc', exitCode: 0, durationMs: 10, stdout: '', dockerDiff: '', dnsLog: '', tcpLog: '', canaryOpened: ['/root/.ssh/id_rsa'], canaryTokens: ['CANARY-abc123'] });
  assert.equal(report.canaryExfil, false);
});

test('notRun yields a fail-closed report the judge adds nothing from', () => {
  const r = notRun('docker not reachable');
  assert.equal(r.ran, false);
  assert.deepEqual(judgeDetonation(r).observations, []);
});
