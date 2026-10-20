import { test } from 'node:test';
import assert from 'node:assert/strict';
import { changesBlock, detectRollouts, parseChangePayload, rankChanges, type WorkloadState } from './changes.ts';

const NOW = new Date('2026-10-18T10:00:00Z');

test('a CI sender can post one change, a list, or GitHub deployment_status', () => {
  const one = parseChangePayload({ service: 'checkout', version: '2.14.0', environment: 'prod', author: 'ci', url: 'https://ci.example.test/run/41', started_at: '2026-10-18T09:40:00Z', status: 'success' }, NOW);
  assert.ok(one.ok);
  assert.deepEqual(one.changes[0], { kind: 'deploy', title: 'checkout 2.14.0 deployed', service: 'checkout', environment: 'prod', version: '2.14.0', author: 'ci', url: 'https://ci.example.test/run/41', status: 'succeeded', startedAt: new Date('2026-10-18T09:40:00Z') });

  const list = parseChangePayload({ changes: [{ title: 'Raised pool size to 50', kind: 'config change', service: 'orders' }, { title: 'Revert 41', type: 'rollback', time: 1760781600 }] }, NOW);
  assert.ok(list.ok);
  assert.deepEqual(list.changes.map((c) => [c.kind, c.startedAt.toISOString()]), [['config', NOW.toISOString()], ['rollback', '2025-10-18T10:00:00.000Z']]);

  const gh = parseChangePayload({ deployment_status: { state: 'success', target_url: 'https://gh.example.test/x', created_at: '2026-10-18T09:45:00Z' }, deployment: { id: 9, ref: 'v5.4.0', environment: 'production', creator: { login: 'dev1' }, created_at: '2026-10-18T09:41:00Z' }, repository: { name: 'checkout' } }, NOW);
  assert.ok(gh.ok);
  assert.equal(gh.changes[0]!.title, 'checkout v5.4.0 deployed to production');
  assert.equal(gh.changes[0]!.externalId, 'github:9');
  assert.equal(gh.changes[0]!.status, 'succeeded');

  const bad = parseChangePayload({ nothing: true }, NOW);
  assert.equal(bad.ok, false);
});

test('rollouts: a new generation with a new image is a deploy, without one a config change; first sight records only', () => {
  const list = (gen: number, image: string) => ({ items: [{ kind: 'Deployment', metadata: { name: 'checkout', namespace: 'shop', generation: gen, annotations: { 'kubernetes.io/change-cause': 'ci run 41' } }, spec: { template: { spec: { containers: [{ name: 'app', image }] } } } }] });
  const first = detectRollouts(new Map(), list(7, 'registry.example.test/shop/checkout:2.13.2'), NOW);
  assert.equal(first.changes.length, 0, 'the first poll only learns what is there');
  const second = detectRollouts(first.next, list(8, 'registry.example.test/shop/checkout:2.14.0'), NOW);
  assert.deepEqual(second.changes.map((c) => [c.kind, c.title, c.version, c.previousVersion, c.externalId]), [['deploy', 'checkout rolled out 2.14.0 (was 2.13.2): ci run 41', '2.14.0', '2.13.2', 'k8s:shop/deployment/checkout@8']]);
  const third = detectRollouts(second.next, list(9, 'registry.example.test/shop/checkout:2.14.0'), NOW);
  assert.equal(third.changes[0]!.kind, 'config');
  const same = detectRollouts(third.next as Map<string, WorkloadState>, list(9, 'registry.example.test/shop/checkout:2.14.0'), NOW);
  assert.equal(same.changes.length, 0, 'nothing new, nothing recorded');
});

test('suspects: same service first, then upstream, nearest first; nothing after the failure or from days before', () => {
  const at = (min: number) => new Date(NOW.getTime() - min * 60_000);
  const c = (id: string, service: string | null, min: number, kind: 'deploy' | 'config' | 'action' = 'deploy') => ({ id, kind, title: id, service, targetId: null, startedAt: at(min), source: 'api' });
  const ranked = rankChanges({ startedAt: NOW, services: ['checkout'], targetIds: [], upstream: ['payments'] }, [
    c('payments-deploy', 'payments', 10),
    c('checkout-old', 'checkout', 300),
    c('checkout-recent', 'checkout', 20),
    c('search-deploy', 'search', 5),
    c('after', 'checkout', -30),
    c('last-week', 'checkout', 7 * 24 * 60),
  ]);
  assert.deepEqual(ranked.map((r) => r.change.id), ['checkout-recent', 'payments-deploy', 'checkout-old', 'search-deploy']);
  assert.equal(ranked[0]!.reason, '20 min before the first failure, on the failing service');
  assert.equal(ranked[1]!.relation, 'upstream');
  assert.match(changesBlock(ranked)!, /^RECENT CHANGES[^\n]*\n\[C1\] 2026-10-18 09:40 deploy: checkout-recent -- 20 min before/);
  assert.equal(changesBlock([]), null);
});
