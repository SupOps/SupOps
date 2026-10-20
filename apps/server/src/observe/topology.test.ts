import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-topo-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, ciEvidence, ciItems, ciLinks, incidents, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');
const { incidentMapBlock } = await import('../servicemap/context.ts');

const projectId = 'p-topo';
db.insert(projects).values({ id: projectId, slug: 'topo', name: 'Topo', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
const item = (key: string) => db.insert(ciItems).values({ projectId, key, name: key, type: 'service' }).returning().get();
const [checkout, payments, db1] = [item('checkout'), item('payments'), item('orders-db')];
// Entered by a person: manual evidence, as the service map page records it.
for (const [from, to] of [[checkout, payments], [payments, db1]] as const) {
  const l = db.insert(ciLinks).values({ projectId, fromId: from.id, toId: to.id, kind: 'depends_on' }).returning().get();
  db.insert(ciEvidence).values({ projectId, linkId: l.id, source: 'manual', ref: 'test' } as never).run();
}

const fire = (fp: string, alertname: string, service: string) =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title: alertname, severity: 'critical', summary: null, labels: { alertname, service }, status: 'firing', notification: true });
const incidentOf = (alertId: string) => db.select().from(alerts).where(eq(alerts.id, alertId)).get()!.incidentId!;

test('alerts on services linked on the map, starting together, become one incident, diagnosed after a short wait', async () => {
  settingsStore.saveObservability({ autoTriage: false, triageGatherSeconds: 1 });
  const a = fire('t-db', 'DbConnectionsHigh', 'orders-db');
  const inc = incidentOf(a.alertId!);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc)).get()!.triageState, 'none', 'waiting for related alerts');
  const b = fire('t-pay', 'PaymentsErrors', 'payments');
  const c = fire('t-co', 'CheckoutLatency', 'checkout');
  assert.equal(incidentOf(b.alertId!), inc);
  assert.equal(incidentOf(c.alertId!), inc);
  assert.match(db.select().from(incidents).where(eq(incidents.id, inc)).get()!.groupReason!, /payments depends on orders-db \(service map\), within 5 minutes/);
  await new Promise((r) => setTimeout(r, 1600));
  assert.notEqual(db.select().from(incidents).where(eq(incidents.id, inc)).get()!.triageState, 'none', 'diagnosed (here: evidence, then skipped) once the wait is over');

  const block = incidentMapBlock(projectId, [], inc, ['checkout', 'payments', 'orders-db'])!;
  assert.match(block, /Likeliest origin \(failing, and nothing it depends on is failing\): orders-db\./);
  assert.match(block, /Probably effects, not causes: .*checkout \(depends on payments\)/);
});

test('related incidents that did not group are suggested, with why; "not related" is remembered', async () => {
  const { suggestMerges, dismissSuggestion } = await import('./incidents.ts');
  const t0 = Date.now() - 30 * 60_000;
  const at = (min: number) => new Date(t0 + min * 60_000);
  const make = (fp: string, alertname: string, service: string, min: number) => {
    const inc = db.insert(incidents).values({ projectId, title: alertname, severity: 'warning', openedAt: at(min), lastSeenAt: at(min), groupKey: { alertname, service } } as never).returning().get();
    db.insert(alerts).values({ projectId, incidentId: inc.id, source: 'alertmanager', fingerprint: fp, title: alertname, severity: 'warning', status: 'new', labels: { alertname, service }, receivedAt: at(min) } as never).run();
    return inc;
  };
  const a = make('s-1', 'PaymentsSlow', 'payments', 0);
  const b = make('s-2', 'CheckoutSlow', 'checkout', 8);
  const sug = suggestMerges(a);
  assert.deepEqual(sug.filter((s) => s.id === b.id).map((s) => s.reason), ['checkout depends on payments (service map); opened 8 min apart']);
  dismissSuggestion(projectId, b.id, a.id, null);
  assert.ok(!suggestMerges(a).some((s) => s.id === b.id), 'a pair a person called unrelated is not suggested again');
});
