import type { RiskContribution, RiskTier, ThreatCategory } from '@supops/shared';

/**
 * Shadow execution: judge a command by what it would actually DO, not only by how it
 * reads. A simulator runs the action (or a native dry-run of it) somewhere it cannot
 * do harm, watches the real effects, and reports them. The report only ever RAISES the
 * risk tier -- a quiet simulation never unlocks anything, because a sandbox-aware
 * payload can behave nicely while it is watched.
 *
 * Phase 1 (this file's first users) is native dry-runs: `kubectl --dry-run=server`,
 * `apt-get -s`, `systemctl list-dependencies --reverse`. They need no custom sandbox
 * and are themselves read-only, so they are safe to run before approval.
 */

export type SimStatus =
  | 'observed' // a simulator ran and saw something
  | 'skipped' // no simulator applies to this command (honest "not simulated")
  | 'unavailable' // a simulator applies but could not run (tool missing, over budget)
  | 'error'; // a simulator ran and failed

export interface Observation {
  /** A short machine-ish kind: pkg.remove, deps.reverse, k8s.apply, k8s.reject, net.connect, file.delete... */
  kind: string;
  /** One line a person reads on the approval card. */
  detail: string;
  /**
   * Set by the simulator when the observed behaviour is worse than the command's text
   * suggested. The judge turns it into a raise-only risk contribution. Omitted when the
   * observation is purely informational.
   */
  raise?: { tier: RiskTier; category?: ThreatCategory; reason: string };
}

export interface SimulationResult {
  status: SimStatus;
  /** Which simulator ran, e.g. 'kubectl-dry-run'; null when nothing applied. */
  simulator: string | null;
  /** What actually ran inside the sandbox (the dry-run preview, the detonated script, or the shadowed command), for the UI. */
  command?: string;
  /** Why it was skipped or could not run -- shown as the honest "not simulated" line. */
  note?: string;
  observations: Observation[];
  /** What the simulation could NOT see, stated plainly rather than assumed safe. */
  blindSpots?: string[];
  /** Raise-only contributions to fold into the assessment. */
  contributions: RiskContribution[];
  ms?: number;
}

export const skipped = (note: string): SimulationResult => ({ status: 'skipped', simulator: null, note, observations: [], contributions: [] });
export const unavailable = (simulator: string, note: string): SimulationResult => ({ status: 'unavailable', simulator, note, observations: [], contributions: [] });
