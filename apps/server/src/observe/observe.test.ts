import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The server's modules open the database named in the environment when imported:
// point them at a fresh one before loading anything.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-observe-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { agents, alerts, incidents, observations, projects, targets, watches, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { and, eq, isNull } = await import('drizzle-orm');
const { watchSeries } = await import('@supops/db');
const { pollConnection } = await import('./alert-poller.ts');
const { ingestAlert } = await import('./ingest.ts');
const { expireIgnores, mergeIncidents, splitIncident } = await import('./incidents.ts');
const { projectConnections } = await import('./connections.ts');
const { reevaluateWatch, sampleWatch } = await import('./watcher.ts');
const { evidenceBlock } = await import('./triage.ts');
const { cleanupObservability } = await import('@supops/core');

// ---- a fake Alertmanager + Prometheus --------------------------------------------

let firing: Array<Record<string, unknown>> = [];
/** The disk the fake backend reports: free bytes now, and losing this many per second. */
let disk = { now: 20e9, perSecond: -1e9 / 3600 };
/** A disk-usage percent the fake backend reports: level now, trend per hour, and an
 * optional step change `dropHoursAgo` from `prev` (history reads `prev` before the step). */
let pct: { now: number; perHour: number; prev?: number; dropHoursAgo?: number } = { now: 50, perHour: 0 };
const vector = (v: number) => ({ status: 'success', data: { resultType: 'vector', result: [{ metric: { instance: 'web-1:9100', mountpoint: '/var' }, value: [0, String(v)] }] } });
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (url.pathname === '/api/v2/alerts') return send(firing);
    const q = url.searchParams.get('query') ?? '';
    if (url.pathname === '/api/v1/query' && q.includes('node_filesystem_avail_bytes')) {
      if (q.startsWith('avg_over_time')) return send(vector(disk.now - disk.perSecond * 43_200));
      if (q.startsWith('stddev_over_time')) return send(vector(Math.abs(disk.perSecond) * 25_000 || 1e8));
      if (q.includes('offset 1d')) return send(vector(disk.now - disk.perSecond * 86_400));
      if (q.startsWith('deriv')) return send(vector(disk.perSecond));
      return send(vector(disk.now));
    }
    // A disk-usage percent, both instant (with its trend extras) and as 15 days of history.
    if (q.includes('supops_disk_pct')) {
      const metric = { instance: 'web-1:9100', mountpoint: '/' };
      if (url.pathname === '/api/v1/query_range') {
        const start = Number(url.searchParams.get('start'));
        const end = Number(url.searchParams.get('end'));
        const step = Number((url.searchParams.get('step') ?? '3600s').replace('s', '')) || 3600;
        const values: Array<[number, string]> = [];
        for (let t = start; t <= end; t += step) {
          const hoursAgo = (end - t) / 3600;
          // A realistic step change: the old level until `dropHoursAgo`, then the new one.
          const v = pct.dropHoursAgo != null && hoursAgo > pct.dropHoursAgo ? pct.prev! : pct.now - pct.perHour * hoursAgo;
          values.push([t, String(v)]);
        }
        return send({ status: 'success', data: { resultType: 'matrix', result: [{ metric, values }] } });
      }
      if (url.pathname === '/api/v1/query') {
        const one = (v: number) => send({ status: 'success', data: { resultType: 'vector', result: [{ metric, value: [0, String(v)] }] } });
        if (q.startsWith('stddev_over_time')) return one(0.5);
        if (q.startsWith('deriv')) return one(pct.perHour / 3600);
        // avg/min/max over any window, and "offset 1d", all read as the current level.
        return one(pct.now);
      }
    }
    if (url.pathname === '/api/v1/query') return send({ status: 'success', data: { resultType: 'vector', result: [] } });
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function seed() {
  // Nothing in these tests may start an investigation.
  settingsStore.saveObservability({ autoTriage: false });
  const project = db.insert(projects).values({ slug: `p-${randomBytes(3).toString('hex')}`, name: 'P', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
  db.insert(agents).values({ projectId: project.id, slug: 'triage', name: 'Triage', role: 'triage', systemPrompt: 'x', budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).run();
  const web = db.insert(targets).values({
    projectId: project.id, slug: 'web-1', name: 'web-1', kind: 'ssh', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'ssh', host: '203.0.113.10', port: 22, user: 'ops', sudo: false, addresses: ['web-1'] }, createdAt: new Date(),
  }).returning().get();
  const am = db.insert(targets).values({
    projectId: project.id, slug: 'am', name: 'am', kind: 'alertmanager', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'alertmanager', baseUrl: base, allowPrivateNetwork: true }, createdAt: new Date(),
  } as never).returning().get();
  const prom = db.insert(targets).values({
    projectId: project.id, slug: 'prom', name: 'prom', kind: 'prometheus', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'prometheus', baseUrl: base, allowPrivateNetwork: true }, createdAt: new Date(),
  } as never).returning().get();
  return { projectId: project.id, web, am, prom };
}

const amAlert = (fingerprint: string, alertname: string, instance: string, severity = 'warning') => ({
  fingerprint, labels: { alertname, instance, severity }, annotations: { summary: `${alertname} on ${instance}` }, startsAt: new Date().toISOString(), status: { state: 'active' },
});

test('alerts read from Alertmanager are grouped, merged with Slack copies, and resolved when gone', async () => {
  const { projectId, web, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;

  firing = [amAlert('f1', 'HighCPU', 'web-1:9100'), amAlert('f2', 'DiskFull', 'web-1:9100', 'critical')];
  const st = await pollConnection(projectId, conn);
  assert.equal(st.ok, true);
  let rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === 'alertmanager' && r.connectionId === am.id));
  assert.equal(new Set(rows.map((r) => r.incidentId)).size, 1, 'one incident for one machine');
  const inc = db.select().from(incidents).where(eq(incidents.id, rows[0]!.incidentId!)).get()!;
  assert.equal(inc.severity, 'critical');
  assert.deepEqual(inc.targetIds, [web.id]);
  assert.match(inc.title, /on web-1/);

  // Polling again does not duplicate or bump counts.
  await pollConnection(projectId, conn);
  rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.count === 1));

  // The same alert relayed through Slack joins the existing row.
  const slack = (status: 'firing' | 'resolved') =>
    ingestAlert({
      projectId, source: 'slack', fingerprint: 'slack-fp', title: 'HighCPU', severity: 'warning', summary: null,
      labels: { alertname: 'HighCPU', instance: 'web-1:9100' }, status, notification: true,
      slack: { channelId: 'C1', channelName: 'alerts', permalink: 'https://example.slack.com/x' },
    });
  slack('firing');
  rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2, 'merged, not duplicated');
  assert.equal(rows.find((r) => r.title === 'HighCPU')!.slackPermalink, 'https://example.slack.com/x');
  // Slack saying "resolved" does not close what the connection still reports.
  slack('resolved');
  assert.equal(db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:f1`)).get()!.status, 'new');

  // Gone from Alertmanager: resolved, kept as history.
  firing = [amAlert('f2', 'DiskFull', 'web-1:9100', 'critical')];
  await pollConnection(projectId, conn);
  const cpu = db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:f1`)).get()!;
  assert.equal(cpu.status, 'resolved');
  assert.ok(cpu.resolvedAt);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'open');

  firing = [];
  await pollConnection(projectId, conn);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'resolved');
});

test('a failed read resolves nothing', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('x1', 'Down', 'db-9')];
  await pollConnection(projectId, conn);
  const broken = { ...conn, config: { ...(conn.config as object), baseUrl: 'http://127.0.0.1:9' } } as typeof conn;
  const st = await pollConnection(projectId, broken);
  assert.equal(st.ok, false);
  assert.equal(db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:x1`)).get()!.status, 'new');
});

test('unrelated alerts open separate incidents; a person can merge and split them', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('a', 'DiskFull', 'db-1'), amAlert('b', 'Latency', 'api-7')];
  await pollConnection(projectId, conn);
  const rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  const [i1, i2] = [...new Set(rows.map((r) => r.incidentId!))];
  assert.ok(i1 && i2 && i1 !== i2);

  const merged = mergeIncidents(i2, i1)!;
  assert.equal(db.select().from(alerts).where(eq(alerts.incidentId, i1)).all().length, 2);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, i2)).get()!.mergedInto, i1);
  assert.match(merged.groupReason ?? '', /merged by a person/);

  const latency = rows.find((r) => r.title === 'Latency')!;
  const split = splitIncident(i1, [latency.id])!;
  assert.equal(db.select().from(alerts).where(eq(alerts.id, latency.id)).get()!.incidentId, split.id);
  assert.equal(splitIncident(split.id, [latency.id]), null, 'cannot split out every alert');
});

test('the watcher scores every series and opens a predicted incident before a disk fills', async () => {
  const { projectId, prom, web } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === prom.id)!;
  // /var losing 1 GB an hour with 20 GB left: full in about 20 hours.
  disk = { now: 20e9, perSecond: -1e9 / 3600 };
  const w = db.insert(watches).values({
    projectId, connectionId: prom.id, key: 'disk_free', title: 'Disk free', query: 'node_filesystem_avail_bytes', unit: 'bytes',
    builtin: true, badDirection: 'down', limit: { value: 0, when: 'below' }, group: 'resources',
  }).returning().get();

  await sampleWatch(w, conn);
  const sampled = db.select().from(watches).where(eq(watches.id, w.id)).get()!;
  assert.equal(sampled.seriesCount, 1);
  assert.equal(sampled.lastError, null);
  const row = db.select().from(watchSeries).where(eq(watchSeries.watchId, w.id)).get()!;
  assert.equal(row.score, 85, 'runs out within a day');
  assert.match(row.reasons[0]!, /runs out in (19|20)h/);
  assert.equal(row.targetId, web.id, 'tied to the machine by its instance label');

  let f = db.select().from(observations).where(and(eq(observations.watchId, w.id), eq(observations.kind, 'forecast'))).get()!;
  assert.equal(f.severity, 'warning', 'about 20h left: inside the 24h warning horizon');
  assert.match(f.message, /Disk free on web-1:9100 \/var runs out in about (19|20)h/);
  assert.equal(f.incidentId, null, 'one scan is not enough: a forecast must hold for 15 minutes first');

  // Still predicted 16 minutes later: now it opens an incident.
  await sampleWatch(db.select().from(watches).where(eq(watches.id, w.id)).get()!, conn, Date.now() + 16 * 60_000);
  f = db.select().from(observations).where(eq(observations.id, f.id)).get()!;
  const inc = db.select().from(incidents).where(eq(incidents.id, f.incidentId!)).get()!;
  assert.equal(inc.origin, 'prediction');
  assert.equal(inc.status, 'open');

  const block = evidenceBlock(inc, [], []);
  assert.match(block, /raised by a forecast/);
  assert.match(block, /Forecast: Disk free on web-1/);

  // The disk was cleaned up: the forecast and its incident resolve.
  disk = { now: 500e9, perSecond: 0 };
  await sampleWatch(db.select().from(watches).where(eq(watches.id, w.id)).get()!, conn);
  assert.ok(db.select().from(observations).where(eq(observations.id, f.id)).get()!.resolvedAt);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'resolved');

  // And the 15-day clean-up leaves recent data alone.
  const r = cleanupObservability(db, { days: 15 });
  assert.equal(r.incidents, 0);
});

test('a cleaned-up percent signal drops its stale forecast, not "reaches its limit now"', async () => {
  const { projectId, prom } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === prom.id)!;
  // Disk usage climbing toward its 80% limit: the fitted model opens a forecast and is cached.
  pct = { now: 79, perHour: 0.1 };
  const w = db.insert(watches).values({
    projectId, connectionId: prom.id, key: 'custom:diskpct', title: 'Disk used', query: 'supops_disk_pct', unit: 'percent',
    builtin: false, badDirection: 'up', limit: { value: 80, when: 'above' }, group: 'custom',
  }).returning().get();

  await sampleWatch(w, conn);
  const r1 = db.select().from(watchSeries).where(eq(watchSeries.watchId, w.id)).get()!;
  assert.match(r1.reasons.join(' '), /reaches its limit|over its limit/, 'near its limit, a forecast is raised');
  assert.ok(
    db.select().from(observations).where(and(eq(observations.watchId, w.id), eq(observations.kind, 'forecast'), isNull(observations.resolvedAt))).get(),
    'a forecast observation is open',
  );

  // Cleaned up to 34.5% an hour later, as a sharp cliff: the history is high for days and
  // then drops. The model from the last hour is now stale; the next scan must refit it and
  // read the new level, not keep pinning "reaches its limit now" on a series with 45% headroom.
  pct = { now: 34.5, perHour: 0, prev: 79, dropHoursAgo: 1 };
  await sampleWatch(db.select().from(watches).where(eq(watches.id, w.id)).get()!, conn, Date.now() + 5 * 60_000);

  const r2 = db.select().from(watchSeries).where(eq(watchSeries.watchId, w.id)).get()!;
  assert.equal(r2.value, 34.5);
  assert.equal(r2.etaMs, null, 'the forecast eta is cleared');
  assert.doesNotMatch(r2.reasons.join(' '), /reaches its limit|over its limit/, 'no stale forecast on a cleaned-up disk');
  assert.ok(
    !db.select().from(observations).where(and(eq(observations.watchId, w.id), eq(observations.kind, 'forecast'), isNull(observations.resolvedAt))).get(),
    'the forecast observation is resolved',
  );
});

/** Ignore an incident the way the route does. */
function ignoreIncident(id: string, hours: number) {
  db.update(incidents).set({ status: 'ignored', resolvedAt: new Date(), ignoredUntil: new Date(Date.now() + hours * 3_600_000) }).where(eq(incidents.id, id)).run();
  db.update(alerts).set({ status: 'ignored' }).where(and(eq(alerts.incidentId, id), isNull(alerts.resolvedAt))).run();
}

test('an ignore always ends: still firing reopens, stopped resolves', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('i1', 'Flappy', 'svc-1'), amAlert('i2', 'Quiet', 'svc-2')];
  await pollConnection(projectId, conn);
  const [flappy, quiet] = ['Flappy', 'Quiet'].map((t) => db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, t))).get()!);
  ignoreIncident(flappy!.incidentId!, 4);
  ignoreIncident(quiet!.incidentId!, 4);

  // While ignored, polling keeps them ignored and opens nothing new.
  firing = [amAlert('i1', 'Flappy', 'svc-1')];
  await pollConnection(projectId, conn);
  assert.equal(db.select().from(alerts).where(eq(alerts.id, flappy!.id)).get()!.status, 'ignored');
  assert.equal(db.select().from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'))).all().length, 0);
  assert.deepEqual(expireIgnores(), [], 'nothing is due yet');

  // Time is up.
  const later = new Date(Date.now() + 5 * 3_600_000);
  const reopened = expireIgnores(later);
  assert.deepEqual(reopened, [flappy!.incidentId]);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, flappy!.incidentId!)).get()!.status, 'open');
  assert.equal(db.select().from(alerts).where(eq(alerts.id, flappy!.id)).get()!.status, 'new', 'back in the queue');
  assert.equal(db.select().from(incidents).where(eq(incidents.id, quiet!.incidentId!)).get()!.status, 'resolved', 'stopped firing: resolved, not reopened');
});

test('an escalation breaks through an ignore at once', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('e1', 'DiskFilling', 'db-3', 'warning')];
  await pollConnection(projectId, conn);
  const row = db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, 'DiskFilling'))).get()!;
  ignoreIncident(row.incidentId!, 168);

  firing = [amAlert('e1', 'DiskFilling', 'db-3', 'critical')];
  await pollConnection(projectId, conn);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, row.incidentId!)).get()!.status, 'open');
  assert.equal(db.select().from(alerts).where(eq(alerts.id, row.id)).get()!.status, 'new');
});

test('a Slack repeat stays with an ignored incident; after the ignore it is news again', () => {
  const { projectId } = seed();
  const slack = () =>
    ingestAlert({
      projectId, source: 'slack', fingerprint: 'slack-x', title: 'NoisyCron', severity: 'warning', summary: null,
      labels: { alertname: 'NoisyCron', instance: 'cron-1' }, status: 'firing', notification: true,
      slack: { channelId: 'C9', channelName: 'cron' },
    });
  slack();
  const first = db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, 'NoisyCron'))).get()!;
  ignoreIncident(first.incidentId!, 1);
  slack();
  assert.equal(db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, 'NoisyCron'))).all().length, 1, 'kept with the ignored one');
  db.update(incidents).set({ ignoredUntil: new Date(Date.now() - 1000) }).where(eq(incidents.id, first.incidentId!)).run();
  slack();
  assert.equal(db.select().from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.title, 'NoisyCron'))).all().length, 2, 'news again once the ignore is over');
});

test('editing a signal re-evaluates what it found', async () => {
  const { projectId, prom } = seed();
  disk = { now: 20e9, perSecond: -1e9 / 3600 };
  const w = db.insert(watches).values({
    projectId, connectionId: prom.id, key: 'custom:disk', title: 'Disk free', query: 'node_filesystem_avail_bytes', unit: 'bytes',
    builtin: false, badDirection: 'down', limit: { value: 0, when: 'below' }, group: 'custom',
  }).returning().get();
  const conn = projectConnections(projectId).find((c) => c.id === prom.id)!;
  await sampleWatch(w, conn);
  await sampleWatch(w, conn, Date.now() + 16 * 60_000);
  const f = db.select().from(observations).where(and(eq(observations.watchId, w.id), eq(observations.kind, 'forecast'))).get()!;
  assert.ok(f.incidentId, 'a predicted incident was raised once the forecast held');

  // A higher limit: it runs out sooner, and the incident follows.
  db.update(watches).set({ limit: { value: 16e9, when: 'below' } }).where(eq(watches.id, w.id)).run();
  assert.deepEqual(await reevaluateWatch(w.id, { queryChanged: false }), { ok: true });
  assert.match(db.select().from(observations).where(eq(observations.id, f.id)).get()!.message, /reaches its limit in about (3|4)h/);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, f.incidentId!)).get()!.severity, 'critical');

  // The limit is removed: no forecast any more, and the predicted incident closes.
  db.update(watches).set({ limit: null }).where(eq(watches.id, w.id)).run();
  await reevaluateWatch(w.id, { queryChanged: false });
  assert.ok(db.select().from(observations).where(eq(observations.id, f.id)).get()!.resolvedAt);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, f.incidentId!)).get()!.status, 'resolved');

  // A new query starts over: what was known about the old one is dropped.
  db.insert(watchSeries).values({ watchId: w.id, series: '{stale="1"}', labels: { stale: '1' }, name: 'stale', value: 1, score: 99, reasons: [] }).run();
  db.update(watches).set({ query: 'node_filesystem_avail_bytes{mountpoint="/var"}' }).where(eq(watches.id, w.id)).run();
  await reevaluateWatch(w.id, { queryChanged: true });
  const after = db.select().from(watchSeries).where(eq(watchSeries.watchId, w.id)).all();
  assert.ok(after.length === 1 && after[0]!.series !== '{stale="1"}', 'stale series gone, the new query scanned');
});
