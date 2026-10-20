import { eq } from 'drizzle-orm';
import {
  HEALTH_SETTINGS_KEY,
  LEARNING_SETTINGS_KEY,
  OBSERVABILITY_SETTINGS_KEY,
  RETENTION_SETTINGS_KEY,
  LLM_SETTINGS_KEY,
  decryptSecret,
  encryptSecret,
  packEnvelope,
  settings,
  unpackEnvelope,
} from '@supops/db';
import type { StoredHealthSettings, StoredLearningSettings, StoredLlmSettings, StoredObservabilitySettings, StoredRetentionSettings } from '@supops/db';
import type { Db } from '@supops/db';
import type { LLMConfig } from '@supops/core';
import { config } from './config.ts';

/** What the UI is allowed to see. The key itself never leaves the server. */
export interface PublicLlmSettings {
  baseUrl: string;
  model: string;
  classifierModel: string;
  fallbackModel: string;
  runConcurrency: number;
  /** Whether a usable key exists, and where it came from. */
  apiKeyConfigured: boolean;
  apiKeySource: 'database' | 'environment' | 'none';
}

export interface LlmSettingsPatch {
  baseUrl?: string;
  model?: string;
  classifierModel?: string;
  /** "" turns the fallback off. */
  fallbackModel?: string;
  runConcurrency?: number;
  /**
   * `undefined` leaves the stored key alone -- important, because the UI cannot show
   * it and must be able to save the other fields without wiping it. An empty string
   * explicitly clears it and falls back to the environment.
   */
  apiKey?: string;
}

/**
 * Resolves provider settings from the database, falling back to the environment.
 *
 * `.env` is the initial default rather than the permanent source of truth, so an
 * operator can move the platform between a hosted model and a local one without
 * editing a file or restarting the process.
 */
export class SettingsStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  private read(): StoredLlmSettings | null {
    const row = this.db.select().from(settings).where(eq(settings.key, LLM_SETTINGS_KEY)).get();
    return (row?.value as StoredLlmSettings | undefined) ?? null;
  }

  /** The full config, secrets included. Server-side only. */
  resolve(): LLMConfig {
    const stored = this.read();
    return {
      baseUrl: stored?.baseUrl || config.llm.baseUrl,
      model: stored?.model || config.llm.model,
      classifierModel: stored?.classifierModel || config.llm.classifierModel,
      // An empty stored value means "turned off", so only a missing one falls back to the environment.
      fallbackModel: (stored?.fallbackModel ?? config.llm.fallbackModel).trim(),
      apiKey: this.resolveApiKey(stored),
    };
  }

  private resolveApiKey(stored: StoredLlmSettings | null): string {
    if (stored?.apiKeyEnc) {
      try {
        return decryptSecret(unpackEnvelope(stored.apiKeyEnc));
      } catch {
        // A key encrypted under a different SUPOPS_MASTER_KEY is unrecoverable.
        // Fall back rather than failing every run with a decryption error.
        console.warn('  ! stored LLM API key could not be decrypted; falling back to the environment');
      }
    }
    return config.llm.apiKey;
  }

  concurrency(): number {
    return this.read()?.runConcurrency ?? config.runConcurrency;
  }

  /** The health scheduler's config, with defaults for a fresh install (off, 30m, quick). */
  health(): StoredHealthSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, HEALTH_SETTINGS_KEY)).get();
    const stored = (row?.value as StoredHealthSettings | undefined) ?? null;
    return {
      enabled: stored?.enabled ?? false,
      intervalMs: stored?.intervalMs ?? 30 * 60_000,
      scanType: stored?.scanType ?? 'quick',
      nextCheckAt: stored?.nextCheckAt ?? null,
      lastCheckAt: stored?.lastCheckAt ?? null,
    };
  }

  /**
   * Persist a partial health config. Changing `enabled`/`intervalMs` recomputes
   * `nextCheckAt` so the new cadence takes effect immediately; the scheduler also
   * writes `nextCheckAt`/`lastCheckAt` here after each cycle.
   */
  saveHealth(patch: Partial<StoredHealthSettings>): StoredHealthSettings {
    const cur = this.health();
    const next: StoredHealthSettings = { ...cur, ...patch };

    // A cadence or enablement change with no explicit nextCheckAt reschedules from now.
    const cadenceChanged =
      (patch.enabled !== undefined && patch.enabled !== cur.enabled) ||
      (patch.intervalMs !== undefined && patch.intervalMs !== cur.intervalMs);
    if (patch.nextCheckAt === undefined && cadenceChanged) {
      next.nextCheckAt = next.enabled ? Date.now() + next.intervalMs : null;
    }

    this.db
      .insert(settings)
      .values({ key: HEALTH_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
      .run();
    return next;
  }

  /** History retention, off by default: nothing is ever deleted unless an admin opts in. */
  retention(): StoredRetentionSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, RETENTION_SETTINGS_KEY)).get();
    const stored = (row?.value as StoredRetentionSettings | undefined) ?? null;
    return {
      days: stored?.days ?? null,
      dropImagesAfterDays: stored?.dropImagesAfterDays ?? null,
      lastRunAt: stored?.lastRunAt ?? null,
      nextRunAt: stored?.nextRunAt ?? null,
      lastResult: stored?.lastResult ?? null,
      observabilityDays: stored?.observabilityDays ?? 15,
    };
  }

  /** Observability defaults: alerts read every minute, metrics every 5, every alert diagnosed (read-only). */
  observability(): StoredObservabilitySettings {
    const row = this.db.select().from(settings).where(eq(settings.key, OBSERVABILITY_SETTINGS_KEY)).get();
    const stored = (row?.value as Partial<StoredObservabilitySettings> | undefined) ?? {};
    return {
      alertPollMs: stored.alertPollMs ?? 60_000,
      watchIntervalMs: stored.watchIntervalMs ?? 5 * 60_000,
      autoTriage: stored.autoTriage ?? true,
      triageMinSeverity: stored.triageMinSeverity ?? 'info',
      triageGatherSeconds: stored.triageGatherSeconds ?? 180,
      triageMaxPerHour: stored.triageMaxPerHour ?? 20,
      predictWarningHours: stored.predictWarningHours ?? 24,
      predictCriticalHours: stored.predictCriticalHours ?? 4,
      flapChanges: stored.flapChanges ?? 4,
      flapWindowMin: stored.flapWindowMin ?? 30,
      slackThreadReplies: stored.slackThreadReplies ?? false,
    };
  }

  saveObservability(patch: Partial<StoredObservabilitySettings>): StoredObservabilitySettings {
    const next: StoredObservabilitySettings = { ...this.observability(), ...patch };
    this.db
      .insert(settings)
      .values({ key: OBSERVABILITY_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
      .run();
    return next;
  }

  learning(): StoredLearningSettings {
    const row = this.db.select().from(settings).where(eq(settings.key, LEARNING_SETTINGS_KEY)).get();
    const stored = (row?.value as Partial<StoredLearningSettings> | undefined) ?? {};
    return { reflect: stored.reflect ?? 'drafts', reflectMinActions: stored.reflectMinActions ?? 3 };
  }

  saveLearning(patch: Partial<StoredLearningSettings>): StoredLearningSettings {
    const next: StoredLearningSettings = { ...this.learning(), ...patch };
    this.db
      .insert(settings)
      .values({ key: LEARNING_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
      .run();
    return next;
  }

  saveRetention(patch: Partial<StoredRetentionSettings>): StoredRetentionSettings {
    const next: StoredRetentionSettings = { ...this.retention(), ...patch };
    this.db
      .insert(settings)
      .values({ key: RETENTION_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
      .run();
    return next;
  }

  public(): PublicLlmSettings {
    const stored = this.read();
    const resolved = this.resolve();
    const source: PublicLlmSettings['apiKeySource'] = stored?.apiKeyEnc
      ? 'database'
      : config.llm.apiKey
        ? 'environment'
        : 'none';

    return {
      baseUrl: resolved.baseUrl,
      model: resolved.model,
      classifierModel: resolved.classifierModel ?? '',
      fallbackModel: resolved.fallbackModel ?? '',
      runConcurrency: this.concurrency(),
      apiKeyConfigured: !!resolved.apiKey,
      apiKeySource: source,
    };
  }

  save(patch: LlmSettingsPatch): PublicLlmSettings {
    const stored = this.read();
    const next: StoredLlmSettings = {
      baseUrl: patch.baseUrl ?? stored?.baseUrl ?? config.llm.baseUrl,
      model: patch.model ?? stored?.model ?? config.llm.model,
      classifierModel: patch.classifierModel ?? stored?.classifierModel ?? config.llm.classifierModel,
      fallbackModel: (patch.fallbackModel ?? stored?.fallbackModel ?? config.llm.fallbackModel).trim(),
      runConcurrency: patch.runConcurrency ?? stored?.runConcurrency ?? config.runConcurrency,
      apiKeyEnc:
        patch.apiKey === undefined
          ? (stored?.apiKeyEnc ?? null)
          : patch.apiKey === ''
            ? null
            : packEnvelope(encryptSecret(patch.apiKey)),
    };

    this.db
      .insert(settings)
      .values({ key: LLM_SETTINGS_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      })
      .run();

    return this.public();
  }
}
