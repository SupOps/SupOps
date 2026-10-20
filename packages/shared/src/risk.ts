/**
 * Risk tiers. The ordering is the whole safety model: every classification stage
 * may only ever RAISE a tier, never lower it (see `maxTier`). That single rule is
 * what makes prompt injection through tool output unable to buy an agent more
 * permission than it started with.
 */
export const RISK_TIERS = ['read_only', 'low', 'medium', 'high', 'forbidden'] as const;
export type RiskTier = (typeof RISK_TIERS)[number];

const ORDER: Record<RiskTier, number> = {
  read_only: 0,
  low: 1,
  medium: 2,
  high: 3,
  forbidden: 4,
};

export const tierRank = (t: RiskTier): number => ORDER[t];

/** Monotonic join. The only way tiers are ever combined. */
export function maxTier(...tiers: RiskTier[]): RiskTier {
  let out: RiskTier = 'read_only';
  for (const t of tiers) if (ORDER[t] > ORDER[out]) out = t;
  return out;
}

export const tierAtMost = (t: RiskTier, ceiling: RiskTier): boolean =>
  ORDER[t] <= ORDER[ceiling];

/**
 * `forbidden` is deliberately NOT the top of the approval range -- it is outside
 * it. No role, no policy, and no amount of approval can execute a forbidden call.
 * That separation is what lets approval UX be ergonomic for medium/high without
 * ever putting `rm -rf /` one tired click away.
 */
export const isApprovable = (t: RiskTier): boolean => t !== 'forbidden';

/**
 * What kind of harm a rule guards against. Shown to the approver next to the reason,
 * so "high" reads as "high: locks SupOps out" or "high: irreversible data loss" rather
 * than an unexplained colour.
 */
export const THREAT_CATEGORIES = [
  'destruction',    // data or systems destroyed
  'availability',   // services or the host taken down
  'lockout',        // SupOps (or everyone) loses access to the machine
  'exfiltration',   // data sent off the machine
  'secrets',        // credential material read or exposed
  'privilege',      // privilege escalation or weakened access control
  'persistence',    // backdoors, new access, scheduled execution
  'anti-forensics', // logs, history or audit evidence destroyed
  'code-execution', // unreviewable code runs (pipe-to-shell, downloads, eval)
  'integrity',      // system config, time, identity or files silently changed
  'resource',       // disk, CPU or memory exhausted
] as const;
export type ThreatCategory = (typeof THREAT_CATEGORIES)[number];

export const THREAT_LABEL: Record<ThreatCategory, string> = {
  destruction: 'Data destruction',
  availability: 'Outage risk',
  lockout: 'Lockout risk',
  exfiltration: 'Data exfiltration',
  secrets: 'Secret exposure',
  privilege: 'Privilege escalation',
  persistence: 'Persistence / backdoor',
  'anti-forensics': 'Audit tampering',
  'code-execution': 'Unreviewed code',
  integrity: 'System integrity',
  resource: 'Resource exhaustion',
};

/** One stage's contribution to a decision, kept for the audit trail and the approver UI. */
export interface RiskContribution {
  stage: 'baseline' | 'arguments' | 'target' | 'learned' | 'observed' | 'model' | 'override';
  tier: RiskTier;
  ruleId?: string;
  reason: string;
  /** The kind of harm, when a rule knows it. */
  category?: ThreatCategory;
  /** True when the effect cannot be undone (data gone, not merely stopped). */
  irreversible?: boolean;
}

export interface RiskAssessment {
  tier: RiskTier;
  contributions: RiskContribution[];
  decision: 'auto' | 'approve' | 'block';
  /** The most that could have run without approval here, and why -- shown on the approval card. */
  ceiling?: RiskTier;
  ceilingReason?: string;
  /**
   * Set when a person's standing approval (a trusted command) let this run without
   * waiting. The tier above is still the engine's own: trust skips the wait, it never
   * makes an action look safer than it is.
   */
  trusted?: { ruleId: string; by: string | null; byName: string | null };
  /** Shown to the approver: a change proposed before anything on that machine was read. */
  preflight?: string;
  /**
   * What a shadow/dry-run simulation observed before approval, for the "what it would
   * actually do" panel. Any risk it implied is already folded into `contributions` as
   * the `observed` stage; this is the human-readable record, including the blind spots
   * it could not see (never assume "safe" from a quiet simulation).
   */
  observed?: {
    status: 'observed' | 'skipped' | 'unavailable' | 'error';
    simulator: string | null;
    note?: string;
    /** What actually ran inside the sandbox, so the approver can see it, not just its effects. */
    command?: string;
    items: Array<{ kind: string; detail: string }>;
    blindSpots?: string[];
    /** When the simulation ran (epoch ms), so a stale one can be re-checked before execution. */
    at: number;
  };
}
