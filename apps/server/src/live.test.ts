import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// The server's modules open the database named in the environment when imported:
// point them at a fresh one before loading anything.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-live-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, sqlite } = await import('./context.ts');
const { alerts, incidents, projects, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { LiveChanges } = await import('./live.ts');
const { constraintError, corsOrigin, staticOptions } = await import('./http-hardening.ts');

test('live changes: writes from anywhere move their topic, and only theirs', () => {
  const live = new LiveChanges(sqlite);
  assert.deepEqual(live.check(), [], 'the first look only records');
  assert.deepEqual(live.check(), [], 'nothing written, nothing moved');

  const projectId = 'p-live';
  db.insert(projects).values({ id: projectId, slug: 'live', name: 'Live', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
  assert.deepEqual(live.check(), [], 'projects are not a live topic');

  db.insert(incidents)
    .values({ id: 'i1', projectId, title: 'Disk filling on web-1', status: 'open', severity: 'warning', groupKey: { host: 'web-1' }, origin: 'alerts' })
    .run();
  assert.deepEqual(live.check(), ['observability']);

  db.insert(alerts)
    .values({
      id: 'a1',
      projectId,
      source: 'alertmanager',
      fingerprint: 'fp1',
      title: 'DiskFilling',
      status: 'new',
      severity: 'warning',
      labels: {},
      incidentId: 'i1',
    })
    .run();
  assert.deepEqual(live.check(), ['alerts']);

  db.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, 'a1')).run();
  db.update(incidents).set({ status: 'resolved' }).where(eq(incidents.id, 'i1')).run();
  assert.deepEqual(live.check().sort(), ['alerts', 'observability'], 'two writes in one tick report both topics once');
  assert.deepEqual(live.check(), []);
});

test('cors: same origin and listed origins only; no Origin header is not a CORS matter', () => {
  const allow = corsOrigin(['https://ops.example.com']);
  const ask = (origin: string | undefined) => {
    let out: boolean | undefined;
    allow(origin, (_e, ok) => (out = ok));
    return out;
  };
  assert.equal(ask(undefined), true);
  assert.equal(ask('https://ops.example.com'), true);
  assert.equal(ask('https://evil.example'), false);
});

test('static caching: hashed assets are immutable, the shell is always revalidated', () => {
  const headers = new Map<string, string>();
  const res = { setHeader: (k: string, v: string) => headers.set(k, v) } as never;
  staticOptions.setHeaders!(res, '/app/apps/web/dist/assets/index-abc123.js', {} as never);
  assert.match(headers.get('Cache-Control')!, /immutable/);
  staticOptions.setHeaders!(res, '/app/apps/web/dist/index.html', {} as never);
  assert.equal(headers.get('Cache-Control'), 'no-cache');
  staticOptions.setHeaders!(res, 'C:\\app\\apps\\web\\dist\\assets\\index-abc123.js', {} as never);
  assert.match(headers.get('Cache-Control')!, /immutable/, 'Windows paths too');
});

test('a duplicate key is a 409 with words a person can act on, not a 500', () => {
  const dup = Object.assign(new Error('UNIQUE constraint failed: targets.project_id, targets.slug'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
  const r = constraintError(dup);
  assert.equal(r?.status, 409);
  assert.doesNotMatch(r!.error, /constraint|sqlite/i);
  assert.equal(constraintError(new Error('boom')), null);
});
