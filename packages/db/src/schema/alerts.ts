import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import type { AlertSeverity, AlertSource, AlertStatus } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { runs } from './runs.ts';
import { targets } from './targets.ts';
import { incidents } from './observe.ts';

/**
 * One alert, as SupOps saw it: from a Slack message an Alertmanager posted, read
 * directly from a connection (`connectionId`), or raised by SupOps from a forecast.
 *
 * Dedup is by `(projectId, fingerprint)` while the alert is still open: a flapping
 * alert bumps `count`/`lastSeenAt` on the existing row instead of spawning a new
 * one, and a resolve flips the matching open row to `resolved` (kept for history,
 * cleaned up with the rest of the observability data).
 */
export const alerts = sqliteTable(
  'alerts',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    source: text('source').$type<AlertSource>().notNull().default('slack'),

    /** The Slack channel the alert arrived in -- shown as the category/segregation. */
    channelId: text('channel_id'),
    channelName: text('channel_name'),

    /** sha256(alertname + instance + channel). Collapses repeats, links resolves. */
    fingerprint: text('fingerprint').notNull(),

    title: text('title').notNull(),
    severity: text('severity').$type<AlertSeverity>().notNull().default('unknown'),
    status: text('status').$type<AlertStatus>().notNull().default('new'),
    summary: text('summary'),
    /** Parsed labels (alertname, instance, job, ...). Drives target auto-matching. */
    labels: text('labels', { mode: 'json' }).$type<Record<string, string>>(),
    /** The full source message, always kept so parsing can improve after the fact. */
    rawPayload: text('raw_payload', { mode: 'json' }).$type<unknown>(),

    /** The connection it was read from, for alerts not relayed through Slack. */
    connectionId: text('connection_id').references(() => targets.id, { onDelete: 'set null' }),
    /** The webhook sender it was pushed by, for alerts that arrived that way. */
    integrationId: text('integration_id').references((): AnySQLiteColumn => alertIntegrations.id, { onDelete: 'set null' }),
    /**
     * What the alert last said, minus timestamps (see contentHash). A notification with
     * the same fingerprint and the same content is an exact repeat: counted, not stored.
     */
    contentHash: text('content_hash'),
    /** The incident this alert is part of. */
    incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
    /** When the source says it started firing (Alertmanager's startsAt). */
    startsAt: ts('starts_at'),
    resolvedAt: ts('resolved_at'),

    slackTs: text('slack_ts'),
    slackPermalink: text('slack_permalink'),

    /** How many times this same alert has fired while the row stayed open. */
    count: integer('count').notNull().default(1),
    /**
     * Firing and resolving over and over (see flapping.ts). While set, its incident is
     * not diagnosed; once the alert stays quiet for the flapping window it settles.
     */
    flapping: integer('flapping', { mode: 'boolean' }).notNull().default(false),
    flappingSince: ts('flapping_since'),
    /**
     * The maintenance window muting this alert: stored and shown, but no incident and
     * no diagnosis until the window ends. Cleared when it ends (see maintenance.ts).
     */
    maintenanceId: text('maintenance_id').references((): AnySQLiteColumn => maintenanceWindows.id, { onDelete: 'set null' }),
    /**
     * Labels SupOps added, and where from: `catalogue:<component id>` (owner, team,
     * runbook from the service map) or `rule:<extraction rule id>`. The source's own
     * labels are never overwritten.
     */
    enriched: text('enriched', { mode: 'json' }).$type<Record<string, string>>(),

    /** The investigation run started from this alert, if any. */
    runId: text('run_id').references(() => runs.id, { onDelete: 'set null' }),

    receivedAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
    decidedAt: ts('decided_at'),
    decidedBy: text('decided_by').references(() => users.id),
  },
  (t) => [
    index('alerts_project_status').on(t.projectId, t.status, t.receivedAt),
    index('alerts_run').on(t.runId),
    index('alerts_incident').on(t.incidentId),
  ],
);

/**
 * Routing layer, kept separate from the (workspace-level) Slack connection so the
 * same channel can feed more than one project. A message in `channelId` creates one
 * alert per enabled subscription that names it.
 */
export const alertSubscriptions = sqliteTable(
  'alert_subscriptions',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    channelName: text('channel_name').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index('alert_subs_channel').on(t.channelId, t.enabled)],
);

export type AlertIntegrationKind = 'alertmanager' | 'grafana' | 'pagerduty' | 'opsgenie' | 'generic' | 'changes';

/**
 * A sender that pushes alerts to SupOps by webhook: an Alertmanager, a Grafana
 * contact point, PagerDuty, Opsgenie, or anything that can POST JSON.
 *
 * Each has its own token, shown once when created and stored only as a hash, so a
 * leaked token is revoked by rotating one sender instead of all of them. Rotating
 * keeps the old token working for a day, so the sender can be updated without a gap.
 */
export const alertIntegrations = sqliteTable(
  'alert_integrations',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<AlertIntegrationKind>().notNull(),
    name: text('name').notNull(),
    /** sha256 of the token, hex. The token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    /** The token's first characters, so a person can tell which one a sender has. */
    tokenPrefix: text('token_prefix').notNull(),
    /** The token before the last rotation, accepted until `previousTokenUntil`. */
    previousTokenHash: text('previous_token_hash'),
    previousTokenUntil: ts('previous_token_until'),
    /** For `generic`: where each field is in the sender's JSON (GenericMapping). */
    mapping: text('mapping', { mode: 'json' }).$type<Record<string, unknown>>(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /**
     * Optional: credentials to write back to the source (PagerDuty REST API token and
     * the email it acts as; an Opsgenie API key), so acknowledging or resolving in
     * SupOps does the same there, and the diagnosis is added as a note. Encrypted.
     */
    writebackEnc: text('writeback_enc'),
    writebackConfig: text('writeback_config', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** Requests accepted, alerts in them, exact repeats dropped, and requests refused. */
    received: integer('received').notNull().default(0),
    alertsIn: integer('alerts_in').notNull().default(0),
    repeats: integer('repeats').notNull().default(0),
    rejected: integer('rejected').notNull().default(0),
    lastReceivedAt: ts('last_received_at'),
    /** The last refused request: why, and when -- shown so a misconfigured sender is easy to spot. */
    lastError: text('last_error'),
    lastErrorAt: ts('last_error_at'),
  },
  (t) => [index('alert_integrations_project').on(t.projectId)],
);

export interface StoredMatcher {
  name: string;
  op: '=' | '!=' | '=~' | '!~';
  value: string;
}

export interface StoredWeeklySlot {
  days: number[];
  start: string;
  end: string;
  timezone: string;
}

/**
 * Planned work: while a window is active, new alerts that match it are stored and
 * shown, but open no incident and start no diagnosis. When it ends, the ones still
 * firing are processed as if they had just arrived. Nothing is ever dropped.
 */
export const maintenanceWindows = sqliteTable(
  'maintenance_windows',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    reason: text('reason'),
    /** Alertmanager-style matchers; at least one, so a window never mutes everything. */
    matchers: text('matchers', { mode: 'json' }).$type<StoredMatcher[]>().notNull(),
    startsAt: ts('starts_at').notNull(),
    endsAt: ts('ends_at').notNull(),
    /** Optional weekly slot repeating between startsAt and endsAt. */
    recurrence: text('recurrence', { mode: 'json' }).$type<StoredWeeklySlot | null>(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** Ended early (or cancelled before it began), and by whom. */
    cancelledAt: ts('cancelled_at'),
    cancelledBy: text('cancelled_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('maintenance_windows_project').on(t.projectId, t.endsAt)],
);

/**
 * Pull labels out of an alert's text with a regular expression: each named group
 * that matches becomes a label (`code=(?<error_code>\d+)` gives `error_code`). Run on
 * every alert as it arrives, so patterns that could take exponential time are refused
 * when saved, and the text is capped.
 */
export const extractionRules = sqliteTable(
  'extraction_rules',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Only alerts these match; empty: every alert. */
    matchers: text('matchers', { mode: 'json' }).$type<StoredMatcher[]>().notNull(),
    /** title | summary | label */
    field: text('field').$type<'title' | 'summary' | 'label'>().notNull(),
    /** For `label`: which label's value to read. */
    labelName: text('label_name'),
    pattern: text('pattern').notNull(),
    priority: integer('priority').notNull().default(100),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    /** Alerts it looked at (its matchers held), and how many it added labels to. */
    seen: integer('seen').notNull().default(0),
    applied: integer('applied').notNull().default(0),
    lastAppliedAt: ts('last_applied_at'),
    /** The labels it added last time, for the rule list. */
    lastExample: text('last_example', { mode: 'json' }).$type<Record<string, string>>(),
  },
  (t) => [index('extraction_rules_project').on(t.projectId, t.priority)],
);

/**
 * What SupOps wrote back to where an alert came from: an acknowledgement or a resolve
 * on the PagerDuty or Opsgenie incident, a note with the diagnosis, a reply in the
 * Slack thread. One row per action (`key`), so each happens once.
 */
export const sourceWritebacks = sqliteTable(
  'source_writebacks',
  {
    id: id(),
    incidentId: text('incident_id')
      .notNull()
      .references(() => incidents.id, { onDelete: 'cascade' }),
    /** The webhook source, or null for a Slack thread reply. */
    integrationId: text('integration_id').references(() => alertIntegrations.id, { onDelete: 'cascade' }),
    action: text('action').$type<'acknowledge' | 'resolve' | 'note' | 'slack_reply'>().notNull(),
    key: text('key').notNull().unique(),
    status: text('status').$type<'done' | 'failed'>().notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    at: createdAt(),
  },
  (t) => [index('source_writebacks_incident').on(t.incidentId)],
);
