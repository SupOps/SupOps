import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-maint-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, incidents, maintenanceWindows, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');
const { releaseEndedWindows } = await import('./maintenance.ts');

const projectId = 'p-maint';
db.insert(projects).values({ id: projectId, slug: 'maint', name: 'Maint', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

const fire = (fp: string, labels: Record<string, string>, status: 'firing' | 'resolved' = 'firing') =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title: labels.alertname ?? 'X', severity: 'warning', summary: null, labels, status, notification: true });

test('during a window, matching alerts are stored but open no incident; others are untouched', () => {
  const w = db
    .insert(maintenanceWindows)
    .values({ projectId, name: 'DB upgrade', matchers: [{ name: 'service', op: '=', value: 'db' }], startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 3_600_000) })
    .returning()
    .get();

  fire('fp-db', { alertname: 'ReplicationLag', service: 'db', instance: 'db-1:9100' });
  fire('fp-db-2', { alertname: 'DbRestarted', service: 'db', instance: 'db-2:9100' });
  fire('fp-web', { alertname: 'HighLatency', service: 'web', instance: 'web-1:9100' });

  const db1 = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-db')).get()!;
  assert.equal(db1.maintenanceId, w.id, 'stored, never dropped');
  assert.equal(db1.incidentId, null, 'but no incident while the work is planned');
  assert.ok(db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-web')).get()!.incidentId, 'an alert the window does not match goes on as usual');

  // One of them resolves during the window: kept as history, never processed.
  fire('fp-db-2', { alertname: 'DbRestarted', service: 'db', instance: 'db-2:9100' }, 'resolved');

  assert.deepEqual(releaseEndedWindows(), [], 'nothing is released while the window lasts');

  db.update(maintenanceWindows).set({ cancelledAt: new Date() }).where(eq(maintenanceWindows.id, w.id)).run();
  const released = releaseEndedWindows();
  assert.deepEqual(released, [db1.id], 'only the one still firing');
  const after = db.select().from(alerts).where(eq(alerts.id, db1.id)).get()!;
  assert.equal(after.maintenanceId, null);
  assert.ok(after.incidentId, 'it is grouped into an incident now, as if it had just arrived');
  const inc = db.select().from(incidents).where(eq(incidents.id, after.incidentId!)).get()!;
  assert.equal(inc.status, 'open');
  const resolvedDuring = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-db-2')).get()!;
  assert.equal(resolvedDuring.status, 'resolved');
  assert.equal(resolvedDuring.incidentId, null, 'resolved during the window: history only');
});

test('a weekly window only mutes inside its slot', () => {
  const now = new Date();
  const day = now.getUTCDay();
  const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
  // A slot that is not now: tomorrow at the same time.
  db.insert(maintenanceWindows)
    .values({
      projectId,
      name: 'Weekly reboot',
      matchers: [{ name: 'alertname', op: '=', value: 'NodeRebooted' }],
      startsAt: new Date(Date.now() - 86_400_000),
      endsAt: new Date(Date.now() + 30 * 86_400_000),
      recurrence: { days: [(day + 1) % 7], start: hh(now.getUTCHours()), end: hh(now.getUTCHours() + 1), timezone: 'UTC' },
    })
    .run();
  fire('fp-reboot', { alertname: 'NodeRebooted', instance: 'node-3:9100' });
  const row = db.select().from(alerts).where(eq(alerts.fingerprint, 'fp-reboot')).get()!;
  assert.equal(row.maintenanceId, null);
  assert.ok(row.incidentId);
});
