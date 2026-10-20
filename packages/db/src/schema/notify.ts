import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { incidents } from './observe.ts';

export type ChannelKind = 'slack' | 'teams' | 'email' | 'webhook' | 'pagerduty' | 'opsgenie';

/**
 * Where SupOps tells people about incidents: a Slack channel, a Teams channel (through
 * a Workflows webhook), email, a signed webhook, PagerDuty (Events v2) or Opsgenie.
 *
 * `config` is what may be shown (the Slack channel, the email recipients, a webhook's
 * host); `secretEnc` holds what may not (webhook URLs, keys, SMTP passwords), encrypted
 * with the master key and never returned by the API.
 */
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<ChannelKind>().notNull(),
    name: text('name').notNull(),
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    secretEnc: text('secret_enc'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    sent: integer('sent').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    lastSentAt: ts('last_sent_at'),
    lastError: text('last_error'),
    lastErrorAt: ts('last_error_at'),
  },
  (t) => [index('notification_channels_project').on(t.projectId)],
);

export type NotifyEvent = 'opened' | 'escalated' | 'acknowledged' | 'resolved' | 'reopened' | 'diagnosed' | 'digest' | 'test';

export interface StoredQuietHours {
  days: number[];
  start: string;
  end: string;
  timezone: string;
}

/**
 * Which incidents go to which channels, and for which events. Every enabled route
 * that matches applies. During quiet hours only critical incidents notify; the rest
 * are recorded as skipped and appear in the daily digest.
 */
export const notificationRoutes = sqliteTable(
  'notification_routes',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** Matched on the incident's alerts' labels (any alert). Empty: every incident. */
    matchers: text('matchers', { mode: 'json' }).$type<Array<{ name: string; op: '=' | '!=' | '=~' | '!~'; value: string }>>().notNull(),
    minSeverity: text('min_severity').$type<'info' | 'warning' | 'critical'>().notNull().default('warning'),
    events: text('events', { mode: 'json' }).$type<NotifyEvent[]>().notNull(),
    channelIds: text('channel_ids', { mode: 'json' }).$type<string[]>().notNull(),
    quietHours: text('quiet_hours', { mode: 'json' }).$type<StoredQuietHours | null>(),
    /** A digest of the last day, sent at this hour (0-23, in the quiet hours' or UTC time zone). Null: none. */
    digestHour: integer('digest_hour'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('notification_routes_project').on(t.projectId)],
);

/**
 * One notification to one channel: sent, failed (retried a few times), or skipped
 * (with why: quiet hours, flapping...). `dedupeKey` makes each event go out once per
 * channel, however often the notifier looks. `threadRef` is what later messages reply
 * to: a Slack message's ts, the PagerDuty dedup key, the Opsgenie alias.
 */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    channelId: text('channel_id')
      .notNull()
      .references(() => notificationChannels.id, { onDelete: 'cascade' }),
    routeId: text('route_id').references(() => notificationRoutes.id, { onDelete: 'set null' }),
    incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
    event: text('event').$type<NotifyEvent>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    status: text('status').$type<'pending' | 'sent' | 'failed' | 'skipped'>().notNull().default('pending'),
    reason: text('reason'),
    /** What was known when it was queued (severity, title), for escalation and the digest. */
    snapshot: text('snapshot', { mode: 'json' }).$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: ts('next_attempt_at'),
    responseCode: integer('response_code'),
    error: text('error'),
    threadRef: text('thread_ref'),
    createdAt: createdAt(),
    sentAt: ts('sent_at'),
  },
  (t) => [
    uniqueIndex('notification_deliveries_dedupe').on(t.channelId, t.dedupeKey),
    index('notification_deliveries_pending').on(t.status, t.nextAttemptAt),
    index('notification_deliveries_incident').on(t.incidentId),
  ],
);
