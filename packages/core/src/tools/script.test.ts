import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import { maxTier } from '@supops/shared';
import type { ToolDef } from './types.ts';
import { assessRisk } from '../risk/index.ts';
import { PROD, STAGING } from '../risk/corpus.ts';
import { effectiveToolKeys } from './registry.ts';
import { classifyScript, renderScript, runScriptTool, scriptForClassification } from './script.ts';

const def = runScriptTool as unknown as ToolDef<never>;
const tier = (script: string, interpreter: 'bash' | 'sh' | 'python3' = 'bash', t = STAGING) =>
  maxTier(...classifyScript({ interpreter, script }, t).map((c) => c.tier));
const assess = (script: string, policy = { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' as const }, t = STAGING, interpreter = 'bash') => {
  const args = { target: t.slug, interpreter, script, timeout_seconds: 120, intent: 'x', expected_effect: 'y' };
  return assessRisk({ def, args, rendered: renderScript(args as never, t), target: t, policy });
};

const READS = `#!/usr/bin/env bash
set -euo pipefail
# what is filling the disk?
df -h
du -sh /var/log
journalctl -u nginx -n 50 --no-pager
`;

test('a script of reads is read-only: comments, the shebang and set lines run nothing', () => {
  assert.equal(scriptForClassification(READS), 'df -h\ndu -sh /var/log\njournalctl -u nginx -n 50 --no-pager');
  assert.equal(tier(READS), 'read_only');
  assert.equal(assess(READS).decision, 'auto');
});

test('one changing line makes the whole script wait, even where single changes may run alone', () => {
  const s = `${READS}systemctl restart nginx\nsystemctl status nginx\n`;
  assert.equal(tier(s), 'medium');
  const a = assess(s);
  assert.equal(a.decision, 'approve', 'run_script runs alone only up to read-only');
  assert.equal(a.ceiling, 'read_only');
  assert.match(a.ceilingReason ?? '', /run_script runs on its own only up to read-only/);
});

test('the worst line decides', () => {
  assert.equal(tier('ls /tmp\nreboot'), 'high');
  assert.equal(tier('ls /tmp\nrm -rf /var/lib/postgresql'), 'forbidden');
  assert.equal(assess('ls\nrm -rf /var/lib/postgresql', undefined, PROD).decision, 'block');
});

test('unreadable lines and env prefixes count too', () => {
  assert.equal(tier('for f in /var/log/*.log; do wc -l $f; done'), 'high');
  assert.equal(tier('LD_PRELOAD=/tmp/x.so ls'), 'high');
});

test('Python always waits for a person', () => {
  assert.equal(tier('print(1)', 'python3'), 'high');
  assert.equal(assess('print(1)', undefined, STAGING, 'python3').decision, 'approve');
  assert.equal(assess('print(1)', undefined, STAGING, 'python3').contributions.some((c) => c.ruleId === 'script.python'), true);
});

test('it runs as one quoted -c argument under a timeout, with the target\'s elevation', () => {
  const r = renderScript({ interpreter: 'bash', script: "echo 'hi'\ndf -h", timeout_seconds: 30 }, STAGING);
  assert.equal(r, "timeout -k 5 30 bash -c 'echo '\\''hi'\\''\ndf -h'");
});

test('agents allowed ssh_exec get run_script', () => {
  assert.ok(effectiveToolKeys(['ssh_exec'])!.includes('run_script'));
  assert.equal(effectiveToolKeys(null), null);
});

test('scripts over 32 KB are refused', () => {
  const big = 'df -h\n'.repeat(6000);
  assert.equal(runScriptTool.argsSchema.safeParse({ target: 'x', script: big, intent: 'a', expected_effect: 'b' }).success, false);
});

test('a script has a signature, so a denied script is recognised when it comes back', async () => {
  const { signatureOf } = await import('../learning/signature.ts');
  const a = signatureOf('run_script', { interpreter: 'bash', script: '# check\nsystemctl restart nginx\njournalctl -u nginx -n 20' });
  const b = signatureOf('run_script', { interpreter: 'bash', script: 'systemctl restart nginx\n\njournalctl -n 50 -u nginx' });
  assert.ok(a && a === b, `${a} vs ${b}`);
  const p = signatureOf('run_script', { interpreter: 'python3', script: 'print(1)\n' });
  assert.match(p!, /^v1\|run_script\|python3\|[0-9a-f]{16}$/);
});
