import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageBlock } from './coverage.ts';

test('missing and failing sources are named, with what to connect', () => {
  const text = coverageBlock({
    sources: [
      { slug: 'prom-main', kind: 'prometheus', problem: null },
      { slug: 'loki-main', kind: 'loki', problem: 'unreachable at the last connection test' },
    ],
    machines: 2,
    clusters: 0,
    alertSenders: 1,
  });
  assert.match(text, /^DATA SOURCES/);
  assert.match(text, /- Metrics: prom-main\n/);
  assert.match(text, /- Logs: loki-main -- NOT WORKING: unreachable/);
  assert.match(text, /- Traces: none connected \(add Tempo, Jaeger or SigNoz/);
  assert.match(text, /- Alerts: prom-main; 1 webhook sender\n/);
  assert.match(text, /- Machines: 2 reachable over SSH; Kubernetes clusters: none/);
  assert.match(text, /First use what you DO have/);
  assert.match(text, /Do not refuse a task just because a data source is missing if a reachable machine can get the answer/);
  // With machines but no cluster, point the agent at kubectl/oc over SSH, not a decline.
  assert.match(text, /run kubectl or oc on a reachable machine/);
  assert.match(text, /before reporting that pods or cluster state cannot be checked/);
});

test('no SSH-to-cluster hint when a cluster is connected, or when there are no machines', () => {
  const withCluster = coverageBlock({ sources: [], machines: 3, clusters: 1, alertSenders: 0 });
  assert.doesNotMatch(withCluster, /run kubectl or oc on a reachable machine/);
  const noMachines = coverageBlock({ sources: [], machines: 0, clusters: 0, alertSenders: 0 });
  assert.doesNotMatch(noMachines, /run kubectl or oc on a reachable machine/);
});

test('with everything connected and working there is no instruction about gaps', () => {
  const text = coverageBlock({
    sources: [
      { slug: 'prom', kind: 'prometheus', problem: null },
      { slug: 'loki', kind: 'loki', problem: null },
      { slug: 'tempo', kind: 'tempo', problem: null },
      { slug: 'am', kind: 'alertmanager', problem: null },
    ],
    machines: 0,
    clusters: 1,
    alertSenders: 0,
  });
  assert.doesNotMatch(text, /connect or fix/);
  assert.match(text, /Kubernetes clusters: 1/);
});
