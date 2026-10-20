import { matchesAll, parseMatchers, type Matcher } from '@supops/shared';

/**
 * Workflows: when something happens to an incident (or on a schedule, or by hand), do
 * these steps. A workflow never has more power than an automatic, unattended run:
 * every step is read-only, a message, or a change to SupOps' own record of the incident
 * (owner, severity, acknowledgement, a note). Nothing that would change a system --
 * a fix, a silence -- can be a step, because nobody is there to approve it.
 */
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

export const STEP_KINDS = ['notify', 'diagnose', 'recheck', 'assign', 'severity', 'acknowledge', 'note', 'wait', 'if'] as const;
/** Steps that need an incident to act on. A scheduled or manual run without one skips them. */
export const NEEDS_INCIDENT = new Set<WorkflowStep['kind']>(['diagnose', 'recheck', 'assign', 'severity', 'acknowledge', 'note', 'if']);
export const MAX_STEPS = 20;

/** Why a workflow cannot be saved, or null. */
export function workflowProblem(trigger: WorkflowTrigger, steps: WorkflowStep[]): string | null {
  if (!steps.length) return 'Add at least one step.';
  if (steps.length > MAX_STEPS) return `At most ${MAX_STEPS} steps.`;
  if (trigger.type === 'incident') {
    if (!trigger.on.length) return 'Pick at least one incident event to start on.';
    const m = parseMatchers(trigger.matchers);
    if (!m.ok) return `Trigger matchers: ${m.error}`;
  }
  if (trigger.type === 'schedule' && !(trigger.everyMinutes >= 5 && trigger.everyMinutes <= 7 * 24 * 60)) return 'A schedule runs every 5 minutes to every 7 days.';
  for (const [i, s] of steps.entries()) {
    const at = `Step ${i + 1}`;
    if (!(STEP_KINDS as readonly string[]).includes(s.kind)) return `${at}: "${(s as { kind: string }).kind}" is not a step SupOps can run.`;
    if (s.kind === 'notify' && !s.channelIds.length) return `${at}: pick a channel.`;
    if (s.kind === 'wait' && !(s.minutes >= 1 && s.minutes <= 24 * 60)) return `${at}: wait 1 minute to 24 hours.`;
    if (s.kind === 'note' && !s.text.trim()) return `${at}: write the note.`;
    if (s.kind === 'if') {
      const m = parseMatchers(s.matchers);
      if (!m.ok) return `${at}: ${m.error}`;
    }
    if (trigger.type === 'schedule' && NEEDS_INCIDENT.has(s.kind)) return `${at}: a scheduled workflow has no incident to ${s.kind === 'if' ? 'check' : 'act on'}.`;
  }
  return null;
}

export interface TemplateContext {
  incident?: { title: string; severity: string; status: string; url: string | null; rootCause: string | null; targets: string[]; owner: string | null };
  workflow: { name: string };
}

/** `{{incident.title}}` and friends, from a fixed set of values. No code is ever evaluated. */
export function renderTemplate(text: string, ctx: TemplateContext): string {
  const values: Record<string, string> = {
    'workflow.name': ctx.workflow.name,
    'incident.title': ctx.incident?.title ?? '',
    'incident.severity': ctx.incident?.severity ?? '',
    'incident.status': ctx.incident?.status ?? '',
    'incident.url': ctx.incident?.url ?? '',
    'incident.rootCause': ctx.incident?.rootCause ?? 'not diagnosed yet',
    'incident.targets': ctx.incident?.targets.join(', ') ?? '',
    'incident.owner': ctx.incident?.owner ?? 'nobody',
  };
  return text.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (m, k: string) => values[k] ?? m).slice(0, 4000);
}

const RANK: Record<string, number> = { critical: 3, warning: 2, unknown: 2, info: 1 };

/** An `if` step: the incident still matches (labels of any of its alerts), is severe enough, and is open if asked. */
export function conditionHolds(step: Extract<WorkflowStep, { kind: 'if' }>, inc: { severity: string; status: string }, labelSets: Array<Record<string, string>>): boolean {
  if (step.stillOpen && inc.status !== 'open') return false;
  if (step.severityAtLeast && (RANK[inc.severity] ?? 0) < (RANK[step.severityAtLeast] ?? 0)) return false;
  const m = parseMatchers(step.matchers);
  const ms: Matcher[] = m.ok ? m.matchers : [];
  return !ms.length || labelSets.some((l) => matchesAll(ms, l));
}
