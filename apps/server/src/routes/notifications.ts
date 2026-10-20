import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { incidents, notificationChannels, notificationDeliveries, notificationRoutes, settings } from '@supops/db';
import { formatMatchers, parseMatchers } from '@supops/shared';
import { validSlot, type IncidentNote } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { packSecrets, sendToChannel, unpackSecrets, type ChannelSecrets } from '../notify/channels.ts';
import { NOTIFICATIONS_SETTINGS_KEY, publicUrl } from '../notify/notifier.ts';

/**
 * Notifications: channels (where), routes (which incidents, which events), the history
 * of what was sent, and SupOps' own address for links. Admins change them; everyone
 * can see them, never their secrets.
 */
export const notificationRoutesApi = Router();

type ChannelRow = typeof notificationChannels.$inferSelect;
const channelView = ({ secretEnc, ...c }: ChannelRow) => {
  const s = unpackSecrets(secretEnc);
  // Which secrets are set, never what they are.
  return { ...c, has: { url: !!s.url, secret: !!s.secret, password: !!s.password, routingKey: !!s.routingKey, apiKey: !!s.apiKey } };
};

function adminOnly(req: { user?: Parameters<typeof isAdmin>[0] }, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change notifications.' });
  return false;
}

const url = z.string().trim().url().max(2000);
const channelBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('slack'), channelId: z.string().min(1).max(40), channelName: z.string().max(120).optional() }),
  z.object({ kind: z.literal('teams'), url: url.optional() }),
  z.object({ kind: z.literal('webhook'), url: url.optional(), secret: z.string().max(200).optional(), allowPrivateNetwork: z.boolean().optional() }),
  z.object({ kind: z.literal('pagerduty'), routingKey: z.string().trim().max(64).optional(), region: z.enum(['us', 'eu']).optional() }),
  z.object({ kind: z.literal('opsgenie'), apiKey: z.string().trim().max(100).optional(), region: z.enum(['us', 'eu']).optional() }),
  z.object({
    kind: z.literal('email'),
    host: z.string().trim().min(1).max(200),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().max(200).optional(),
    password: z.string().max(500).optional(),
    from: z.string().trim().email().max(200),
    to: z.array(z.string().trim().email()).min(1).max(20),
  }),
]);

/** Split a channel's settings into what may be shown and what must stay secret (merged over what is stored). */
function split(b: z.infer<typeof channelBody>, before?: ChannelSecrets): { config: Record<string, unknown>; secrets: ChannelSecrets } {
  const keep = (v: string | undefined, old: string | undefined) => (v === undefined ? old : v.trim() || undefined);
  switch (b.kind) {
    case 'slack':
      return { config: { channelId: b.channelId, channelName: b.channelName ?? b.channelId }, secrets: {} };
    case 'teams': {
      const u = keep(b.url, before?.url);
      return { config: { target: u ? new URL(u).host : null }, secrets: { url: u } };
    }
    case 'webhook': {
      const u = keep(b.url, before?.url);
      return { config: { target: u ? new URL(u).host : null, allowPrivateNetwork: b.allowPrivateNetwork === true }, secrets: { url: u, secret: keep(b.secret, before?.secret) } };
    }
    case 'pagerduty':
      return { config: { region: b.region ?? 'us' }, secrets: { routingKey: keep(b.routingKey, before?.routingKey) } };
    case 'opsgenie':
      return { config: { region: b.region ?? 'us' }, secrets: { apiKey: keep(b.apiKey, before?.apiKey) } };
    case 'email':
      return { config: { host: b.host, port: b.port, secure: b.secure, user: b.user || null, from: b.from, to: b.to }, secrets: { password: keep(b.password, before?.password) } };
  }
}

const REQUIRED: Record<string, keyof ChannelSecrets | null> = { slack: null, email: null, teams: 'url', webhook: 'url', pagerduty: 'routingKey', opsgenie: 'apiKey' };

notificationRoutesApi.get('/channels', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) return void res.status(400).json({ error: 'projectId is required' });
  res.json(db.select().from(notificationChannels).where(eq(notificationChannels.projectId, projectId)).orderBy(desc(notificationChannels.createdAt)).all().map(channelView));
});

notificationRoutesApi.post('/channels', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = z.object({ projectId: z.string().min(1), name: z.string().trim().min(1).max(80), settings: channelBody }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid channel' });
  const { config, secrets } = split(b.data.settings);
  const need = REQUIRED[b.data.settings.kind];
  if (need && !secrets[need]) return void res.status(400).json({ error: `This channel needs its ${need === 'url' ? 'webhook address' : need === 'routingKey' ? 'routing key' : 'API key'}.` });
  const row = db
    .insert(notificationChannels)
    .values({ projectId: b.data.projectId, kind: b.data.settings.kind, name: b.data.name, config, secretEnc: packSecrets(secrets), createdBy: req.user?.id ?? null })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'notification_channel', entityId: row.id, action: 'create', after: { kind: row.kind, name: row.name, config } });
  res.status(201).json(channelView(row));
});

notificationRoutesApi.patch('/channels/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const before = db.select().from(notificationChannels).where(eq(notificationChannels.id, req.params.id)).get();
  if (!before) return void res.status(404).json({ error: 'Channel not found' });
  const b = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), settings: channelBody.optional() }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid change' });
  if (b.data.settings && b.data.settings.kind !== before.kind) return void res.status(400).json({ error: 'A channel cannot change its kind. Add a new one instead.' });
  const parts = b.data.settings ? split(b.data.settings, unpackSecrets(before.secretEnc)) : null;
  const row = db
    .update(notificationChannels)
    .set({ ...(b.data.name ? { name: b.data.name } : {}), ...(b.data.enabled !== undefined ? { enabled: b.data.enabled } : {}), ...(parts ? { config: parts.config, secretEnc: packSecrets(parts.secrets) } : {}) })
    .where(eq(notificationChannels.id, before.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'notification_channel', entityId: row.id, action: 'update', before: { name: before.name, enabled: before.enabled, config: before.config }, after: { name: row.name, enabled: row.enabled, config: row.config } });
  res.json(channelView(row));
});

notificationRoutesApi.delete('/channels/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(notificationChannels).where(eq(notificationChannels.id, req.params.id)).returning().get();
  if (!row) return void res.status(404).json({ error: 'Channel not found' });
  // Routes keep working for their other channels.
  for (const r of db.select().from(notificationRoutes).where(eq(notificationRoutes.projectId, row.projectId)).all()) {
    if (r.channelIds.includes(row.id)) db.update(notificationRoutes).set({ channelIds: r.channelIds.filter((c) => c !== row.id) }).where(eq(notificationRoutes.id, r.id)).run();
  }
  audit(req.user, { projectId: row.projectId, entity: 'notification_channel', entityId: row.id, action: 'delete', before: { kind: row.kind, name: row.name } });
  res.json({ ok: true });
});

/** Send a test message now, and say exactly what came back. */
notificationRoutesApi.post('/channels/:id/test', async (req, res) => {
  if (!adminOnly(req, res)) return;
  const ch = db.select().from(notificationChannels).where(eq(notificationChannels.id, req.params.id)).get();
  if (!ch) return void res.status(404).json({ error: 'Channel not found' });
  const note: IncidentNote = { id: 'test', title: 'Test', severity: 'info', status: 'open', targets: [], alertCount: 0, rootCause: null, confidence: null, owner: null, acknowledgedBy: null, url: publicUrl(), openedAt: Date.now() };
  const r = await sendToChannel(ch, 'test', note, { deliveryId: `test-${Date.now()}` });
  db.update(notificationChannels)
    .set(r.ok ? { lastSentAt: new Date(), lastError: null } : { lastError: (r.error ?? 'failed').slice(0, 300), lastErrorAt: new Date() })
    .where(eq(notificationChannels.id, ch.id))
    .run();
  res.json(r);
});

// ---- routes ------------------------------------------------------------------------

const EVENTS = ['opened', 'escalated', 'acknowledged', 'resolved', 'reopened', 'diagnosed'] as const;
const routeBody = z.object({
  name: z.string().trim().min(1).max(120),
  matchers: z.string().max(4000),
  minSeverity: z.enum(['info', 'warning', 'critical']),
  events: z.array(z.enum(EVENTS)).min(1),
  channelIds: z.array(z.string()).min(1, 'Pick at least one channel').max(20),
  quietHours: z.object({ days: z.array(z.number().int().min(0).max(6)).min(1), start: z.string(), end: z.string(), timezone: z.string() }).nullish(),
  digestHour: z.number().int().min(0).max(23).nullish(),
});

const routeView = (r: typeof notificationRoutes.$inferSelect) => ({ ...r, matcherText: formatMatchers(r.matchers) });

function parseRoute(projectId: string, b: z.infer<typeof routeBody>) {
  const m = parseMatchers(b.matchers);
  if (!m.ok) return { error: `Matchers: ${m.error}` };
  if (b.quietHours) {
    const why = validSlot(b.quietHours);
    if (why) return { error: `Quiet hours: ${why}` };
  }
  const known = new Set(db.select({ id: notificationChannels.id }).from(notificationChannels).where(eq(notificationChannels.projectId, projectId)).all().map((c) => c.id));
  if (b.channelIds.some((c) => !known.has(c))) return { error: 'A chosen channel does not exist in this project.' };
  return { route: { ...b, matchers: m.matchers, quietHours: b.quietHours ?? null, digestHour: b.digestHour ?? null } };
}

notificationRoutesApi.get('/routes', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) return void res.status(400).json({ error: 'projectId is required' });
  res.json(db.select().from(notificationRoutes).where(eq(notificationRoutes.projectId, projectId)).orderBy(desc(notificationRoutes.createdAt)).all().map(routeView));
});

notificationRoutesApi.post('/routes', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = routeBody.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid route' });
  const p = parseRoute(b.data.projectId, b.data);
  if ('error' in p) return void res.status(400).json({ error: p.error });
  const row = db.insert(notificationRoutes).values({ ...p.route, projectId: b.data.projectId, createdBy: req.user?.id ?? null }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'notification_route', entityId: row.id, action: 'create', after: routeView(row) });
  res.status(201).json(routeView(row));
});

notificationRoutesApi.patch('/routes/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const before = db.select().from(notificationRoutes).where(eq(notificationRoutes.id, req.params.id)).get();
  if (!before) return void res.status(404).json({ error: 'Route not found' });
  if (Object.keys(req.body ?? {}).length === 1 && typeof req.body?.enabled === 'boolean') {
    const row = db.update(notificationRoutes).set({ enabled: req.body.enabled }).where(eq(notificationRoutes.id, before.id)).returning().get();
    audit(req.user, { projectId: row.projectId, entity: 'notification_route', entityId: row.id, action: row.enabled ? 'enable' : 'disable' });
    return void res.json(routeView(row));
  }
  const b = routeBody.safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid route' });
  const p = parseRoute(before.projectId, b.data);
  if ('error' in p) return void res.status(400).json({ error: p.error });
  const row = db.update(notificationRoutes).set(p.route).where(eq(notificationRoutes.id, before.id)).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'notification_route', entityId: row.id, action: 'update', before: routeView(before), after: routeView(row) });
  res.json(routeView(row));
});

notificationRoutesApi.delete('/routes/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.delete(notificationRoutes).where(eq(notificationRoutes.id, req.params.id)).returning().get();
  if (!row) return void res.status(404).json({ error: 'Route not found' });
  audit(req.user, { projectId: row.projectId, entity: 'notification_route', entityId: row.id, action: 'delete', before: routeView(row) });
  res.json({ ok: true });
});

/** What was sent, skipped or failed lately, newest first. */
notificationRoutesApi.get('/deliveries', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) return void res.status(400).json({ error: 'projectId is required' });
  const rows = db.select().from(notificationDeliveries).where(eq(notificationDeliveries.projectId, projectId)).orderBy(desc(notificationDeliveries.createdAt)).limit(100).all();
  const incIds = [...new Set(rows.map((r) => r.incidentId).filter((x): x is string => !!x))];
  const titles = new Map(incIds.length ? db.select({ id: incidents.id, title: incidents.title }).from(incidents).where(inArray(incidents.id, incIds)).all().map((i) => [i.id, i.title]) : []);
  res.json(rows.map(({ threadRef: _t, snapshot, ...r }) => ({ ...r, incidentTitle: r.incidentId ? titles.get(r.incidentId) ?? String(snapshot?.title ?? '') : null })));
});

/** Send a failed delivery again now. */
notificationRoutesApi.post('/deliveries/:id/retry', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db
    .update(notificationDeliveries)
    .set({ status: 'pending', nextAttemptAt: new Date(), attempts: 0 })
    .where(and(eq(notificationDeliveries.id, req.params.id), eq(notificationDeliveries.status, 'failed')))
    .returning()
    .get();
  if (!row) return void res.status(404).json({ error: 'No failed delivery with that id.' });
  res.json({ ok: true });
});

// ---- settings ------------------------------------------------------------------------

notificationRoutesApi.get('/settings', (_req, res) => {
  res.json({ publicUrl: publicUrl(), fromEnvironment: !!process.env.SUPOPS_PUBLIC_URL?.trim() });
});

notificationRoutesApi.put('/settings', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = z.object({ publicUrl: z.string().trim().max(500) }).safeParse(req.body);
  if (!b.success) return void res.status(400).json({ error: 'publicUrl is required' });
  const v = b.data.publicUrl.replace(/\/+$/, '');
  if (v && !/^https?:\/\/[^/\s]+/.test(v)) return void res.status(400).json({ error: "Give SupOps' address as it is opened in a browser, e.g. https://supops.example.com" });
  db.insert(settings).values({ key: NOTIFICATIONS_SETTINGS_KEY, value: { publicUrl: v }, updatedAt: new Date() }).onConflictDoUpdate({ target: settings.key, set: { value: { publicUrl: v }, updatedAt: new Date() } }).run();
  audit(req.user, { entity: 'settings.notifications', action: 'update', after: { publicUrl: v } });
  res.json({ publicUrl: publicUrl(), fromEnvironment: !!process.env.SUPOPS_PUBLIC_URL?.trim() });
});
