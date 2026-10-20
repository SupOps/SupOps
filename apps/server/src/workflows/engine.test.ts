import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-wf-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { incidentEvents, incidents, projects, users, workflowRuns, workflows, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('../observe/ingest.ts');
const { executeRuns, planWorkflows } = await import('./engine.ts');

const projectId = 'p-wf';
db.insert(projects).values({ id: projectId, slug: 'wf', name: 'WF', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(users).values({ id: 'u-oncall', email: 'oncall@example.com', name: 'On-call', globalRole: 'member', passwordHash: null }).run();
settingsStore.saveObservability({ autoTriage: false });

const fire = (fp: string, labels: Record<string, string>, severity: 'warning' | 'critical' = 'critical') =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title: labels.alertname!, severity, summary: null, labels, status: 'firing', notification: true });

test('on a matching incident: assign, note, wait, then only carry on if still open; once per event', async () => {
  const wf = db
    .insert(workflows)
    .values({
      projectId,
      name: 'Page on-call',
      trigger: { type: 'incident', on: ['opened'], matchers: 'env="prod"', minSeverity: 'critical' },
      steps: [
        { kind: 'assign', userId: 'u-oncall' },
        { kind: 'note', text: 'Paged {{incident.owner}} for {{incident.title}}' },
        { kind: 'wait', minutes: 10 },
        { kind: 'if', matchers: '', severityAtLeast: null, stillOpen: true },
        { kind: 'severity', severity: 'critical' },
      ],
      updatedAt: new Date(Date.now() - 1000),
    })
    .returning()
    .get();
  fire('w1', { alertname: 'ApiDown', env: 'prod', instance: 'api-1:9100' });
  fire('w2', { alertname: 'StagingSlow', env: 'staging', instance: 'api-s:9100' }); // does not match
  assert.equal(planWorkflows(), 1);
  assert.equal(planWorkflows(), 0, 'the same event never starts it twice');

  await executeRuns();
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id)).get()!;
  assert.equal(run.status, 'waiting');
  assert.deepEqual(run.log.map((l) => l.status), ['done', 'done', 'waiting']);
  const inc = db.select().from(incidents).where(eq(incidents.id, run.incidentId!)).get()!;
  assert.equal(inc.assigneeId, 'u-oncall');
  const note = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id)).all().find((e) => e.kind === 'comment')!;
  assert.equal(note.actorName, 'Workflow "Page on-call"');
  assert.equal(note.data?.text, 'Paged On-call for ApiDown on api-1');

  await executeRuns(Date.now() + 5 * 60_000);
  assert.equal(db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).get()!.status, 'waiting', 'not yet');

  db.update(incidents).set({ status: 'resolved', resolvedAt: new Date() }).where(eq(incidents.id, inc.id)).run();
  await executeRuns(Date.now() + 11 * 60_000);
  const done = db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)).get()!;
  assert.equal(done.status, 'stopped', 'resolved meanwhile: the condition stops it');
  assert.equal(done.log.at(-1)!.text, 'The condition does not hold: stopping here.');
});

test('a workflow keeps the steps of the revision it started on', async () => {
  const wf = db
    .insert(workflows)
    .values({ projectId, name: 'Rev', trigger: { type: 'incident', on: ['opened'], matchers: 'team="rev"', minSeverity: 'info' }, steps: [{ kind: 'wait', minutes: 1 }, { kind: 'acknowledge' }], updatedAt: new Date(Date.now() - 1000) })
    .returning()
    .get();
  fire('w3', { alertname: 'RevAlert', team: 'rev', instance: 'r-1:9100' }, 'warning');
  planWorkflows();
  await executeRuns();
  db.update(workflows).set({ steps: [{ kind: 'note', text: 'changed' }], revision: 2 }).where(eq(workflows.id, wf.id)).run();
  await executeRuns(Date.now() + 2 * 60_000);
  const run = db.select().from(workflowRuns).where(eq(workflowRuns.workflowId, wf.id)).get()!;
  assert.equal(run.revision, 1);
  assert.equal(run.log.at(-1)!.text, 'Acknowledged it.');
});

test('incidents from before the workflow was saved do not start it', () => {
  fire('w4', { alertname: 'Old', team: 'later', instance: 'o-1:9100' });
  db.insert(workflows).values({ projectId, name: 'Later', trigger: { type: 'incident', on: ['opened'], matchers: 'team="later"', minSeverity: 'info' }, steps: [{ kind: 'acknowledge' }], updatedAt: new Date(Date.now() + 1000) }).run();
  assert.equal(planWorkflows(), 0);
});
