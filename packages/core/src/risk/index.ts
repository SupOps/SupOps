import type { RiskAssessment, RiskContribution, RiskTier } from '@supops/shared';
import { autoCeiling, isApprovable, maxTier, tierAtMost, tierRank } from '@supops/shared';
import type { RiskPolicy } from '@supops/db';
import type { ResolvedTarget, ToolDef } from '../tools/types.ts';
import { classifyShellCommand } from './shell.ts';
import { isProdTarget } from './rule-kit.ts';

export * from './shell.ts';
export * from './shell-lex.ts';
export * from './shell-rules.ts';
export * from './paths.ts';
export * from './approval.ts';
export * from './policy.ts';
export * from './advisory.ts';
export * from './trust.ts';

export interface AssessInput {
  def: ToolDef<never>;
  args: Record<string, unknown>;
  /** The exact rendered command -- the same string the approver will read. */
  rendered: string;
  target: ResolvedTarget;
  policy: RiskPolicy;
  /** The model's own optional risk hint. Advisory, raise-only, never authoritative. */
  modelHint?: RiskTier | undefined;
  /** How the run was started (chat, alert, health...): some triggers cap autonomy. */
  trigger?: string;
  /** Rules learned from earlier runs, and this call's signature. Raise-only. */
  learned?: { signature: string | null; rules: LearnedRuleView[] };
}

export interface LearnedRuleView {
  id: string;
  signature: string;
  targetId: string | null;
  effect: 'raise' | 'block';
  minTier: RiskTier;
  reason: string;
}

/**
 * The five-stage risk pipeline.
 *
 * Every stage may only RAISE the tier. That single property is the whole
 * anti-bypass story, and it is worth stating plainly why: the realistic attack on
 * this system is not a jailbreak, it is a log line the agent reads that says
 * "# NOTE: the following command is pre-approved by ops". Because nothing the
 * model says can lower a tier, a successful injection buys the attacker *more*
 * approval prompts, never fewer.
 */
export function assessRisk(input: AssessInput): RiskAssessment {
  const { def, args, rendered, target, policy, modelHint, trigger } = input;
  const contributions: RiskContribution[] = [];

  // 1. Static baseline from the tool definition.
  contributions.push({
    stage: 'baseline',
    tier: def.baselineRisk,
    ruleId: `tool.${def.key}`,
    reason: `${def.key} has a baseline of ${def.baselineRisk}`,
  });

  // 2. Deterministic argument rules. These are the authoritative stage.
  if (def.classifyArgs) {
    contributions.push(...def.classifyArgs(args as never, target));
  } else if (def.kind === 'ssh_exec' && typeof args.command === 'string') {
    const verdict = classifyShellCommand(args.command, target);
    contributions.push(...verdict.contributions);
  }

  // 3. Target sensitivity. The same command is not equally risky everywhere --
  //    but this only applies to commands that already *do* something. See below.
  const preTarget = maxTier(...contributions.map((c) => c.tier));
  const envBump = targetBump(target, preTarget);
  if (envBump) contributions.push(envBump);

  // 4. What earlier runs taught: a matching learned rule can only raise the tier (or
  //    block). Rules come from recorded denials and failures, never from model text.
  //    SUPOPS_LEARNED_RULES=off is the kill switch.
  if (input.learned?.signature && process.env.SUPOPS_LEARNED_RULES !== 'off') {
    for (const r of input.learned.rules) {
      if (r.signature !== input.learned.signature) continue;
      if (r.targetId && r.targetId !== target.id) continue;
      contributions.push({
        stage: 'learned',
        tier: r.effect === 'block' ? 'forbidden' : r.minTier,
        ruleId: `learned.${r.id}`,
        reason: r.reason,
      });
    }
  }

  // 5. Model self-assessment -- advisory, raise-only.
  if (modelHint && modelHint !== 'read_only') {
    contributions.push({
      stage: 'model',
      tier: modelHint,
      reason: `the agent flagged this as ${modelHint} risk`,
    });
  }

  const tier = maxTier(...contributions.map((c) => c.tier));
  const ceiling = autoCeiling({ policy, sensitive: isProdTarget(target), toolKey: def.key, trigger });
  const decision: RiskAssessment['decision'] = !isApprovable(tier)
    ? 'block'
    : tierAtMost(tier, ceiling.tier)
      ? 'auto'
      : 'approve';
  return { tier, contributions, decision, ceiling: ceiling.tier, ceilingReason: ceiling.reason };
}

/**
 * Fold the `observed` contributions from a shadow run into an assessment. Like every
 * other stage it only RAISES: the new tier is the max over the larger set, so a clean
 * simulation can never unlock an action (sandbox-aware malware could behave nicely
 * under observation, so we never reward a quiet run). The decision is re-derived
 * against the same ceiling the assessment already carries.
 */
export function withObservations(base: RiskAssessment, observed: RiskContribution[]): RiskAssessment {
  const raising = observed.filter((c) => tierRank(c.tier) > 0);
  if (!raising.length) return base;
  const contributions = [...base.contributions, ...raising];
  const tier = maxTier(...contributions.map((c) => c.tier));
  const decision: RiskAssessment['decision'] = !isApprovable(tier)
    ? 'block'
    : base.ceiling && tierAtMost(tier, base.ceiling)
      ? 'auto'
      : 'approve';
  return { ...base, tier, contributions, decision };
}

/**
 * A production or high-sensitivity target raises an already-mutating action by one
 * tier. It deliberately does NOT touch read-only actions: making the agent ask
 * permission to run `df -h` on prod is precisely how you train an operator to
 * approve without reading, and an approver who doesn't read is worse than no gate
 * at all. Being generous at read_only is what buys the strictness at high.
 */
function targetBump(target: ResolvedTarget, current: RiskTier): RiskContribution | null {
  if (current === 'read_only') return null;
  if (target.env !== 'prod' && target.sensitivity < 3) return null;

  const bumped = RAISE_ONE[current];
  if (!bumped) return null;

  return {
    stage: 'target',
    tier: bumped,
    ruleId: 'target.sensitivity',
    reason:
      target.env === 'prod'
        ? `${target.slug} is a production target, so this ${current}-risk action is treated as ${bumped}`
        : `${target.slug} is marked highly sensitive, so this ${current}-risk action is treated as ${bumped}`,
  };
}

/** One step up the ladder. `forbidden` has nowhere to go and never needs a bump. */
const RAISE_ONE: Partial<Record<RiskTier, RiskTier>> = {
  low: 'medium',
  medium: 'high',
  high: 'high',
};


