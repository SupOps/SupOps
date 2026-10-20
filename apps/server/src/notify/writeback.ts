import { and, eq, gt, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { WebClient } from '@slack/web-api';
import { alertIntegrations, alerts, incidentEvents, incidents, sourceWritebacks } from '@supops/db';
import { safeGet, type HookAlert } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { recordIncidentEvent } from '../observe/incident-events.ts';
import { resolveSlackSettings } from '../slack/settings.ts';
import { unpackSecrets } from './channels.ts';

/**
 * Writing back to where alerts came from.
 *
 * In: an acknowledgement in PagerDuty or Opsgenie acknowledges the SupOps incident.
 * Out (with the source's REST credentials): acknowledging or resolving in SupOps does
 * the same there, and the diagnosis is added as a note. And, when switched on, the
 * diagnosis is posted as a reply in the Slack thread an alert arrived in.
 *
 * Each action is recorded once (source_writebacks.key), so it never repeats.
 */

type IncidentRow = typeof incidents.$inferSelect;
type IntegrationRow = typeof alertIntegrations.$inferSelect;

const VIA: Record<string, string> = { pagerduty: 'PagerDuty', opsgenie: 'Opsgenie' };

/** Someone acknowledged it at the source: so is the SupOps incident, saying where and by whom. */
export function acknowledgeFromSource(row: IntegrationRow, a: HookAlert, alertId: string | null): void {
  if (!a.acknowledged || !alertId) return;
  const incidentId = db.select({ id: alerts.incidentId }).from(alerts).where(eq(alerts.id, alertId)).get()?.id;
  if (!incidentId) return;
  const inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || inc.status !== 'open' || inc.acknowledgedAt) return;
  db.update(incidents).set({ acknowledgedAt: new Date(), acknowledgedBy: null }).where(eq(incidents.id, inc.id)).run();
  recordIncidentEvent(inc.id, 'acknowledged', null, { via: VIA[row.kind] ?? row.kind, by: a.acknowledged.by });
}

export interface WritebackCredentials {
  pagerduty?: { apiToken: string; fromEmail: string };
  opsgenie?: { apiKey: string; region: 'us' | 'eu' };
}

/** The source's own id for this alert: the PagerDuty incident id, or the Opsgenie alias. */
const externalIdOf = (kind: string, labels: Record<string, string> | null) =>
  kind === 'pagerduty' ? labels?.pagerduty_incident ?? null : kind === 'opsgenie' ? labels?.opsgenie_alias ?? null : null;

type Action = 'acknowledge' | 'resolve' | 'note';

async function callSource(row: IntegrationRow, externalId: string, action: Action, text: string): Promise<{ ok: boolean; error?: string }> {
  const secret = unpackSecrets(row.writebackEnc).apiKey;
  const cfg = (row.writebackConfig ?? {}) as Record<string, string>;
  if (!secret) return { ok: false, error: 'No writeback credentials' };
  // SUPOPS_PAGERDUTY_API_URL / SUPOPS_OPSGENIE_API_URL point these at a proxy or a test double.
  const override = row.kind === 'pagerduty' ? process.env.SUPOPS_PAGERDUTY_API_URL : process.env.SUPOPS_OPSGENIE_API_URL;
  const send = async (baseUrl: string, path: string, method: 'POST' | 'PUT', body: unknown, headers: Record<string, string>) => {
    try {
      const r = await safeGet({ baseUrl: override || baseUrl, path, method, jsonBody: body, headers, allowPrivateNetwork: !!override, timeoutMs: 15_000, maxBytes: 32_000 });
      return r.status >= 200 && r.status < 300 ? { ok: true } : { ok: false, error: `${r.status}: ${r.body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  if (row.kind === 'pagerduty') {
    const headers = { authorization: `Token token=${secret}`, from: cfg.fromEmail ?? '', accept: 'application/vnd.pagerduty+json;version=2' };
    const id = encodeURIComponent(externalId);
    if (action === 'note') return send('https://api.pagerduty.com', `/incidents/${id}/notes`, 'POST', { note: { content: text.slice(0, 25_000) } }, headers);
    return send('https://api.pagerduty.com', `/incidents/${id}`, 'PUT', { incident: { type: 'incident_reference', status: action === 'acknowledge' ? 'acknowledged' : 'resolved' } }, headers);
  }
  if (row.kind === 'opsgenie') {
    const host = cfg.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com';
    const headers = { authorization: `GenieKey ${secret}` };
    const path = `/v2/alerts/${encodeURIComponent(externalId)}/${action === 'acknowledge' ? 'acknowledge' : action === 'resolve' ? 'close' : 'notes'}?identifierType=alias`;
    return send(host, path, 'POST', { source: 'SupOps', note: text.slice(0, 25_000) }, headers);
  }
  return { ok: false, error: `${row.kind} has no writeback` };
}

/** Run an action once: record it done, or failed (tried again on later ticks, three times in all). */
async function once(incidentId: string, integrationId: string | null, action: Action | 'slack_reply', key: string, run: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const prior = db.select().from(sourceWritebacks).where(eq(sourceWritebacks.key, key)).get();
  if (prior && (prior.status === 'done' || prior.attempts >= 3)) return;
  const r = await run();
  if (prior) {
    db.update(sourceWritebacks).set({ status: r.ok ? 'done' : 'failed', error: r.error?.slice(0, 300) ?? null, attempts: prior.attempts + 1 }).where(eq(sourceWritebacks.id, prior.id)).run();
  } else {
    db.insert(sourceWritebacks).values({ incidentId, integrationId, action, key, status: r.ok ? 'done' : 'failed', error: r.error?.slice(0, 300) ?? null }).onConflictDoNothing().run();
  }
}

/** Everything due to be written back, for incidents that changed in the last two hours. */
export async function runWritebacks(now = Date.now()): Promise<void> {
  const since = new Date(now - 2 * 3_600_000);
  const incs = db.select().from(incidents).where(and(isNull(incidents.mergedInto), or(eq(incidents.status, 'open'), gt(incidents.resolvedAt, since)), gt(incidents.lastSeenAt, new Date(now - 7 * 86_400_000)))).all();
  if (!incs.length) return;
  const sources = new Map(db.select().from(alertIntegrations).where(isNotNull(alertIntegrations.writebackEnc)).all().map((s) => [s.id, s]));
  const slackOn = settingsStore.observability().slackThreadReplies;
  for (const inc of incs) {
    const members = db.select({ integrationId: alerts.integrationId, labels: alerts.labels, channelId: alerts.channelId, slackTs: alerts.slackTs }).from(alerts).where(eq(alerts.incidentId, inc.id)).all();
    if (sources.size) await writeBackToSources(inc, members, sources);
    if (slackOn) await replyInSlackThreads(inc, members);
  }
}

async function writeBackToSources(inc: IncidentRow, members: Array<{ integrationId: string | null; labels: Record<string, string> | null }>, sources: Map<string, IntegrationRow>): Promise<void> {
  const events = db.select().from(incidentEvents).where(and(eq(incidentEvents.incidentId, inc.id), inArray(incidentEvents.kind, ['acknowledged', 'resolved']))).all();
  const lastAck = events.filter((e) => e.kind === 'acknowledged').at(-1);
  for (const m of members) {
    const src = m.integrationId ? sources.get(m.integrationId) : undefined;
    const ext = src ? externalIdOf(src.kind, m.labels) : null;
    if (!src || !ext) continue;
    const base = `${inc.id}:${src.id}:${ext}`;
    // An acknowledgement made at this very source does not need sending back to it.
    if (inc.acknowledgedAt && lastAck && (lastAck.data as { via?: string } | null)?.via !== VIA[src.kind]) {
      await once(inc.id, src.id, 'acknowledge', `${base}:ack:${inc.acknowledgedAt.getTime()}`, () => callSource(src, ext, 'acknowledge', `Acknowledged in SupOps by ${lastAck.actorName ?? 'SupOps'}`));
    }
    // Resolved by a person in SupOps (not because the source resolved it).
    for (const e of events.filter((x) => x.kind === 'resolved')) {
      await once(inc.id, src.id, 'resolve', `${base}:resolve:${e.id}`, () => callSource(src, ext, 'resolve', `Resolved in SupOps by ${e.actorName ?? 'SupOps'}`));
    }
    if (inc.triageState === 'done' && inc.rootCause && inc.runId) {
      await once(inc.id, src.id, 'note', `${base}:note:${inc.runId}`, () => callSource(src, ext, 'note', `SupOps diagnosis${inc.confidence ? ` (${inc.confidence} confidence)` : ''}: ${inc.rootCause}`));
    }
  }
}

/** The diagnosis, as a reply in the Slack thread each of its alerts arrived in (at most three threads). */
async function replyInSlackThreads(inc: IncidentRow, members: Array<{ channelId: string | null; slackTs: string | null }>): Promise<void> {
  if (!(inc.triageState === 'done' && inc.rootCause && inc.runId)) return;
  const { botToken } = resolveSlackSettings();
  if (!botToken) return;
  const threads = [...new Map(members.filter((m) => m.channelId && m.slackTs).map((m) => [`${m.channelId}:${m.slackTs}`, m])).values()].slice(0, 3);
  for (const t of threads) {
    await once(inc.id, null, 'slack_reply', `${inc.id}:slack:${t.channelId}:${t.slackTs}:${inc.runId}`, async () => {
      try {
        await new WebClient(botToken, { timeout: 15_000, retryConfig: { retries: 0 } }).chat.postMessage({
          channel: t.channelId!,
          thread_ts: t.slackTs!,
          text: `SupOps diagnosis${inc.confidence ? ` (${inc.confidence} confidence)` : ''}: ${inc.rootCause!.slice(0, 2500)}`,
          unfurl_links: false,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }
}
