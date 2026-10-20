import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-mcp-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';
delete process.env.SUPOPS_MCP_STDIO;

const express = (await import('express')).default;
const { db, registry } = await import('../context.ts');
const { agents, auditLog, mcpServers, projects, runs, targets, users, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { assessRisk, NETWORK_TARGET } = await import('@supops/core');
const { eq } = await import('drizzle-orm');
const { mcpServerRoutes } = await import('../routes/mcp-servers.ts');
const { startRun } = await import('../services/start-run.ts');

const projectId = 'p-mcp';
db.insert(users).values({ id: 'u-admin', email: 'admin@example.test', name: 'Ada Admin', globalRole: 'admin', passwordHash: null }).run();
db.insert(projects).values({ id: projectId, slug: 'mcp', name: 'MCP', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).run();
db.insert(targets).values({ projectId, slug: 'web-1', name: 'web', kind: 'ssh', env: 'staging', sensitivity: 1, description: 'app server', tags: [], config: { kind: 'ssh', host: 'web-1.example.test', port: 22, user: 'ops', sudo: false }, createdAt: new Date() } as never).run();
const agent = (keys: string[] | null) =>
  db.insert(agents).values({ projectId, slug: `a${Math.random().toString(36).slice(2, 8)}`, name: 'A', role: 'triage', systemPrompt: 'x', toolKeys: keys, budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).returning().get().id;

let fake: Server;
let mcpUrl = '';
let api = '';
let app: Server;
let role = 'admin';
const calls: string[] = [];

before(async () => {
  fake = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'DELETE') return res.writeHead(200).end();
      if (req.headers.authorization !== 'Bearer t0k') return res.writeHead(401).end();
      const m = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      if (m.id === undefined) return res.writeHead(202).end();
      calls.push(m.method === 'tools/call' ? `call ${m.params?.name}` : m.method);
      const result =
        m.method === 'initialize' ? { protocolVersion: '2025-06-18', serverInfo: { name: 'ops-fake', version: '3' } }
        : m.method === 'tools/list' ? { tools: [{ name: 'whoami', annotations: { readOnlyHint: true } }, { name: 'restart_service', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }] }
        : { content: [{ type: 'text', text: m.params?.name === 'whoami' ? 'svc-supops@example.test' : 'restarted' }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  fake.listen(0, '127.0.0.1');
  await new Promise((r) => fake.once('listening', r));
  mcpUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/mcp`;

  const e = express();
  e.use(express.json());
  e.use((req, _res, next) => {
    req.user = { id: 'u-admin', email: 'admin@example.test', name: role === 'admin' ? 'Ada Admin' : 'Mo Member', globalRole: role };
    next();
  });
  e.use('/api/mcp-servers', mcpServerRoutes);
  app = e.listen(0, '127.0.0.1');
  await new Promise((r) => app.once('listening', r));
  api = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/mcp-servers`;
});
after(() => {
  fake.closeAllConnections();
  fake.close();
  app.closeAllConnections();
  app.close();
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${api}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

test('an admin adds an MCP server: it is checked, its tools listed, its token never shown', async () => {
  const r = await send('POST', '', { projectId, name: 'ops', transport: 'http', url: mcpUrl, headers: { Authorization: 'Bearer t0k' }, allowPrivateNetwork: true, identityTool: 'whoami' });
  assert.equal(r.status, 201);
  const s = (await r.json()) as { id: string; tools: Array<{ name: string; key: string }>; serverInfo: { name: string }; identity: string; headerNames: string[]; lastError: string | null };
  assert.equal(s.lastError, null);
  assert.equal(s.serverInfo.name, 'ops-fake');
  assert.deepEqual(s.tools.map((t) => t.key), ['mcp_ops_whoami', 'mcp_ops_restart_service']);
  assert.match(s.identity, /mark whoami read-only/, 'the identity tool is not called before it is marked read-only');
  assert.deepEqual(s.headerNames, ['Authorization']);
  const listed = await (await send('GET', `?projectId=${projectId}`)).text();
  assert.doesNotMatch(listed, /t0k/, 'the token never leaves the server');

  // Marked read-only, the health check calls it and shows who SupOps acts as.
  assert.equal((await send('PUT', `/${s.id}/tools/whoami/read-only`, { readOnly: true })).status, 200);
  const checked = (await (await send('POST', `/${s.id}/check`)).json()) as { identity: string };
  assert.equal(checked.identity, 'svc-supops@example.test');
  const audit = db.select().from(auditLog).where(eq(auditLog.entityId, s.id)).all().map((a) => a.action);
  assert.ok(audit.includes('mark_tool_read_only'));
});

test('every MCP tool waits for approval until an admin marks it read-only', () => {
  const restart = registry.get('mcp_ops_restart_service')!;
  const whoami = registry.get('mcp_ops_whoami')!;
  const assess = (def: typeof restart) => assessRisk({ def, args: { target: 'supops-server', name: 'nginx' }, rendered: 'x', target: NETWORK_TARGET, policy: { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' }, trigger: 'chat' } as never);
  const r = assess(restart);
  assert.equal(r.tier, 'high');
  assert.equal(r.decision, 'approve');
  const w = assess(whoami);
  assert.equal(w.tier, 'read_only');
  assert.equal(w.decision, 'auto');
  assert.match(w.contributions.map((c) => c.reason).join(' '), /marked read-only by Ada Admin/);
});

test('a call goes to the server through a reused connection', async () => {
  calls.length = 0;
  const def = registry.get('mcp_ops_whoami')!;
  const ctx = { timeoutMs: 5_000, maxOutputBytes: 10_000, signal: new AbortController().signal } as never;
  assert.equal((await def.execute({ target: 'supops-server' } as never, ctx)).text, 'svc-supops@example.test');
  assert.equal((await def.execute({ target: 'supops-server' } as never, ctx)).text, 'svc-supops@example.test');
  assert.deepEqual(calls, ['initialize', 'call whoami', 'call whoami'], 'one initialise for both calls');
});

test('runs get the project\'s MCP tools by the agent\'s allowlist, bound to the SupOps server', () => {
  const toolsOf = (agentId: string) => {
    const r = startRun({ projectId, agentId, task: 'check' });
    assert.ok(r.ok);
    return db.select().from(runs).where(eq(runs.id, r.run.id)).get()!.toolsSnapshot.map((t) => t.function.name);
  };
  assert.ok(toolsOf(agent(null)).includes('mcp_ops_restart_service'), 'an agent allowed everything');
  assert.ok(!toolsOf(agent(['ssh_exec'])).some((k) => k.startsWith('mcp_')), 'an agent without them');
  const some = toolsOf(agent(['ssh_exec', 'mcp_ops_whoami']));
  assert.ok(some.includes('mcp_ops_whoami') && !some.includes('mcp_ops_restart_service'), 'by key');
  assert.ok(toolsOf(agent(['mcp_ops_*'])).includes('mcp_ops_restart_service'), 'by server');
  const snap = db.select().from(runs).all().at(-1)!.toolsSnapshot.find((t) => t.function.name === 'mcp_ops_whoami')!;
  assert.deepEqual((snap.function.parameters.properties!.target as { enum: string[] }).enum, ['supops-server']);
});

test('members cannot change servers; stdio is off unless the SupOps operator allows it; delete removes the tools', async () => {
  role = 'member';
  assert.equal((await send('POST', '', { projectId, name: 'x', transport: 'http', url: mcpUrl })).status, 403);
  role = 'admin';
  const stdio = await send('POST', '', { projectId, name: 'local', transport: 'stdio', command: 'node' });
  assert.equal(stdio.status, 400);
  assert.match(((await stdio.json()) as { error: string }).error, /SUPOPS_MCP_STDIO/);
  assert.equal((await send('POST', '', { projectId, name: 'ops', transport: 'http', url: mcpUrl })).status, 409);
  const id = db.select().from(mcpServers).get()!.id;
  assert.equal((await send('PATCH', `/${id}`, { name: 'renamed' })).status, 400, 'the name names the tools');
  assert.equal((await send('DELETE', `/${id}`)).status, 204);
  assert.equal(registry.get('mcp_ops_whoami'), undefined);
});
