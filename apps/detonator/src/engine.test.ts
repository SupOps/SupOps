import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRunArgs, validate, type SandboxSpec } from './engine.ts';

test('validate accepts a clean request and clamps the timeout', () => {
  const v = validate({ interpreter: 'bash', script: 'echo hi', timeoutSec: 999 });
  assert.ok(v.ok && v.req.timeoutSec === 120);
  const low = validate({ interpreter: 'sh', script: 'x', timeoutSec: 1 });
  assert.ok(low.ok && low.req.timeoutSec === 5);
});

test('validate rejects a bad interpreter, a missing script, and an oversize script', () => {
  assert.equal(validate({ interpreter: 'ruby', script: 'x' }).ok, false);
  assert.equal(validate({ interpreter: 'bash' }).ok, false);
  assert.equal(validate({ interpreter: 'bash', script: 'a'.repeat(65 * 1024) }).ok, false);
  assert.equal(validate(null).ok, false);
});

const spec: SandboxSpec = { image: 'sandbox', runsc: true, network: 'sinks', scriptPath: '/tmp/d/script', interpreter: 'bash', memoryMb: 512, pidsLimit: 256, timeoutSec: 20, name: 'detonate-abc' };

test('the docker run args are locked down: no caps, no new privileges, read-only, gVisor, no host network', () => {
  const a = buildRunArgs(spec);
  const has = (...xs: string[]) => xs.every((x) => a.includes(x));
  assert.ok(has('--cap-drop', 'ALL'));
  assert.ok(has('--security-opt', 'no-new-privileges'));
  assert.ok(has('--read-only'));
  assert.ok(has('--pids-limit', '256'));
  assert.ok(has('--memory', '512m', '--memory-swap', '512m'));
  assert.ok(has('--runtime', 'runsc'), 'gVisor when available');
  assert.ok(has('--network', 'sinks'), 'only the sink network, never host');
  assert.ok(a.includes('/tmp/d/script:/script:ro'), 'the script is mounted read-only');
  // the script runs under a hard timeout, as the chosen interpreter
  const i = a.indexOf('timeout');
  assert.deepEqual(a.slice(i, i + 6), ['timeout', '-k', '5', '20', 'bash', '/script']);
  assert.ok(!a.includes('--privileged') && !a.includes('host'));
});

test('without gVisor the runtime flag is omitted (runc with the other locks still applies)', () => {
  const a = buildRunArgs({ ...spec, runsc: false });
  assert.ok(!a.includes('runsc'));
  assert.ok(a.includes('--cap-drop'));
});
