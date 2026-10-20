import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveBreach, learnLimit } from './adaptive.ts';

test('a limit learned from a week: P99 + 2 x IQR upward, P1 - 2 x IQR downward', () => {
  assert.deepEqual(learnLimit({ p01: 10, p25: 40, p75: 60, p99: 90 }, 'up', { iqrs: 2 }), { upper: 130, lower: null });
  assert.deepEqual(learnLimit({ p01: 10, p25: 40, p75: 60, p99: 90 }, 'both', { iqrs: 1 }), { upper: 110, lower: -10 });
  assert.deepEqual(learnLimit({ p01: 5, p25: 5, p75: 5, p99: 5 }, 'up', { iqrs: 2 }), { upper: 5.5, lower: null }, 'a flat series still gets some room');
  assert.equal(learnLimit({ p25: null, p75: 1 }, 'up', { iqrs: 2 }), null, 'no history, no limit');
});

test('3 of the last 5 minutes past the limit fire; a single spike does not', () => {
  const lim = { upper: 100, lower: null };
  assert.deepEqual(adaptiveBreach([50, 60, 140, 55, 60], lim), { over: 1, firing: false, side: 'above' });
  assert.deepEqual(adaptiveBreach([10, 120, 50, 130, 150], lim), { over: 3, firing: true, side: 'above' });
  assert.equal(adaptiveBreach([150, 150, 150, 50, 50, 50, 50], lim).firing, false, 'only the latest five count');
  assert.deepEqual(adaptiveBreach([1, 1, 1], { upper: null, lower: 5 }), { over: 3, firing: true, side: 'below' });
});
