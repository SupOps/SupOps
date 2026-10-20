import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-enrich-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, ciItems, extractionRules, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');

const projectId = 'p-enrich';
db.insert(projects).values({ id: projectId, slug: 'enrich', name: 'Enrich', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

test('an arriving alert gets labels from its own text and from the service catalogue, never over the source', () => {
  const rule = db
    .insert(extractionRules)
    .values({ projectId, name: 'Job', matchers: [{ name: 'alertname', op: '=', value: 'JobFailed' }], field: 'summary', pattern: 'job=(?<job>[\\w-]+) exit=(?<exit_code>\\d+)' })
    .returning()
    .get();
  const comp = db
    .insert(ciItems)
    .values({ projectId, key: 'backup-runner', name: 'backup-runner', type: 'service', aliases: ['backups'], attrs: { owner: 'Ana', team: 'storage', runbook: 'https://wiki.example.com/rb/backups', port: '9000' } })
    .returning()
    .get();

  ingestAlert({
    projectId,
    source: 'alertmanager',
    fingerprint: 'fp-job',
    title: 'JobFailed',
    severity: 'warning',
    summary: 'job=nightly-backup exit=137',
    labels: { alertname: 'JobFailed', service: 'backups', team: 'oncall-core' },
    status: 'firing',
    notification: true,
  });
  const a = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-job')).get()!;
  assert.equal(a.labels!.job, 'nightly-backup');
  assert.equal(a.labels!.exit_code, '137');
  assert.equal(a.labels!.owner, 'Ana', 'from the component its service alias names');
  assert.equal(a.labels!.runbook_url, 'https://wiki.example.com/rb/backups');
  assert.equal(a.labels!.team, 'oncall-core', 'the sender said its team: kept');
  assert.equal(a.labels!.port, undefined, 'only catalogue fields become labels');
  assert.deepEqual(a.enriched, { job: `rule:${rule.id}`, exit_code: `rule:${rule.id}`, owner: `catalogue:${comp.id}`, runbook_url: `catalogue:${comp.id}` });

  const counted = db.select().from(extractionRules).where(eq(extractionRules.id, rule.id)).get()!;
  assert.deepEqual([counted.seen, counted.applied], [1, 1]);
  assert.deepEqual(counted.lastExample, { job: 'nightly-backup', exit_code: '137' });
});
