import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFromArgs, planTool, renderPlan } from './plan.ts';

test('a plan is read-only, replaced whole, and rendered as a checklist', async () => {
  assert.equal(planTool.baselineRisk, 'read_only');
  assert.equal(planTool.mutating, false);
  const steps = [
    { step: 'Check disk on web-1', status: 'done' as const, note: '/var at 97%' },
    { step: 'Find what grew', status: 'doing' as const },
    { step: 'Rotate the log', status: 'todo' as const },
    { step: 'Restart the app', status: 'dropped' as const, note: 'not needed' },
  ];
  assert.equal(renderPlan(steps), '1. [x] Check disk on web-1 -- /var at 97%\n2. [>] Find what grew\n3. [ ] Rotate the log\n4. [-] Restart the app -- not needed');
  const out = await planTool.execute({ target: 'x', steps }, {} as never);
  assert.ok(out.ok);
  assert.match(out.text, /^Plan updated:\n1\. \[x\]/);
});

test('a malformed plan is refused by the schema, not stored', () => {
  assert.equal(planTool.argsSchema.safeParse({ target: 'x', steps: [] }).success, false, 'empty');
  assert.equal(planTool.argsSchema.safeParse({ target: 'x', steps: [{ step: 'a', status: 'maybe' }] }).success, false, 'unknown status');
  assert.equal(planTool.argsSchema.safeParse({ target: 'x', steps: Array.from({ length: 13 }, () => ({ step: 'a', status: 'todo' })) }).success, false, 'too long');
  assert.equal(planFromArgs({ steps: 'nope' }), null);
  assert.deepEqual(planFromArgs({ target: 'web-1', steps: [{ step: 'a', status: 'todo' }] }), [{ step: 'a', status: 'todo' }]);
});

test('the plan is about the run, so its target is always the SupOps server, whatever the project has', async () => {
  const { bindTool } = await import('./registry.ts');
  const { readOutputTool } = await import('./read-output.ts');
  const web = { id: 'w', slug: 'web-1', kind: 'ssh', env: 'prod', sensitivity: 1, description: null, config: { kind: 'ssh' }, credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null } as never;
  for (const def of [planTool, readOutputTool]) assert.deepEqual([...bindTool(def as never, [web])!.targetsBySlug.keys()], ['supops-server'], def.key);
});
