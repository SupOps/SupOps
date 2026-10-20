/**
 * An accuracy case: a realistic failure, the outputs SupOps' tools would have returned
 * (recorded, replayed, so a case needs no infrastructure and gives the same evidence
 * every time), and what a correct answer must contain.
 */
export interface EvalCase {
  id: string;
  title: string;
  /** For the report's per-tag pass rates: linux, kubernetes, database, network, misleading... */
  tags: string[];
  /** What the operator asked, or the incident line triage would be given. */
  task: string;
  /** incident: run as the automatic diagnosis of an incident (incident prompt, evidence pack). */
  mode?: 'investigate' | 'incident';
  /** incident mode: the alerts and evidence pack as triage would show them. */
  evidence?: string;
  targets: Array<{ slug: string; kind: 'ssh' | 'k8s' | 'prometheus' | 'loki' | 'elasticsearch' | 'alertmanager' | 'tempo' | 'jaeger'; env?: 'dev' | 'staging' | 'prod'; description?: string }>;
  /** The agent's tools (session tools and record_finding are always given). Default: the triage agent's. */
  tools?: string[];
  /** Recorded outputs. The first rule whose pattern matches the call as rendered wins. */
  replay: ReplayRule[];
  expect: Expectation;
}

export interface ReplayRule {
  /** Only this tool (key), when set. */
  tool?: string;
  /** Only on this target, when set. */
  target?: string;
  /** A regular expression (case-insensitive) over the call as the run page shows it. */
  match: string;
  output: string;
  /** Default 0. Anything else makes the call a failure, as a real non-zero exit would. */
  exitCode?: number;
}

export interface Element {
  /** What a correct answer says, in words the judge model can check. */
  text: string;
  /**
   * A regular expression (case-insensitive) the final answer must match, for checking
   * without a judge model. When absent, only the judge can decide this element.
   */
  match?: string;
}

export interface Expectation {
  /** Every one must be in the final answer (the first is usually the root cause). */
  elements: Element[];
  /** True when "inconclusive" is the right answer: the evidence cannot settle it. */
  inconclusive?: boolean;
  /** Calls that must have happened (regular expressions over the rendered call). */
  mustCall?: string[];
  /** Tools the agent must not use in this case. */
  forbiddenTools?: string[];
  /** Calls that must not happen, even attempted (regular expressions over the rendered call). */
  forbiddenCalls?: string[];
  /** Most model steps allowed (default 20). */
  maxSteps?: number;
}

export interface CallRecord {
  tool: string;
  target: string | null;
  rendered: string;
  state: string;
  /** No replay rule matched: the case is missing an output for this call. */
  unrecorded: boolean;
}

export interface CaseRun {
  caseId: string;
  model: string;
  status: string;
  answer: string;
  calls: CallRecord[];
  steps: number;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

export interface Verdict {
  pass: boolean;
  /** Why it failed, one line each; empty when it passed. */
  reasons: string[];
  /** Per element: present or not, and how that was decided. */
  elements: Array<{ text: string; present: boolean; by: 'match' | 'judge'; quote?: string }>;
}
