import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { runs } from './runs.ts';

export type KnowledgeKind = 'runbook' | 'note' | 'fact';
export type KnowledgeStatus = 'draft' | 'approved' | 'archived';

/** Which runs a document applies to. Empty = the whole project. */
export interface KnowledgeScope {
  targetIds?: string[];
  kinds?: string[];
  envs?: string[];
}

/**
 * What the operators know that the agent should too: runbooks to follow, notes about
 * how things are set up, and short facts ("the primary database is db-1").
 *
 * Only approved documents ever reach a run. Anything a member writes starts as a
 * draft an admin approves -- a document is a trusted instruction channel into every
 * future run, so it gets the same care as an agent's own instructions.
 */
export const knowledgeDocs = sqliteTable(
  'knowledge_docs',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    kind: text('kind').$type<KnowledgeKind>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    scope: text('scope', { mode: 'json' }).$type<KnowledgeScope>().notNull().default({}),
    /** Pinned documents are always included in matching runs (facts default to pinned). */
    pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
    /**
     * Runbooks only: the alerts it is for, as alert names ("DiskFull, Disk*") or
     * Alertmanager matchers. A run on a matching incident is given it to follow.
     */
    alertMatch: text('alert_match'),
    status: text('status').$type<KnowledgeStatus>().notNull().default('draft'),
    sourceRunId: text('source_run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** Where an imported document came from, e.g. "ops-handbook.pdf, p. 4–7". */
    source: text('source'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: ts('approved_at'),
    useCount: integer('use_count').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
  },
  (t) => [
    uniqueIndex('knowledge_project_slug').on(t.projectId, t.slug),
    index('knowledge_project_status').on(t.projectId, t.status, t.kind),
  ],
);

/** Which documents a run was given, so a document can show where it was used. */
export const runKnowledge = sqliteTable(
  'run_knowledge',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    docId: text('doc_id')
      .notNull()
      .references(() => knowledgeDocs.id, { onDelete: 'cascade' }),
    /** pinned/matched/runbook/alert (for the incident's alerts): given at the start. read: the agent chose to read it (read_knowledge). */
    via: text('via').$type<'pinned' | 'matched' | 'runbook' | 'alert' | 'read'>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('run_knowledge_run').on(t.runId), index('run_knowledge_doc').on(t.docId)],
);

/**
 * What an operator thought of an agent reply. A correction is the strongest
 * learning signal there is: it becomes a knowledge note (approved when an admin
 * wrote it, a draft otherwise) so the next run starts from it.
 */
export const runFeedback = sqliteTable(
  'run_feedback',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Kept when the run is cleaned up, so feedback history survives. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    runTitle: text('run_title'),
    stepId: text('step_id'),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    rating: text('rating').$type<'up' | 'down'>().notNull(),
    correction: text('correction'),
    /** The knowledge note a correction created, if any. */
    docId: text('doc_id').references(() => knowledgeDocs.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('run_feedback_run').on(t.runId), index('run_feedback_project').on(t.projectId, t.createdAt)],
);
