import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contentHash, parseWebhook, pathGet, sampleWebhook, INTEGRATION_KINDS } from './webhooks.ts';

const ok = (r: ReturnType<typeof parseWebhook>) => {
  if (!r.ok) throw new Error(r.error);
  return r.alerts;
};

// Shapes as the senders document them; values are made up.
const AM = {
  version: '4',
  status: 'firing',
  receiver: 'supops',
  alerts: [
    {
      status: 'firing',
      labels: { alertname: 'DiskFilling', severity: 'warning', instance: 'web-1:9100', mountpoint: '/var' },
      annotations: { summary: '/var on web-1 fills in 6 hours' },
      startsAt: '2026-10-16T08:00:00Z',
      generatorURL: 'http://prometheus.example.com/graph?g0.expr=x',
      fingerprint: 'a1b2c3d4e5f6',
    },
    { status: 'resolved', labels: { alertname: 'HighCPU', severity: 'critical', instance: 'db-1:9100' }, annotations: {}, startsAt: '2026-10-16T07:00:00Z', fingerprint: 'ffee' },
    { status: 'firing', labels: {}, annotations: {} },
  ],
};

test('Alertmanager: every alert in the batch, firing and resolved, with its fingerprint', () => {
  const a = ok(parseWebhook('alertmanager', AM));
  assert.equal(a.length, 2, 'an alert without labels is skipped');
  assert.deepEqual(
    { fp: a[0]!.fingerprint, title: a[0]!.title, sev: a[0]!.severity, status: a[0]!.status, summary: a[0]!.summary },
    { fp: 'a1b2c3d4e5f6', title: 'DiskFilling', sev: 'warning', status: 'firing', summary: '/var on web-1 fills in 6 hours' },
  );
  assert.equal(a[1]!.status, 'resolved');
  assert.equal(a[1]!.severity, 'critical');
  assert.equal(a[0]!.startsAt, Date.parse('2026-10-16T08:00:00Z'));
  assert.equal(parseWebhook('alertmanager', { hello: 1 }).ok, false);
});

test('Grafana: the same shape, linking to the panel when it gives one', () => {
  const g = ok(parseWebhook('grafana', { alerts: [{ ...AM.alerts[0], panelURL: 'https://grafana.example.com/d/x?viewPanel=2' }] }));
  assert.equal(g[0]!.link, 'https://grafana.example.com/d/x?viewPanel=2');
});

test('PagerDuty v3: an incident, firing until resolved; other events are ignored', () => {
  const ev = (event_type: string) => ({
    event: {
      event_type,
      occurred_at: '2026-10-16T08:00:00Z',
      data: { id: 'Q1ABC', type: 'incident', title: 'Checkout errors', urgency: 'high', number: 42, html_url: 'https://acme.pagerduty.com/incidents/Q1ABC', service: { summary: 'checkout' }, priority: { summary: 'P1' } },
    },
  });
  const [t] = ok(parseWebhook('pagerduty', ev('incident.triggered')));
  assert.equal(t!.fingerprint, 'pagerduty:Q1ABC');
  assert.equal(t!.severity, 'critical');
  assert.equal(t!.labels.service, 'checkout');
  assert.equal(t!.status, 'firing');
  assert.equal(ok(parseWebhook('pagerduty', ev('incident.acknowledged')))[0]!.status, 'firing', 'acknowledged is still happening');
  assert.equal(ok(parseWebhook('pagerduty', ev('incident.resolved')))[0]!.status, 'resolved');
  assert.deepEqual(ok(parseWebhook('pagerduty', { event: { event_type: 'service.updated', data: { type: 'service' } } })), []);
  assert.equal(parseWebhook('pagerduty', { messages: [] }).ok, false);
});

test('Opsgenie: priority to severity, key:value tags and details to labels, Close resolves', () => {
  const body = (action: string) => ({
    action,
    alert: { alertId: 'x-1', alias: 'db-1-disk', message: 'Disk almost full', priority: 'P2', tags: ['team:storage', 'urgent'], entity: 'db-1', details: { region: 'eu-1' } },
  });
  const [a] = ok(parseWebhook('opsgenie', body('Create')));
  assert.equal(a!.fingerprint, 'opsgenie:db-1-disk');
  assert.equal(a!.severity, 'critical');
  assert.equal(a!.labels.team, 'storage');
  assert.equal(a!.labels.region, 'eu-1');
  assert.equal(a!.labels.host, 'db-1');
  assert.equal(ok(parseWebhook('opsgenie', body('Close')))[0]!.status, 'resolved');
});

test('generic: common field names are found without setup; paths override them', () => {
  const [a] = ok(parseWebhook('generic', { name: 'Queue backlog', level: 'critical', state: 'firing', hostname: 'worker-3', id: 'q-77' }));
  assert.equal(a!.title, 'Queue backlog');
  assert.equal(a!.severity, 'critical');
  assert.equal(a!.labels.host, 'worker-3');
  assert.equal(a!.fingerprint, 'generic:q-77');
  const custom = ok(
    parseWebhook(
      'generic',
      { events: [{ check: { label: 'Login page' }, result: 'RECOVERED', target: 'shop.example.com' }] },
      { alertsPath: 'events', titlePath: 'check.label', statusPath: 'result', hostPath: 'target', resolvedValues: ['recovered'] },
    ),
  );
  assert.equal(custom[0]!.title, 'Login page');
  assert.equal(custom[0]!.status, 'resolved');
  assert.equal(custom[0]!.labels.host, 'shop.example.com');
  assert.equal(parseWebhook('generic', { nothing: 'here' }).ok, false);
});

test('labels are bounded: odd keys dropped, values cut, at most 64', () => {
  const labels: Record<string, string> = { 'bad key!': 'x', ok: 'y'.repeat(2000) };
  for (let i = 0; i < 100; i++) labels[`k${i}`] = 'v';
  const [a] = ok(parseWebhook('alertmanager', { alerts: [{ labels: { alertname: 'X', ...labels } }] }));
  assert.equal(a!.labels['bad key!'], undefined);
  assert.equal(a!.labels.ok!.length, 512);
  assert.ok(Object.keys(a!.labels).length <= 64);
});

test('every kind can produce a test payload its own parser understands', async () => {
  const { parseChangePayload } = await import('./changes.ts');
  const change = parseChangePayload(sampleWebhook('changes'));
  assert.ok(change.ok && change.changes[0]!.labels?.supops_test === 'true', 'changes: a test change, marked');
  for (const kind of INTEGRATION_KINDS.filter((k) => k !== 'changes')) {
    const firing = ok(parseWebhook(kind, sampleWebhook(kind, 'firing')));
    const resolved = ok(parseWebhook(kind, sampleWebhook(kind, 'resolved')));
    assert.equal(firing[0]!.status, 'firing', kind);
    assert.equal(resolved[0]!.status, 'resolved', kind);
    assert.equal(firing[0]!.fingerprint, resolved[0]!.fingerprint, `${kind}: the resolve finds its alert`);
    assert.equal(firing[0]!.labels.supops_test, 'true', `${kind}: marked as a test`);
  }
});

test('content hash: same content is a repeat, any real change is not', () => {
  const base = { title: 'X', severity: 'warning', summary: 's', labels: { a: '1', b: '2' }, status: 'firing' };
  assert.equal(contentHash(base), contentHash({ ...base, labels: { b: '2', a: '1' } }), 'label order does not matter');
  assert.notEqual(contentHash(base), contentHash({ ...base, severity: 'critical' }));
  assert.notEqual(contentHash(base), contentHash({ ...base, labels: { a: '1', b: '3' } }));
});

test('pathGet reads dotted paths and indexes, and never walks the prototype', () => {
  assert.equal(pathGet({ a: { b: [{ c: 5 }] } }, 'a.b[0].c'), 5);
  assert.equal(pathGet({ a: 1 }, 'a.b.c'), undefined);
  assert.equal(pathGet({}, 'constructor'), undefined);
});

test('acknowledgements at the source come through, and SupOps\' own incidents never echo back', () => {
  const pd = (extra: Record<string, unknown>, type = 'incident.acknowledged') => ({ event: { event_type: type, agent: { summary: 'Bob' }, data: { id: 'Q9', type: 'incident', title: 'X', urgency: 'high', ...extra } } });
  const [a] = ok(parseWebhook('pagerduty', pd({})));
  assert.deepEqual(a!.acknowledged, { by: 'Bob' });
  assert.equal(a!.externalId, 'Q9');
  assert.deepEqual(ok(parseWebhook('pagerduty', pd({ incident_key: 'supops-inc1' }, 'incident.triggered'))), []);
  const [o] = ok(parseWebhook('opsgenie', { action: 'Acknowledge', alert: { alias: 'db-1-disk', message: 'Disk', username: 'carol@example.com' } }));
  assert.deepEqual(o!.acknowledged, { by: 'carol@example.com' });
  assert.deepEqual(ok(parseWebhook('opsgenie', { action: 'Create', alert: { alias: 'supops-inc1', message: 'x' } })), []);
});
