import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id } from './_common.ts';
import { projects, users } from './identity.ts';
import { targets } from './targets.ts';
import { syntheticChecks } from './synthetics.ts';

/** The last evaluation: the SLI over the window, the budget left, burn rates, what fires. */
export interface SloStatus {
  at: number;
  /** Good share over the whole window, 0..1. */
  sli: number | null;
  budgetRemaining: number | null;
  /** Burn rate per window (5m ... 24h): 1 = spending exactly the budget. */
  rates: Record<string, number | null>;
  firing: Array<{ rule: string; severity: 'critical' | 'warning'; long: string; short: string; rate: number; burn: number }>;
  error?: string;
}

/**
 * A service level objective: good events over total events (two PromQL expressions with
 * `$window` where the window goes), a target share, and the window it is measured over.
 * Burn-rate alerts arrive as ordinary alerts, so they group, notify and get diagnosed
 * like any other.
 */
export const slos = sqliteTable(
  'slos',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    service: text('service'),
    /** Measured on PromQL from this connection, or (syntheticId) on a synthetic check's results. */
    connectionId: text('connection_id').references(() => targets.id, { onDelete: 'cascade' }),
    syntheticId: text('synthetic_id').references(() => syntheticChecks.id, { onDelete: 'cascade' }),
    goodQuery: text('good_query').notNull().default(''),
    totalQuery: text('total_query').notNull().default(''),
    /** e.g. 0.999 */
    target: real('target').notNull(),
    windowDays: integer('window_days').notNull().default(30),
    /** Raise burn-rate alerts. */
    alerting: integer('alerting', { mode: 'boolean' }).notNull().default(true),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    status: text('status', { mode: 'json' }).$type<SloStatus>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('slos_project').on(t.projectId)],
);
