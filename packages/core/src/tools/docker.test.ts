import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dockerCommand, dockerTool, splitOutput, summariseEvents, summariseInspect, summarisePs, summariseStats } from './docker.ts';

const target = { id: 't', slug: 'web-1', kind: 'ssh', env: 'staging', sensitivity: 1, description: null, config: { kind: 'ssh', host: 'web-1.example.test', port: 22, user: 'ops', sudo: false }, credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null } as never;
const tier = (a: Record<string, unknown>) => dockerTool.classifyArgs!({ target: 'web-1', ...a } as never, target).map((c) => c.tier);

test('reads are read-only; restart, start and stop are changes classified like the same command in ssh_exec', () => {
  for (const operation of ['ps', 'inspect', 'logs', 'stats', 'events']) assert.deepEqual(tier({ operation, container: 'api' }), ['read_only'], operation);
  for (const operation of ['restart', 'start', 'stop']) assert.deepEqual(tier({ operation, container: 'api' }), ['medium'], operation);
});

test('commands are fixed and quoted; a container name cannot carry another command', () => {
  assert.equal(dockerCommand({ target: 't', operation: 'logs', container: 'api', tail: 50, since: '30m' }), 'docker logs --timestamps --tail 50 --since 30m api');
  assert.equal(dockerCommand({ target: 't', operation: 'events', container: 'api' }), "docker events --since 1h --until 0s --filter type=container --filter container=api --format '{{json .}}'");
  assert.match(dockerCommand({ target: 't', operation: 'inspect', container: 'api' }), /--format '.*"EnvNames":\[\{\{range \$i, \$e := \.Config\.Env\}\}.*\(split \$e "="\).*' api$/);
  const bad = (a: Record<string, unknown>) => dockerTool.argsSchema.safeParse({ target: 't', ...a }).success;
  assert.equal(bad({ operation: 'logs', container: 'api; rm -rf /' }), false);
  assert.equal(bad({ operation: 'logs', container: '-v' }), false, 'an option is not a container');
  assert.equal(bad({ operation: 'inspect' }), false, 'inspect needs a container');
  assert.equal(bad({ operation: 'logs', container: 'api', since: '$(id)' }), false);
  assert.equal(bad({ operation: 'ps' }), true);
});

test('ps puts trouble first', () => {
  const out = summarisePs([
    JSON.stringify({ Names: 'web', Image: 'nginx:1.27', Status: 'Up 3 days', Ports: '0.0.0.0:80->80/tcp' }),
    JSON.stringify({ Names: 'worker', Image: 'app:4.2', Status: 'Restarting (137) 5 seconds ago' }),
    JSON.stringify({ Names: 'old', Image: 'app:4.1', Status: 'Exited (0) 2 weeks ago' }),
    'not json',
  ].join('\n'));
  assert.deepEqual(out.split('\n').slice(1).map((l) => l.split(' · ')[0]), ['worker', 'web', 'old']);
});

test('inspect says why it stopped: OOM kill, exit code, health; environment names only', () => {
  const now = Date.UTC(2026, 9, 18, 12);
  const out = summariseInspect(
    JSON.stringify({
      Name: '/worker', Image: 'app:4.2', State: { Status: 'restarting', Restarting: true, OOMKilled: true, ExitCode: 137, StartedAt: '2026-10-18T11:58:00Z', FinishedAt: '2026-10-18T11:59:30Z', Health: { Status: 'unhealthy', FailingStreak: 3, Log: [{ ExitCode: 1, Output: 'curl: (7) Failed to connect' }] } },
      RestartCount: 14, RestartPolicy: { Name: 'always' }, Memory: 536870912, NanoCpus: 1e9, Mounts: [{ Source: '/srv/data', Destination: '/data', RW: true }], Ports: { '8080/tcp': [{ HostIp: '', HostPort: '8080' }] }, Networks: { backend: {} }, EnvNames: ['DATABASE_URL', 'LOG_LEVEL'],
    }),
    now,
  );
  assert.match(out, /^worker \(app:4\.2\)/);
  assert.match(out, /State: restarting \(restarting\); started 2m ago; last stopped 1m ago/);
  assert.match(out, /Last exit: code 137 -- KILLED FOR RUNNING OUT OF MEMORY \(OOM\)/);
  assert.match(out, /Restarts: 14; restart policy always/);
  assert.match(out, /Limits: memory 512 MiB; CPU 1 cores/);
  assert.match(out, /Health: unhealthy, failing 3 checks in a row; last check exit 1: curl: \(7\)/);
  assert.match(out, /Environment variables \(names only\): DATABASE_URL, LOG_LEVEL/);
  assert.match(out, /Ports: \*:8080->8080\/tcp/);
});

test('stats sorts by memory; events keep deaths, OOM kills and health changes', () => {
  const s = summariseStats([JSON.stringify({ Name: 'a', CPUPerc: '1%', MemUsage: '10MiB / 1GiB', MemPerc: '1.0%', NetIO: '', BlockIO: '', PIDs: '3' }), JSON.stringify({ Name: 'b', CPUPerc: '90%', MemUsage: '900MiB / 1GiB', MemPerc: '88.0%', NetIO: '', BlockIO: '', PIDs: '40' })].join('\n'));
  assert.match(s.split('\n')[1]!, /^b · CPU 90%/);
  const t = Date.UTC(2026, 9, 18, 11) * 1_000_000;
  const e = summariseEvents([
    JSON.stringify({ Action: 'oom', id: 'abc', timeNano: t, Actor: { Attributes: { name: 'worker' } } }),
    JSON.stringify({ Action: 'die', id: 'abc', timeNano: t + 1e6, Actor: { Attributes: { name: 'worker', exitCode: '137' } } }),
    JSON.stringify({ Action: 'exec_start: sh', id: 'abc', timeNano: t + 2e6, Actor: { Attributes: { name: 'worker' } } }),
    JSON.stringify({ Action: 'health_status: unhealthy', id: 'abc', timeNano: t + 3e6, Actor: { Attributes: { name: 'worker' } } }),
  ].join('\n'));
  assert.match(e, /^3 events: 1 oom, 1 die, 1 health_status/);
  assert.match(e, /worker die \(exit 137\)/);
  assert.doesNotMatch(e, /exec_start/);
  assert.equal(summariseEvents(''), 'No container starts, stops, deaths, OOM kills or health changes in that time.');
});

test('ssh output splits into stdout and stderr', () => {
  assert.deepEqual(splitOutput('[exit 1]\n\n[stderr]\npermission denied'), { stdout: '', stderr: 'permission denied' });
  assert.deepEqual(splitOutput('[exit 0]\n{"a":1}'), { stdout: '{"a":1}', stderr: '' });
});
