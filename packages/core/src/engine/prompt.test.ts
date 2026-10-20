import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVISORY_PROMPT, NETWORK_CHECKS_PROMPT, buildOpeningMessage, buildSystemPrompt } from './prompt.ts';

test('advisory runs say there is no access, and list no targets', () => {
  assert.ok(buildSystemPrompt(null, 'agent', '', { advisory: true }).endsWith(ADVISORY_PROMPT));
  assert.ok(!buildSystemPrompt(null, 'agent').includes('ADVISORY MODE'));

  const opening = buildOpeningMessage({ projectName: 'p', targets: [], task: 'nginx 502s', knowledge: 'PROJECT KNOWLEDGE ...', advisory: true });
  assert.match(opening, /Mode: advisory/);
  assert.match(opening, /PROJECT KNOWLEDGE/);
  assert.doesNotMatch(opening, /Targets you may act on/);
  assert.ok(opening.endsWith('Task:\nnginx 502s'));
});

test('advisory runs with network checks are told what net_check is and where it runs from', () => {
  const sys = buildSystemPrompt(null, 'agent', '', { advisory: true, networkChecks: true });
  assert.ok(sys.endsWith(NETWORK_CHECKS_PROMPT));
  assert.ok(!buildSystemPrompt(null, 'agent', '', { networkChecks: true }).includes('NETWORK CHECKS'), 'only for advisory runs');
  assert.ok(!buildSystemPrompt(null, 'agent', '', { advisory: true }).includes('NETWORK CHECKS'));
  assert.match(NETWORK_CHECKS_PROMPT, /not from the operator's network/);
  const opening = buildOpeningMessage({ projectName: 'p', targets: [], task: 't', advisory: true, networkChecks: true });
  assert.match(opening, /net_check/);
});

test('incident runs: diagnosis and fix get their own instructions', () => {
  const d = buildSystemPrompt(null, 'agent', '', { incident: 'diagnose' });
  assert.ok(d.includes('INCIDENT INVESTIGATION') && !d.includes('INCIDENT -- FIX'));
  const f = buildSystemPrompt(null, 'agent', '', { incident: 'fix' });
  assert.ok(f.includes('INCIDENT -- FIX') && !f.includes('INCIDENT INVESTIGATION'));
  assert.ok(!buildSystemPrompt(null, 'agent').includes('INCIDENT'));
});

test('project documents come first; the model adds its own expertise, marked as such', () => {
  const sys = buildSystemPrompt(null, 'agent');
  assert.match(sys, /PROJECT KNOWLEDGE AND YOUR OWN/);
  assert.match(sys, /come first and are binding/);
  assert.match(sys, /mark it as general knowledge/);
  assert.match(sys, /Facts about this environment .* never from general knowledge/);
});
