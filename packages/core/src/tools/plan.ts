import { z } from 'zod';
import { TARGET_KINDS } from '@supops/shared';
import type { RiskContribution } from '@supops/shared';
import type { ToolDef } from './types.ts';
import { NETWORK_TARGET } from './net-check.ts';
import { okOutput } from './output.ts';

/**
 * The model's own to-do list for this run, replaced whole on every call. It changes
 * nothing anywhere: the run page shows the latest list live, and it survives the
 * conversation being summarised. Read-only by construction.
 */
export const PLAN_STATUSES = ['todo', 'doing', 'done', 'dropped'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export interface PlanStep {
  step: string;
  status: PlanStatus;
  note?: string;
}

const MAX_STEPS = 12;

const NOTHING: RiskContribution[] = [{ stage: 'arguments', tier: 'read_only', ruleId: 'plan.update', reason: 'updates the run\'s own to-do list; changes nothing outside SupOps' }];

const args = z.object({
  target: z.string(),
  steps: z
    .array(
      z.object({
        step: z.string().trim().min(1).max(200),
        status: z.enum(PLAN_STATUSES),
        note: z.string().trim().max(200).optional(),
      }),
    )
    .min(1)
    .max(MAX_STEPS),
});

const MARK: Record<PlanStatus, string> = { todo: '[ ]', doing: '[>]', done: '[x]', dropped: '[-]' };

export function renderPlan(steps: PlanStep[]): string {
  return steps.map((s, i) => `${i + 1}. ${MARK[s.status]} ${s.step}${s.note ? ` -- ${s.note}` : ''}`).join('\n');
}

/** The plan as a tool call left it, or null when the arguments are not a plan. */
export function planFromArgs(a: unknown): PlanStep[] | null {
  const parsed = args.safeParse({ target: '', ...(a as object) });
  return parsed.success ? parsed.data.steps : null;
}

export const planTool: ToolDef<z.infer<typeof args>> = {
  key: 'update_plan',
  kind: 'knowledge',
  description:
    'Keep a short to-do list for this investigation, shown live to the operator. Call it once you know the steps ' +
    '(the hypotheses to test, then the fix and its check), and again whenever a step starts, finishes or is dropped. ' +
    'Send the whole list each time (at most 12 steps); status is todo, doing, done or dropped, with an optional short note ' +
    '(for example what a check showed). Skip it for a one-step task. The target is always supops-server.',
  parameters: {
    steps: {
      type: 'array',
      description: 'The whole list, in order.',
      items: {
        type: 'object',
        properties: {
          step: { type: 'string', description: 'What to do, in a few words.' },
          status: { type: 'string', enum: [...PLAN_STATUSES] },
          note: { type: 'string', description: 'Optional: the result, or why it was dropped.' },
        },
        required: ['step', 'status'],
      },
    },
  },
  required: ['steps'],
  argsSchema: args,
  baselineRisk: 'read_only',
  targetKinds: [...TARGET_KINDS],
  // About the run itself, not any machine: always the SupOps server, so the model never has to pick one.
  fixedTarget: NETWORK_TARGET,
  mutating: false,
  timeoutMs: 1_000,
  render: (a) => {
    const done = a.steps.filter((s) => s.status === 'done').length;
    return `update_plan ${done}/${a.steps.length} done`;
  },
  classifyArgs: () => NOTHING,
  execute: async (a) => okOutput(`Plan updated:\n${renderPlan(a.steps)}`),
};
