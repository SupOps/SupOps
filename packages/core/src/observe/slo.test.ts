import { test } from 'node:test';
import assert from 'node:assert/strict';
import { atWindow, availabilityQueries, budgetRemaining, burnRate, burnSummary, daysToExhaustion, evaluateBurn } from './slo.ts';
import { RED_FAMILIES, redQueries } from './red.ts';

test('burn rate and budget: 0.1% budget, 1.44% errors burns it 14.4x too fast', () => {
  assert.equal(burnRate(0.0144, 0.999)!.toFixed(1), '14.4');
  assert.equal(burnRate(null, 0.999), null);
  assert.equal(budgetRemaining(0.0005, 0.999)!.toFixed(2), '0.50', 'half the budget spent');
  assert.equal(budgetRemaining(0.002, 0.999)!.toFixed(2), '-1.00', 'overspent');
  assert.equal(daysToExhaustion(0.5, 14.4, 30)!.toFixed(2), '1.04');
  assert.equal(daysToExhaustion(0.5, 0, 30), null);
});

test('multi-window rules: the long and the short window must both burn', () => {
  const fast = evaluateBurn({ '5m': 0.02, '1h': 0.016, '30m': 0.01, '6h': 0.004, '2h': 0.006, '24h': 0.002 }, 0.999);
  assert.deepEqual(fast.firing.map((f) => [f.rule, f.severity, f.burn]), [['fast', 'critical', 16]]);
  // The problem has stopped: the hour still looks bad, the last 5 minutes do not.
  const recovered = evaluateBurn({ '5m': 0.0001, '1h': 0.016 }, 0.999);
  assert.equal(recovered.firing.length, 0);
  const slow = evaluateBurn({ '24h': 0.0035, '2h': 0.004, '5m': 0.004, '1h': 0.004, '30m': 0.004, '6h': 0.004 }, 0.999);
  assert.deepEqual(slow.firing.map((f) => f.rule), ['slow']);
  assert.equal(evaluateBurn({}, 0.999).firing.length, 0, 'no data never fires');
});

test('alert text, window substitution, and availability from RED queries', () => {
  const text = burnSummary({ name: 'Checkout availability', target: 0.999, windowDays: 30 }, { rule: 'fast', severity: 'critical', long: '1h', short: '5m', rate: 14.4, burn: 16 }, 0.6);
  assert.equal(text, 'Checkout availability: the error budget is being spent 16× faster than sustainable over 1h (and over 5m). Objective 99.90% over 30 days; 60% of the budget is left, gone in 1.1 days at this rate.');
  assert.equal(atWindow('sum(rate(x[$window]))/sum(rate(y[$window]))', '1h'), 'sum(rate(x[1h]))/sum(rate(y[1h]))');
  const q = availabilityQueries(redQueries(RED_FAMILIES[0]!, 'service_name', 'checkout'));
  assert.deepEqual(q, {
    total: 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[$window]))',
    good: 'sum(rate(http_server_request_duration_seconds_count{service_name="checkout"}[$window])) - (sum(rate(http_server_request_duration_seconds_count{service_name="checkout",http_response_status_code=~"5.."}[$window])) or vector(0))',
  });
});
