import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { emailMessage, headline, opsgenieRequest, pagerdutyEvent, signWebhook, slackMessage, teamsCard, webhookBody, type IncidentNote } from './format.ts';

const n: IncidentNote = {
  id: 'inc1',
  title: 'DiskFilling on web-1',
  severity: 'critical',
  status: 'open',
  targets: ['web-1'],
  alertCount: 2,
  rootCause: 'Log rotation stopped on 12 Oct; /var/log/app grew 40 GB.',
  confidence: 'high',
  owner: 'Ana',
  acknowledgedBy: null,
  url: 'https://supops.example.com/observability/incidents/inc1',
  openedAt: Date.parse('2026-10-16T08:00:00Z'),
};

test('every channel leads with the same headline and links back', () => {
  assert.equal(headline('opened', n), 'New incident: DiskFilling on web-1 (critical)');
  assert.equal(headline('resolved', n), 'Resolved: DiskFilling on web-1');
  const s = slackMessage('opened', n);
  assert.equal(s.text, headline('opened', n));
  assert.match(JSON.stringify(s.blocks), /Open in SupOps/);
  assert.match(JSON.stringify(teamsCard('opened', n)), /AdaptiveCard.*Open in SupOps/s);
  const e = emailMessage('diagnosed', n);
  assert.equal(e.subject, '[SupOps] Diagnosis ready: DiskFilling on web-1 (critical)');
  assert.match(e.text, /Log rotation stopped/);
  assert.match(e.html, /href="https:\/\/supops.example.com/);
});

test('text from alerts cannot inject markup into Slack or email', () => {
  const evil = { ...n, title: '<!channel> <script>x</script> & co', url: null };
  assert.doesNotMatch(JSON.stringify(slackMessage('opened', evil).blocks), /<!channel>|<script>/);
  assert.doesNotMatch(emailMessage('opened', evil).html, /<script>/);
});

test('PagerDuty: one alert per incident, triggered, acknowledged and resolved by dedup key', () => {
  const t = pagerdutyEvent('opened', n, 'R0UT1NG')!;
  assert.deepEqual([t.event_action, t.dedup_key, (t.payload as { severity: string }).severity], ['trigger', 'supops-inc1', 'critical']);
  assert.deepEqual(pagerdutyEvent('acknowledged', n, 'R0UT1NG'), { routing_key: 'R0UT1NG', event_action: 'acknowledge', dedup_key: 'supops-inc1' });
  assert.equal(pagerdutyEvent('resolved', n, 'R0UT1NG')!.event_action, 'resolve');
  assert.equal(pagerdutyEvent('diagnosed', n, 'R0UT1NG'), null, 'Events v2 has no notes');
});

test('Opsgenie: create, acknowledge, close and notes, all by alias', () => {
  const c = opsgenieRequest('opened', n)!;
  assert.equal(c.path, '/v2/alerts');
  assert.equal(c.body.alias, 'supops-inc1');
  assert.equal(c.body.priority, 'P1');
  assert.equal(opsgenieRequest('acknowledged', n)!.path, '/v2/alerts/supops-inc1/acknowledge?identifierType=alias');
  assert.equal(opsgenieRequest('resolved', n)!.path, '/v2/alerts/supops-inc1/close?identifierType=alias');
  assert.equal(opsgenieRequest('diagnosed', n)!.path, '/v2/alerts/supops-inc1/notes?identifierType=alias');
});

test('webhooks are signed over timestamp and body, so a receiver can check and refuse replays', () => {
  const body = JSON.stringify(webhookBody('opened', n, 'd1', 1_000));
  const sig = signWebhook('s3cret', 1_000, body);
  assert.equal(sig, `sha256=${createHmac('sha256', 's3cret').update(`1000.${body}`).digest('hex')}`);
  assert.notEqual(signWebhook('s3cret', 1_001, body), sig);
  assert.equal(JSON.parse(body).incident.id, 'inc1');
});
