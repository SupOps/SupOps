import type { RiskTier } from './risk.ts';
import { tierRank } from './risk.ts';

/**
 * How much an agent may do without asking.
 *
 * A project sets the level its agents act at on their own (`autoExecuteMaxTier`)
 * and the most any single agent may be raised to (`autoExecuteCeiling`). On top of
 * that sit caps that no setting can lift past:
 *
 *  - `high` never runs on its own, anywhere; `forbidden` never runs at all.
 *  - Production (or sensitivity 3) is capped -- by default at `low`, which is
 *    today's behaviour, since the prod bump already lifts any change there to medium.
 *  - Some tools are capped (a script only when every line is read-only).
 *  - Some triggers are capped: alert text arrives from Slack and is reachable by
 *    whoever can post there, so a raised project must not auto-run medium actions off
 *    an alert unless an admin raises that cap explicitly; health scans stay read-only.
 *
 * Pure and shared, so the engine and the Settings matrix compute the same answer.
 */
export interface AutonomyPolicy {
  autoExecuteMaxTier: RiskTier;
  autoExecuteCeiling?: RiskTier;
  prodAutoExecuteCap?: RiskTier;
  toolAutoExecuteCap?: Record<string, RiskTier>;
  triggerAutoExecuteCap?: Partial<Record<string, RiskTier>>;
}

/** Nothing above this ever runs without a human. */
export const AUTONOMY_HARD_CAP: RiskTier = 'medium';
export const DEFAULT_PROD_AUTO_CAP: RiskTier = 'low';
/** A script runs on its own only when every line is read-only, whatever the project allows. */
export const DEFAULT_TOOL_AUTO_CAPS: Record<string, RiskTier> = { run_script: 'read_only' };
export const DEFAULT_TRIGGER_AUTO_CAPS: Partial<Record<string, RiskTier>> = {
  health: 'read_only',
  alert: 'low',
  webhook: 'low',
  api: 'low',
  schedule: 'low',
};

export const minTier = (...tiers: RiskTier[]): RiskTier =>
  tiers.reduce((a, b) => (tierRank(b) < tierRank(a) ? b : a));

export interface CeilingInput {
  policy: AutonomyPolicy;
  /** env=prod or sensitivity >= 3. */
  sensitive: boolean;
  toolKey?: string;
  trigger?: string;
}

/** The highest tier that may run without approval here, and what set that limit. */
export function autoCeiling(i: CeilingInput): { tier: RiskTier; reason: string } {
  const caps: Array<[RiskTier, string]> = [
    [i.policy.autoExecuteMaxTier, 'this project/agent acts on its own only up to'],
    [AUTONOMY_HARD_CAP, 'high-risk actions always need a human; the most that ever runs alone is'],
  ];
  if (i.sensitive) caps.push([i.policy.prodAutoExecuteCap ?? DEFAULT_PROD_AUTO_CAP, 'on production and sensitive targets, agents act alone only up to']);
  const toolCap = i.toolKey ? (i.policy.toolAutoExecuteCap?.[i.toolKey] ?? DEFAULT_TOOL_AUTO_CAPS[i.toolKey]) : undefined;
  if (toolCap) caps.push([toolCap, `${i.toolKey} runs on its own only up to`]);
  const trigCap = i.trigger ? (i.policy.triggerAutoExecuteCap?.[i.trigger] ?? DEFAULT_TRIGGER_AUTO_CAPS[i.trigger]) : undefined;
  if (trigCap) caps.push([trigCap, `${i.trigger}-triggered runs act alone only up to`]);

  let best = caps[0]!;
  for (const c of caps) if (tierRank(c[0]) < tierRank(best[0])) best = c;
  return { tier: best[0], reason: `${best[1]} ${best[0].replace('_', '-')}` };
}

const word = (t: RiskTier): string => (t === 'read_only' ? 'read-only' : t);

/** The one-line autonomy statement for a run's opening message (and the Settings summary). */
export function describeAutonomy(policy: AutonomyPolicy, trigger?: string): string {
  const here = autoCeiling({ policy, sensitive: false, trigger });
  const prod = autoCeiling({ policy, sensitive: true, trigger });
  const reads = (t: RiskTier) => (t === 'read_only' ? 'only read-only actions' : `actions up to ${word(t)} risk`);
  return (
    `${reads(here.tier)} run on their own here` +
    (prod.tier !== here.tier ? `; on production and sensitive targets, ${reads(prod.tier)}` : '') +
    '; everything else waits for a human, and forbidden actions never run.'
  ).replace(/^./, (c) => c.toUpperCase());
}
