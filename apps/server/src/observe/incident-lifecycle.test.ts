import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-inc-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, incidentEvents, incidents, projects, users, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { asc, eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');
const { mergeIncidents } = await import('./incidents.ts');
const { recordIncidentEvent } = await import('./incident-events.ts');

const projectId = 'p-inc';
db.insert(projects).values({ id: projectId, slug: 'inc', name: 'Inc', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(users).values({ id: 'u-ana', email: 'ana@example.com', name: 'Ana', globalRole: 'member', passwordHash: null }).run();
settingsStore.saveObservability({ autoTriage: false });
const ana = { id: 'u-ana', email: 'ana@example.com', name: 'Ana', globalRole: 'member' };

const fire = (fp: string, title: string, severity: 'warning' | 'critical', instance = 'web-1:9100') =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title, severity, summary: null, labels: { alertname: title, instance }, status: 'firing', notification: true });
const incidentOf = (fp: string) => db.select().from(incidents).where(eq(incidents.id, db.select().from(alerts).where(eq(alerts.fingerprint, fp)).get()!.incidentId!)).get()!;
const ack = (id: string) => {
  db.update(incidents).set({ acknowledgedAt: new Date(), acknowledgedBy: ana.id }).where(eq(incidents.id, id)).run();
  recordIncidentEvent(id, 'acknowledged', ana);
};
const kinds = (id: string) => db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, id)).orderBy(asc(incidentEvents.at)).all().map((e) => e.kind);

test('an acknowledgement lapses by itself when a new alert joins', () => {
  fire('fp-a', 'HighLatency', 'warning');
  const inc = incidentOf('fp-a');
  ack(inc.id);
  fire('fp-b', 'ErrorRate', 'warning'); // same machine: joins
  const after = db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!;
  assert.equal(after.acknowledgedAt, null);
  assert.deepEqual(kinds(inc.id), ['acknowledged', 'ack_lapsed']);
  const lapse = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, inc.id)).all().find((e) => e.kind === 'ack_lapsed')!;
  assert.equal(lapse.actorName, null, 'SupOps did it, not a person');
  assert.match(String(lapse.data?.reason), /ErrorRate/);
});

test('…and when one of its alerts gets worse; the incident severity follows unless a person pinned it', () => {
  fire('fp-c', 'DiskFilling', 'warning', 'db-1:9100');
  const inc = incidentOf('fp-c');
  ack(inc.id);
  fire('fp-c', 'DiskFilling', 'critical', 'db-1:9100');
  const after = db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!;
  assert.equal(after.acknowledgedAt, null);
  assert.equal(after.severity, 'critical');

  fire('fp-d', 'QueueDepth', 'critical', 'mq-1:9100');
  const pinned = incidentOf('fp-d');
  db.update(incidents).set({ severity: 'info', severityPinned: true }).where(eq(incidents.id, pinned.id)).run();
  fire('fp-e', 'QueueStalled', 'critical', 'mq-1:9100'); // joins
  assert.equal(db.select().from(incidents).where(eq(incidents.id, pinned.id)).get()!.severity, 'info', 'pinned by a person: alerts no longer change it');
});

test('merging is recorded on the incident that remains, with who did it', () => {
  fire('fp-x', 'CertExpiring', 'warning', 'edge-1:443');
  fire('fp-y', 'TlsHandshakeErrors', 'warning', 'edge-9:443');
  const a = incidentOf('fp-x');
  const b = incidentOf('fp-y');
  assert.notEqual(a.id, b.id);
  mergeIncidents(b.id, a.id, ana);
  const ev = db.select().from(incidentEvents).where(eq(incidentEvents.incidentId, a.id)).all().find((e) => e.kind === 'merged_in')!;
  assert.equal(ev.actorName, 'Ana');
  assert.equal(ev.data?.fromTitle, b.title);
});
