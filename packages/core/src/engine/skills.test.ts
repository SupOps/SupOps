import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INJECTED_SKILLS, MAX_SKILL_CHARS, SKILLS, renderSkills, selectSkills } from './skills.ts';
import type { Skill } from './skills.ts';

const fake = (id: string, o: Partial<Skill> = {}): Skill => ({ id, title: id, body: `${id} guidance`, ...o });
const reg = [
  fake('linux', { kinds: ['ssh'] }),
  fake('kubernetes', { kinds: ['k8s'], keywords: /\b(pod|kubectl|deployment)s?\b/i }),
  fake('terraform', { keywords: /terraform|tfstate/i }),
  fake('helm', { keywords: /\bhelm\b/i }),
  fake('aws', { kinds: ['aws'] }),
  fake('networking', { keywords: /\b(dns|tls|502|504)\b/i }),
];

test('every built-in playbook fits the budget and has a unique id', () => {
  const ids = new Set<string>();
  for (const s of SKILLS) {
    assert.ok(s.body.length <= MAX_SKILL_CHARS, `${s.id} is ${s.body.length} chars`);
    assert.ok(!ids.has(s.id), `duplicate ${s.id}`);
    assert.doesNotMatch(s.body, /\$\{/, `${s.id} must be static text`);
    ids.add(s.id);
  }
});

test('playbooks are chosen by kinds in scope, then task keywords, capped and stable', () => {
  const a = selectSkills({ kinds: ['ssh'], task: 'pods crashing after a helm upgrade, also 502 errors' }, reg);
  assert.deepEqual(a.injected.map((s) => s.id), ['helm', 'kubernetes', 'linux', 'networking']);
  const b = selectSkills({ kinds: ['ssh', 'k8s', 'aws'], task: 'terraform plan shows drift; helm too; dns broken' }, reg);
  assert.equal(b.injected.length, MAX_INJECTED_SKILLS);
  assert.ok(['aws', 'kubernetes', 'linux'].every((id) => b.injected.some((s) => s.id === id)), 'kinds beat keywords');
  assert.equal(b.others.length, 2);
  assert.deepEqual(selectSkills({ kinds: ['ssh', 'k8s', 'aws'], task: 'terraform plan shows drift; helm too; dns broken' }, reg), b, 'deterministic');
});

test('agent-pinned playbooks always win a slot', () => {
  const s = selectSkills({ kinds: ['ssh', 'k8s', 'aws'], task: 'dns', pinned: ['terraform'] }, reg);
  assert.ok(s.injected.some((x) => x.id === 'terraform'));
});

test('nothing selected renders nothing', () => {
  assert.equal(renderSkills(selectSkills({ kinds: [], task: 'hello' }, reg)), '');
  assert.match(renderSkills(selectSkills({ kinds: ['ssh'], task: '' }, reg)), /^PLAYBOOKS FOR THIS RUN\n\nLINUX\nlinux guidance$/);
});
