import type { ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check, Circle, ListChecks, Loader2, Minus } from 'lucide-react';
import type { ToolCall } from '../lib/types';

type Status = 'todo' | 'doing' | 'done' | 'dropped';
interface Step {
  step: string;
  status: Status;
  note?: string;
}

export const PLAN_TOOL = 'update_plan';

function stepsOf(call: ToolCall): Step[] {
  const steps = (call.argsJson as { steps?: unknown }).steps;
  return Array.isArray(steps)
    ? steps.filter((s): s is Step => !!s && typeof (s as Step).step === 'string' && ['todo', 'doing', 'done', 'dropped'].includes((s as Step).status))
    : [];
}

/** The plan as the agent last left it: the latest successful update_plan call (calls in the order made). */
export function latestPlan(calls: ToolCall[]): Step[] {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.toolKey === PLAN_TOOL && c.state === 'succeeded') return stepsOf(c);
  }
  return [];
}

/** The plain step strings a confirm_target call carried, if any (the seeded plan). */
function confirmTargetSteps(call: ToolCall): Step[] {
  const raw = (call.argsJson as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => ({ step: s, status: 'todo' as const }));
}

/**
 * The run's plan for the panel: the latest update_plan if the agent made one (with live
 * statuses), otherwise the steps it seeded via confirm_target (shown as a plain checklist,
 * `seeded`, so it does not read as "0 of N done"). update_plan always wins because it comes
 * later in the run.
 */
export function runPlan(calls: ToolCall[]): { steps: Step[]; seeded: boolean } {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.toolKey === PLAN_TOOL && c.state === 'succeeded') return { steps: stepsOf(c), seeded: false };
    if (c.toolKey === 'confirm_target' && c.state === 'succeeded') {
      const steps = confirmTargetSteps(c);
      if (steps.length) return { steps, seeded: true };
    }
  }
  return { steps: [], seeded: false };
}

const ICON: Record<Status, ReactNode> = {
  done: <Check size={13} className="text-green" aria-label="done" />,
  doing: <Loader2 size={13} className="animate-spin text-blue-text motion-reduce:animate-none" aria-label="in progress" />,
  todo: <Circle size={11} className="text-muted" aria-label="to do" />,
  dropped: <Minus size={13} className="text-muted" aria-label="dropped" />,
};

/** The agent's to-do list, updated live as the run works through it. */
export function PlanCard({ steps, live, seeded }: { steps: Step[]; live: boolean; seeded?: boolean }) {
  if (!steps.length) return null;
  const done = steps.filter((s) => s.status === 'done').length;
  const open = steps.filter((s) => s.status !== 'dropped').length;
  return (
    <section className="mt-4 rounded-tile border border-hairline bg-tile px-4 py-3" aria-label="The agent's plan">
      <div className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
        <ListChecks size={13} /> Plan
        <span className="font-normal normal-case tracking-normal">
          {/* A seeded plan (from confirm_target) is what the agent set out to do; it only
              gains done/doing marks once the agent starts calling update_plan. */}
          {seeded ? `${open} step${open === 1 ? '' : 's'}` : `${done} of ${open} done${live ? '' : ' when the run ended'}`}
        </span>
      </div>
      <ol className="space-y-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2.5 text-[13px] leading-snug">
            <span className="mt-0.5 grid w-4 shrink-0 place-items-center">{ICON[s.status]}</span>
            <span className={clsx('min-w-0 break-words', s.status === 'dropped' && 'text-muted line-through', s.status === 'doing' && 'font-medium text-ink', s.status === 'done' && 'text-ink/80')}>
              {s.step}
              {s.note && <span className="text-muted"> · {s.note}</span>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** In the timeline: one quiet line per plan update instead of a full action card. */
export function PlanLine({ call }: { call: ToolCall }) {
  const steps = stepsOf(call);
  const doing = steps.find((s) => s.status === 'doing');
  const done = steps.filter((s) => s.status === 'done').length;
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted">
      <ListChecks size={13} className="shrink-0" />
      <span className="min-w-0 truncate">
        Plan updated: {done}/{steps.filter((s) => s.status !== 'dropped').length} done{doing ? ` · now: ${doing.step}` : ''}
      </span>
    </div>
  );
}
