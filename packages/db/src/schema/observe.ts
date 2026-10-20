import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AlertSeverity, EvidenceStatus, IncidentStatus, TriageState } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { targets } from './targets.ts';
import { runs } from './runs.ts';

/**
 * One problem, made of related alerts and predictions. Alerts that share a service,
 * namespace or machine and arrive close together join the same incident, so the
 * investigation runs once per problem instead of once per alert.
 */
export const incidents = sqliteTable(
  'incidents',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull().default('unknown'),
    status: text('status').$type<IncidentStatus>().notNull().default('open'),
    /** `alerts` (grouped from alerts) or `prediction` (raised by a forecast). */
    origin: text('origin').$type<'alerts' | 'prediction' | 'threshold'>().notNull().default('alerts'),
    /** The labels that define the group (namespace, service, instance...). */
    groupKey: text('group_key', { mode: 'json' }).$type<Record<string, string>>(),
    /** Why the alerts were grouped, in words a person can check. */
    groupReason: text('group_reason'),
    /** Targets the incident is about, matched from its alerts' labels. */
    targetIds: text('target_ids', { mode: 'json' }).$type<string[]>(),

    triageState: text('triage_state').$type<TriageState>().notNull().default('none'),
    triageNote: text('triage_note'),
    /** The automatic (or first) investigation of this incident. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),
    rootCause: text('root_cause'),
    /** high | medium | low | inconclusive */
    confidence: text('confidence'),
    /** The diagnosis' verdict in plain terms: act_now | can_wait | none. */
    action: text('action').$type<'act_now' | 'can_wait' | 'none'>(),
    /** What the diagnosis weighed: each cause confirmed, ruled out or untested, with its evidence. */
    hypotheses: text('hypotheses', { mode: 'json' }).$type<Array<{ hypothesis: string; verdict: 'confirmed' | 'ruled_out' | 'untested'; evidence: string }>>(),
    /** What is affected, what was checked and is fine, and what was not checked. */
    blastRadius: text('blast_radius', { mode: 'json' }).$type<{ affected: string | null; healthy: string | null; unchecked: string | null }>(),

    openedAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
    resolvedAt: ts('resolved_at'),
    /** Set when a person merged this incident into another. */
    mergedInto: text('merged_into'),
    /**
     * An ignore always ends: at this time the incident is checked again and reopens
     * if its alerts still fire (or its forecast still holds). Never permanent, so a
     * mistaken ignore cannot hide a real problem for good.
     */
    ignoredUntil: ts('ignored_until'),
    /** Who ignored it, and why -- shown with the incident. */
    ignoredBy: text('ignored_by'),
    ignoreReason: text('ignore_reason'),
    /**
     * Someone is on it. An acknowledgement lapses by itself when the incident gets
     * worse (a new alert joins, or a worse severity), so it can never hide news.
     */
    acknowledgedAt: ts('acknowledged_at'),
    acknowledgedBy: text('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    /** Who owns it now. Any user; changing the status never changes this. */
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    /** A person set the severity: new alerts no longer raise or lower it. */
    severityPinned: integer('severity_pinned', { mode: 'boolean' }).notNull().default(false),
    /** Made by this correlation rule, for this group (its group-by values). */
    ruleId: text('rule_id'),
    ruleGroupKey: text('rule_group_key'),
    /**
     * Waiting for its rule's threshold: not listed, not counted, not diagnosed until
     * enough alerts join. Its alerts are shown on the Alerts page meanwhile.
     */
    held: integer('held', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [index('incidents_project_status').on(t.projectId, t.status, t.openedAt), index('incidents_resolved').on(t.resolvedAt)],
);

/** A person's grouping rule (see rules.ts in core). Evaluated in `priority` order, lowest first. */
export const correlationRules = sqliteTable(
  'correlation_rules',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    matchers: text('matchers', { mode: 'json' }).$type<Array<{ name: string; op: '=' | '!=' | '=~' | '!~'; value: string }>>().notNull(),
    groupBy: text('group_by', { mode: 'json' }).$type<string[]>().notNull(),
    windowMin: integer('window_min').notNull().default(15),
    threshold: integer('threshold').notNull().default(1),
    resolveOn: text('resolve_on').$type<'all' | 'first' | 'never'>().notNull().default('all'),
    titleTemplate: text('title_template').notNull().default(''),
    priority: integer('priority').notNull().default(100),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** Incidents it has made, and alerts it has grouped: shown so a useless rule is easy to spot. */
    incidentsMade: integer('incidents_made').notNull().default(0),
    alertsGrouped: integer('alerts_grouped').notNull().default(0),
    lastMatchedAt: ts('last_matched_at'),
  },
  (t) => [index('correlation_rules_project').on(t.projectId, t.priority)],
);

export type IncidentEventKind =
  | 'acknowledged'
  | 'unacknowledged'
  | 'ack_lapsed'
  | 'assigned'
  | 'comment'
  | 'severity'
  | 'merged_in'
  | 'split_out'
  | 'resolved'
  | 'reopened';

/**
 * What people did with an incident, and what undid it: acknowledgements, assignment,
 * comments, severity changes, merges. Append-only -- never edited or deleted -- so the
 * timeline is a record. (What the alerts and the diagnosis did is read from them.)
 */
export const incidentEvents = sqliteTable(
  'incident_events',
  {
    id: id(),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    at: createdAt(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    /** Kept with the event, so it still reads right after the user is removed. Null: SupOps itself. */
    actorName: text('actor_name'),
    kind: text('kind').$type<IncidentEventKind>().notNull(),
    /** comment: { text }; assigned: { to, toName }; severity: { from, to }; ... */
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [index('incident_events_incident').on(t.incidentId, t.at)],
);

/**
 * The result of one read-only check run for an incident. `ref` (E1, E2...) is what
 * the investigation cites, and what the report's citations are verified against.
 */
export const evidence = sqliteTable(
  'evidence',
  {
    id: id(),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    check: text('check').notNull(),
    title: text('title').notNull(),
    connectionId: text('connection_id').references(() => targets.id, { onDelete: 'set null' }),
    query: text('query'),
    status: text('status').$type<EvidenceStatus>().notNull(),
    summary: text('summary').notNull(),
    data: text('data', { mode: 'json' }).$type<unknown>(),
    createdAt: createdAt(),
  },
  (t) => [index('evidence_incident').on(t.incidentId)],
);

export interface WatchLimit {
  /** The value at which the resource is exhausted (e.g. 0 bytes free, 100%). */
  value: number;
  /** Exhausted when the series falls below (`below`) or rises above (`above`) it. */
  when: 'below' | 'above';
}

/**
 * A signal SupOps watches on a metrics connection: a PromQL query evaluated every
 * few minutes, kept as a small rollup, and checked for anomalies and for when it
 * will run out. Built-in watches are discovered from the metrics that exist.
 */
export const watches = sqliteTable(
  'watches',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    connectionId: text('connection_id')
      .notNull()
      .references(() => targets.id, { onDelete: 'cascade' }),
    /** Built-in signal key (e.g. `disk_free`) or `custom:<slug>`. */
    key: text('key').notNull(),
    title: text('title').notNull(),
    query: text('query').notNull(),
    /** percent | bytes | seconds | ratio | count | days | per_second */
    unit: text('unit').notNull().default('count'),
    builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
    /** Which way is bad, for anomaly direction: up, down or both. */
    badDirection: text('bad_direction').$type<'up' | 'down' | 'both'>().notNull().default('both'),
    /** When set, the watch forecasts the time until this limit is reached. */
    limit: text('limit', { mode: 'json' }).$type<WatchLimit | null>(),
    /** Self-adjusting threshold: each series learns P99 + n x IQR from its last 7 days. */
    adaptive: text('adaptive', { mode: 'json' }).$type<{ iqrs: number } | null>(),
    /** stack = the observability stack's own health. */
    group: text('group').$type<'resources' | 'traffic' | 'kubernetes' | 'databases' | 'stack' | 'custom'>().notNull().default('custom'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    lastRunAt: ts('last_run_at'),
    lastError: text('last_error'),
    seriesCount: integer('series_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('watches_connection_key').on(t.connectionId, t.key), index('watches_project').on(t.projectId)],
);

/** Rolled-up samples of a watch, one per series per step. Kept 15 days by default. */
export const metricPoints = sqliteTable(
  'metric_points',
  {
    watchId: text('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    /** The series' labels, canonical `{a="1",b="2"}`. */
    series: text('series').notNull(),
    at: integer('at').notNull(),
    value: real('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.watchId, t.series, t.at] }), index('metric_points_at').on(t.at)],
);

/**
 * Something the watcher noticed: a series behaving unlike its own baseline
 * (`anomaly`), or heading for its limit (`forecast`). Stays open while it holds and
 * resolves on its own when it stops.
 */
export const observations = sqliteTable(
  'observations',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    watchId: text('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    series: text('series').notNull(),
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>(),
    targetId: text('target_id').references(() => targets.id, { onDelete: 'set null' }),
    kind: text('kind').$type<'anomaly' | 'forecast'>().notNull(),
    severity: text('severity').$type<'info' | 'warning' | 'critical'>().notNull(),
    message: text('message').notNull(),
    value: real('value'),
    /** anomaly: { z, baseline, direction }; forecast: { etaMs, limit, slopePerHour, confidence } */
    details: text('details', { mode: 'json' }).$type<Record<string, unknown>>(),
    incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    startedAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
    resolvedAt: ts('resolved_at'),
  },
  (t) => [
    index('observations_open').on(t.projectId, t.resolvedAt),
    index('observations_watch').on(t.watchId, t.series, t.kind),
  ],
);

/**
 * The latest look at every series of a watch: its value, how close it is to trouble
 * (score 0-100, with reasons) and what that is based on. One row per series,
 * replaced on every scan, so the list of what is watched is always complete -- the
 * history behind a graph is read from the metrics backend when it is shown.
 */
export const watchSeries = sqliteTable(
  'watch_series',
  {
    watchId: text('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    series: text('series').notNull(),
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    name: text('name').notNull(),
    value: real('value').notNull(),
    score: integer('score').notNull().default(0),
    reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull(),
    /** Last day's average and spread: the "usual range" band on its graph. */
    avg1d: real('avg_1d'),
    sd1d: real('sd_1d'),
    /** Change per hour over the last 6 hours, for the forecast line. */
    slopePerHour: real('slope_per_hour'),
    etaMs: integer('eta_ms'),
    /** Consecutive scans it has looked unusual; two in a row before it is reported. */
    anomalyStreak: integer('anomaly_streak').notNull().default(0),
    targetId: text('target_id').references(() => targets.id, { onDelete: 'set null' }),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.watchId, t.series] }), index('watch_series_score').on(t.watchId, t.score)],
);

/** The limit each series of an adaptive watch learned from its last 7 days, relearned daily. */
export const adaptiveLimits = sqliteTable(
  'adaptive_limits',
  {
    watchId: text('watch_id')
      .notNull()
      .references(() => watches.id, { onDelete: 'cascade' }),
    series: text('series').notNull(),
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    upper: real('upper'),
    lower: real('lower'),
    computedAt: ts('computed_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.watchId, t.series] })],
);

/** A person said two incidents are not the same problem: never suggested for merging again. */
export const incidentDismissals = sqliteTable(
  'incident_dismissals',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The two incident ids, in sorted order. */
    a: text('a').notNull(),
    b: text('b').notNull(),
    by: text('by').references(() => users.id, { onDelete: 'set null' }),
    at: ts('at').notNull().$defaultFn(() => new Date()),
  },
  (t) => [primaryKey({ columns: [t.a, t.b] })],
);
