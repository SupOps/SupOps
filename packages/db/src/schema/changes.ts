import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects } from './identity.ts';
import { targets } from './targets.ts';
import { runs } from './runs.ts';
import { alertIntegrations } from './alerts.ts';

export type ChangeSource = 'api' | 'kubernetes' | 'grafana' | 'supops' | 'manual';

/** Before and after a deploy, per signal: what changed, flagged when it got worse. */
export interface DeployVerdict {
  computedAt: number;
  /** better | worse | same | unknown (no data). */
  overall: 'better' | 'worse' | 'same' | 'unknown';
  signals: Array<{ name: string; before: number | null; after: number | null; unit: string; change: number | null; flag: boolean; note?: string }>;
}

/**
 * Something that changed: a deploy from CI, a rollout seen in a cluster, an annotation
 * in Grafana, or an action SupOps carried out with approval. Changes never open
 * incidents; they are listed as suspects when one opens.
 */
export const changes = sqliteTable(
  'changes',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source').$type<ChangeSource>().notNull(),
    kind: text('kind').$type<'deploy' | 'config' | 'rollback' | 'flag' | 'infra' | 'action' | 'other'>().notNull(),
    title: text('title').notNull(),
    service: text('service'),
    environment: text('environment'),
    version: text('version'),
    previousVersion: text('previous_version'),
    author: text('author'),
    url: text('url'),
    status: text('status').$type<'started' | 'succeeded' | 'failed'>(),
    targetId: text('target_id').references(() => targets.id, { onDelete: 'set null' }),
    integrationId: text('integration_id').references(() => alertIntegrations.id, { onDelete: 'set null' }),
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    /** The sender's own id, so a repeated delivery is stored once. */
    externalId: text('external_id'),
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>(),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    /** Deploys: the signals before and after, once enough time has passed to compare. */
    verdict: text('verdict', { mode: 'json' }).$type<DeployVerdict>(),
    createdAt: createdAt(),
  },
  (t) => [index('changes_project_started').on(t.projectId, t.startedAt), uniqueIndex('changes_external').on(t.projectId, t.source, t.externalId)],
);

/** What each cluster workload looked like at the last poll, so a restart misses no rollout. */
export const rolloutStates = sqliteTable(
  'rollout_states',
  {
    targetId: text('target_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    generation: integer('generation').notNull(),
    images: text('images', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.targetId, t.key] })],
);

/**
 * A person's verdict on a suspected change: it was the cause of this incident, or it
 * was not. The features are kept as the ranking saw them, together with the other
 * suspects shown at the time, so the learned ranking can be retrained from these rows
 * alone, even after the changes or the incident are cleaned up.
 */
export const suspectFeedback = sqliteTable(
  'suspect_feedback',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    incidentId: text('incident_id').notNull(),
    changeId: text('change_id').notNull(),
    changeTitle: text('change_title').notNull(),
    verdict: text('verdict').$type<'cause' | 'not_cause'>().notNull(),
    features: text('features', { mode: 'json' }).$type<number[]>().notNull(),
    /** For "cause": the other suspects shown then, each an implied "not this". */
    others: text('others', { mode: 'json' }).$type<number[][]>().notNull().default([]),
    userId: text('user_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('suspect_feedback_pair').on(t.incidentId, t.changeId), index('suspect_feedback_project').on(t.projectId)],
);
