import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSchemaProfile } from '@supops/shared';
import { HttpTransport, McpClient, StdioTransport, mcpToolDef, mcpToolKey, profileOf, resultText, sseMessages } from './mcp.ts';
import { bindTool } from './registry.ts';

/** A fake MCP server: JSON replies, or SSE with a notification first when asked. */
const seen: Array<{ method: string; session: string | undefined; version: string | undefined }> = [];
let server: Server;
let url = '';
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'DELETE') return res.writeHead(200).end();
      const m = JSON.parse(body) as { id?: number; method: string; params?: Record<string, unknown> };
      seen.push({ method: m.method, session: req.headers['mcp-session-id'] as string | undefined, version: req.headers['mcp-protocol-version'] as string | undefined });
      if (req.headers.authorization !== 'Bearer t0k') return res.writeHead(401).end('no');
      if (m.id === undefined) return res.writeHead(202).end();
      const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
      let result: unknown;
      if (m.method === 'initialize') result = { protocolVersion: '2025-03-26', serverInfo: { name: 'fake', version: '1.2' }, capabilities: { tools: {} } };
      else if (m.method === 'tools/list') {
        result = m.params?.cursor
          ? { tools: [{ name: 'restart_service', description: 'Restart', inputSchema: { type: 'object', properties: { target: { type: 'string' }, name: { type: 'string' } }, required: ['target', 'name'] }, annotations: { destructiveHint: true } }] }
          : { tools: [{ name: 'whoami', description: 'Who am I', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }], nextCursor: 'p2' };
      } else if (m.method === 'tools/call') {
        const p = m.params as { name: string; arguments: Record<string, unknown> };
        result = p.name === 'whoami' ? { content: [{ type: 'text', text: 'svc-supops' }] } : { content: [{ type: 'text', text: `args ${JSON.stringify(p.arguments)}` }], isError: p.arguments.name === 'bad' };
      }
      const headers: Record<string, string> = m.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
      if (m.method === 'tools/call') {
        // As a stream: a progress notification first, then the answer, and the stream left open.
        res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`);
        res.write(`data: ${JSON.stringify(reply(result))}\n\n`);
        return;
      }
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(reply(result)));
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
after(() => server.closeAllConnections?.() ?? server.close());

test('HTTP: initialise, list every page of tools, call one answered as a stream', async () => {
  const c = new McpClient(new HttpTransport({ url, headers: { authorization: 'Bearer t0k' }, allowPrivateNetwork: true }));
  const info = await c.connect();
  assert.deepEqual(info, { name: 'fake', version: '1.2', protocolVersion: '2025-03-26' });
  const tools = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['whoami', 'restart_service']);
  const r = await c.callTool('whoami', {}, 5_000);
  assert.deepEqual(r, { ok: true, text: 'svc-supops' });
  assert.deepEqual(await c.callTool('restart_service', { name: 'bad' }, 5_000), { ok: false, text: 'args {"name":"bad"}' });
  c.close();
  const afterInit = seen.filter((s) => s.method !== 'initialize');
  assert.ok(afterInit.every((s) => s.session === 'sess-1' && s.version === '2025-03-26'), 'the session and agreed version go with every later request');
});

test('HTTP: wrong credentials, a private address not allowed, and cloud metadata are refused', async () => {
  await assert.rejects(new McpClient(new HttpTransport({ url, allowPrivateNetwork: true })).connect(), /HTTP 401.*credentials/);
  await assert.rejects(new McpClient(new HttpTransport({ url, headers: { authorization: 'Bearer t0k' }, allowPrivateNetwork: false })).connect(), /private or loopback/);
  await assert.rejects(new McpClient(new HttpTransport({ url: 'http://169.254.169.254/mcp', allowPrivateNetwork: true })).connect(), /cloud-metadata/);
});

test('SSE events are split on blank lines; multi-line data joins; junk is skipped', () => {
  const s = sseMessages();
  assert.deepEqual(s.push('data: {"id":1,\r\ndata: "result":{}}\r\n'), []);
  assert.deepEqual(s.push('\r\n: comment\n\ndata: nope\n\ndata: {"id":2}\n\n'), [{ id: 1, result: {} }, { id: 2 }]);
});

test('stdio: a local server speaks newline JSON-RPC and never sees SupOps\' environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'supops-mcp-'));
  const script = join(dir, 'server.mjs');
  writeFileSync(
    script,
    `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const out = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') out({ protocolVersion: '2025-06-18', serverInfo: { name: 'local', version: '0' } });
  else if (m.method === 'tools/list') out({ tools: [{ name: 'env' }] });
  else out({ content: [{ type: 'text', text: [process.env.SUPOPS_MASTER_KEY ? 'LEAK' : 'clean', process.env.GIVEN].join(' ') }] });
});`,
  );
  process.env.SUPOPS_MASTER_KEY ??= 'test-only-key';
  const c = new McpClient(new StdioTransport({ command: process.execPath, args: [script], env: { GIVEN: 'only-this' } }));
  assert.equal((await c.connect()).name, 'local');
  assert.deepEqual((await c.listTools()).map((t) => t.name), ['env']);
  assert.deepEqual(await c.callTool('env', {}, 5_000), { ok: true, text: 'clean only-this' });
  c.close();
  const dead = new McpClient(new StdioTransport({ command: join(dir, 'no-such-binary'), args: [] }));
  await assert.rejects(dead.connect(2_000), /Could not start|exited/);
});

test('MCP tools: approval by default, read-only only when an admin marked it; names and schemas fit every backend', async () => {
  const marked = new Map<string, { by: string; at: number }>();
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const binding = {
    serverName: 'Ops Tools',
    readOnly: (t: string) => marked.get(t) ?? null,
    call: async (tool: string, args: Record<string, unknown>) => { calls.push({ tool, args }); return { ok: true, text: 'done' }; },
  };
  const def = mcpToolDef(binding, { name: 'restart-service', inputSchema: { type: 'object', properties: { target: { type: ['string', 'null'] }, n: { type: 'integer', minimum: 1 }, opts: { type: 'object', additionalProperties: true, properties: { force: { type: 'boolean' } } } }, required: ['target'] } });
  assert.equal(def.key, 'mcp_ops_tools_restart_service');
  assert.equal(mcpToolKey('x'.repeat(80), 'y'), `mcp_${'x'.repeat(60)}`);
  assert.equal(def.classifyArgs!({ target: 'supops-server' } as never, {} as never)[0]!.tier, 'high');
  marked.set('restart-service', { by: 'Admin', at: Date.UTC(2026, 9, 18) });
  const ro = def.classifyArgs!({ target: 'supops-server' } as never, {} as never)[0]!;
  assert.equal(ro.tier, 'read_only');
  assert.match(ro.reason, /marked read-only by Admin on 2026-10-18/);

  // Bound to the SupOps server whatever the project's targets; the schema passes the profile check.
  const bound = bindTool(def as never, []);
  assert.ok(bound);
  assert.deepEqual([...bound.targetsBySlug.keys()], ['supops-server']);
  assert.deepEqual(bound.spec.function.parameters.required, ['target', 'mcp_target']);

  const out = await def.execute({ target: 'supops-server', mcp_target: 'nginx', n: 2, intent: 'x', expected_effect: 'y' } as never, { timeoutMs: 1000, maxOutputBytes: 1000, signal: new AbortController().signal } as never);
  assert.equal(out.ok, true);
  assert.deepEqual(calls[0], { tool: 'restart-service', args: { target: 'nginx', n: 2 } }, 'our arguments stripped, the clashing one renamed back');
});

test('schemas are cut to the common profile; results keep text and describe the rest', () => {
  const p = profileOf({ type: 'object', properties: { a: { anyOf: [{ type: 'string' }] }, b: { type: 'array', items: { type: 'number' } }, e: { type: 'string', enum: ['x', 'y'], pattern: '^x' } }, required: ['a', 'zzz'] });
  assertSchemaProfile(p);
  assert.deepEqual(p.required, ['a']);
  assert.deepEqual(resultText({ content: [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'AAA' }, { type: 'resource', resource: { uri: 'file:///x', text: 'body' } }] }), {
    ok: true,
    text: 'hi\n[image (image/png) not shown]\n[resource file:///x]\nbody',
  });
  assert.deepEqual(resultText({ content: [], structuredContent: { n: 1 }, isError: true }), { ok: false, text: '{\n  "n": 1\n}' });
});
