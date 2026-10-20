import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ts } from './_common.ts';

/**
 * Global key/value configuration that operators can change at runtime.
 *
 * Anything here overrides the matching environment variable, so `.env` becomes the
 * initial default rather than the permanent source of truth -- which is what lets
 * someone switch the platform from a hosted model to a local one from the UI
 * instead of editing a file and restarting the process.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
});

/** Stored under `settings.key = 'llm'`. The API key is an encrypted envelope. */
export interface StoredLlmSettings {
  baseUrl: string;
  model: string;
  classifierModel: string;
  /** Tried when the main model fails (same provider). Absent or empty: no fallback. */
  fallbackModel?: string;
  /** AES-256-GCM envelope, or null when the key should fall back to the environment. */
  apiKeyEnc: string | null;
  runConcurrency: number;
}

export const LLM_SETTINGS_KEY = 'llm';

/**
 * Stored under `settings.key = 'slack'`. Workspace-level: one Slack app serves the
 * whole install, and per-project routing lives in `alert_subscriptions`. Both tokens
 * are encrypted envelopes. `appToken` (xapp-) drives the outbound Socket Mode
 * connection; `botToken` (xoxb-) reads channel/message metadata via the Web API.
 */
export interface StoredSlackSettings {
  appTokenEnc: string | null;
  botTokenEnc: string | null;
  enabled: boolean;
}

export const SLACK_SETTINGS_KEY = 'slack';

/**
 * Stored under `settings.key = 'health'`. Drives the recurring health scheduler.
 * `nextCheckAt`/`lastCheckAt` are epoch-ms and persisted so the schedule survives a
 * restart (the in-memory timer only decides when to *look*, not when a scan is due).
 */
export interface StoredHealthSettings {
  enabled: boolean;
  intervalMs: number;
  scanType: 'quick' | 'deep';
  nextCheckAt: number | null;
  lastCheckAt: number | null;
}

export const HEALTH_SETTINGS_KEY = 'health';

/**
 * Run-history retention. Runs carry transcripts, command output and pasted images,
 * so history grows without bound; this removes finished runs past an age, and can
 * drop just the images sooner. Pinned runs and runs still tied to an open health
 * issue are always kept.
 */
export interface StoredRetentionSettings {
  /** Delete finished runs older than this many days; null = keep forever. */
  days: number | null;
  /** Drop pasted images older than this many days (the run itself stays); null = never. */
  dropImagesAfterDays: number | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  lastResult: { at: number; runs: number; images: number; freedBytes: number; observability?: number; error?: string } | null;
  /**
   * Keep alerts, incidents, evidence, metric rollups and observations this many days
   * after they resolve. Always on (default 15): they are rebuilt from the backends,
   * and rollups would otherwise grow every few minutes forever.
   */
  observabilityDays?: number;
}

export const RETENTION_SETTINGS_KEY = 'retention';

/**
 * Stored under `settings.key = 'observability'`: how SupOps reads alerts from its
 * connections, watches metrics, and triages incidents on its own.
 */
export interface StoredObservabilitySettings {
  /** How often alerts are read from connections that import them. */
  alertPollMs: number;
  /** How often watched metrics are sampled. */
  watchIntervalMs: number;
  /** Diagnose new incidents automatically, read-only (like a health scan); fixes need a person. */
  autoTriage: boolean;
  /** Lowest severity that is triaged automatically. */
  triageMinSeverity: 'critical' | 'warning' | 'info';
  /** Wait this long after an incident opens before diagnosing it, so related alerts can join (0: straight away). */
  triageGatherSeconds: number;
  /** At most this many automatic investigations start per hour, across all projects. */
  triageMaxPerHour: number;
  /** Open an incident when a resource is predicted to run out within this many hours. */
  predictWarningHours: number;
  /** ...and mark it critical within this many. */
  predictCriticalHours: number;
  /** An alert is flapping after this many fire/resolve changes within `flapWindowMin`. */
  flapChanges: number;
  /** The window for flapping, and how long a flapping alert must stay quiet to settle. */
  flapWindowMin: number;
  /** Reply with the diagnosis in the Slack thread an alert arrived in. Off unless switched on. */
  slackThreadReplies: boolean;
}

export const OBSERVABILITY_SETTINGS_KEY = 'observability';

/**
 * Learning after a run. `reflect`: off; drafts (every lesson waits for an admin, the
 * default); or auto (an observed fact with evidence and no commands is approved at
 * once, scoped to its machines and never pinned; everything else is still a draft).
 */
export interface StoredLearningSettings {
  reflect: 'off' | 'drafts' | 'auto';
  /** Only runs with at least this many actions are reflected on. */
  reflectMinActions: number;
}
export const LEARNING_SETTINGS_KEY = 'learning';
