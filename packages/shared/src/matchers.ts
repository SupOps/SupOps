/**
 * Label matchers in Alertmanager's syntax, the one grammar SupOps uses wherever a
 * person picks out alerts: maintenance windows, correlation rules, routing and
 * extraction rules.
 *
 *   env="prod", service=~"api|web", severity!="info"
 *
 * Four operators, as in Alertmanager: `=` equals, `!=` differs, `=~` matches the
 * regular expression (anchored at both ends), `!~` does not. Values may be quoted
 * ("..." with \" and \\ escapes) or bare. A label the alert does not have counts as
 * the empty string, again as in Alertmanager, so `team=""` means "has no team".
 *
 * Regular expressions come from people and run on every incoming alert, so they are
 * kept short and anything that can take exponential time (a repeated group that
 * itself repeats, back-references) is refused when the matcher is saved.
 */
export type MatchOp = '=' | '!=' | '=~' | '!~';

export interface Matcher {
  name: string;
  op: MatchOp;
  value: string;
}

export const MAX_MATCHERS = 20;
const MAX_VALUE = 256;
/** Text a regex is run against is cut to this, so a huge label cannot slow ingest. */
const MAX_SUBJECT = 1024;

const NAME = /^[A-Za-z_][A-Za-z0-9_.\-]*$/;

/** Why a regex is refused, or null if it is safe to run on every alert. */
export function unsafeRegex(source: string): string | null {
  if (source.length > MAX_VALUE) return `is longer than ${MAX_VALUE} characters`;
  if (/\\[1-9]|\\k</.test(source)) return 'uses a back-reference';
  if (/\(\?<?[=!]/.test(source)) return 'uses a look-around';
  // A group containing a quantifier, itself quantified: (a+)+, (\w*)*, (x{2,})+ ...
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+,?\d*\})(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(source)) {
    return 'repeats a group that already repeats, which can take forever on some text';
  }
  // A repeated group of alternatives that can overlap: (a|aa)*, (x|xy)+ ...
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*]|\{\d+,?\d*\})/.test(source)) {
    return 'repeats a group of alternatives, which can take forever on some text; list the values without repeating the group';
  }
  try {
    new RegExp(source);
  } catch (e) {
    return `is not a valid regular expression (${e instanceof Error ? e.message : String(e)})`;
  }
  return null;
}

export type ParseResult = { ok: true; matchers: Matcher[] } | { ok: false; error: string };

/** Parse `a="1", b=~"x|y"` (optionally wrapped in braces). An empty string is no matchers. */
export function parseMatchers(text: string): ParseResult {
  let s = text.trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim();
  const out: Matcher[] = [];
  let i = 0;
  const fail = (error: string): ParseResult => ({ ok: false, error });
  const skipSpace = () => {
    while (i < s.length && /\s/.test(s[i]!)) i++;
  };
  while (true) {
    skipSpace();
    if (i >= s.length) break;
    const nameStart = i;
    while (i < s.length && /[A-Za-z0-9_.\-]/.test(s[i]!)) i++;
    const name = s.slice(nameStart, i);
    if (!name) return fail(`expected a label name at "${s.slice(nameStart, nameStart + 20)}"`);
    if (!NAME.test(name)) return fail(`"${name}" is not a valid label name`);
    skipSpace();
    const op = (['=~', '!~', '!=', '='] as const).find((o) => s.startsWith(o, i));
    if (!op) return fail(`expected =, !=, =~ or !~ after "${name}"`);
    i += op.length;
    skipSpace();
    let value = '';
    if (s[i] === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const c = s[i]!;
        if (c === '\\' && i + 1 < s.length) {
          const n = s[i + 1]!;
          value += n === 'n' ? '\n' : n;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) return fail(`the value for "${name}" has no closing quote`);
    } else {
      const start = i;
      while (i < s.length && s[i] !== ',') i++;
      value = s.slice(start, i).trim();
    }
    if (value.length > MAX_VALUE) return fail(`the value for "${name}" is longer than ${MAX_VALUE} characters`);
    if (op === '=~' || op === '!~') {
      const why = unsafeRegex(value);
      if (why) return fail(`the pattern for "${name}" ${why}`);
    }
    out.push({ name, op, value });
    if (out.length > MAX_MATCHERS) return fail(`use at most ${MAX_MATCHERS} matchers`);
    skipSpace();
    if (i >= s.length) break;
    if (s[i] !== ',') return fail(`expected a comma after the value for "${name}"`);
    i++;
  }
  return { ok: true, matchers: out };
}

const compiled = new Map<string, RegExp>();
function anchored(source: string): RegExp {
  let re = compiled.get(source);
  if (!re) {
    re = new RegExp(`^(?:${source})$`, 's');
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, re);
  }
  return re;
}

export function matchOne(m: Matcher, labels: Record<string, string | undefined>): boolean {
  const v = labels[m.name] ?? '';
  switch (m.op) {
    case '=':
      return v === m.value;
    case '!=':
      return v !== m.value;
    case '=~':
      return anchored(m.value).test(v.slice(0, MAX_SUBJECT));
    case '!~':
      return !anchored(m.value).test(v.slice(0, MAX_SUBJECT));
  }
}

/** Every matcher holds. No matchers match everything: callers that must not allow that check it. */
export const matchesAll = (ms: Matcher[], labels: Record<string, string | undefined>): boolean => ms.every((m) => matchOne(m, labels));

const quote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
export const formatMatchers = (ms: Matcher[]): string => ms.map((m) => `${m.name}${m.op}${quote(m.value)}`).join(', ');

/**
 * The labels an alert is matched on: its own labels, plus `alertname`, `severity`
 * and `source` from the alert itself when the labels do not already carry them.
 */
export function alertMatchLabels(a: { title: string; severity: string; source?: string; labels?: Record<string, string> | null }): Record<string, string> {
  const l = a.labels ?? {};
  return { ...l, alertname: l.alertname || a.title, severity: l.severity || a.severity, ...(a.source ? { source: l.source || a.source } : {}) };
}
