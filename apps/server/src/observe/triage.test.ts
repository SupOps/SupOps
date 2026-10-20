import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-triage-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db } = await import('../context.ts');
const { agents, alerts, incidents, projects, runSteps, runs, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { reconcileTriage } = await import('./triage.ts');

const project = db.insert(projects).values({ slug: 'tri', name: 'Tri', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
const agent = db.insert(agents).values({ projectId: project.id, slug: 'triage', name: 'Triage', role: 'triage', systemPrompt: 'x', budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).returning().get();

/** An incident whose read-only diagnosis just finished with this report. */
function diagnosed(title: string, report: string) {
  const run = db
    .insert(runs)
    .values({
      projectId: project.id, agentId: agent.id, trigger: 'alert', title, status: 'succeeded', providerBaseUrl: 'http://test', model: 'm',
      systemSnapshot: 'x', toolsSnapshot: [], targetsSnapshot: [], policySnapshot: DEFAULT_RISK_POLICY, startedAt: new Date(),
    })
    .returning()
    .get();
  db.insert(runSteps).values({ runId: run.id, seq: 1, messageJson: { role: 'assistant', content: report }, state: 'committed' } as never).run();
  const inc = db.insert(incidents).values({ projectId: project.id, title, severity: 'warning', triageState: 'running', runId: run.id } as never).returning().get();
  db.insert(alerts).values({ projectId: project.id, incidentId: inc.id, source: 'alertmanager', fingerprint: `fp-${inc.id}`, title, severity: 'warning', status: 'new', labels: {} } as never).run();
  return inc.id;
}

test('the diagnosis keeps its hypotheses and blast radius', () => {
  const id = diagnosed(
    'DiskFull web-1',
    [
      '**Action:** act now',
      '**Root cause:** the nightly export writes 40 GB of logs into /var on web-1',
      '**Confidence:** high',
      '### Evidence',
      '| Hypothesis | Verdict | Evidence |',
      '|---|---|---|',
      '| Export logs | confirmed | du: /var/log/export 41G |',
      '| Disk failure | ruled out | smartctl clean |',
      '### Blast radius',
      '- **Affected:** web-1',
      '- **Checked healthy:** web-2',
      '- **Not checked:** the backup host',
    ].join('\n'),
  );
  reconcileTriage();
  const inc = db.select().from(incidents).where(eq(incidents.id, id)).get()!;
  assert.equal(inc.triageState, 'done');
  assert.equal(inc.confidence, 'high');
  assert.deepEqual(inc.hypotheses?.map((h) => h.verdict), ['confirmed', 'ruled_out']);
  assert.deepEqual(inc.blastRadius, { affected: 'web-1', healthy: 'web-2', unchecked: 'the backup host' });
  assert.equal(inc.triageNote, null);
});

test('a root cause that only restates the alert is marked, and its confidence capped', () => {
  const id = diagnosed('HighCpuUsage api-3', '**Root cause:** High CPU usage on api-3\n**Confidence:** high');
  reconcileTriage();
  const inc = db.select().from(incidents).where(eq(incidents.id, id)).get()!;
  assert.equal(inc.rootCause, 'High CPU usage on api-3');
  assert.equal(inc.confidence, 'low');
  assert.match(inc.triageNote ?? '', /only restates what fired/);
  assert.equal(inc.hypotheses, null);
  assert.equal(inc.blastRadius, null);
});
