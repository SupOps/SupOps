import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHADOW_BEGIN, SHADOW_END, buildShadowHelper, buildShadowProbe, judgeShadow, notRunShadow, parseShadowProbe, parseShadowReport, parseStrace } from './shadow.ts';
import type { ShadowReport } from './shadow.ts';
import { contributionsFrom } from './judge.ts';

const r = (o: Partial<ShadowReport> = {}): ShadowReport => ({ ran: true, exit: 0, filesWritten: [], filesDeleted: [], connects: [], dnsPorts: 0, execs: [], privilege: [], ...o });

test('the capability probe reads bwrap / overlay / strace support', () => {
  assert.match(buildShadowProbe(), /command -v bwrap/);
  assert.deepEqual(parseShadowProbe('bwrap=1\nstrace=0\noverlay=1'), { bwrap: true, strace: false, overlay: true });
  assert.deepEqual(parseShadowProbe('bwrap=0\nstrace=0\noverlay=0'), { bwrap: false, strace: false, overlay: false });
});

test('the helper carries the command as base64, uses an ephemeral overlay, and cleans up', () => {
  const h = buildShadowHelper('rm -rf /var/lib/postgresql/data');
  assert.doesNotMatch(h, /rm -rf \/var\/lib/, 'the command never appears in the clear');
  assert.match(h, /base64 -d \| \/bin\/sh$/);
  const inner = Buffer.from(/printf %s '([A-Za-z0-9+/=]+)'/.exec(h)![1]!, 'base64').toString('utf8');
  assert.match(inner, /bwrap --unshare-all/);
  assert.match(inner, /--overlay-src \/ --tmp-overlay \//, 'ephemeral tmpfs upper: the real / is never written');
  assert.match(inner, /strace -f -qq/);
  assert.match(inner, /rm -rf "\$T"/);
});

test('strace yields the files written and deleted, the connections, execs and privilege', () => {
  const text = [
    '1234 openat(AT_FDCWD, "/etc/cron.d/backdoor", O_WRONLY|O_CREAT|O_TRUNC, 0644) = 3',
    '1234 openat(AT_FDCWD, "/etc/motd", O_RDONLY) = 4',
    '1234 unlink("/var/log/auth.log") = 0',
    '1234 rename("/data/db", "/data/db.bak") = 0',
    '1234 connect(5, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("203.0.113.5")}, 16) = 0',
    '1234 sendto(6, "", 0, 0, {sa_family=AF_INET, sin_port=htons(53), sin_addr=inet_addr("198.51.100.1")}, 16) = 0',
    '1234 execve("/usr/bin/curl", ["curl"], 0x7ff) = 0',
    '1234 setuid(0) = 0',
    '1234 openat(AT_FDCWD, "/fail", O_WRONLY) = -1 ENOENT',
  ].join('\n');
  const p = parseStrace(text);
  assert.deepEqual(p.filesWritten.sort(), ['/data/db.bak', '/etc/cron.d/backdoor']);
  assert.deepEqual(p.filesDeleted.sort(), ['/data/db', '/var/log/auth.log']);
  assert.deepEqual(p.connects, [{ host: '203.0.113.5', port: 443 }]);
  assert.equal(p.dnsPorts, 1);
  assert.deepEqual(p.execs, ['/usr/bin/curl']);
  assert.deepEqual(p.privilege, ['setuid']);
  // a read-only open is not a write; a failed syscall is ignored
  assert.ok(!p.filesWritten.includes('/etc/motd') && !p.filesWritten.includes('/fail'));
});

test('the report is parsed out of the markers, decoding the embedded strace', () => {
  const strace = Buffer.from('openat(AT_FDCWD, "/root/.ssh/authorized_keys", O_WRONLY|O_CREAT, 0600) = 3').toString('base64');
  const stdout = `pty noise\n${SHADOW_BEGIN}{"ran":true,"exit":0,"strace":"${strace}"}${SHADOW_END}\ntrailing`;
  const report = parseShadowReport(stdout);
  assert.equal(report.ran, true);
  assert.deepEqual(report.filesWritten, ['/root/.ssh/authorized_keys']);
});

test('a missing, malformed, or trace-less report fails closed', () => {
  assert.equal(parseShadowReport('nothing here').ran, false);
  assert.equal(parseShadowReport(`${SHADOW_BEGIN}not json${SHADOW_END}`).ran, false);
  assert.equal(parseShadowReport(`${SHADOW_BEGIN}{"ran":false,"note":"no overlay"}${SHADOW_END}`).ran, false);
  assert.equal(parseShadowReport(`${SHADOW_BEGIN}{"ran":true,"exit":0}${SHADOW_END}`).ran, false, 'ran but no trace to read');
});

test('the judge raises on destruction, persistence, anti-forensics, network and privilege — all raise-only', () => {
  assert.equal(judgeShadow(r({ filesDeleted: ['/var/lib/postgresql/data/base/1'] })).observations.find((o) => o.kind === 'file.delete')?.raise?.category, 'destruction');
  assert.equal(judgeShadow(r({ filesWritten: ['/root/.ssh/authorized_keys'] })).observations.find((o) => o.kind === 'persistence')?.raise?.tier, 'high');
  assert.equal(judgeShadow(r({ filesDeleted: ['/var/log/auth.log'] })).observations.find((o) => o.kind === 'anti-forensics')?.raise?.category, 'anti-forensics');
  assert.equal(judgeShadow(r({ connects: [{ host: '203.0.113.5', port: 443 }] })).observations.find((o) => o.kind === 'net.connect')?.raise?.category, 'exfiltration');
  assert.equal(judgeShadow(r({ privilege: ['capset'] })).observations.find((o) => o.kind === 'privilege')?.raise?.tier, 'high');
  const c = contributionsFrom('shadow', judgeShadow(r({ filesDeleted: ['/var/lib/x'] })).observations);
  assert.ok(c.length && c.every((x) => x.stage === 'observed'));
});

test('transient paths are ignored, an ordinary write is informational, and a clean run says so', () => {
  assert.equal(judgeShadow(r({ filesWritten: ['/tmp/scratch', '/proc/self/oom_score'] })).observations[0]!.kind, 'clean', 'tmp/proc writes are noise');
  assert.equal(judgeShadow(r({ filesWritten: ['/etc/nginx/nginx.conf'] })).observations[0]!.raise, undefined);
  assert.equal(judgeShadow(r()).observations[0]!.kind, 'clean');
  assert.ok(judgeShadow(notRunShadow('x')).observations.length === 0);
});
