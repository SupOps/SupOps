import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aptAdapter, dnfAdapter, kubectlAdapter, planKubectlDryRun, planSshDryRun, systemctlAdapter } from './adapters.ts';
import { contributionsFrom } from './judge.ts';

test('apt: a plain remove previews as a simulation and lists what would go', () => {
  assert.equal(aptAdapter.plan('apt-get', ['remove', 'nginx'], 'apt-get remove nginx'), 'apt-get -s -o Debug::NoLocking=true remove nginx');
  assert.equal(aptAdapter.plan('apt', ['install', '-y', 'htop'], 'apt install -y htop'), 'apt-get -s -o Debug::NoLocking=true install htop');
  assert.equal(aptAdapter.plan('ls', ['-la'], 'ls -la'), null);
  const out = `NOTE: This is only a simulation!
The following packages will be REMOVED:
  nginx nginx-common
0 upgraded, 0 newly installed, 2 to remove and 0 not upgraded.
Remv nginx [1.24.0-1]
Remv nginx-common [1.24.0-1]`;
  const { observations } = aptAdapter.interpret(out, 0);
  assert.equal(observations.length, 1);
  assert.match(observations[0]!.detail, /would remove 2 packages: nginx, nginx-common/);
  assert.equal(observations[0]!.raise, undefined, 'removing nginx is ordinary; no raise');
});

test('apt: a remove that cascades to openssh-server is a lockout the command text never showed', () => {
  const out = `The following packages will be REMOVED:
  libpam-modules openssh-server openssh-sftp-server
Remv openssh-server [1:8.9p1]
Remv openssh-sftp-server [1:8.9p1]
Remv libpam-modules [1.4.0]`;
  const { observations } = aptAdapter.interpret(out, 0);
  assert.match(observations[0]!.detail, /including openssh-server/);
  assert.equal(observations[0]!.raise?.tier, 'high');
  assert.equal(observations[0]!.raise?.category, 'lockout');
});

test('apt: a huge cascade is flagged even without an essential package', () => {
  const names = Array.from({ length: 30 }, (_, i) => `pkg${i}`);
  const out = `The following packages will be REMOVED:\n  ${names.join(' ')}\n`;
  const { observations } = aptAdapter.interpret(out, 0);
  assert.equal(observations[0]!.raise?.tier, 'high');
  assert.equal(observations[0]!.raise?.category, 'availability');
});

test('dnf: removing and installing packages are read from the transaction sections', () => {
  assert.equal(dnfAdapter.plan('dnf', ['remove', 'httpd'], 'dnf remove httpd'), 'dnf --assumeno remove httpd');
  const out = `Dependencies resolved.
Removing:
 httpd         x86_64   2.4.57   @updates   1.4 M
Removing dependent packages:
 httpd-tools   x86_64   2.4.57   @updates   120 k
Transaction Summary
Remove  2 Packages
Operation aborted.`;
  const { observations } = dnfAdapter.interpret(out, 1);
  assert.match(observations[0]!.detail, /would remove 2 packages: httpd, httpd-tools/);
});

test('systemctl: a restart previews the reverse-dependency blast radius', () => {
  assert.equal(systemctlAdapter.plan('systemctl', ['restart', 'nginx'], 'systemctl restart nginx'), 'systemctl list-dependencies --reverse --no-pager --plain nginx');
  assert.equal(systemctlAdapter.plan('systemctl', ['status', 'nginx'], 'systemctl status nginx'), null, 'status is read-only, not disruptive');
  const out = `nginx.service
checkout.service
web-frontend.service
monitoring.target`;
  const { observations, blindSpots } = systemctlAdapter.interpret(out, 0);
  assert.match(observations[0]!.detail, /3 units depend on it/);
  assert.match(observations[0]!.detail, /checkout\.service/);
  assert.ok(blindSpots?.some((b) => /systemd itself is not observed/.test(b)));
});

test('planSshDryRun only handles a single plain command', () => {
  assert.ok(planSshDryRun('apt-get remove nginx'));
  assert.equal(planSshDryRun('apt-get remove nginx && reboot'), null, 'a chain is the shadow\'s job');
  assert.equal(planSshDryRun('df -h'), null);
});

test('kubectl: only mutating verbs get a server dry-run, and a rejection is reported as "would fail"', () => {
  assert.deepEqual(planKubectlDryRun(['delete', 'deploy', 'api', '-n', 'shop']), ['delete', 'deploy', 'api', '-n', 'shop', '--dry-run=server']);
  assert.equal(planKubectlDryRun(['get', 'pods']), null);
  assert.equal(planKubectlDryRun(['apply', '-f', 'x', '--dry-run=server']), null, 'already a dry run');

  const ok = kubectlAdapter.interpret('deployment.apps/api configured (server dry run)', 0);
  assert.match(ok.observations[0]!.detail, /deployment\.apps\/api configured/);
  assert.ok(ok.blindSpots?.length);
  const rejected = kubectlAdapter.interpret('Error from server (Forbidden): admission webhook denied the request: image not signed', 1);
  assert.equal(rejected.observations[0]!.kind, 'k8s.reject');
  assert.match(rejected.observations[0]!.detail, /admission webhook denied/);
});

test('the judge turns raise hints into raise-only observed contributions, and nothing else', () => {
  const obs = [
    { kind: 'pkg.remove', detail: 'x', raise: { tier: 'high' as const, category: 'lockout' as const, reason: 'removes sshd' } },
    { kind: 'pkg.install', detail: 'y' },
  ];
  const c = contributionsFrom('apt-simulate', obs);
  assert.equal(c.length, 1);
  assert.equal(c[0]!.stage, 'observed');
  assert.equal(c[0]!.tier, 'high');
  assert.equal(c[0]!.ruleId, 'sim.pkg.remove');
  assert.match(c[0]!.reason, /removes sshd \(observed by apt-simulate\)/);
  assert.equal(contributionsFrom('x', [{ kind: 'a', detail: 'b' }]).length, 0);
});
