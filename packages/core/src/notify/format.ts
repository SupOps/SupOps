import { createHmac } from 'node:crypto';

/**
 * What a notification says, one shape for every channel, and how each channel wants
 * it: Slack blocks, a Teams Adaptive Card, an email, a signed webhook, a PagerDuty
 * Events v2 event, an Opsgenie request. Pure: no network, no database.
 */
export type NotifyEventName = 'opened' | 'escalated' | 'acknowledged' | 'resolved' | 'reopened' | 'diagnosed' | 'digest' | 'workflow' | 'test';

export interface IncidentNote {
  id: string;
  title: string;
  severity: string;
  status: string;
  targets: string[];
  alertCount: number;
  rootCause: string | null;
  confidence: string | null;
  owner: string | null;
  acknowledgedBy: string | null;
  /** Link to the incident in SupOps, when SupOps' address is known. */
  url: string | null;
  openedAt: number;
  /** For a digest: its lines, in place of one incident's facts. */
  lines?: string[];
}

const HEADLINE: Record<NotifyEventName, string> = {
  opened: 'New incident',
  escalated: 'Incident got worse',
  acknowledged: 'Acknowledged',
  resolved: 'Resolved',
  reopened: 'Incident is back',
  diagnosed: 'Diagnosis ready',
  digest: 'SupOps daily digest',
  workflow: '',
  test: 'Test notification from SupOps',
};

const SEV = (s: string) => (s === 'critical' ? 'Critical' : s === 'warning' ? 'Warning' : s === 'info' ? 'Info' : 'Unknown severity');

/** The short line every channel starts with. */
export function headline(event: NotifyEventName, n: IncidentNote): string {
  if (event === 'test') return HEADLINE.test;
  if (event === 'digest') return `${HEADLINE.digest}: ${n.title}`;
  // A workflow's own message: its first line leads.
  if (event === 'workflow') return n.title;
  return `${HEADLINE[event]}: ${n.title}${event === 'resolved' ? '' : ` (${SEV(n.severity).toLowerCase()})`}`;
}

/** The facts under it, as plain lines. */
export function details(event: NotifyEventName, n: IncidentNote): string[] {
  if (event === 'test') return ['If you can read this, SupOps can reach this channel. Nothing is wrong.'];
  if (event === 'digest' || event === 'workflow') return n.lines ?? [];
  const lines: string[] = [];
  if (n.targets.length) lines.push(`On ${n.targets.slice(0, 5).join(', ')}${n.targets.length > 5 ? ` and ${n.targets.length - 5} more` : ''}`);
  lines.push(`${n.alertCount} alert${n.alertCount === 1 ? '' : 's'} · ${SEV(n.severity)}`);
  if (event === 'acknowledged' && n.acknowledgedBy) lines.push(`${n.acknowledgedBy} is on it`);
  else if (n.owner) lines.push(`Owner: ${n.owner}`);
  if (n.rootCause && (event === 'diagnosed' || event === 'resolved' || event === 'escalated')) {
    lines.push(`Diagnosis${n.confidence ? ` (${n.confidence} confidence)` : ''}: ${n.rootCause.slice(0, 700)}`);
  }
  return lines;
}

export interface SlackMessage {
  text: string;
  blocks: unknown[];
}

const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(event: NotifyEventName, n: IncidentNote): SlackMessage {
  const head = headline(event, n);
  return {
    text: head,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${slackEscape(head)}*\n${details(event, n).map(slackEscape).join('\n')}` } },
      ...(n.url ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in SupOps' }, url: n.url }] }] : []),
    ],
  };
}

/** A Teams message for a Workflows ("Post to a channel when a webhook request is received") webhook. */
export function teamsCard(event: NotifyEventName, n: IncidentNote): unknown {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            { type: 'TextBlock', text: headline(event, n), weight: 'Bolder', size: 'Medium', wrap: true, ...(n.severity === 'critical' && event !== 'resolved' ? { color: 'Attention' } : {}) },
            ...details(event, n).map((t) => ({ type: 'TextBlock', text: t, wrap: true, spacing: 'Small' })),
          ],
          ...(n.url ? { actions: [{ type: 'Action.OpenUrl', title: 'Open in SupOps', url: n.url }] } : {}),
        },
      },
    ],
  };
}

const htmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function emailMessage(event: NotifyEventName, n: IncidentNote): { subject: string; text: string; html: string } {
  const head = headline(event, n);
  const lines = details(event, n);
  const link = n.url ? `\n\nOpen in SupOps: ${n.url}` : '';
  return {
    subject: `[SupOps] ${head}`.slice(0, 200),
    text: `${head}\n\n${lines.join('\n')}${link}\n`,
    html:
      `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#111">` +
      `<p style="font-size:16px;font-weight:600;margin:0 0 8px">${htmlEscape(head)}</p>` +
      lines.map((l) => `<p style="margin:0 0 4px">${htmlEscape(l)}</p>`).join('') +
      (n.url ? `<p style="margin:16px 0 0"><a href="${htmlEscape(n.url)}">Open in SupOps</a></p>` : '') +
      `</div>`,
  };
}

/** The webhook body: stable, versioned JSON a receiver can rely on. */
export function webhookBody(event: NotifyEventName, n: IncidentNote, deliveryId: string, sentAt: number): Record<string, unknown> {
  return {
    version: 1,
    event,
    deliveryId,
    sentAt: new Date(sentAt).toISOString(),
    headline: headline(event, n),
    incident: {
      id: n.id,
      title: n.title,
      severity: n.severity,
      status: n.status,
      targets: n.targets,
      alertCount: n.alertCount,
      rootCause: n.rootCause,
      confidence: n.confidence,
      owner: n.owner,
      openedAt: new Date(n.openedAt).toISOString(),
      url: n.url,
    },
  };
}

/**
 * `X-SupOps-Signature: sha256=<hex>` over `<timestamp>.<body>`, the way Stripe and
 * GitHub sign theirs: the receiver recomputes it with the shared secret, and the
 * timestamp (also sent as X-SupOps-Timestamp) lets it refuse replays.
 */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

/** PagerDuty Events v2. One alert per incident (dedup_key), triggered, acknowledged and resolved with it. */
export function pagerdutyEvent(event: NotifyEventName, n: IncidentNote, routingKey: string): Record<string, unknown> | null {
  if (event === 'digest') return null;
  const action = event === 'opened' || event === 'reopened' || event === 'escalated' || event === 'workflow' || event === 'test' ? 'trigger' : event === 'acknowledged' ? 'acknowledge' : event === 'resolved' ? 'resolve' : null;
  if (!action) return null;
  const dedup = event === 'test' ? `supops-test-${Date.now()}` : event === 'workflow' ? `supops-wf-${n.id}` : `supops-${n.id}`;
  if (action !== 'trigger') return { routing_key: routingKey, event_action: action, dedup_key: dedup };
  return {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: dedup,
    payload: {
      summary: headline(event, n).slice(0, 1024),
      source: n.targets[0] ?? 'SupOps',
      severity: n.severity === 'critical' ? 'critical' : n.severity === 'info' ? 'info' : 'warning',
      component: n.targets.slice(0, 3).join(', ') || undefined,
      custom_details: { details: details(event, n), alerts: n.alertCount, ...(n.rootCause ? { diagnosis: n.rootCause } : {}) },
    },
    ...(n.url ? { links: [{ href: n.url, text: 'Open in SupOps' }] } : {}),
  };
}

/** Opsgenie Alert API calls. One alert per incident, by alias. */
export function opsgenieRequest(event: NotifyEventName, n: IncidentNote): { method: 'POST'; path: string; body: Record<string, unknown> } | null {
  if (event === 'digest') return null;
  const alias = event === 'test' ? `supops-test-${Date.now()}` : event === 'workflow' ? `supops-wf-${n.id}` : `supops-${n.id}`;
  const by = { identifierType: 'alias' };
  const q = `?identifierType=${by.identifierType}`;
  if (event === 'opened' || event === 'reopened' || event === 'workflow' || event === 'test') {
    return {
      method: 'POST',
      path: '/v2/alerts',
      body: {
        message: headline(event, n).slice(0, 130),
        alias,
        description: [...details(event, n), ...(n.url ? [`Open in SupOps: ${n.url}`] : [])].join('\n').slice(0, 15000),
        priority: n.severity === 'critical' ? 'P1' : n.severity === 'warning' ? 'P3' : 'P5',
        source: 'SupOps',
        tags: ['supops', n.severity],
        entity: n.targets[0],
      },
    };
  }
  if (event === 'acknowledged') return { method: 'POST', path: `/v2/alerts/${encodeURIComponent(alias)}/acknowledge${q}`, body: { source: 'SupOps', note: n.acknowledgedBy ? `${n.acknowledgedBy} acknowledged it in SupOps` : 'Acknowledged in SupOps' } };
  if (event === 'resolved') return { method: 'POST', path: `/v2/alerts/${encodeURIComponent(alias)}/close${q}`, body: { source: 'SupOps', note: 'Resolved in SupOps' } };
  if (event === 'escalated' || event === 'diagnosed') return { method: 'POST', path: `/v2/alerts/${encodeURIComponent(alias)}/notes${q}`, body: { source: 'SupOps', note: [headline(event, n), ...details(event, n)].join('\n').slice(0, 25000) } };
  return null;
}
