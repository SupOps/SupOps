import { matchesAll, type Matcher } from '@supops/shared';

/**
 * Maintenance windows: planned work during which matching alerts are expected.
 *
 * A window is a start and an end, both absolute -- never a duration that would shift
 * if the window were edited -- plus, optionally, a weekly slot (e.g. Sundays 02:00-04:00
 * in the team's time zone) that repeats within those bounds.
 */
export interface WeeklySlot {
  /** 0 = Sunday ... 6 = Saturday, in `timezone`. */
  days: number[];
  /** "HH:MM", 24-hour. An end before the start crosses midnight. */
  start: string;
  end: string;
  /** IANA name, e.g. "Europe/Berlin". */
  timezone: string;
}

export interface WindowLike {
  matchers: Matcher[];
  startsAt: number;
  endsAt: number;
  recurrence: WeeklySlot | null;
  cancelledAt: number | null;
}

const minutes = (hhmm: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export function validSlot(s: WeeklySlot): string | null {
  if (!s.days.length || s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Pick at least one day.';
  const a = minutes(s.start);
  const b = minutes(s.end);
  if (!(a >= 0 && a < 1440) || !(b >= 0 && b < 1440)) return 'Times are HH:MM, 24-hour.';
  if (a === b) return 'The start and end time are the same.';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s.timezone });
  } catch {
    return `"${s.timezone}" is not a time zone.`;
  }
  return null;
}

/** Weekday and minute of the day at `at`, in a time zone. */
function localTime(at: number, timezone: string): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Is `at` inside the weekly slot? A slot crossing midnight belongs to the day it starts. */
export function inSlot(s: WeeklySlot, at: number): boolean {
  const { day, minute } = localTime(at, s.timezone);
  const a = minutes(s.start);
  const b = minutes(s.end);
  if (a < b) return s.days.includes(day) && minute >= a && minute < b;
  // Crosses midnight: the late part of a listed day, or the early part of the day after one.
  return (s.days.includes(day) && minute >= a) || (s.days.includes((day + 6) % 7) && minute < b);
}

export function windowActive(w: WindowLike, at: number): boolean {
  if (w.cancelledAt !== null && w.cancelledAt <= at) return false;
  if (at < w.startsAt || at >= w.endsAt) return false;
  return w.recurrence ? inSlot(w.recurrence, at) : true;
}

/** The window muting this alert right now, if any. A window with no matchers mutes nothing. */
export function mutingWindow<W extends WindowLike>(windows: W[], labels: Record<string, string>, at: number): W | null {
  return windows.find((w) => w.matchers.length > 0 && windowActive(w, at) && matchesAll(w.matchers, labels)) ?? null;
}
