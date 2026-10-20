import { Router } from 'express';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { alertIntegrations, alerts, changes } from '@supops/db';
import { INTEGRATION_KINDS, parseWebhook, sampleWebhook, type IntegrationKind } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { newToken, receive } from '../observe/hooks.ts';
import { packSecrets } from '../notify/channels.ts';

/**
 * Alert sources that push to SupOps by webhook. Admins add, rotate and remove them;
 * everyone can see them. A token is returned once, in the response that creates or
 * rotates it, and never again.
 */
export const alertSourceRoutes = Router();

type Row = typeof alertIntegrations.$inferSelect;
/** Everything but the hashes and the writeback credentials (only whether they are set). */
const view = ({ tokenHash: _t, previousTokenHash: _p, writebackEnc, ...rest }: Row) => ({
  ...rest,
  rotating: !!rest.previousTokenUntil && rest.previousTokenUntil.getTime() > Date.now(),
  writeback: !!writebackEnc,
});

const mapping = z
  .object({
    alertsPath: z.string().max(200),
    titlePath: z.string().max(200),
    severityPath: z.string().max(200),
    statusPath: z.string().max(200),
    resolvedValues: z.array(z.string().max(50)).max(20),
    fingerprintPath: z.string().max(200),
    summaryPath: z.string().max(200),
    labelsPath: z.string().max(200),
    hostPath: z.string().max(200),
    servicePath: z.string().max(200),
    linkPath: z.string().max(200),
  })
  .partial();

/** Empty strings in the form mean "not set". */
const cleanMapping = (m: z.infer<typeof mapping> | undefined) =>
  m ? Object.fromEntries(Object.entries(m).filter(([, v]) => (Array.isArray(v) ? v.length : !!v?.trim()))) : null;

function requireAdmin(req: Parameters<Parameters<typeof alertSourceRoutes.post>[1]>[0], res: Parameters<Parameters<typeof alertSourceRoutes.post>[1]>[1]): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change alert sources.' });
  return false;
}

alertSourceRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json(db.select().from(alertIntegrations).where(eq(alertIntegrations.projectId, projectId)).orderBy(desc(alertIntegrations.createdAt)).all().map(view));
});

const createBody = z.object({
  projectId: z.string().min(1),
  kind: z.enum(INTEGRATION_KINDS),
  name: z.string().trim().min(1).max(80),
  mapping: mapping.optional(),
});

alertSourceRoutes.post('/', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = createBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid alert source' });
    return;
  }
  const t = newToken();
  const row = db
    .insert(alertIntegrations)
    .values({
      projectId: body.data.projectId,
      kind: body.data.kind,
      name: body.data.name,
      tokenHash: t.hash,
      tokenPrefix: t.prefix,
      mapping: body.data.kind === 'generic' ? cleanMapping(body.data.mapping) : null,
      createdBy: req.user?.id ?? null,
    })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'alert_source', entityId: row.id, action: 'create', after: { kind: row.kind, name: row.name } });
  res.status(201).json({ source: view(row), token: t.token });
});

const patchBody = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), mapping: mapping.optional() });

alertSourceRoutes.patch('/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const body = patchBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid change' });
    return;
  }
  const before = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).get();
  if (!before) {
    res.status(404).json({ error: 'Alert source not found' });
    return;
  }
  const row = db
    .update(alertIntegrations)
    .set({
      ...(body.data.name ? { name: body.data.name } : {}),
      ...(body.data.enabled !== undefined ? { enabled: body.data.enabled } : {}),
      ...(body.data.mapping && before.kind === 'generic' ? { mapping: cleanMapping(body.data.mapping) } : {}),
    })
    .where(eq(alertIntegrations.id, before.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'alert_source', entityId: row.id, action: 'update', before: { name: before.name, enabled: before.enabled }, after: { name: row.name, enabled: row.enabled } });
  res.json(view(row));
});

/**
 * Credentials to write back to the source (PagerDuty: a REST API token and the email it
 * acts as; Opsgenie: an API key and region), or `null` to stop writing back.
 */
alertSourceRoutes.put('/:id/writeback', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).get();
  if (!row) return void res.status(404).json({ error: 'Alert source not found' });
  if (row.kind !== 'pagerduty' && row.kind !== 'opsgenie') return void res.status(400).json({ error: 'Only PagerDuty and Opsgenie sources can be written back to.' });
  const b = z
    .union([z.null(), z.object({ apiKey: z.string().trim().min(8).max(200), fromEmail: z.string().trim().email().optional(), region: z.enum(['us', 'eu']).optional() })])
    .safeParse(req.body?.credentials ?? null);
  if (!b.success) return void res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid credentials' });
  if (b.data && row.kind === 'pagerduty' && !b.data.fromEmail) return void res.status(400).json({ error: 'PagerDuty needs the email of the user the token acts as.' });
  const updated = db
    .update(alertIntegrations)
    .set(b.data ? { writebackEnc: packSecrets({ apiKey: b.data.apiKey }), writebackConfig: { fromEmail: b.data.fromEmail ?? null, region: b.data.region ?? 'us' } } : { writebackEnc: null, writebackConfig: null })
    .where(eq(alertIntegrations.id, row.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'alert_source', entityId: row.id, action: b.data ? 'set_writeback' : 'clear_writeback' });
  res.json(view(updated));
});

/** A new token. The old one keeps working for a day, so the sender can be updated without losing alerts. */
alertSourceRoutes.post('/:id/rotate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const before = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).get();
  if (!before) {
    res.status(404).json({ error: 'Alert source not found' });
    return;
  }
  const t = newToken();
  const row = db
    .update(alertIntegrations)
    .set({ tokenHash: t.hash, tokenPrefix: t.prefix, previousTokenHash: before.tokenHash, previousTokenUntil: new Date(Date.now() + 86_400_000) })
    .where(eq(alertIntegrations.id, before.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'alert_source', entityId: row.id, action: 'rotate_token' });
  res.json({ source: view(row), token: t.token });
});

/**
 * Send a test alert through the real path -- parser, ingest, incident -- and resolve
 * it straight away, so a person sees it arrive without anything left open. Test
 * alerts carry `supops_test="true"` and are never diagnosed.
 */
alertSourceRoutes.post('/:id/test', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'Alert source not found' });
    return;
  }
  const kind = row.kind as IntegrationKind;
  if (kind === 'changes') {
    // Through the real path, then removed: a test change must never become a suspect.
    const r = receive(row, sampleWebhook(kind));
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    const stored = db.delete(changes).where(and(eq(changes.integrationId, row.id), eq(changes.externalId, 'supops-test'))).returning().get();
    res.json({ ok: true, change: stored ? { title: stored.title, service: stored.service, version: stored.version } : null });
    return;
  }
  // A generic sender's own field paths may not fit SupOps' sample; test the pipeline with the default shape.
  const testRow = kind === 'generic' ? { ...row, mapping: null } : row;
  const fired = receive(testRow, sampleWebhook(kind, 'firing'));
  if (!fired.ok) {
    res.status(400).json({ error: fired.error });
    return;
  }
  const stored = db
    .select({ id: alerts.id, title: alerts.title, incidentId: alerts.incidentId })
    .from(alerts)
    .where(and(eq(alerts.integrationId, row.id), eq(alerts.title, kind === 'alertmanager' || kind === 'grafana' ? 'SupOpsTestAlert' : 'SupOps test alert')))
    .orderBy(desc(alerts.receivedAt))
    .get();
  receive(testRow, sampleWebhook(kind, 'resolved'));
  res.json({ ok: true, alert: stored ?? null });
});

/** Check a sample payload against a generic sender's field paths, without storing anything. */
alertSourceRoutes.post('/preview', (req, res) => {
  const body = z.object({ kind: z.enum(INTEGRATION_KINDS), mapping: mapping.optional(), payload: z.unknown() }).safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid preview' });
    return;
  }
  res.json(parseWebhook(body.data.kind, body.data.payload, cleanMapping(body.data.mapping) ?? {}));
});

alertSourceRoutes.delete('/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const row = db.delete(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Alert source not found' });
    return;
  }
  audit(req.user, { projectId: row.projectId, entity: 'alert_source', entityId: row.id, action: 'delete', before: { kind: row.kind, name: row.name } });
  res.json({ ok: true });
});
