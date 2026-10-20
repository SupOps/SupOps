import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionHolds, renderTemplate, workflowProblem, type WorkflowStep } from './index.ts';

const onOpen = { type: 'incident' as const, on: ['opened' as const], matchers: 'team="shop"', minSeverity: 'warning' as const };

test('a workflow can only do what an unattended run could: no unknown steps', () => {
  assert.equal(workflowProblem(onOpen, [{ kind: 'diagnose' }, { kind: 'note', text: 'Looking' }]), null);
  assert.match(workflowProblem(onOpen, [{ kind: 'fix' } as unknown as WorkflowStep])!, /not a step SupOps can run/);
  assert.match(workflowProblem(onOpen, [{ kind: 'silence' } as unknown as WorkflowStep])!, /not a step/);
  assert.match(workflowProblem(onOpen, [])!, /at least one step/);
});

test('a schedule has no incident, so incident steps are refused; bad values are explained', () => {
  const every = { type: 'schedule' as const, everyMinutes: 60 };
  assert.equal(workflowProblem(every, [{ kind: 'notify', channelIds: ['c1'], message: 'hourly' }]), null);
  assert.match(workflowProblem(every, [{ kind: 'assign', userId: 'u1' }])!, /no incident/);
  assert.match(workflowProblem({ type: 'schedule', everyMinutes: 1 }, [{ kind: 'wait', minutes: 5 }])!, /every 5 minutes/);
  assert.match(workflowProblem(onOpen, [{ kind: 'wait', minutes: 0 }])!, /1 minute/);
  assert.match(workflowProblem({ ...onOpen, matchers: 'team=' + '"' }, [{ kind: 'diagnose' }])!, /Trigger matchers/);
});

test('templates fill known values only, and never run code', () => {
  const ctx = { workflow: { name: 'Page' }, incident: { title: 'Disk full', severity: 'critical', status: 'open', url: 'https://supops.example.com/i/1', rootCause: null, targets: ['db-1'], owner: null } };
  assert.equal(renderTemplate('{{incident.title}} on {{incident.targets}} ({{incident.severity}}): {{incident.rootCause}}', ctx), 'Disk full on db-1 (critical): not diagnosed yet');
  assert.equal(renderTemplate('{{constructor.constructor}} {{ process.env }}', ctx), '{{constructor.constructor}} {{ process.env }}');
});

test('conditions: matchers on any alert, a minimum severity, and still open', () => {
  const step = { kind: 'if' as const, matchers: 'env="prod"', severityAtLeast: 'critical' as const, stillOpen: true };
  assert.equal(conditionHolds(step, { severity: 'critical', status: 'open' }, [{ env: 'staging' }, { env: 'prod' }]), true);
  assert.equal(conditionHolds(step, { severity: 'warning', status: 'open' }, [{ env: 'prod' }]), false);
  assert.equal(conditionHolds(step, { severity: 'critical', status: 'resolved' }, [{ env: 'prod' }]), false);
});
