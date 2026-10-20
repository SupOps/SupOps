import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';

/**
 * A check SupOps runs on a schedule from its own server: an HTTP endpoint, a TCP port, a
 * DNS name or a TLS certificate. Failures raise alerts; every result counts towards the
 * check's availability, and an SLO can be measured on it.
 */
export const syntheticChecks = sqliteTable(
  'synthetic_checks',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind').$type<'http' | 'tcp' | 'dns' | 'tls'>().notNull(),
    target: text('target').notNull(),
    port: integer('port'),
    method: text('method').$type<'GET' | 'HEAD'>(),
    expectStatus: text('expect_status'),
    contains: text('contains'),
    maxLatencyMs: integer('max_latency_ms'),
    certDaysWarn: integer('cert_days_warn').notNull().default(14),
    intervalSec: integer('interval_sec').notNull().default(300),
    /** Failures in a row before an alert (one blip is not an outage). */
    failThreshold: integer('fail_threshold').notNull().default(2),
    allowPrivate: integer('allow_private', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: ts('last_run_at'),
    lastStatus: text('last_status').$type<'up' | 'degraded' | 'down'>(),
    lastError: text('last_error'),
    failStreak: integer('fail_streak').notNull().default(0),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('synthetic_checks_project').on(t.projectId)],
);

/** One run of a check. Kept 30 days. */
export const syntheticResults = sqliteTable(
  'synthetic_results',
  {
    id: id(),
    checkId: text('check_id')
      .notNull()
      .references(() => syntheticChecks.id, { onDelete: 'cascade' }),
    at: ts('at').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull(),
    status: text('status').$type<'up' | 'degraded' | 'down'>().notNull(),
    latencyMs: integer('latency_ms'),
    statusCode: integer('status_code'),
    certDaysLeft: integer('cert_days_left'),
    error: text('error'),
  },
  (t) => [index('synthetic_results_check_at').on(t.checkId, t.at)],
);
