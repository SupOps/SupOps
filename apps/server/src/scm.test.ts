import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-scm-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const express = (await import('express')).default;
const { db } = await import('./context.ts');
const { projects, users, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { signToken } = await import('./auth.ts');
const { api } = await import('./routes/index.ts');

const admin = { id: 'u-admin', email: 'admin@example.test', name: 'Ada', globalRole: 'admin' as const };
db.insert(users).values({ ...admin, passwordHash: null }).run();
const project = db.insert(projects).values({ slug: 'shop', name: 'Shop', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();

let app: Server;
let gh: Server;
let base = '';
let ghBase = '';
const auths: string[] = [];
before(async () => {
  gh = createServer((req, res) => {
    auths.push(String(req.headers.authorization));
    if (req.url === '/repos/acme/shop') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"full_name":"acme/shop"}');
    res.writeHead(404).end('{}');
  }).listen(0, '127.0.0.1');
  await new Promise((r) => gh.once('listening', r));
  ghBase = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
  const e = express();
  e.use(express.json());
  e.use('/api', api);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  base = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api`;
});
after(() => {
  app.closeAllConnections();
  app.close();
  gh.close();
});
const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${signToken(admin)}` }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('a GitHub connection: an allowlist is required, the token is stored, and the test reads the first repository', async () => {
  const body = (repos: string[]) => ({ projectId: project.id, slug: 'github', name: 'GitHub', env: 'prod', description: 'code and CI', config: { kind: 'github', baseUrl: ghBase, repos, allowPrivateNetwork: true }, auth: { type: 'bearer', token: 'ghp_testtoken' } });
  assert.equal((await call('POST', '/targets', body([]))).status, 400, 'no repositories, no connection');
  const r = await call('POST', '/targets', body(['acme/shop', 'acme/*']));
  assert.equal(r.status, 201);
  const t = (await r.json()) as { id: string; kind: string; hasCredential?: boolean };
  assert.equal(t.kind, 'github');
  const probe = (await (await call('POST', `/targets/${t.id}/test`)).json()) as { ok: boolean; detail: string };
  assert.deepEqual(probe, { ok: true, detail: 'Connected; can read acme/shop.' });
  assert.equal(auths.at(-1), 'Bearer ghp_testtoken');
  const listed = await (await call('GET', `/targets?projectId=${project.id}`)).text();
  assert.doesNotMatch(listed, /ghp_testtoken/, 'the token is never sent back');
});
