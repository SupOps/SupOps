import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deployVerdict, familiesIn, redQueries, RED_FAMILIES } from './red.ts';

test('the conventions present are recognised from metric names', () => {
  assert.deepEqual(familiesIn(['up', 'http_server_requests_seconds_bucket', 'http_server_requests_seconds_count', 'istio_request_duration_milliseconds_bucket']).map((f) => f.id), ['micrometer', 'istio']);
  assert.deepEqual(familiesIn(['up', 'node_load1']), []);
});

test('RED queries: rate, error ratio and percentiles, in seconds whatever the histogram unit', () => {
  const istio = RED_FAMILIES.find((f) => f.id === 'istio')!;
  const q = redQueries(istio, 'destination_service_name', 'check"out');
  assert.equal(q.rate, 'sum(rate(istio_request_duration_milliseconds_count{destination_service_name="check\\"out"}[5m]))');
  assert.equal(q.p95, 'histogram_quantile(0.95, sum by (le) (rate(istio_request_duration_milliseconds_bucket{destination_service_name="check\\"out"}[5m]))) * 0.001');
  assert.match(q.errorRatio, /response_code=~"5\.\."/);
  const span = redQueries(RED_FAMILIES.find((f) => f.id === 'spanmetrics')!, 'service_name', 'api');
  assert.equal(span.rate, 'sum(rate(traces_span_metrics_calls_total{service_name="api"}[5m]))', 'span metrics count calls in their own counter');
});

test('deploy verdict: only meaningful regressions are flagged; a clean release is "same"', () => {
  const worse = deployVerdict([
    { name: 'p95 latency', kind: 'latency', before: 0.3, after: 2.5 },
    { name: 'errors', kind: 'errors', before: 0.002, after: 0.004 },
    { name: 'requests', kind: 'rate', before: 40, after: 610 },
    { name: 'memory', kind: 'memory', before: 4e8, after: 4.2e8 },
  ]);
  assert.equal(worse.overall, 'worse');
  assert.deepEqual(worse.signals.map((s) => [s.name, s.flag]), [['p95 latency', true], ['errors', false], ['requests', false], ['memory', false]]);
  assert.equal(worse.signals[0]!.note, '+733% (300 ms → 2500 ms)');

  assert.equal(deployVerdict([{ name: 'p95 latency', kind: 'latency', before: 0.2, after: 0.21 }, { name: 'errors', kind: 'errors', before: 0.01, after: 0.012 }]).overall, 'same');
  assert.equal(deployVerdict([{ name: 'errors', kind: 'errors', before: 0.08, after: 0.01 }]).overall, 'better');
  assert.equal(deployVerdict([{ name: 'errors', kind: 'errors', before: 0.01, after: 0.05 }]).signals[0]!.note, '1.0% → 5.0% of requests');
  assert.equal(deployVerdict([{ name: 'cpu', kind: 'cpu', before: null, after: 0.4 }]).overall, 'unknown');
});
