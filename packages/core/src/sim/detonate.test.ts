import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { detonate, detonationScript, judgeDetonation } from './detonate.ts';
import type { DetonationReport } from './detonate.ts';

const base: DetonationReport = {
  ran: true, engine: 'gvisor', exitCode: 0, durationMs: 100, stdout: '',
  dnsQueries: [], connects: [], filesCreated: [], filesModified: [], filesDeleted: [], canaryReads: [], canaryExfil: false,
};
const judge = (r: Partial<DetonationReport>) => judgeDetonation({ ...base, ...r });

test('detonationScript only picks up a run_script body', () => {
  assert.deepEqual(detonationScript('run_script', { interpreter: 'sh', script: 'echo hi' }), { interpreter: 'sh', script: 'echo hi' });
  assert.deepEqual(detonationScript('run_script', { script: 'echo hi' }), { interpreter: 'bash', script: 'echo hi' });
  assert.equal(detonationScript('ssh_exec', { command: 'ls' }), null);
});

test('reading a credential canary and reaching the network is exfiltration — forbidden', () => {
  const { observations } = judge({ canaryExfil: true, connects: [{ host: '203.0.113.5', port: 443 }] });
  const exfil = observations.find((o) => o.kind === 'exfil')!;
  assert.equal(exfil.raise?.tier, 'forbidden');
  assert.equal(exfil.raise?.category, 'exfiltration');
  // the network line is still shown, but not double-raised
  assert.equal(observations.find((o) => o.kind === 'net.connect')?.raise, undefined);
});

test('a canary read plus any outbound, even without proven exfil bytes, is forbidden', () => {
  const { observations } = judge({ canaryReads: ['/root/.ssh/id_rsa'], connects: [{ host: 'evil.test', port: 4444 }] });
  assert.equal(observations.find((o) => o.kind === 'exfil')?.raise?.tier, 'forbidden');
});

test('an outbound connection alone is high: the script reaches out when its text did not say so', () => {
  const { observations } = judge({ connects: [{ host: '198.51.100.9', port: 4444, preview: 'sh\n' }] });
  const net = observations.find((o) => o.kind === 'net.connect')!;
  assert.equal(net.raise?.tier, 'high');
  assert.match(net.detail, /198\.51\.100\.9:4444/);
});

test('writing a persistence location is high', () => {
  for (const p of ['/root/.ssh/authorized_keys', '/etc/cron.d/backup', '/etc/systemd/system/x.service', '/etc/ld.so.preload', '/home/ops/.bashrc']) {
    const { observations } = judge({ filesCreated: [p] });
    assert.equal(observations.find((o) => o.kind === 'persistence')?.raise?.tier, 'high', p);
  }
  // an ordinary write is informational only
  assert.equal(judge({ filesCreated: ['/opt/app/config.yaml'] }).observations[0]!.raise, undefined);
});

test('deleting logs or history is flagged as anti-forensics', () => {
  const { observations } = judge({ filesDeleted: ['/var/log/auth.log', '/home/ops/.bash_history'] });
  assert.equal(observations.find((o) => o.kind === 'anti-forensics')?.raise?.category, 'anti-forensics');
});

test('a coin miner is recognised from its output or a mining-pool lookup', () => {
  assert.equal(judge({ stdout: 'starting xmrig 6.21...' }).observations.find((o) => o.kind === 'miner')?.raise?.tier, 'high');
  assert.equal(judge({ dnsQueries: ['pool.supportxmr.com'] }).observations.find((o) => o.kind === 'miner')?.raise?.tier, 'high');
});

test('a clean run is informational, never a raise, and always names its blind spots', () => {
  const { observations, blindSpots } = judge({ exitCode: 0, filesModified: ['/tmp/x'] });
  assert.ok(observations.every((o) => !o.raise));
  assert.ok(blindSpots.some((b) => /not proof of safety/.test(b)));
  const empty = judge({});
  assert.equal(empty.observations[0]!.kind, 'clean');
});

test('a script that was not detonated adds nothing (fail closed)', () => {
  const { observations, blindSpots } = judge({ ran: false, note: 'no sandbox image' });
  assert.deepEqual(observations, []);
  assert.deepEqual(blindSpots, ['no sandbox image']);
});

// --- client against a fake detonator (the dumb runner returns raw outputs) ----

let server: Server;
let reply: { raw: Record<string, unknown> } | { error: string } | { status: number };
before(async () => {
  server = createServer((_req, res) => {
    if ('status' in reply) return res.writeHead(reply.status).end('err');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.SUPOPS_DETONATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); delete process.env.SUPOPS_DETONATOR_URL; });
const run = () => detonate({ interpreter: 'bash', script: 'echo hi', signal: AbortSignal.timeout(5000) });

test('the client detonates, assembles the raw outputs, judges, and surfaces a forbidden verdict', async () => {
  reply = { raw: { engine: 'gvisor', exitCode: 0, durationMs: 90, stdout: 'done', dockerDiff: 'A /tmp/x', dnsLog: '', tcpLog: '203.0.113.5:443 CANARY-9f8e7d6c5b4a', canaryOpened: ['/root/.ssh/id_rsa'], canaryTokens: ['CANARY-9f8e7d6c5b4a'] } };
  const r = await run();
  assert.equal(r.status, 'observed');
  assert.equal(r.simulator, 'detonate/gvisor');
  assert.ok(r.contributions.some((c) => c.stage === 'observed' && c.tier === 'forbidden'));
  assert.ok(r.blindSpots?.length);
});

test('fail closed: no detonator configured adds nothing', async () => {
  const saved = process.env.SUPOPS_DETONATOR_URL;
  delete process.env.SUPOPS_DETONATOR_URL;
  const r = await run();
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.contributions, []);
  process.env.SUPOPS_DETONATOR_URL = saved;
});

test('a detonator error never raises and never throws', async () => {
  reply = { status: 500 };
  const r = await run();
  assert.equal(r.status, 'error');
  assert.deepEqual(r.contributions, []);
});

test('a run the sandbox could not perform is unavailable, not observed', async () => {
  reply = { error: 'docker not reachable' };
  const r = await run();
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.contributions, []);
});
