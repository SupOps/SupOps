import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { alertIntegrations } from '@supops/db';
import type { AlertSource } from '@supops/shared';
import { contentHash, parseChangePayload, parseWebhook, type GenericMapping, type IntegrationKind } from '@supops/core';
import { recordChanges } from '../changes/store.ts';
import { db } from '../context.ts';
import { ingestAlert } from './ingest.ts';
import { acknowledgeFromSource } from '../notify/writeback.ts';

type IntegrationRow = typeof alertIntegrations.$inferSelect;

/** A new token: shown once, never stored. `sup_` makes it easy to spot in a config file. */
export function newToken(): { token: string; hash: string; prefix: string } {
  const token = `sup_${randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token), prefix: token.slice(0, 10) };
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * The token a sender presented: `Authorization: Bearer <token>` (Alertmanager's
 * `authorization`, Grafana's "Authorization header"), HTTP Basic with the token as the
 * password (Alertmanager's `basic_auth`), or `X-SupOps-Token` for senders that can
 * only set a custom header. Never the URL: those end up in proxy and access logs.
 */
export function presentedToken(headers: Record<string, string | string[] | undefined>): string | null {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const auth = h('authorization') ?? '';
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  if (bearer) return bearer[1]!;
  const basic = /^Basic\s+(\S+)$/i.exec(auth);
  if (basic) {
    const decoded = Buffer.from(basic[1]!, 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i >= 0 ? decoded.slice(i + 1) : null;
  }
  return h('x-supops-token') ?? null;
}

export function tokenMatches(row: Pick<IntegrationRow, 'tokenHash' | 'previousTokenHash' | 'previousTokenUntil'>, token: string, now = Date.now()): boolean {
  const h = hashToken(token);
  if (sameHash(h, row.tokenHash)) return true;
  return !!row.previousTokenHash && !!row.previousTokenUntil && row.previousTokenUntil.getTime() > now && sameHash(h, row.previousTokenHash);
}

/** At most this many requests a minute per sender: a misconfigured loop cannot flood ingest. */
export const RATE_PER_MINUTE = 300;
const buckets = new Map<string, { windowStart: number; n: number }>();
export function overRate(id: string, now = Date.now()): boolean {
  const b = buckets.get(id);
  if (!b || now - b.windowStart >= 60_000) {
    buckets.set(id, { windowStart: now, n: 1 });
    return false;
  }
  b.n++;
  return b.n > RATE_PER_MINUTE;
}

const SOURCE: Record<Exclude<IntegrationKind, 'changes'>, AlertSource> = {
  alertmanager: 'alertmanager',
  grafana: 'grafana',
  pagerduty: 'pagerduty',
  opsgenie: 'opsgenie',
  generic: 'webhook',
};

export function recordRejection(id: string, reason: string): void {
  db.update(alertIntegrations)
    .set({ rejected: sql`${alertIntegrations.rejected} + 1`, lastError: reason.slice(0, 300), lastErrorAt: new Date() })
    .where(eq(alertIntegrations.id, id))
    .run();
}

export interface Received {
  alerts: number;
  created: number;
  resolved: number;
  repeats: number;
  /** A changes sender: how many changes were stored. */
  changes?: number;
}

/** A sender's payload, through the same ingest every other alert takes. */
export function receive(row: IntegrationRow, payload: unknown): { ok: true; result: Received } | { ok: false; error: string } {
  if (row.kind === 'changes') return receiveChanges(row, payload);
  const kind = row.kind;
  const parsed = parseWebhook(kind, payload, (row.mapping ?? {}) as GenericMapping);
  if (!parsed.ok) {
    recordRejection(row.id, parsed.error);
    return parsed;
  }
  const result: Received = { alerts: parsed.alerts.length, created: 0, resolved: 0, repeats: 0 };
  // The raw payload is kept so parsing can improve later -- but a batch of hundreds of
  // alerts is not copied onto each of them.
  const raw = parsed.alerts.length === 1 || JSON.stringify(payload).length <= 16_384 ? payload : undefined;
  for (const a of parsed.alerts) {
    const labels = a.link ? { ...a.labels, _link: a.link } : a.labels;
    const r = ingestAlert({
      projectId: row.projectId,
      source: SOURCE[kind],
      integrationId: row.id,
      fingerprint: `${row.id}:${a.fingerprint}`,
      title: a.title,
      severity: a.severity,
      summary: a.summary,
      labels,
      status: a.status,
      startsAt: a.startsAt,
      contentHash: contentHash({ ...a, labels }),
      rawPayload: raw,
      notification: true,
    });
    acknowledgeFromSource(row, a, r.alertId);
    if (r.created) result.created++;
    if (r.resolved) result.resolved++;
    if (r.repeat) result.repeats++;
  }
  db.update(alertIntegrations)
    .set({
      received: sql`${alertIntegrations.received} + 1`,
      alertsIn: sql`${alertIntegrations.alertsIn} + ${result.alerts}`,
      repeats: sql`${alertIntegrations.repeats} + ${result.repeats}`,
      lastReceivedAt: new Date(),
    })
    .where(eq(alertIntegrations.id, row.id))
    .run();
  return { ok: true, result };
}

/**
 * A CI/CD sender: the payload is one or more changes (see parseChangePayload). Changes
 * never open incidents; they are kept as suspects for when one opens.
 */
function receiveChanges(row: IntegrationRow, payload: unknown): { ok: true; result: Received } | { ok: false; error: string } {
  const parsed = parseChangePayload(payload);
  if (!parsed.ok) {
    recordRejection(row.id, parsed.error);
    return parsed;
  }
  const stored = recordChanges(row.projectId, 'api', parsed.changes, { integrationId: row.id });
  db.update(alertIntegrations)
    .set({ received: sql`${alertIntegrations.received} + 1`, alertsIn: sql`${alertIntegrations.alertsIn} + ${stored.length}`, lastReceivedAt: new Date() })
    .where(eq(alertIntegrations.id, row.id))
    .run();
  return { ok: true, result: { alerts: 0, created: 0, resolved: 0, repeats: 0, changes: stored.length } };
}
