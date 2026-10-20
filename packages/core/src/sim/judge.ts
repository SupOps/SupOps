import type { RiskContribution } from '@supops/shared';
import type { Observation } from './types.ts';

/**
 * Observations → raise-only risk contributions. An observation carries a `raise` hint
 * only when the simulator saw behaviour worse than the command's text implied; the
 * judge turns each such hint into an `observed` contribution. Observations without a
 * hint are informational (they fill the approval panel) and never change the tier.
 */
export function contributionsFrom(simulator: string, observations: Observation[]): RiskContribution[] {
  return observations
    .filter((o): o is Observation & { raise: NonNullable<Observation['raise']> } => !!o.raise)
    .map((o) => ({
      stage: 'observed' as const,
      tier: o.raise.tier,
      ruleId: `sim.${o.kind}`,
      reason: `${o.raise.reason} (observed by ${simulator})`,
      ...(o.raise.category ? { category: o.raise.category } : {}),
    }));
}
