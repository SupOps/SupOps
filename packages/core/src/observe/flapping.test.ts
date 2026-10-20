import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasSettled, isFlapping, stateChanges } from './flapping.ts';

const MIN = 60_000;
const now = 100 * MIN;
const opts = { changes: 4, windowMs: 30 * MIN };

test('fired-resolved-fired-resolved within the window is flapping; once is not', () => {
  const twice = [
    { firedAt: now - 25 * MIN, resolvedAt: now - 20 * MIN },
    { firedAt: now - 15 * MIN, resolvedAt: now - 10 * MIN },
  ];
  assert.equal(stateChanges(twice, now - opts.windowMs), 4);
  assert.equal(isFlapping(twice, now, opts), true);
  assert.equal(isFlapping([{ firedAt: now - 5 * MIN, resolvedAt: null }], now, opts), false);
});

test('only changes inside the window count', () => {
  const old = [
    { firedAt: now - 90 * MIN, resolvedAt: now - 80 * MIN },
    { firedAt: now - 70 * MIN, resolvedAt: now - 60 * MIN },
    { firedAt: now - 5 * MIN, resolvedAt: null },
  ];
  assert.equal(isFlapping(old, now, opts), false);
});

test('settled: no change at all in the window, even if still firing', () => {
  assert.equal(hasSettled([{ firedAt: now - 40 * MIN, resolvedAt: null }], now, opts.windowMs), true);
  assert.equal(hasSettled([{ firedAt: now - 40 * MIN, resolvedAt: now - 2 * MIN }], now, opts.windowMs), false);
});
