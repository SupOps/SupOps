import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAnomaly, mad, median, type Point } from './anomaly.ts';
import { forecastLimit, formatEta, holt, linearFit } from './forecast.ts';

const STEP = 5 * 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

/** A deterministic wobble so tests never depend on Math.random. */
const wobble = (i: number) => Math.sin(i * 1.7) * 0.5 + Math.cos(i * 0.37) * 0.3;
const series = (n: number, f: (i: number, at: number) => number, start = T0): Point[] =>
  Array.from({ length: n }, (_, i) => ({ at: start + i * STEP, value: f(i, start + i * STEP) }));

test('median and MAD', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Math.abs(mad([1, 2, 3, 4, 100]) - 1.4826) < 1e-9, 'one outlier does not inflate the spread');
});

test('a steady series is not anomalous', () => {
  const r = detectAnomaly(series(100, (i) => 50 + wobble(i)));
  assert.ok(r && !r.anomalous);
});

test('a sustained jump is anomalous; a single spike is not', () => {
  const base = series(100, (i) => 50 + wobble(i));
  const jump = base.map((p, i) => (i >= 97 ? { ...p, value: 80 } : p));
  const r = detectAnomaly(jump, { badDirection: 'up' });
  assert.ok(r?.anomalous);
  assert.equal(r?.direction, 'up');
  assert.equal(r?.method, 'recent');

  const spike = base.map((p, i) => (i === 99 ? { ...p, value: 80 } : p));
  assert.equal(detectAnomaly(spike)?.anomalous, false);
});

test('a jump in the harmless direction is not reported', () => {
  const base = series(100, (i) => 50 + wobble(i));
  const drop = base.map((p, i) => (i >= 97 ? { ...p, value: 10 } : p));
  assert.equal(detectAnomaly(drop, { badDirection: 'up' })?.anomalous, false);
  assert.equal(detectAnomaly(drop, { badDirection: 'both' })?.anomalous, true);
});

test('a daily pattern is learned: the nightly peak is normal, the same peak at noon is not', () => {
  // Three days, high (90) between 02:00 and 03:00 every night, ~20 otherwise.
  const daily = (at: number) => (new Date(at).getUTCHours() === 2 ? 90 : 20);
  const days = series(3 * 288, (i, at) => daily(at) + wobble(i));
  // Now it is 02:15 on day 4: the high value matches previous nights.
  const night = [...days, ...series(4, (i) => 90 + wobble(i), T0 + 3 * 24 * HOUR + 2 * HOUR)];
  const n = detectAnomaly(night.filter((p) => p.at <= T0 + 3 * 24 * HOUR + 2 * HOUR + 3 * STEP));
  assert.equal(n?.method, 'seasonal');
  assert.equal(n?.anomalous, false);
  // Same value at 12:00 is far outside what noon looks like.
  const noon = [...days, ...series(4, () => 90, T0 + 3 * 24 * HOUR + 12 * HOUR)];
  assert.equal(detectAnomaly(noon)?.anomalous, true);
});

test('minDelta ignores changes too small to matter', () => {
  const flat = series(100, () => 10);
  const tiny = flat.map((p, i) => (i >= 97 ? { ...p, value: 10.5 } : p));
  assert.equal(detectAnomaly(tiny, { minDelta: 2 })?.anomalous, false);
});

test('linear fit and Holt follow a straight line', () => {
  const pts = series(50, (i) => 100 - i);
  const f = linearFit(pts)!;
  assert.ok(Math.abs(f.slope * STEP + 1) < 1e-9);
  assert.equal(f.r2, 1);
  const h = holt(pts)!;
  assert.ok(h.trend < 0);
});

test('disk filling steadily: time until it runs out', () => {
  // 100 GB free, losing 2 GB an hour, sampled every 5 minutes for 12 hours.
  const GB = 1e9;
  const pts = series(145, (i) => 100 * GB - (i * STEP * 2 * GB) / HOUR + wobble(i) * 0.05 * GB);
  const f = forecastLimit(pts, { value: 0, when: 'below' })!;
  const hoursLeft = f.etaMs! / HOUR;
  assert.ok(Math.abs(hoursLeft - 38) < 1, `about 38h left, got ${hoursLeft}`);
  assert.equal(f.confidence, 'high');
  assert.ok(f.slopePerHour < 0);
});

test('not heading to the limit: no ETA', () => {
  const pts = series(145, (i) => 100 + i * 0.1);
  assert.equal(forecastLimit(pts, { value: 0, when: 'below' })?.etaMs, null);
});

test('already past the limit: ETA 0', () => {
  const pts = series(30, (i) => 99 + i * 0.1);
  assert.equal(forecastLimit(pts, { value: 100, when: 'above' })?.etaMs, 0);
});

test('a noisy, flat series is low confidence', () => {
  const pts = series(145, (i) => 50 + Math.sin(i) * 20 - i * 0.01);
  const f = forecastLimit(pts, { value: 0, when: 'below' });
  assert.equal(f?.confidence, 'low');
});

test('too little history: no forecast', () => {
  assert.equal(forecastLimit(series(5, (i) => 10 - i), { value: 0, when: 'below' }), null);
});

test('ETAs read naturally', () => {
  assert.equal(formatEta(0), 'now');
  assert.equal(formatEta(20_000), '<1m', 'not "0m"');
  assert.equal(formatEta(45 * 60_000), '45m');
  assert.equal(formatEta(3 * HOUR + 20 * 60_000), '3h 20m');
  assert.equal(formatEta(72 * HOUR), '3.0 days');
});
