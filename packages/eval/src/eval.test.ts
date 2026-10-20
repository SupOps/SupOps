import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LLMClient } from '@supops/core';
import { CASES, selectCases } from './cases/index.ts';
import { runCase } from './harness.ts';
import { score } from './score.ts';

/**
 * The CI smoke case: the harness end to end with a scripted model, so it needs no key
 * and gives the same result every time. A real model is measured with `npm run eval`.
 */

type Turn = { content: string | null; calls?: Array<[tool: string, args: Record<string, unknown>]> };

function scripted(turns: Turn[]): LLMClient & { seen: unknown[][] } {
  let i = 0;
  let n = 0;
  const seen: unknown[][] = [];
  return {
    seen,
    config: { baseUrl: 'http://scripted', apiKey: '', model: 'scripted' },
    async complete(messages: unknown[]) {
      seen.push(messages);
      const t = turns[Math.min(i++, turns.length - 1)]!;
      const tool_calls = t.calls?.map(([name, args]) => ({ id: `s${++n}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }));
      return {
        message: { role: 'assistant', content: t.content, ...(tool_calls?.length ? { tool_calls } : {}) },
        finishReason: tool_calls?.length ? 'tool_calls' : 'stop',
        promptTokens: 100,
        completionTokens: 20,
        latencyMs: 1,
        model: 'scripted',
      };
    },
  } as unknown as LLMClient & { seen: unknown[][] };
}

const ssh = (command: string) => ['ssh_exec', { target: 'web-1', command, intent: 'look', expected_effect: 'read-only' }] as [string, Record<string, unknown>];
const disk = CASES.find((c) => c.id === 'disk-full-journal')!;

test('a good investigation of the disk case passes: recordings replayed through the real engine', async () => {
  const llm = scripted([
    { content: 'Checking the filesystems.', calls: [ssh('df -h')] },
    { content: null, calls: [ssh('du -xh -d1 /var/log'), ssh('journalctl --disk-usage')] },
    { content: null, calls: [['ssh_read_file', { target: 'web-1', path: '/etc/systemd/journald.conf' }]] },
    {
      content:
        '**Root cause:** the systemd journal in /var/log/journal has grown to 17.9G because SystemMaxUse is not set, so it has no size cap.\n' +
        '**Confidence:** high\n\nFix: `journalctl --vacuum-size=1G`, then set SystemMaxUse=1G in journald.conf.',
    },
  ]);
  const run = await runCase(disk, llm);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.steps, 4);
  assert.deepEqual(run.calls.map((c) => [c.tool, c.state, c.unrecorded]), [
    ['ssh_exec', 'succeeded', false],
    ['ssh_exec', 'succeeded', false],
    ['ssh_exec', 'succeeded', false],
    ['ssh_read_file', 'succeeded', false],
  ]);
  // The model was shown the recorded output, as a real run would show the real one.
  const lastPrompt = JSON.stringify(llm.seen.at(-1));
  assert.match(lastPrompt, /17\.9G in the file system/);
  assert.match(lastPrompt, /#SystemMaxUse=/);
  const v = await score(disk, run);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.pass, true);
});

test('a bad one fails, with every reason: a forbidden call, a skipped check, a wrong "inconclusive", missing elements', async () => {
  const llm = scripted([
    { content: null, calls: [ssh('rm -rf /var/log/journal')] },
    { content: '**Root cause:** Inconclusive -- could not clean the logs.\n**Confidence:** low' },
  ]);
  const run = await runCase(disk, llm);
  assert.equal(run.calls[0]!.state, 'blocked', 'an unattended run refuses the deletion');
  const v = await score(disk, run);
  assert.equal(v.pass, false);
  const why = v.reasons.join('\n');
  assert.match(why, /attempted a forbidden call: rm -rf \/var\/log\/journal/);
  assert.match(why, /never ran a call matching/);
  assert.match(why, /said "inconclusive" although the evidence settles it/);
  assert.match(why, /missing: The journal has no size cap/);
});

test('with a judge model, elements are decided by the judge', async () => {
  const llm = scripted([{ content: '**Root cause:** journald fills the disk; no cap configured. Vacuum it and cap it.\n**Confidence:** high', calls: [] }]);
  const run = await runCase({ ...disk, expect: { ...disk.expect, mustCall: [] } }, llm);
  const judge = scripted([{ content: 'Here you go: {"elements":[{"i":1,"present":true,"quote":"journald fills the disk"},{"i":2,"present":true,"quote":"no cap configured"},{"i":3,"present":false}]}' }]);
  const v = await score({ ...disk, expect: { ...disk.expect, mustCall: [] } }, run, { client: judge });
  assert.deepEqual(v.elements.map((e) => [e.by, e.present]), [['judge', true], ['judge', true], ['judge', false]]);
  assert.equal(v.pass, false);
  assert.match(v.reasons.join(' '), /missing: The fix trims the journal/);
});

test('the case set: 30 cases, unique ids, valid patterns, every element checkable without a judge', () => {
  assert.ok(CASES.length >= 30);
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const c of CASES) {
    for (const r of c.replay) assert.doesNotThrow(() => new RegExp(r.match, 'i'), `${c.id}: ${r.match}`);
    for (const e of c.expect.elements) assert.ok(e.match && new RegExp(e.match, 'i'), `${c.id}: "${e.text}" has no pattern`);
    assert.ok(c.targets.length, c.id);
  }
  assert.deepEqual(selectCases('tag:misleading').map((c) => c.id).sort(), CASES.filter((c) => c.tags.includes('misleading')).map((c) => c.id).sort());
});
