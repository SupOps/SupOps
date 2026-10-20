import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchers } from '@supops/shared';
import { inSlot, mutingWindow, validSlot, windowActive } from './maintenance.ts';

const m = (s: string) => {
  const r = parseMatchers(s);
  if (!r.ok) throw new Error(r.error);
  return r.matchers;
};
const H = 3_600_000;
const t0 = Date.parse('2026-10-18T12:00:00Z'); // a Sunday

test('a one-off window: from its start, until its end, unless cancelled', () => {
  const w = { matchers: m('env="prod"'), startsAt: t0, endsAt: t0 + 2 * H, recurrence: null, cancelledAt: null };
  assert.equal(windowActive(w, t0 - 1), false);
  assert.equal(windowActive(w, t0), true);
  assert.equal(windowActive(w, t0 + 2 * H - 1), true);
  assert.equal(windowActive(w, t0 + 2 * H), false, 'the end is exclusive');
  assert.equal(windowActive({ ...w, cancelledAt: t0 + H }, t0 + H + 1), false, 'ended early');
});

test('a weekly slot, in its own time zone, including one that crosses midnight', () => {
  // Sundays 02:00-04:00 in Berlin (UTC+2 in October): 00:00-02:00 UTC.
  const sunday = { days: [0], start: '02:00', end: '04:00', timezone: 'Europe/Berlin' };
  assert.equal(inSlot(sunday, Date.parse('2026-10-18T00:30:00Z')), true);
  assert.equal(inSlot(sunday, Date.parse('2026-10-18T02:30:00Z')), false);
  assert.equal(inSlot(sunday, Date.parse('2026-10-19T00:30:00Z')), false, 'a Monday');
  // Saturdays 23:00-01:00 UTC: the slot runs into Sunday.
  const late = { days: [6], start: '23:00', end: '01:00', timezone: 'UTC' };
  assert.equal(inSlot(late, Date.parse('2026-10-17T23:30:00Z')), true, 'Saturday night');
  assert.equal(inSlot(late, Date.parse('2026-10-18T00:30:00Z')), true, 'early Sunday belongs to the Saturday slot');
  assert.equal(inSlot(late, Date.parse('2026-10-18T23:30:00Z')), false, 'Sunday night is not listed');
});

test('slots are checked when saved', () => {
  assert.equal(validSlot({ days: [], start: '01:00', end: '02:00', timezone: 'UTC' }), 'Pick at least one day.');
  assert.match(validSlot({ days: [1], start: '25:00', end: '02:00', timezone: 'UTC' })!, /HH:MM/);
  assert.match(validSlot({ days: [1], start: '01:00', end: '01:00', timezone: 'UTC' })!, /same/);
  assert.match(validSlot({ days: [1], start: '01:00', end: '02:00', timezone: 'Mars/Olympus' })!, /time zone/);
  assert.equal(validSlot({ days: [1, 3], start: '22:00', end: '02:00', timezone: 'Asia/Kolkata' }), null);
});

test('the muting window is the first active one whose matchers all hold; no matchers mutes nothing', () => {
  const windows = [
    { id: 'empty', matchers: [], startsAt: 0, endsAt: Infinity, recurrence: null, cancelledAt: null },
    { id: 'db', matchers: m('service="db", env="prod"'), startsAt: 0, endsAt: Infinity, recurrence: null, cancelledAt: null },
  ];
  assert.equal(mutingWindow(windows, { service: 'db', env: 'prod' }, t0)?.id, 'db');
  assert.equal(mutingWindow(windows, { service: 'db', env: 'staging' }, t0), null);
  assert.equal(mutingWindow(windows, { anything: 'x' }, t0), null, 'an empty window never mutes everything');
});
