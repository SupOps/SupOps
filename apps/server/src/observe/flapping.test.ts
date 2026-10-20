import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-flap-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, incidents, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { and, eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');
const { settleFlapping } = await import('./flapping.ts');

const projectId = 'p-flap';
db.insert(projects).values({ id: projectId, slug: 'flap', name: 'Flap', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

const send = (status: 'firing' | 'resolved') =>
  ingestAlert({
    projectId,
    source: 'alertmanager',
    fingerprint: 'fp-flappy',
    title: 'ProbeFailed',
    severity: 'warning',
    summary: 'probe to api-1 failed',
    labels: { alertname: 'ProbeFailed', instance: 'api-1:9115' },
    status,
    notification: true,
  });

test('an alert that keeps firing and resolving is one incident, marked flapping, until it settles', () => {
  send('firing');
  send('resolved');
  send('firing');
  const rows = () => db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.fingerprint, 'fp-flappy'))).all();
  assert.equal(rows().length, 2, 'a refire after a resolve is a new occurrence');
  assert.equal(new Set(rows().map((r) => r.incidentId)).size, 1, 'but the same incident, reopened');
  assert.equal(rows().some((r) => r.flapping), false, 'three changes is not flapping yet');

  send('resolved');
  send('firing');
  const open = rows().find((r) => r.status === 'new')!;
  assert.equal(open.flapping, true, 'five changes in 30 minutes is');
  assert.ok(open.flappingSince);
  const incs = db.select().from(incidents).where(eq(incidents.projectId, projectId)).all();
  assert.equal(incs.length, 1, 'no incident per flap');
  assert.equal(incs[0]!.status, 'open');
  assert.match(incs[0]!.groupReason ?? '', /fired again soon after resolving/);

  // Still changing a minute later: not settled.
  assert.deepEqual(settleFlapping(Date.now() + 60_000), []);
  // Quiet for the whole window: settled, still firing, mark cleared.
  assert.deepEqual(settleFlapping(Date.now() + 31 * 60_000), [open.id]);
  assert.equal(db.select().from(alerts).where(eq(alerts.id, open.id)).get()!.flapping, false);
});

test('a refire long after resolving is a new incident', () => {
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'fp-rare', title: 'Rare', severity: 'info', summary: null, labels: { alertname: 'Rare', instance: 'db-9:9100' }, status: 'firing', notification: true });
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'fp-rare', title: 'Rare', severity: 'info', summary: null, labels: { alertname: 'Rare', instance: 'db-9:9100' }, status: 'resolved', notification: true });
  const first = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-rare')).get()!;
  db.update(alerts).set({ resolvedAt: new Date(Date.now() - 3 * 3_600_000) }).where(eq(alerts.id, first.id)).run();
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: 'fp-rare', title: 'Rare', severity: 'info', summary: null, labels: { alertname: 'Rare', instance: 'db-9:9100' }, status: 'firing', notification: true });
  const both = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-rare')).all();
  assert.equal(new Set(both.map((r) => r.incidentId)).size, 2);
});
