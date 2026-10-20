import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { id, ts } from './_common.ts';
import { projects } from './identity.ts';

/**
 * Errors grouped by service, exception type, own top frame and masked message, read from
 * logs and traces. A group first seen soon after a change to its service is marked with
 * that change: the likeliest cause of a new kind of error.
 */
export const errorGroups = sqliteTable(
  'error_groups',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fingerprint: text('fingerprint').notNull(),
    service: text('service').notNull(),
    type: text('type').notNull(),
    message: text('message').notNull(),
    frame: text('frame'),
    source: text('source').$type<'logs' | 'traces'>().notNull(),
    example: text('example').notNull(),
    traceId: text('trace_id'),
    count: integer('count').notNull().default(0),
    /** Occurrences in the latest scan: is it still happening? */
    lastCount: integer('last_count').notNull().default(0),
    firstSeen: ts('first_seen').notNull(),
    lastSeen: ts('last_seen').notNull(),
    newAfterChange: text('new_after_change', { mode: 'json' }).$type<{ changeId: string; title: string; startedAt: number } | null>(),
  },
  (t) => [uniqueIndex('error_groups_fp').on(t.projectId, t.fingerprint), index('error_groups_seen').on(t.projectId, t.lastSeen)],
);
