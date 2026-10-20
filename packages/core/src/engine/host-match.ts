import type { TargetConfig } from '@supops/db';

/**
 * Matching an alert's host label to the machine it is about.
 *
 * Alerts name a machine however their exporter sees it -- `10.0.4.20:9100`,
 * `ip-10-0-4-20.us-east-1.compute.internal`, `jump-metrics` -- while a
 * target is registered by whatever address SupOps connects to (often a public IP or
 * a jump alias). So a target is matched on every name it is known by: its slug, the
 * address SupOps dials (for a machine reached directly), its alias behind a jump, and
 * the hostnames/IPs recorded for it (`addresses`, filled in by Test and discovery).
 */

interface MatchableTarget {
  id: string;
  slug: string;
  kind: string;
  config: TargetConfig;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Every form an alert's host value could take, normalised: full name, short name, IP. */
export function hostForms(value: string): string[] {
  let v = value.trim().toLowerCase();
  if (!v) return [];
  v = v.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  // Strip a port, but not from a bare IPv6 address.
  if (/^\[.*\](:\d+)?$/.test(v)) v = v.replace(/^\[(.*)\](:\d+)?$/, '$1');
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(':')[0]!;
  const out = new Set<string>([v]);
  const short = v.split('.')[0]!;
  if (!IPV4.test(v) && short) out.add(short);
  // AWS-style private DNS names carry the IP: ip-10-0-4-20[.region.compute.internal].
  const aws = short.match(/^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  if (aws) out.add(aws.slice(1).join('.'));
  return [...out];
}

/** The names a target is known by, normalised for matching. */
export function targetNames(t: MatchableTarget): string[] {
  const names = new Set<string>([t.slug.toLowerCase()]);
  if (t.config.kind === 'ssh') {
    const c = t.config;
    // A machine behind a jump shares the jump's host; that address is not its own.
    if (c.via?.alias) for (const f of hostForms(c.via.alias)) names.add(f);
    else for (const f of hostForms(c.host)) names.add(f);
    for (const a of c.addresses ?? []) for (const f of hostForms(a)) names.add(f);
  }
  return [...names];
}

/** Targets the host value refers to. Empty when nothing matches. */
export function matchTargetsByHost<T extends MatchableTarget>(available: T[], value: string): T[] {
  const forms = new Set(hostForms(value));
  if (!forms.size) return [];
  return available.filter((t) => targetNames(t).some((n) => forms.has(n)));
}

/**
 * Add the jump of every scoped machine that is reached through one. A problem is
 * often on the jump itself, and without it in scope the agent can see the jump's
 * address in the alert but has no way to log in to it.
 */
export function withJumps<T extends MatchableTarget>(scoped: T[], available: T[]): T[] {
  const out = new Map(scoped.map((t) => [t.id, t]));
  for (const t of scoped) {
    if (t.config.kind !== 'ssh' || !t.config.via?.alias) continue;
    const { host, port } = t.config;
    for (const j of available) {
      if (j.config.kind === 'ssh' && !j.config.via?.alias && j.config.host === host && j.config.port === port) out.set(j.id, j);
    }
  }
  return [...out.values()];
}

/**
 * Add every machine reached through a scoped jump. The manual Investigate picker does
 * the same when a jump is selected: an alert that resolves to the jump (by its
 * address, its name, or the channel it fired in) is usually about one of the machines
 * behind it, and a run scoped to the jump alone cannot log in to any of them.
 */
export function withMachinesBehind<T extends MatchableTarget>(scoped: T[], available: T[]): T[] {
  const out = new Map(scoped.map((t) => [t.id, t]));
  for (const j of scoped) {
    if (j.config.kind !== 'ssh' || j.config.via?.alias) continue;
    const { host, port } = j.config;
    for (const t of available) {
      if (t.config.kind === 'ssh' && t.config.via?.alias && t.config.host === host && t.config.port === port) out.set(t.id, t);
    }
  }
  return [...out.values()];
}

const OBSERVABILITY = new Set(['prometheus', 'alertmanager', 'loki', 'elasticsearch', 'grafana', 'tempo', 'jaeger', 'signoz']);

/**
 * Add every observability connection. A run limited to one machine still needs the
 * metrics, logs and alerts about it: they are read-only, and they are where the agent
 * is told to look first.
 */
export function withObservability<T extends MatchableTarget>(scoped: T[], available: T[]): T[] {
  const out = new Map(scoped.map((t) => [t.id, t]));
  for (const t of available) if (OBSERVABILITY.has(t.kind)) out.set(t.id, t);
  return [...out.values()];
}

/** Label keys that name the machine an alert is about, most specific first. */
export const HOST_LABEL_KEYS = ['instance', 'host', 'hostname', 'node', 'nodename', 'server', 'ip', 'address'];

/**
 * Words in free text that could name a machine: hostnames, IPs (with or without a
 * port), slugs. Matching them against target names is what keeps this safe -- a word
 * only counts if a registered target is actually known by it.
 */
export function hostCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split(/[\s,;()\[\]{}<>|"'`*=]+/)) {
    const tok = raw.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
    if (tok.length >= 3 && /[a-z0-9]/i.test(tok) && !/^\d+$/.test(tok)) out.add(tok);
  }
  return [...out].slice(0, 200);
}

/** Letters and digits only: `code-runner`, `Code_Runner` and `coderunner` compare equal. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Shorter names are too likely to occur inside unrelated words ("app", "web", "db1"). */
export const MIN_EMBEDDED_NAME = 6;

/**
 * Targets whose name appears inside a word of the text, ignoring punctuation and case:
 * an alert about `acme-code-runner-restored` finds the machine `coderunner`.
 * Only for when nothing matched exactly, and only names of MIN_EMBEDDED_NAME or more.
 */
export function matchTargetsEmbedded<T extends MatchableTarget>(available: T[], words: string[]): Array<{ target: T; word: string }> {
  const squashed = words.map((w) => ({ w, s: squash(w) })).filter((x) => x.s.length >= MIN_EMBEDDED_NAME);
  const out: Array<{ target: T; word: string }> = [];
  for (const t of available) {
    const names = new Set([t.slug, ...(t.config.kind === 'ssh' && t.config.via?.alias ? [t.config.via.alias] : [])].map(squash));
    const hit = squashed.find((x) => [...names].some((n) => n.length >= MIN_EMBEDDED_NAME && x.s.includes(n)));
    if (hit) out.push({ target: t, word: hit.w });
  }
  return out;
}

export interface AlertForScope {
  labels: Record<string, string> | null;
  title: string;
  summary: string | null;
  channelName: string | null;
}

export interface AlertScope<T> {
  /** Empty means no match: the run gets every target and the agent decides. */
  targets: T[];
  /** What the alert itself pointed at, before its jump or the machines behind it were added. */
  matched: T[];
  /** How the match was made, for the agent and the person reading the run. */
  reason: string | null;
  /** label/text name a machine; channel only narrows to an environment or group. */
  by: 'label' | 'text' | 'channel' | null;
}

/**
 * The targets an alert-driven investigation should be able to reach, chosen the way
 * a person would scope it by hand:
 *   1. a host label (instance, host, node...) naming a registered machine;
 *   2. failing that, a machine named in the alert's title, summary or other labels --
 *      exactly, or embedded in a longer name (see matchTargetsEmbedded);
 *   3. failing that, a target whose slug or environment is a word of the channel name
 *      ("#acme-prod-alerts" -> the prod targets);
 *   4. failing all three, nothing: every target, as an unscoped manual run gets.
 * A scoped jump brings the machines behind it, and a scoped machine behind a jump
 * brings the jump, so the agent can always reach what the alert is about.
 */
export function scopeAlert<T extends MatchableTarget & { env?: string }>(alert: AlertForScope, available: T[]): AlertScope<T> {
  const labels = alert.labels ?? {};
  let matches: T[] = [];
  let reason: string | null = null;
  let by: AlertScope<T>['by'] = null;

  for (const k of HOST_LABEL_KEYS) {
    const v = labels[k]?.trim();
    if (!v) continue;
    matches = matchTargetsByHost(available, v);
    if (matches.length) {
      reason = `the alert's ${k} label (${v})`;
      by = 'label';
      break;
    }
  }

  if (!matches.length) {
    const named = new Map<string, T>();
    const words: string[] = [];
    const otherLabels = Object.entries(labels)
      .filter(([k]) => !k.startsWith('_') && !HOST_LABEL_KEYS.includes(k))
      .map(([, v]) => v);
    const candidates = hostCandidates([alert.title, alert.summary ?? '', ...otherLabels].join('\n'));
    for (const w of candidates) {
      const hit = matchTargetsByHost(available, w);
      if (hit.length) words.push(w);
      for (const t of hit) named.set(t.id, t);
    }
    if (!named.size) {
      for (const { target, word } of matchTargetsEmbedded(available, candidates)) {
        named.set(target.id, target);
        if (!words.includes(word)) words.push(word);
      }
    }
    if (named.size) {
      matches = [...named.values()];
      reason = `the alert text naming ${words.slice(0, 4).join(', ')}`;
      by = 'text';
    }
  }

  if (!matches.length && alert.channelName) {
    const words = new Set(alert.channelName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    matches = available.filter((t) => words.has(t.slug.toLowerCase()) || words.has(String(t.env ?? '').toLowerCase()));
    if (matches.length) {
      reason = `the channel name (${alert.channelName})`;
      by = 'channel';
    }
  }

  if (!matches.length) return { targets: [], matched: [], reason: null, by: null };
  return { targets: withJumps(withMachinesBehind(matches, available), available), matched: matches, reason, by };
}

/**
 * Hostnames and IPs from `hostname; hostname -I` output, for a target's `addresses`.
 * Loopback and link-local addresses are dropped; at most 16 are kept.
 */
export function parseHostAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const tok of text.split(/\s+/)) {
    const t = tok.trim().toLowerCase();
    if (!t || t.length > 253) continue;
    if (IPV4.test(t)) {
      if (t.startsWith('127.') || t.startsWith('169.254.')) continue;
      out.add(t);
    } else if (/^[a-f0-9:]+$/.test(t) && t.includes(':')) {
      if (t === '::1' || t.startsWith('fe80')) continue;
      out.add(t);
    } else if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(t) && t !== 'localhost' && t !== 'supops-ok') {
      out.add(t);
    }
  }
  return [...out].slice(0, 16);
}
