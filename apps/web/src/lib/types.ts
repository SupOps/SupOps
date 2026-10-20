import type { ContentPart } from '@supops/shared';
import type { RiskAssessment, RiskTier, RunStatus, ToolCallState } from '@supops/shared';

export interface ProjectPolicy {
  autoExecuteMaxTier: RiskTier;
  autoExecuteCeiling?: RiskTier;
  prodAutoExecuteCap?: RiskTier;
  toolAutoExecuteCap?: Record<string, RiskTier>;
  triggerAutoExecuteCap?: Partial<Record<string, RiskTier>>;
  approverRoleByTier: Partial<Record<RiskTier, string>>;
  requireSecondPersonAtTier: RiskTier | null;
  ttlMsByTier: Partial<Record<RiskTier, number>>;
  onExpiry: 'continue_as_denied' | 'abort_run';
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  killSwitch: boolean;
  riskPolicy?: ProjectPolicy;
  /** Instructions added to every run's system prompt. */
  systemPromptExtra?: string | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actorName: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
}

export interface Target {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  kind: string;
  env: 'dev' | 'staging' | 'prod';
  description: string | null;
  sensitivity: number;
  healthState: 'unknown' | 'ok' | 'degraded' | 'unreachable';
  lastCheckedAt: number | null;
  hasCredential: boolean;
  becomeUsers?: string[];
  config: Record<string, unknown>;
}

/**
 * A machine reached via a jump (config.via) is not a top-level target -- it lives
 * under its jump's umbrella. It stays a real, reachable target, but the UI must not
 * count or list it as a separate target. The Targets page is the one exception: it
 * shows these grouped beneath their jump.
 */
export const isBehindJump = (t: Target): boolean =>
  !!(t.config as { via?: { alias?: string } }).via?.alias;

/** Only the top-level targets -- jumps and direct hosts, not the machines behind a jump. */
export const topLevelTargets = (list: Target[] | undefined): Target[] =>
  (list ?? []).filter((t) => !isBehindJump(t));

export interface AgentBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxOutputBytesPerCall: number;
  maxSessionToolCalls?: number;
  maxOutputTokens?: number;
}

export interface Agent {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  role: string;
  description?: string | null;
  systemPrompt: string;
  model?: string | null;
  toolKeys: string[] | null;
  enabled: boolean;
  budget?: AgentBudget;
  riskPolicyOverride?: { autoExecuteMaxTier?: RiskTier; prodAutoExecuteCap?: RiskTier; requireSecondPersonAtTier?: RiskTier | null } | null;
  /** Ships with SupOps: cannot be deleted (triage/console can be reset). */
  builtIn?: boolean;
  /** Health-check agents follow their spec; only model and enabled are editable. */
  healthAgent?: boolean;
  effectivePolicy?: ProjectPolicy | null;
}

export interface RunAction {
  tier: RiskTier | null;
  state: ToolCallState;
  toolKey: string;
  command: string | null;
}

export interface Run {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  status: RunStatus;
  statusReason: string | null;
  model: string;
  iteration: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: number;
  endedAt: number | null;
  /** Console sessions stay open between turns instead of ending. */
  interactive?: boolean;
  /** Kept by history clean-up regardless of age. */
  pinned?: boolean;
  trigger?: string;
  /** Who started the run; `startedByName` is resolved server-side. Null for scheduled runs. */
  startedBy?: string | null;
  startedByName?: string | null;
  /** Present on the list endpoint: the run's risk fingerprint, in execution order. */
  actions?: RunAction[];
  targets?: string[];
  /** Present on the list endpoint: who approved/rejected this run's gated steps. */
  approvals?: RunApprovals;
  /** The policy frozen at start; `advisory` marks a run with no system access. */
  policySnapshot?: { advisory?: boolean; unattended?: boolean; networkChecks?: boolean; call?: boolean };
}

export interface ToolCall {
  id: string;
  runId: string;
  toolCallId: string;
  callIndex: number;
  toolKey: string;
  argsJson: Record<string, unknown>;
  renderedCommand: string | null;
  tier: RiskTier | null;
  riskJson: RiskAssessment | null;
  state: ToolCallState;
  resultJson: { ok: boolean; text: string; exitCode?: number } | null;
  isError: boolean;
  decisionComment: string | null;
  /** Who decided this action, and when. `decidedByName` is resolved server-side. */
  decidedBy?: string | null;
  decidedByName?: string | null;
  decidedAt?: number | null;
}

/** Who decided a run's gated steps, rolled up per person. */
export interface RunApprovals {
  approved: number;
  denied: number;
  by: Array<{ name: string; approved: number; denied: number }>;
}

/** One run's decided approvals (the history is grouped per run, not per step). */
export interface ApprovalHistoryEntry extends RunApprovals {
  runId: string;
  runTitle: string;
  kind: 'investigate' | 'console' | 'health' | 'alert';
  status: RunStatus;
  startedAt: number;
  startedByName: string | null;
  lastDecidedAt: number | null;
  lastComment: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  globalRole: 'owner' | 'admin' | 'member';
  disabledAt: number | null;
  createdAt: number;
}

export interface RunStep {
  id: string;
  seq: number;
  /** The model that wrote this reply (the fallback when the main one failed); null on older steps. */
  model?: string | null;
  messageJson: {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** A user turn with screenshots is multimodal parts; everything else is text. */
    content: string | ContentPart[] | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  };
}

export interface RunDetail {
  run: Run & { toolsSnapshot: unknown[]; targetsSnapshot: unknown[] };
  steps: RunStep[];
  toolCalls: ToolCall[];
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
  /** Project knowledge the run was given, and how each document was chosen. */
  knowledge?: Array<{ docId: string; via: 'pinned' | 'matched' | 'runbook' | 'alert'; title: string; kind: string }>;
}

export interface PendingApproval {
  toolCall: ToolCall;
  run: Run | null;
}

export interface DashboardData {
  runs: Record<string, number>;
  tiers: Partial<Record<RiskTier, number>>;
  states: Record<string, number>;
  /** The autonomy split: how much the agent did without asking anyone. */
  autonomy: { auto: number; approved: number; refused: number; blocked: number };
  activity: Array<{ day: string; runs: number; failed: number }>;
  targetHealth: Record<string, number>;
  approvals: {
    pending: number;
    oldestWaitingSince: number | null;
    decided: number;
    approveRate: number | null;
    avgDecisionMs: number | null;
  };
}

export interface Alert {
  id: string;
  projectId: string;
  source: string;
  channelId: string | null;
  channelName: string | null;
  fingerprint: string;
  title: string;
  severity: 'critical' | 'warning' | 'info' | 'unknown';
  status: 'new' | 'investigating' | 'ignored' | 'resolved';
  summary: string | null;
  labels: Record<string, string> | null;
  count: number;
  runId: string | null;
  incidentId?: string | null;
  /** The automatic read-only diagnosis of the alert's incident. */
  diagnosis?: {
    triageState: 'none' | 'evidence' | 'running' | 'done' | 'skipped' | 'failed';
    triageNote: string | null;
    rootCause: string | null;
    confidence: string | null;
    runId: string | null;
  } | null;
  slackPermalink: string | null;
  /** Firing and resolving over and over; its incident's diagnosis waits until it settles. */
  flapping?: boolean;
  /** The webhook sender's name, for alerts pushed to SupOps. */
  sourceName?: string | null;
  /** The maintenance window muting it: stored, but no incident until the window ends. */
  maintenanceId?: string | null;
  maintenanceName?: string | null;
  receivedAt: number | string;
  lastSeenAt: number | string;
}

export interface AlertList {
  alerts: Alert[];
  statusCounts: Record<string, number>;
  channels: Array<{ channelId: string; channelName: string | null }>;
}

export interface HealthTargetMetric {
  targetId: string;
  slug: string;
  healthState: 'ok' | 'degraded' | 'unreachable' | 'unknown';
  diskPct: number | null;
  memPct: number | null;
  load1: number | null;
  cores: number | null;
  failedUnits: number;
  namespaces: number | null;
  pods: number | null;
  badPods: number | null;
}

export interface HealthCheckSummary {
  checked: number;
  ok: number;
  degraded: number;
  unreachable: number;
  issues: number;
  notes?: number;
  targets?: HealthTargetMetric[];
}

export interface HealthCheck {
  id: string;
  type: 'quick' | 'deep';
  trigger: 'manual' | 'schedule';
  status: 'running' | 'done' | 'failed';
  runId: string | null;
  summaryJson: HealthCheckSummary | null;
  startedAt: number | string;
  finishedAt: number | string | null;
}

export interface HealthIssue {
  id: string;
  projectId: string;
  targetId: string;
  severity: 'notice' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  state: 'open' | 'investigating' | 'resolved';
  runId: string | null;
  createdAt: number | string;
  lastSeenAt: number | string;
}

export interface HealthSchedule {
  enabled: boolean;
  intervalMs: number;
  scanType: 'quick' | 'deep';
  nextCheckAt: number | null;
  lastCheckAt: number | null;
}

export interface HealthOverview {
  latest: HealthCheck | null;
  issues: HealthIssue[];
  schedule: HealthSchedule;
}

// ---- observability ----------------------------------------------------------------

export type Severity = 'critical' | 'warning' | 'info' | 'unknown';

export interface Incident {
  id: string;
  projectId: string;
  title: string;
  severity: Severity;
  status: 'open' | 'resolved' | 'ignored';
  origin: 'alerts' | 'prediction' | 'threshold';
  /** The diagnosis' verdict: act_now | can_wait | none. */
  action: 'act_now' | 'can_wait' | 'none' | null;
  ignoredUntil: string | null;
  ignoredBy: string | null;
  ignoreReason: string | null;
  groupReason: string | null;
  targetIds: string[] | null;
  triageState: 'none' | 'evidence' | 'running' | 'done' | 'skipped' | 'failed';
  triageNote: string | null;
  runId: string | null;
  rootCause: string | null;
  confidence: 'high' | 'medium' | 'low' | 'inconclusive' | null;
  /** What the diagnosis weighed, each cause confirmed, ruled out or untested. */
  hypotheses?: Array<{ hypothesis: string; verdict: 'confirmed' | 'ruled_out' | 'untested'; evidence: string }> | null;
  /** What is affected, what was checked and is fine, what was not checked. */
  blastRadius?: { affected: string | null; healthy: string | null; unchecked: string | null } | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  mergedInto: string | null;
  alertCount?: number;
  /** Someone is on it; lapses by itself when the incident gets worse. */
  acknowledgedAt: string | null;
  acknowledgedByName?: string | null;
  assigneeId: string | null;
  assigneeName?: string | null;
  /** A person set the severity; alerts no longer change it. */
  severityPinned: boolean;
  /** Waiting for its rule's threshold: not listed or diagnosed yet. */
  held?: boolean;
}

export interface Observation {
  id: string;
  kind: 'anomaly' | 'forecast';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  targetId: string | null;
  watchId: string;
  series: string;
  details: {
    etaMs?: number;
    confidence?: string;
    z?: number;
    baseline?: number;
    direction?: 'up' | 'down';
    over?: boolean;
    worsening?: boolean;
    slopePerHour?: number;
    limit?: { value: number; when: 'below' | 'above' };
    unit?: string;
    value?: number;
    name?: string;
    signal?: string;
  } | null;
  startedAt: string;
  incidentId: string | null;
  unit?: string;
  title?: string;
}

export interface ObsConnection {
  id: string;
  slug: string;
  kind: string;
  importsAlerts: boolean;
  watches: boolean;
  poll: { at: number; ok: boolean; firing: number; error?: string } | null;
  watchCount: number;
  watchErrors: number;
  lastSampledAt: number | null;
}

export interface ObservabilitySettings {
  alertPollMs: number;
  watchIntervalMs: number;
  autoTriage: boolean;
  triageMinSeverity: 'critical' | 'warning' | 'info';
  triageGatherSeconds: number;
  triageMaxPerHour: number;
  predictWarningHours: number;
  predictCriticalHours: number;
  flapChanges: number;
  flapWindowMin: number;
  slackThreadReplies: boolean;
}

export interface ObservabilityOverview {
  incidents: Incident[];
  observations: Observation[];
  connections: ObsConnection[];
  settings: ObservabilitySettings;
  /** Series being watched right now. */
  watched: number;
}

export interface Evidence {
  id: string;
  ref: string;
  check: string;
  title: string;
  connection: string | null;
  query: string | null;
  status: 'interesting' | 'normal' | 'unavailable' | 'error';
  summary: string;
}

export interface IncidentDetail {
  incident: Incident & { targets: string[] };
  alerts: Array<Alert & { startsAt: string | null; resolvedAt: string | null; connectionId: string | null }>;
  evidence: Evidence[];
  observations: Observation[];
  run: { id: string; status: RunStatus; title: string; startedAt: string; endedAt: string | null } | null;
  fixRun: { id: string; status: RunStatus; startedAt: string } | null;
  /** From the service map: what this incident's systems rely on, and what relies on them. */
  map: {
    dependsOn: Array<{ id: string; name: string; type: string; depth: number; certainty: string; problems: string[] }>;
    affected: Array<{ id: string; name: string; type: string; depth: number; certainty: string; problems: string[] }>;
  };
  timeline: Array<{ at: number; kind: string; text: string }>;
  mergeCandidates: Array<{ id: string; title: string }>;
  /** Open incidents that may be the same problem, and why. */
  suggestions?: Array<{ id: string; title: string; reason: string }>;
  /** The correlation rule that made it, if one did. */
  rule: { id: string; name: string; threshold: number; resolveOn: 'all' | 'first' | 'never' } | null;
}

export interface WatchItem {
  key: string;
  name: string;
  labels: Record<string, string>;
  value: number;
  /** 0-100: how close to trouble. */
  score: number;
  reasons: string[];
  etaMs: number | null;
  /** The registered machine it is about, when matched. */
  target: string | null;
  flags: string[];
}

export interface Watch {
  id: string;
  connectionId: string;
  connection: string | null;
  key: string;
  title: string;
  query: string;
  unit: string;
  builtin: boolean;
  badDirection: 'up' | 'down' | 'both';
  limit: { value: number; when: 'below' | 'above' } | null;
  /** Self-adjusting threshold: limits learned from each series' last 7 days. */
  adaptive?: { iqrs: number } | null;
  group: 'resources' | 'traffic' | 'kubernetes' | 'databases' | 'stack' | 'custom';
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  seriesCount: number;
  series: WatchItem[];
}

export interface SeriesChartData {
  points: Array<[number, number]>;
  unit: string;
  limit: { value: number; when: 'below' | 'above' } | null;
  band: { low: number; high: number } | null;
  /** `path`: the model's forecast, hourly: [time, expected, low, high] (a 90% band). */
  forecast: {
    slopePerHour: number;
    etaMs: number | null;
    path?: Array<[number, number, number, number]>;
    model?: 'linear' | 'daily' | 'weekly';
    confidence?: 'high' | 'medium' | 'low';
  } | null;
}

export interface AtRiskItem {
  watchId: string;
  key: string;
  name: string;
  value: number;
  score: number;
  reasons: string[];
  title: string;
  unit: string;
  group: Watch['group'];
}

/** A command an admin trusted in a project: a standing approval (see Approvals → Trusted). */
export interface TrustedCommand {
  id: string;
  projectId: string;
  toolKey: 'ssh_exec' | 'k8s_kubectl';
  matchKind: 'exact' | 'folder';
  canonical: string;
  program: string | null;
  flags: string[] | null;
  folder: string | null;
  glob: string | null;
  envs: Array<'dev' | 'staging' | 'prod'>;
  status: 'active' | 'suggested' | 'revoked';
  note: string | null;
  sourceToolCallId: string | null;
  description: string;
  createdAt: string;
  createdByName: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  hits: number;
  lastUsedAt: string | null;
}

export type AlertSourceKind = 'alertmanager' | 'grafana' | 'pagerduty' | 'opsgenie' | 'generic' | 'changes';

export interface GenericMapping {
  alertsPath?: string;
  titlePath?: string;
  severityPath?: string;
  statusPath?: string;
  resolvedValues?: string[];
  fingerprintPath?: string;
  summaryPath?: string;
  labelsPath?: string;
  hostPath?: string;
  servicePath?: string;
  linkPath?: string;
}

/** A sender that pushes alerts to SupOps by webhook. The token itself is never returned after creation. */
export interface AlertSource {
  id: string;
  projectId: string;
  kind: AlertSourceKind;
  name: string;
  tokenPrefix: string;
  previousTokenUntil: string | number | null;
  rotating: boolean;
  mapping: GenericMapping | null;
  enabled: boolean;
  createdAt: string | number;
  received: number;
  alertsIn: number;
  repeats: number;
  rejected: number;
  lastReceivedAt: string | number | null;
  lastError: string | null;
  lastErrorAt: string | number | null;
  /** Writes acknowledgements, resolves and the diagnosis back to the source. */
  writeback?: boolean;
}

export interface MaintenanceWindow {
  id: string;
  projectId: string;
  name: string;
  reason: string | null;
  matcherText: string;
  startsAt: string | number;
  endsAt: string | number;
  recurrence: { days: number[]; start: string; end: string; timezone: string } | null;
  state: 'active' | 'scheduled' | 'waiting' | 'ended' | 'cancelled';
  alertsMuted: number;
  createdByName: string | null;
  cancelledByName: string | null;
  cancelledAt: string | number | null;
}

export interface CorrelationRule {
  id: string;
  projectId: string;
  name: string;
  matcherText: string;
  groupBy: string[];
  windowMin: number;
  threshold: number;
  resolveOn: 'all' | 'first' | 'never';
  titleTemplate: string;
  priority: number;
  enabled: boolean;
  incidentsMade: number;
  alertsGrouped: number;
  lastMatchedAt: string | number | null;
}

export interface RulePreview {
  ok: boolean;
  error?: string;
  considered?: number;
  matched?: number;
  incidents?: number;
  held?: number;
  groups?: Array<{ title: string; alerts: number; visible: boolean; first: number; last: number }>;
}

export interface ExtractionRuleView {
  id: string;
  name: string;
  matcherText: string;
  field: 'title' | 'summary' | 'label';
  labelName: string | null;
  pattern: string;
  enabled: boolean;
  seen: number;
  applied: number;
  lastAppliedAt: string | number | null;
  lastExample: Record<string, string> | null;
}

export type ChannelKind = 'slack' | 'teams' | 'email' | 'webhook' | 'pagerduty' | 'opsgenie';

export interface NotificationChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  config: Record<string, unknown>;
  has: { url: boolean; secret: boolean; password: boolean; routingKey: boolean; apiKey: boolean };
  enabled: boolean;
  sent: number;
  failed: number;
  lastSentAt: string | number | null;
  lastError: string | null;
  lastErrorAt: string | number | null;
  createdAt: string | number;
}

export type NotifyEvent = 'opened' | 'escalated' | 'acknowledged' | 'resolved' | 'reopened' | 'diagnosed';

export interface NotificationRoute {
  id: string;
  name: string;
  matcherText: string;
  minSeverity: 'info' | 'warning' | 'critical';
  events: NotifyEvent[];
  channelIds: string[];
  quietHours: { days: number[]; start: string; end: string; timezone: string } | null;
  digestHour: number | null;
  enabled: boolean;
}

export interface NotificationDelivery {
  id: string;
  channelId: string;
  incidentId: string | null;
  incidentTitle: string | null;
  event: string;
  status: 'pending' | 'sent' | 'failed' | 'skipped';
  reason: string | null;
  attempts: number;
  error: string | null;
  responseCode: number | null;
  createdAt: string | number;
  sentAt: string | number | null;
}

export type WorkflowTrigger =
  | { type: 'incident'; on: Array<'opened' | 'escalated' | 'acknowledged' | 'resolved' | 'diagnosed'>; matchers: string; minSeverity: 'info' | 'warning' | 'critical' }
  | { type: 'schedule'; everyMinutes: number }
  | { type: 'manual' };

export type WorkflowStep =
  | { kind: 'notify'; channelIds: string[]; message: string }
  | { kind: 'diagnose' }
  | { kind: 'recheck' }
  | { kind: 'assign'; userId: string | null }
  | { kind: 'severity'; severity: 'critical' | 'warning' | 'info' }
  | { kind: 'acknowledge' }
  | { kind: 'note'; text: string }
  | { kind: 'wait'; minutes: number }
  | { kind: 'if'; matchers: string; severityAtLeast: 'info' | 'warning' | 'critical' | null; stillOpen: boolean };

export interface Workflow {
  id: string;
  name: string;
  description: string | null;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  revision: number;
  enabled: boolean;
  lastRunAt: string | number | null;
  updatedAt: string | number;
}

export interface WorkflowRun {
  id: string;
  revision: number;
  incidentId: string | null;
  reason: string;
  status: 'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped';
  log: Array<{ step: number; at: number; status: 'done' | 'skipped' | 'failed' | 'waiting' | 'stopped'; text: string }>;
  steps: WorkflowStep[];
  startedAt: string | number;
  endedAt: string | number | null;
  resumeAt: string | number | null;
}
