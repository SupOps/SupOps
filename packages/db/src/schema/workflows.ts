import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { incidents } from './observe.ts';

/**
 * A workflow: a trigger and steps (see workflows/index.ts in core). `revision` goes
 * up on every edit; a run keeps the steps of the revision it started on.
 */
export const workflows = sqliteTable(
  'workflows',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    trigger: text('trigger', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    steps: text('steps', { mode: 'json' }).$type<Array<Record<string, unknown>>>().notNull(),
    revision: integer('revision').notNull().default(1),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** When it was last saved: incident events from before this do not start it. */
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
    lastRunAt: ts('last_run_at'),
  },
  (t) => [index('workflows_project').on(t.projectId)],
);

export interface WorkflowLogEntry {
  step: number;
  at: number;
  status: 'done' | 'skipped' | 'failed' | 'waiting' | 'stopped';
  text: string;
}

/** One run of a workflow, with a line per step. `dedupeKey` makes each trigger start it once. */
export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    id: id(),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    steps: text('steps', { mode: 'json' }).$type<Array<Record<string, unknown>>>().notNull(),
    incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    /** What started it: "incident opened", "schedule", "Ana, by hand". */
    reason: text('reason').notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    status: text('status').$type<'running' | 'waiting' | 'succeeded' | 'failed' | 'stopped'>().notNull().default('running'),
    nextStep: integer('next_step').notNull().default(0),
    resumeAt: ts('resume_at'),
    log: text('log', { mode: 'json' }).$type<WorkflowLogEntry[]>().notNull().$defaultFn(() => []),
    startedBy: text('started_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: createdAt(),
    endedAt: ts('ended_at'),
  },
  (t) => [index('workflow_runs_workflow').on(t.workflowId, t.startedAt), index('workflow_runs_due').on(t.status, t.resumeAt)],
);
