import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createServer as tcpServer, type Server as TcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { availability, runSynthetic, statusMatcher } from './synthetics.ts';

let http: Server;
let tcp: TcpServer;
let base = '';
let tcpPort = 0;
before(async () => {
  http = createServer((req, res) => {
    if (req.url === '/old') return res.writeHead(301, { location: '/health' }).end();
    if (req.url === '/slow') return setTimeout(() => res.writeHead(200).end('ok'), 120);
    if (req.url === '/health') return res.writeHead(200, { 'content-type': 'text/plain' }).end('status: ok');
    res.writeHead(503).end('down');
  });
  http.listen(0, '127.0.0.1');
  await new Promise((r) => http.once('listening', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  tcp = tcpServer((s) => s.end());
  tcp.listen(0, '127.0.0.1');
  await new Promise((r) => tcp.once('listening', r));
  tcpPort = (tcp.address() as AddressInfo).port;
});
after(() => { http.close(); tcp.close(); });

test('http: status and content decide up or down; redirects are followed; slow is degraded', async () => {
  const up = await runSynthetic({ kind: 'http', target: `${base}/old`, contains: 'status: ok', allowPrivate: true });
  assert.equal(up.status, 'up');
  assert.equal(up.statusCode, 200);
  const down = await runSynthetic({ kind: 'http', target: `${base}/broken`, allowPrivate: true });
  assert.deepEqual([down.status, down.ok, down.error], ['down', false, 'HTTP 503 (expected 200-399)']);
  const wrong = await runSynthetic({ kind: 'http', target: `${base}/health`, contains: 'healthy', allowPrivate: true });
  assert.equal(wrong.error, 'the response does not contain "healthy"');
  const slow = await runSynthetic({ kind: 'http', target: `${base}/slow`, maxLatencyMs: 50, allowPrivate: true });
  assert.equal(slow.status, 'degraded');
  assert.equal(slow.ok, true, 'degraded still counts as working');
  assert.match(slow.error!, /took \d+ ms \(limit 50 ms\)/);
});

test('internal addresses need permission; cloud metadata never', async () => {
  const no = await runSynthetic({ kind: 'http', target: `${base}/health` });
  assert.match(no.error!, /internal address/);
  const meta = await runSynthetic({ kind: 'http', target: 'http://169.254.169.254/latest', allowPrivate: true });
  assert.match(meta.error!, /never checked/);
});

test('tcp answers or not; status lists; availability', async () => {
  assert.equal((await runSynthetic({ kind: 'tcp', target: '127.0.0.1', port: tcpPort, allowPrivate: true })).status, 'up');
  const closed = await runSynthetic({ kind: 'tcp', target: '127.0.0.1', port: 1, allowPrivate: true });
  assert.equal(closed.status, 'down');
  assert.match(closed.error!, /ECONNREFUSED/);
  const m = statusMatcher('200-204,418');
  assert.deepEqual([200, 204, 205, 418].map(m), [true, true, false, true]);
  assert.equal(availability([{ ok: true }, { ok: false }, { ok: true }, { ok: true }]), 0.75);
  assert.equal(availability([]), null);
});
