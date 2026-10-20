import { WebClient } from '@slack/web-api';
import nodemailer from 'nodemailer';
import { decryptSecret, encryptSecret, packEnvelope, unpackEnvelope, type notificationChannels } from '@supops/db';
import { emailMessage, opsgenieRequest, pagerdutyEvent, safeGet, signWebhook, slackMessage, teamsCard, webhookBody, type IncidentNote, type NotifyEventName } from '@supops/core';
import { resolveSlackSettings } from '../slack/settings.ts';

type ChannelRow = typeof notificationChannels.$inferSelect;

/** What each kind keeps secret. Never returned by the API; encrypted at rest. */
export interface ChannelSecrets {
  url?: string;
  secret?: string;
  password?: string;
  routingKey?: string;
  apiKey?: string;
}

export const packSecrets = (s: ChannelSecrets): string | null => (Object.values(s).some(Boolean) ? packEnvelope(encryptSecret(JSON.stringify(s))) : null);

export function unpackSecrets(enc: string | null): ChannelSecrets {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(unpackEnvelope(enc))) as ChannelSecrets;
  } catch {
    return {};
  }
}

export interface SendResult {
  ok: boolean;
  /** HTTP status, when there was one. */
  code?: number;
  error?: string;
  /** What later messages about the same incident attach to (Slack's message ts). */
  threadRef?: string;
  /** Nothing to send for this event on this kind of channel (e.g. a diagnosis to PagerDuty). */
  notApplicable?: boolean;
}

const TIMEOUT = 15_000;

/** POST JSON through the guarded client: no redirects followed, cloud metadata never reachable. */
async function postJson(url: string, body: unknown, headers: Record<string, string> = {}, allowPrivateNetwork = false): Promise<SendResult> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'The address is not a valid URL.' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: 'Only http and https addresses are allowed.' };
  try {
    const r = await safeGet({ baseUrl: u.origin, path: `${u.pathname}${u.search}`, method: 'POST', jsonBody: body, headers, allowPrivateNetwork, timeoutMs: TIMEOUT, maxBytes: 64_000 });
    if (r.status >= 200 && r.status < 300) return { ok: true, code: r.status };
    if (r.status >= 300 && r.status < 400) return { ok: false, code: r.status, error: `The address redirects (${r.status}), and redirects are not followed. Use the final address.` };
    return { ok: false, code: r.status, error: `${r.status}: ${r.body.slice(0, 300) || 'no details'}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Send one event about one incident to one channel. */
export async function sendToChannel(ch: ChannelRow, event: NotifyEventName, note: IncidentNote, opts: { deliveryId: string; threadRef?: string | null }): Promise<SendResult> {
  const cfg = ch.config as Record<string, unknown>;
  const sec = unpackSecrets(ch.secretEnc);
  switch (ch.kind) {
    case 'slack': {
      const { botToken } = resolveSlackSettings();
      if (!botToken) return { ok: false, error: 'Slack is not connected: add the bot token under Settings → Slack.' };
      const m = slackMessage(event, note);
      try {
        const r = await new WebClient(botToken, { timeout: TIMEOUT, retryConfig: { retries: 0 } }).chat.postMessage({
          channel: String(cfg.channelId),
          text: m.text,
          blocks: m.blocks as never,
          ...(opts.threadRef ? { thread_ts: opts.threadRef } : {}),
          unfurl_links: false,
        });
        return { ok: true, threadRef: opts.threadRef ?? r.ts ?? undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: /not_in_channel|channel_not_found/.test(msg) ? `${msg}: invite the SupOps bot to the channel` : msg };
      }
    }
    case 'teams':
      if (!sec.url) return { ok: false, error: 'No Teams webhook address is stored.' };
      return postJson(sec.url, teamsCard(event, note));
    case 'webhook': {
      if (!sec.url) return { ok: false, error: 'No webhook address is stored.' };
      const now = Date.now();
      const body = webhookBody(event, note, opts.deliveryId, now);
      const headers: Record<string, string> = { 'x-supops-event': event, 'x-supops-delivery': opts.deliveryId, 'x-supops-timestamp': String(now), 'user-agent': 'SupOps-Webhook/1' };
      // safeGet serialises the body with JSON.stringify, so the signature covers exactly what is sent.
      if (sec.secret) headers['x-supops-signature'] = signWebhook(sec.secret, now, JSON.stringify(body));
      return postJson(sec.url, body, headers, cfg.allowPrivateNetwork === true);
    }
    case 'pagerduty': {
      if (!sec.routingKey) return { ok: false, error: 'No PagerDuty routing key is stored.' };
      const ev = pagerdutyEvent(event, note, sec.routingKey);
      if (!ev) return { ok: true, notApplicable: true };
      const host = cfg.region === 'eu' ? 'https://events.eu.pagerduty.com' : 'https://events.pagerduty.com';
      const r = await postJson(`${host}/v2/enqueue`, ev);
      return r.ok ? { ...r, threadRef: String(ev.dedup_key) } : r;
    }
    case 'opsgenie': {
      if (!sec.apiKey) return { ok: false, error: 'No Opsgenie API key is stored.' };
      const req = opsgenieRequest(event, note);
      if (!req) return { ok: true, notApplicable: true };
      const host = cfg.region === 'eu' ? 'https://api.eu.opsgenie.com' : 'https://api.opsgenie.com';
      return postJson(`${host}${req.path}`, req.body, { authorization: `GenieKey ${sec.apiKey}` });
    }
    case 'email': {
      const to = Array.isArray(cfg.to) ? (cfg.to as string[]) : [];
      if (!to.length || !cfg.host || !cfg.from) return { ok: false, error: 'The email channel needs an SMTP server, a sender and at least one recipient.' };
      const m = emailMessage(event, note);
      try {
        const transport = nodemailer.createTransport({
          host: String(cfg.host),
          port: Number(cfg.port ?? 587),
          secure: cfg.secure === true,
          ...(cfg.user ? { auth: { user: String(cfg.user), pass: sec.password ?? '' } } : {}),
          connectionTimeout: TIMEOUT,
          greetingTimeout: TIMEOUT,
          socketTimeout: TIMEOUT,
          // The mail is built from SupOps' own text: never let it pull files or URLs in.
          disableFileAccess: true,
          disableUrlAccess: true,
        });
        await transport.sendMail({ from: String(cfg.from), to, subject: m.subject, text: m.text, html: m.html });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  }
}
