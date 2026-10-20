import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-rules-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { alerts, correlationRules, incidents, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { ingestAlert } = await import('./ingest.ts');

const projectId = 'p-rules';
db.insert(projects).values({ id: projectId, slug: 'rules', name: 'Rules', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
settingsStore.saveObservability({ autoTriage: false });

const fire = (fp: string, labels: Record<string, string>, status: 'firing' | 'resolved' = 'firing') =>
  ingestAlert({ projectId, source: 'alertmanager', fingerprint: fp, title: labels.alertname!, severity: 'warning', summary: null, labels, status, notification: true });
const incOf = (fp: string) => db.select().from(incidents).where(eq(incidents.id, db.select().from(alerts).where(eq(alerts.fingerprint, fp)).get()!.incidentId!)).get()!;

test('a rule groups by its labels across machines, holds until its threshold, titles from its template', () => {
  const rule = db
    .insert(correlationRules)
    .values({ projectId, name: 'Per service', matchers: [{ name: 'team', op: '=', value: 'shop' }], groupBy: ['service'], windowMin: 15, threshold: 2, resolveOn: 'all', titleTemplate: '{{service}}: {{alertname}}' })
    .returning()
    .get();
  fire('r1', { alertname: 'HighLatency', team: 'shop', service: 'checkout', instance: 'api-1:9100' });
  const first = incOf('r1');
  assert.equal(first.ruleId, rule.id);
  assert.equal(first.held, true, 'one alert, threshold two: held');
  assert.equal(first.title, 'checkout: HighLatency');

  fire('r2', { alertname: 'ErrorRate', team: 'shop', service: 'checkout', instance: 'api-7:9100' }); // another machine, same service
  const second = incOf('r2');
  assert.equal(second.id, first.id, 'same service: same incident, whatever the machine');
  assert.equal(second.held, false, 'threshold reached: listed and diagnosed');
  assert.equal(second.title, 'checkout: HighLatency, ErrorRate');
  assert.match(second.groupReason ?? '', /^the rule "Per service" says so: they share service/);

  fire('r3', { alertname: 'HighLatency', team: 'shop', service: 'cart', instance: 'api-1:9100' }); // same machine, other service
  assert.notEqual(incOf('r3').id, first.id, 'the rule groups by service, not by machine');

  const counted = db.select().from(correlationRules).where(eq(correlationRules.id, rule.id)).get()!;
  assert.deepEqual([counted.incidentsMade, counted.alertsGrouped], [2, 3]);

  fire('r9', { alertname: 'HighLatency', team: 'payments', instance: 'api-1:9100' });
  assert.equal(incOf('r9').ruleId, null, 'alerts no rule matches are grouped the built-in way');
});

test('resolve on first: one resolved closes the incident and its other alerts', () => {
  db.insert(correlationRules)
    .values({ projectId, name: 'Probe', matchers: [{ name: 'alertname', op: '=~', value: 'Probe.*' }], groupBy: ['target'], windowMin: 15, threshold: 1, resolveOn: 'first', titleTemplate: '', priority: 1 })
    .run();
  fire('p1', { alertname: 'ProbeFailed', target: 'shop.example.com' });
  fire('p2', { alertname: 'ProbeSlow', target: 'shop.example.com' });
  const inc = incOf('p1');
  assert.equal(incOf('p2').id, inc.id);
  fire('p1', { alertname: 'ProbeFailed', target: 'shop.example.com' }, 'resolved');
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'resolved');
  assert.equal(db.select().from(alerts).where(eq(alerts.fingerprint, 'p2')).get()!.status, 'resolved');
});
