import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecContext, ResolvedTarget } from './types.ts';
import { condenseLog, repoAllowed, scmProbe, scmTool } from './scm.ts';

/** A fake GitHub and GitLab, answering the few calls the tool makes, and recording them. */
const seen: Array<{ url: string; auth: string | undefined }> = [];
let server: Server;
let base = '';
const LOG = ['2026-10-19T10:00:00.0000000Z Run npm ci', 'added 812 packages', ...Array(80).fill('compiling...'), 'Error: Cannot find module \'left-pad\'', 'npm ERR! code 1', 'Process completed with exit code 1.'].join('\n');
const routes: Record<string, unknown> = {
  '/repos/acme/shop': { full_name: 'acme/shop' },
  '/repos/acme/shop/actions/runs': { workflow_runs: [{ id: 7, name: 'deploy', head_branch: 'main', head_sha: 'abcdef123', conclusion: 'failure', created_at: '2026-10-19T09:58:00Z', event: 'push' }] },
  '/repos/acme/shop/actions/runs/7/jobs': { jobs: [{ id: 9, name: 'build', conclusion: 'failure', status: 'completed', steps: [{ name: 'npm ci', conclusion: 'failure' }] }, { id: 10, name: 'lint', conclusion: 'success', status: 'completed' }] },
  '/repos/acme/shop/pulls/42': { number: 42, title: 'Bump deps', state: 'closed', merged_at: '2026-10-19T09:50:00Z', user: { login: 'dev1' }, head: { sha: 'abcdef123', ref: 'deps' }, base: { ref: 'main' }, body: 'routine' },
  '/repos/acme/shop/pulls/42/files': [{ filename: 'package.json', status: 'modified', additions: 3, deletions: 1 }],
  '/repos/acme/shop/commits/abcdef123/check-runs': { check_runs: [{ name: 'build', conclusion: 'failure', status: 'completed' }] },
  '/api/v4/projects/platform%2Fapi/pipelines': [{ id: 31, ref: 'main', sha: '0123456789', status: 'failed', created_at: '2026-10-19T08:00:00Z', source: 'push' }],
  '/api/v4/projects/platform%2Fapi/pipelines/31/jobs': [{ id: 77, name: 'test', stage: 'test', status: 'failed', failure_reason: 'script_failure' }],
};
before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    seen.push({ url: req.url!, auth: (req.headers.authorization ?? req.headers['private-token']) as string | undefined });
    if (url.pathname === '/repos/acme/shop/actions/jobs/9/logs') return res.writeHead(200, { 'content-type': 'text/plain' }).end(LOG);
    if (url.pathname === '/api/v4/projects/platform%2Fapi/jobs/77/trace') return res.writeHead(200, { 'content-type': 'text/plain' }).end('$ pytest\nFAILED tests/test_api.py::test_health - AssertionError\n1 failed');
    if (url.pathname === '/repos/acme/shop/actions/jobs/99/logs') return res.writeHead(302, { location: 'https://evil.example.test/log' }).end();
    const body = routes[url.pathname.replace('%2F', '%2F')];
    if (!body) return res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const target = (kind: 'github' | 'gitlab', repos: string[]): ResolvedTarget => ({
  id: 't', slug: kind, kind, env: 'prod', sensitivity: 2, description: null,
  config: { kind, baseUrl: base, repos, allowPrivateNetwork: true },
  credentialId: 'c', protectedPaths: null, writablePaths: null, unitAllowlist: null,
  secret: JSON.stringify({ type: 'bearer', token: 'tkn' }),
} as unknown as ResolvedTarget);
const ctx = (t: ResolvedTarget): ExecContext => ({ runId: 'r', toolCallId: 'c', target: t, timeoutMs: 5_000, maxOutputBytes: 64_000, signal: AbortSignal.timeout(10_000) } as ExecContext);
const run = (t: ResolvedTarget, a: Record<string, unknown>) => scmTool.execute(scmTool.argsSchema.parse({ target: t.slug, ...a }) as never, ctx(t));

test('repositories outside the allowlist are refused before any request', async () => {
  assert.ok(repoAllowed({ repos: ['acme/*'] }, 'acme/shop'));
  assert.ok(!repoAllowed({ repos: ['acme/*'] }, 'other/shop'));
  assert.ok(!repoAllowed({ repos: [] }, 'acme/shop'), 'an empty list allows nothing');
  assert.ok(repoAllowed({ repos: ['platform/**'] }, 'platform/team/api'));
  const before = seen.length;
  const r = await run(target('github', ['acme/*']), { operation: 'runs', repo: 'other/shop' });
  assert.equal(r.ok, false);
  assert.match(r.text, /not one of the repositories/);
  assert.equal(seen.length, before, 'nothing was sent');
});

test('GitHub: failed runs, then the failed job with its log cut to the error and the tail', async () => {
  const t = target('github', ['acme/*']);
  const runs = await run(t, { operation: 'runs', repo: 'acme/shop', failed_only: true });
  assert.match(runs.text, /#7 deploy on main \(abcdef1\): failure/);
  assert.match(seen.at(-1)!.url, /status=failure/);
  assert.equal(seen.at(-1)!.auth, 'Bearer tkn');
  const one = await run(t, { operation: 'run', repo: 'acme/shop', id: 7 });
  assert.match(one.text, /job 9 build: failure \(failed step: npm ci\)/);
  assert.match(one.text, /Cannot find module 'left-pad'/);
  assert.doesNotMatch(one.text, /2026-10-19T10:00/, 'timestamps stripped');
  assert.ok(one.text.split('\n').length < 70, 'the 80 lines of noise are cut');
});

test('GitHub: a pull request with its checks and changed files', async () => {
  const r = await run(target('github', ['acme/shop']), { operation: 'pull', repo: 'acme/shop', id: '42' });
  assert.match(r.text, /#42 Bump deps \(closed, merged 2026-10-19 09:50\) by dev1: deps -> main/);
  assert.match(r.text, /build: failure/);
  assert.match(r.text, /modified package\.json \(\+3 -1\)/);
});

test('GitLab: pipelines and a failed job log, with the private-token header', async () => {
  const t = target('gitlab', ['platform/*']);
  const p = await run(t, { operation: 'runs', repo: 'platform/api' });
  assert.match(p.text, /#31 main \(0123456\): failed/);
  assert.equal(seen.at(-1)!.auth, 'tkn');
  const j = await run(t, { operation: 'run', repo: 'platform/api', id: 31 });
  assert.match(j.text, /job 77 test\/test: failed \(script_failure\)/);
  assert.match(j.text, /FAILED tests\/test_api\.py::test_health/);
});

test('a redirect to a host that is not a known log store is not followed', async () => {
  routes['/repos/acme/shop/actions/runs/8/jobs'] = { jobs: [{ id: 99, name: 'build', conclusion: 'failure', status: 'completed' }] };
  const r = await run(target('github', ['acme/*']), { operation: 'run', repo: 'acme/shop', id: 8 });
  assert.match(r.text, /could not read the log: redirected to evil\.example\.test, which SupOps does not follow/);
  assert.ok(!seen.some((s) => s.url.includes('evil')));
});

test('the connection test reads the first allowed repository', async () => {
  assert.deepEqual(await scmProbe(ctx(target('github', ['acme/shop', 'acme/*']))), { ok: true, detail: 'Connected; can read acme/shop.' });
  assert.equal((await scmProbe(ctx(target('github', ['acme/missing'])))).ok, false);
});

test('condensing keeps the errors with a line of context, and the tail', () => {
  const c = condenseLog(['a', 'b', 'boom: error here', 'c', ...Array(50).fill('x'), 'end'].join('\n'), 5);
  assert.match(c, /b\nboom: error here\nc/);
  assert.match(c, /x\nend$/);
});
