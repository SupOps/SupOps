import { Router } from 'express';
import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import { alerts, changes, ciItems, ciLinks, incidents } from '@supops/db';
import { CATALOGUE_FIELDS, resourceQueries } from '@supops/core';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from '../context.ts';
import { findService, firstWithData, range } from '../servicehealth/signals.ts';
import { sloStatusForService } from '../slo/status.ts';

/**
 * One page per service, built from what SupOps already has: its catalogue entry and
 * dependencies from the service map, its rate, errors and latency (and CPU and memory)
 * from metrics, its changes, its SLOs and its open incidents.
 */
export const serviceHealthRoutes = Router();

const SERVICE_LABELS = ['service', 'service_name', 'app', 'app_kubernetes_io_name', 'application', 'job', 'deployment', 'container'];
const lower = (s: string) => s.toLowerCase();

function openAlertsByService(projectId: string): Map<string, Set<string>> {
  const rows = db
    .select({ labels: alerts.labels, incidentId: alerts.incidentId })
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .limit(2000)
    .all();
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const k of SERVICE_LABELS) {
      const v = r.labels?.[k];
      if (!v || !r.incidentId) continue;
      const set = out.get(lower(v)) ?? new Set<string>();
      set.add(r.incidentId);
      out.set(lower(v), set);
    }
  }
  return out;
}

/** Every service SupOps knows of: the service map, recent changes, and open alerts. */
serviceHealthRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const byName = new Map<string, { name: string; inMap: boolean; lastChange: Date | null; openIncidents: number; owner: string | null; tier: string | null }>();
  const add = (name: string) => {
    const k = lower(name);
    if (!byName.has(k)) byName.set(k, { name, inMap: false, lastChange: null, openIncidents: 0, owner: null, tier: null });
    return byName.get(k)!;
  };
  for (const i of db.select().from(ciItems).where(and(eq(ciItems.projectId, projectId), eq(ciItems.type, 'service'), eq(ciItems.status, 'approved'))).all()) {
    const s = add(i.name);
    s.inMap = true;
    s.owner = i.attrs[CATALOGUE_FIELDS.owner] ?? i.attrs.owner ?? null;
    s.tier = i.attrs[CATALOGUE_FIELDS.tier] ?? i.attrs.tier ?? null;
  }
  for (const c of db.select({ service: changes.service, at: changes.startedAt }).from(changes).where(and(eq(changes.projectId, projectId), gte(changes.startedAt, new Date(Date.now() - 30 * 86_400_000)))).orderBy(desc(changes.startedAt)).all()) {
    if (!c.service) continue;
    const s = add(c.service);
    if (!s.lastChange || c.at > s.lastChange) s.lastChange = c.at;
  }
  for (const [svc, ids] of openAlertsByService(projectId)) {
    const s = byName.get(svc) ?? null;
    if (s) s.openIncidents = ids.size;
  }
  res.json([...byName.values()].sort((a, b) => b.openIncidents - a.openIncidents || (b.lastChange?.getTime() ?? 0) - (a.lastChange?.getTime() ?? 0) || a.name.localeCompare(b.name)));
});

serviceHealthRoutes.get('/:name', async (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const name = req.params.name;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const hours = Math.min(7 * 24, Math.max(1, Number(req.query.hours ?? 6)));
  const end = Date.now();
  const start = end - hours * 3_600_000;
  const step = Math.max(30, Math.round((hours * 3600) / 240));

  // The catalogue entry and its neighbours on the map.
  const items = db.select().from(ciItems).where(and(eq(ciItems.projectId, projectId), eq(ciItems.status, 'approved'))).all();
  const me = items.find((i) => [i.name, i.key, ...(i.aliases ?? [])].some((n) => lower(n) === lower(name)));
  const byId = new Map(items.map((i) => [i.id, i]));
  const links = me ? db.select().from(ciLinks).where(and(eq(ciLinks.projectId, projectId), eq(ciLinks.status, 'approved'))).all() : [];
  const dependsOn = links.filter((l) => l.fromId === me?.id).map((l) => byId.get(l.toId)).filter(Boolean).map((i) => ({ name: i!.name, type: i!.type }));
  const usedBy = links.filter((l) => l.toId === me?.id).map((l) => byId.get(l.fromId)).filter(Boolean).map((i) => ({ name: i!.name, type: i!.type }));
  const attrs = me?.attrs ?? {};
  const catalogue = Object.fromEntries(Object.entries(CATALOGUE_FIELDS).map(([field, label]) => [field, attrs[label] ?? attrs[field] ?? null]));

  // Rate, errors and latency, and CPU and memory, over the window.
  const src = await findService(projectId, name);
  let metrics: null | { family: string; label: string; connection: string; series: Record<string, Array<[number, number]>> } = null;
  if (src) {
    const res2 = resourceQueries(name);
    const [cpu, memory] = await Promise.all([firstWithData(src.conn, res2.cpu), firstWithData(src.conn, res2.memory)]);
    const want: Array<[string, string | null]> = [['rate', src.red.rate], ['errors', src.red.errorRatio], ['p50', src.red.p50], ['p95', src.red.p95], ['p99', src.red.p99], ['cpu', cpu], ['memory', memory]];
    const series: Record<string, Array<[number, number]>> = {};
    await Promise.all(want.map(async ([k, expr]) => { if (expr) series[k] = await range(src.conn, expr, start, end, step); }));
    metrics = { family: src.red.family, label: src.red.label, connection: src.conn.slug, series };
  }

  const changeRows = db
    .select()
    .from(changes)
    .where(and(eq(changes.projectId, projectId), gte(changes.startedAt, new Date(Math.min(start, end - 7 * 86_400_000)))))
    .orderBy(desc(changes.startedAt))
    .limit(500)
    .all()
    .filter((c) => (c.service && lower(c.service) === lower(name)) || (me && c.service && [me.key, ...(me.aliases ?? [])].some((a) => lower(a) === lower(c.service!))));

  const incidentIds = [...(openAlertsByService(projectId).get(lower(name)) ?? [])];
  const open = incidentIds.length ? db.select().from(incidents).where(and(inArray(incidents.id, incidentIds), eq(incidents.status, 'open'))).all() : [];

  res.json({
    name: me?.name ?? name,
    description: me?.description ?? null,
    inMap: !!me,
    catalogue,
    dependsOn,
    usedBy,
    window: { start, end, step },
    metrics,
    changes: changeRows.slice(0, 50),
    incidents: open.map((i) => ({ id: i.id, title: i.title, severity: i.severity, openedAt: i.openedAt, rootCause: i.rootCause })),
    slos: sloStatusForService(projectId, name),
  });
});
