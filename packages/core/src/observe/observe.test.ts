import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResolvedTarget } from '../tools/types.ts';
import { chooseIncident, groupKeyOf, worstSeverity, type OpenIncidentRef } from './correlate.ts';
import { fromAlertmanager, fromPrometheus, fetchConnectionAlerts } from './sources.ts';
import { checkCitations, parseAction, parseVerdict } from './citations.ts';
import { clusterLogLines, logTemplate } from './logs.ts';
import { promString, runChecks, scopeFromLabels, scopeMatchers } from './checks.ts';
import { formatValue, parseSeriesKey, seriesKey, seriesName } from './signals.ts';
import { queryMetricsTool, queryLogsTool, alertsTool } from '../tools/observability.ts';

const NOW = Date.UTC(2026, 5, 1, 12);
const inc = (id: string, labels: Record<string, string>, targetIds: string[] = [], ago = 60_000): OpenIncidentRef => ({
  id, title: labels.alertname ?? id, groupKey: groupKeyOf({ title: labels.alertname ?? id, labels }), targetIds, lastSeenAt: NOW - ago,
});

// ---- grouping ------------------------------------------------------------------

test('alerts about the same machine join one incident', () => {
  const open = [inc('i1', { alertname: 'HighCPU', instance: 'web-1:9100' })];
  const r = chooseIncident({ title: 'DiskFull', labels: { alertname: 'DiskFull', instance: 'web-1:9100' }, targetIds: [], at: NOW }, open);
  assert.equal(r?.incidentId, 'i1');
  assert.match(r!.reason, /web-1/);
});

test('the same alert on several machines joins one incident', () => {
  const open = [inc('i1', { alertname: 'HighCPU', instance: 'web-1' })];
  const r = chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-2' }, targetIds: [], at: NOW }, open);
  assert.equal(r?.incidentId, 'i1');
  assert.match(r!.reason, /several machines/);
});

test('same service, matched target, or namespace group; unrelated alerts do not', () => {
  const open = [
    inc('svc', { alertname: 'Latency', service: 'checkout', namespace: 'shop' }),
    inc('tgt', { alertname: 'Ping' }, ['t-9']),
    inc('ns', { alertname: 'X', namespace: 'billing' }),
  ];
  assert.equal(chooseIncident({ title: 'Errors', labels: { alertname: 'Errors', service: 'checkout', namespace: 'shop' }, targetIds: [], at: NOW }, open)?.incidentId, 'svc');
  assert.equal(chooseIncident({ title: 'Mem', labels: { alertname: 'Mem' }, targetIds: ['t-9'], at: NOW }, open)?.incidentId, 'tgt');
  assert.equal(chooseIncident({ title: 'Y', labels: { alertname: 'Y', namespace: 'billing' }, targetIds: [], at: NOW }, open)?.incidentId, 'ns');
  assert.equal(chooseIncident({ title: 'Z', labels: { alertname: 'Z', instance: 'db-7' }, targetIds: [], at: NOW }, open), null);
});

test('old incidents and other clusters are not joined', () => {
  const stale = [inc('old', { alertname: 'HighCPU', instance: 'web-1' }, [], 60 * 60_000)];
  assert.equal(chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-1' }, targetIds: [], at: NOW }, stale), null);
  const other = [inc('c1', { alertname: 'HighCPU', instance: 'web-1', cluster: 'eu' })];
  assert.equal(chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-1', cluster: 'us' }, targetIds: [], at: NOW }, other), null);
});

test('an incident takes its worst severity', () => {
  assert.equal(worstSeverity('warning', 'critical'), 'critical');
  assert.equal(worstSeverity('critical', 'info'), 'critical');
});

// ---- sources -------------------------------------------------------------------

test('Alertmanager alerts keep their fingerprint, labels and summary; silenced ones are skipped', () => {
  const list = fromAlertmanager([
    { fingerprint: 'abc', labels: { alertname: 'DiskFull', instance: 'db-1', severity: 'critical' }, annotations: { summary: 'Disk 95% full' }, startsAt: '2026-06-01T11:00:00Z', status: { state: 'active' } },
    { fingerprint: 'def', labels: { alertname: 'Muted' }, status: { state: 'suppressed' } },
  ]);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0]!.fingerprint, list[0]!.title, list[0]!.severity, list[0]!.summary], ['abc', 'DiskFull', 'critical', 'Disk 95% full']);
  assert.equal(list[0]!.startsAt, Date.parse('2026-06-01T11:00:00Z'));
});

test('Prometheus alerts: firing only, with a stable fingerprint from labels', () => {
  const json = { data: { alerts: [
    { labels: { alertname: 'A', instance: 'x' }, state: 'firing', activeAt: '2026-06-01T11:00:00Z' },
    { labels: { alertname: 'B' }, state: 'pending' },
  ] } };
  const a = fromPrometheus(json);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.fingerprint, fromPrometheus(json)[0]!.fingerprint);
  assert.equal(a[0]!.severity, 'unknown');
});

// ---- citations -----------------------------------------------------------------

test('citations to evidence that does not exist are caught', () => {
  const r = checkCitations('Disk is full [E1], caused by logs [E2] and [E7]. Again [E1].', ['E1', 'E2', 'E3']);
  assert.deepEqual(r.cited, ['E1', 'E2', 'E7']);
  assert.deepEqual(r.unknown, ['E7']);
});

test('the verdict is read from the report', () => {
  assert.deepEqual(parseVerdict('## Summary\n**Root cause:** the log volume filled /var [E2]\n**Confidence:** high'), {
    rootCause: 'the log volume filled /var [E2]', confidence: 'high',
  });
  assert.deepEqual(parseVerdict('- Root cause: Inconclusive -- no metrics for the host'), { rootCause: 'Inconclusive -- no metrics for the host', confidence: 'inconclusive' });
  assert.deepEqual(parseVerdict('nothing here'), { rootCause: null, confidence: null });
});

// ---- logs ------------------------------------------------------------------------

test('log lines group by template', () => {
  assert.equal(logTemplate('2026-06-01T11:00:00Z request 8f1c2d3e-1111-2222-3333-444455556666 from 10.1.2.3:443 took 120ms'), '<time> request <id> from <ip> took <n>');
  const g = clusterLogLines(['error: timeout after 30s id=1', 'error: timeout after 31s id=2', 'panic: nil map', '']);
  assert.equal(g[0]!.count, 2);
  assert.equal(g.length, 2);
});

// ---- checks against a fake Prometheus --------------------------------------------

async function fakeProm(answer: (q: string, path: string) => unknown) {
  const queries: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const q = url.searchParams.get('query') ?? '';
    queries.push(q);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(q, url.pathname)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, queries, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const conn = (kind: string, baseUrl: string) =>
  ({ id: `c-${kind}`, slug: `${kind}-main`, kind, env: 'prod', config: { kind, baseUrl, allowPrivateNetwork: true } }) as unknown as ResolvedTarget;
const vec = (rows: Array<[Record<string, string>, number]>) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) } });

test('scope matchers escape label values', () => {
  assert.equal(promString('a"b\\c'), 'a\\"b\\\\c');
  assert.deepEqual(scopeMatchers({ host: 'web.1', namespace: 'shop' }), ['instance=~"web\\\\.1(:[0-9]+)?"', 'namespace="shop"']);
  assert.deepEqual(scopeFromLabels([{ instance: 'Web-1:9100', namespace: 'shop' }], ['HighCPU']), { host: 'web-1', namespace: 'shop', alertnames: ['HighCPU'] });
});

test('the evidence pack finds what is wrong and marks what is not measured', async () => {
  const be = await fakeProm((q) => {
    if (q.startsWith('count by (alertname')) return vec([[{ alertname: 'DiskFull', severity: 'critical' }, 1], [{ alertname: 'HighCPU' }, 1]]);
    if (q.includes('node_filesystem_avail_bytes') && q.startsWith('max by (instance, mountpoint)')) return vec([[{ instance: 'web-1:9100', mountpoint: '/var' }, 97.5]]);
    if (q.startsWith('count(node_')) return vec([[{}, 3]]);
    if (q.startsWith('count(up)')) return vec([[{}, 3]]);
    return vec([]);
  });
  try {
    const items = await runChecks([conn('prometheus', be.base)], { host: 'web-1', alertnames: ['DiskFull'] });
    const by = Object.fromEntries(items.map((i) => [i.check, i]));
    assert.equal(by.disk!.status, 'interesting');
    assert.match(by.disk!.summary, /web-1:9100 \/var: 97\.5%/);
    assert.equal(by.related_alerts!.status, 'interesting');
    assert.match(by.related_alerts!.summary, /HighCPU/);
    assert.doesNotMatch(by.related_alerts!.summary, /DiskFull/);
    assert.equal(by.targets_down!.status, 'normal');
    assert.equal(by.oom_kills!.status, 'unavailable', 'kube-state-metrics is not there');
    assert.equal(items[0]!.status, 'interesting', 'interesting results first');
    assert.ok(be.queries.some((q) => q.includes('instance=~"web-1(:[0-9]+)?"')), 'scoped to the host');
  } finally {
    await be.close();
  }
});

test('the stack checks look at the monitoring itself', async () => {
  const be = await fakeProm((q) => {
    if (q.includes('prometheus_rule_evaluation_failures_total[1h]')) return vec([[{ rule_group: 'node.rules' }, 4]]);
    if (q.startsWith('up') || q.startsWith('up{')) return vec([[{ job: 'node', instance: 'db-1:9100' }, 0]]);
    return vec([]);
  });
  try {
    const items = await runChecks([conn('prometheus', be.base)], {}, { stack: true });
    const by = Object.fromEntries(items.map((i) => [i.check, i]));
    assert.equal(by.rule_failures!.status, 'interesting');
    assert.equal(by.targets_down!.status, 'interesting');
    assert.match(by.targets_down!.summary, /db-1:9100/);
    assert.equal(by.disk, undefined, 'incident checks are not part of a stack check');
  } finally {
    await be.close();
  }
});

// ---- series helpers --------------------------------------------------------------

test('series keys round-trip and values read naturally', () => {
  const k = seriesKey({ __name__: 'x', mountpoint: '/', instance: 'web-1' });
  assert.equal(k, '{instance="web-1",mountpoint="/"}');
  assert.deepEqual(parseSeriesKey(k), { instance: 'web-1', mountpoint: '/' });
  assert.equal(formatValue(12_345_678_901, 'bytes'), '12.3 GB');
  assert.equal(formatValue(87.25, 'percent'), '87.3%');
  assert.equal(formatValue(0.25, 'seconds'), '250 ms');
});

// ---- tool operations ---------------------------------------------------------------

const ctx = (t: ResolvedTarget) => ({ runId: 'r', toolCallId: 'c', target: t, timeoutMs: 5000, maxOutputBytes: 16_384, signal: new AbortController().signal }) as never;

test('query_metrics forecast says when a disk runs out', async () => {
  const now = Math.floor(Date.now() / 1000);
  const be = await fakeProm(() => ({
    status: 'success',
    data: { resultType: 'matrix', result: [{ metric: { instance: 'web-1', mountpoint: '/' }, values: Array.from({ length: 145 }, (_, i) => [now - (144 - i) * 300, String(50e9 - i * 300 * (1e9 / 3600))]) }] },
  }));
  try {
    const out = await queryMetricsTool.execute({ target: 'p', operation: 'forecast', query: 'node_filesystem_avail_bytes', limit_value: 0, limit_when: 'below' }, ctx(conn('prometheus', be.base)));
    assert.equal(out.ok, true, out.text);
    assert.match(out.text, /reaches 0 in about 3[78]h/);
    // Half a day of perfectly steady fill: worth acting on, but high needs days of history.
    assert.match(out.text, /confidence medium/);
    assert.match(out.text, /Model: steady trend/);
  } finally {
    await be.close();
  }
});

test('query_metrics status and alerts status describe the stack', async () => {
  const be = await fakeProm((_q, path) => {
    if (path === '/api/v1/status/buildinfo') return { data: { version: '3.1.0' } };
    if (path === '/api/v1/status/runtimeinfo') return { data: { reloadConfigSuccess: false, startTime: 'x' } };
    if (path === '/api/v1/status/tsdb') return { data: { headStats: { numSeries: 1234 }, seriesCountByMetricName: [{ name: 'http_requests_total', value: 900 }] } };
    if (path === '/api/v1/targets') return { data: { activeTargets: [{ labels: { job: 'node' }, health: 'down', lastError: 'connection refused' }, { labels: { job: 'api' }, health: 'up' }] } };
    if (path === '/api/v2/status') return { versionInfo: { version: '0.27.0' }, uptime: 'u', cluster: { status: 'ready', peers: [{ name: 'a' }] }, config: { original: 'receivers:\n- name: team-pager\n- name: "slack"\n' } };
    return {};
  });
  try {
    const p = await queryMetricsTool.execute({ target: 'p', operation: 'status' }, ctx(conn('prometheus', be.base)));
    assert.match(p.text, /Version: 3\.1\.0/);
    assert.match(p.text, /Config reload: FAILED/);
    assert.match(p.text, /Active series: 1234/);
    assert.match(p.text, /2, 1 not up/);
    assert.match(p.text, /connection refused/);
    const a = await alertsTool.execute({ target: 'a', operation: 'status' }, ctx(conn('alertmanager', be.base)));
    assert.match(a.text, /0\.27\.0/);
    assert.match(a.text, /team-pager, slack/);
    const l = await queryLogsTool.execute({ target: 'l' } as never, ctx(conn('loki', be.base)));
    assert.equal(l.ok, false, 'search still needs a query');
  } finally {
    await be.close();
  }
});

test('alerts are read from Prometheus connections', async () => {
  const be = await fakeProm(() => ({ data: { alerts: [{ labels: { alertname: 'A' }, state: 'firing' }] } }));
  try {
    const r = await fetchConnectionAlerts(conn('prometheus', be.base));
    assert.ok('alerts' in r && r.alerts.length === 1);
  } finally {
    await be.close();
  }
});

test('series are named the way people know the machine', () => {
  // A per-VM scrape job beats a cloud DNS instance name.
  assert.equal(seriesName({ instance: 'ip-10-0-4-20.ec2.internal:9100', job: 'billing-api-node-metrics', mountpoint: '/' }), 'billing-api /');
  // An explicit name label beats the job.
  assert.equal(seriesName({ instance: '10.0.4.20:9100', job: 'node', vm_name: 'web-1' }), 'web-1');
  // A generic job says nothing about the machine: fall back to the instance.
  assert.equal(seriesName({ instance: 'web-1:9100', job: 'node-exporter', mountpoint: '/var' }), 'web-1:9100 /var');
  // The namespace only when nothing more specific separates the series.
  assert.equal(seriesName({ namespace: 'shop', persistentvolumeclaim: 'data-0' }), 'data-0');
  assert.equal(seriesName({ job: 'node' }), 'job node');
});

test('the plain verdict is read from the report', () => {
  assert.equal(parseAction('**Action:** act now\n**Root cause:** x'), 'act_now');
  assert.equal(parseAction('- Action: can wait (schedule it)'), 'can_wait');
  assert.equal(parseAction('**Action:** none needed'), 'none');
  assert.equal(parseAction('no verdict here'), null);
});

test('the hypotheses table is read into confirmed, ruled out and untested', async () => {
  const { parseHypotheses } = await import('./citations.ts');
  const report = [
    '**Root cause:** the nightly export filled /var',
    '### Evidence',
    '| Hypothesis | Verdict | Evidence |',
    '|---|---|---|',
    '| **Log growth** | Supported | du shows /var/log/export at 41G [E2] |',
    '| Disk failure | Refuted | smartctl reports no errors |',
    '| Memory leak | untested | |',
    '| Something odd | ¯\\_(ツ)_/¯ | |',
    '',
    'After the table.',
  ].join('\n');
  assert.deepEqual(parseHypotheses(report), [
    { hypothesis: 'Log growth', verdict: 'confirmed', evidence: 'du shows /var/log/export at 41G [E2]' },
    { hypothesis: 'Disk failure', verdict: 'ruled_out', evidence: 'smartctl reports no errors' },
    { hypothesis: 'Memory leak', verdict: 'untested', evidence: '' },
    { hypothesis: 'Something odd', verdict: 'untested', evidence: '' },
  ]);
  assert.deepEqual(parseHypotheses('| Host | Disk |\n|---|---|\n| web-1 | 97% |'), [], 'a table without a hypothesis column is not one');
});

test('the blast radius section is read; an absent one is null', async () => {
  const { parseBlastRadius } = await import('./citations.ts');
  const report = '### Impact\nCheckout slow.\n### Blast radius\n- **Affected:** checkout-api on web-1 and web-2\n- **Checked healthy:** payments-api, the database\n- **Not checked:** the CDN\n### Suggested actions\n...';
  assert.deepEqual(parseBlastRadius(report), { affected: 'checkout-api on web-1 and web-2', healthy: 'payments-api, the database', unchecked: 'the CDN' });
  assert.deepEqual(parseBlastRadius('### Blast radius\nAffected: web-1'), { affected: 'web-1', healthy: null, unchecked: null }, 'at the end of the text');
  assert.equal(parseBlastRadius('no such section'), null);
});

test('a root cause that only restates the alert is a symptom; one naming a mechanism is not', async () => {
  const { restatesSymptom } = await import('./citations.ts');
  assert.equal(restatesSymptom('High CPU usage on web-1', ['HighCpuUsage web-1']), true);
  assert.equal(restatesSymptom('The disk on web-1 is full [E1]', ['Disk full on web-1']), true);
  assert.equal(restatesSymptom('High CPU on web-1 because the image resize job runs without a limit', ['HighCpuUsage web-1']), false);
  assert.equal(restatesSymptom('The nightly export writes 40 GB of logs into /var', ['Disk full on web-1']), false);
  assert.equal(restatesSymptom('Inconclusive -- no metrics for web-1', ['Disk full on web-1']), false);
});

test('Drain: lines that differ only in their variable words share one pattern', async () => {
  const { drainPatterns } = await import('./logs.ts');
  const p = drainPatterns([
    'user alice logged in from web',
    'user bob logged in from web',
    'user carol logged in from mobile',
    'payment declined for order 4411: card expired',
    'payment declined for order 4412: card expired',
    'cache warm',
  ]);
  assert.deepEqual(p.map((x) => [x.template, x.count]), [
    ['user <*> logged in from <*>', 3],
    ['payment declined for order <n>: card expired', 2],
    ['cache warm', 1],
  ]);
});

test('Drain with times: a pattern only in the latest bucket is new, one far above its average is spiking', async () => {
  const { drainPatterns, patternLine } = await import('./logs.ts');
  const t0 = Date.UTC(2026, 9, 18, 10, 0);
  const at = (b: number, n: number, line: string) => Array.from({ length: n }, (_, i) => ({ line: line.replace('#', String(i)), ts: t0 + b * 60_000 + i }));
  const p = drainPatterns(
    [
      ...[0, 1, 2, 3, 4].flatMap((b) => at(b, 2, 'GET /health 200 in #ms')),
      ...at(0, 1, 'upstream timeout after #s'),
      ...at(4, 12, 'upstream timeout after #s'),
      ...at(4, 3, 'connection refused to db-1:5432 attempt #'),
    ],
    { buckets: 5, start: t0, end: t0 + 5 * 60_000 },
  );
  const by = new Map(p.map((x) => [x.template, x]));
  assert.equal(by.get('connection refused to db-<n>:<n> attempt <n>')!.isNew, true);
  assert.equal(by.get('upstream timeout after <n>')!.spiking, true);
  assert.deepEqual(by.get('upstream timeout after <n>')!.buckets, [1, 0, 0, 0, 12]);
  assert.ok(!by.get('GET /health <n> in <n>')!.spiking && !by.get('GET /health <n> in <n>')!.isNew);
  assert.match(patternLine(p[0]!), /\[(NEW|SPIKING)\]/, 'what changed comes first');
});

test('database evidence: connection slots, a stuck transaction and evictions are named', async () => {
  const be = await fakeProm((q) => {
    if (q.includes('pg_stat_activity_count')) return vec([[{ instance: 'db-1:9187' }, 94]]);
    if (q.includes('pg_stat_activity_max_tx_duration')) return vec([[{ instance: 'db-1:9187' }, 5400]]);
    if (q.includes('redis_evicted_keys_total')) return vec([[{ instance: 'db-1:9121' }, 250]]);
    if (q.startsWith('count(pg_') || q.startsWith('count(redis_')) return vec([[{}, 1]]);
    return vec([]);
  });
  try {
    const items = await runChecks([conn('prometheus', be.base)], { host: 'db-1' });
    const by = Object.fromEntries(items.map((i) => [i.check, i]));
    assert.equal(by.pg_connections!.status, 'interesting');
    assert.match(by.pg_connections!.summary, /80% of its connection slots[\s\S]*db-1:9187: 94/);
    assert.match(by.pg_oldest_tx!.summary, /open for over 5 minutes/);
    assert.equal(by.redis_evictions!.status, 'interesting');
    assert.equal(by.mysql_connections, undefined, 'no mysqld exporter: left out, not listed as missing');
  } finally {
    await be.close();
  }
});

test('database signals are discovered from the exporters present', async () => {
  const { SIGNALS } = await import('./signals.ts');
  const db = SIGNALS.filter((s) => s.group === 'databases').map((s) => s.key);
  assert.deepEqual(db, ['pg_connections', 'pg_replication_lag', 'pg_cache_hit', 'pg_deadlocks', 'pg_oldest_tx', 'mysql_connections', 'mysql_replica_lag', 'mysql_slow_queries', 'redis_memory', 'redis_evictions', 'redis_hit_rate']);
  assert.equal(new Set(SIGNALS.map((s) => s.key)).size, SIGNALS.length, 'keys are unique');
});

test('topology: connected services group only when they start within 5 minutes; an incident closes to new alerts after 90', () => {
  const t0 = Date.UTC(2026, 9, 18, 10);
  const inc = { id: 'i1', title: 'x', groupKey: { alertname: 'DbSlow', service: 'orders-db' }, targetIds: [], lastSeenAt: t0, openedAt: t0 };
  const rel = (a: string, b: string) => (a === 'checkout' && b === 'orders-db' ? 'checkout depends on orders-db (service map)' : null);
  const alert = (min: number) => ({ title: 'CheckoutErrors', labels: { alertname: 'CheckoutErrors', service: 'checkout' }, targetIds: [], at: t0 + min * 60_000 });
  assert.equal(chooseIncident(alert(3), [inc], 15 * 60_000, undefined, rel)!.reason, 'checkout depends on orders-db (service map), within 5 minutes');
  assert.equal(chooseIncident(alert(8), [inc], 15 * 60_000, undefined, rel), null, 'too far apart for a map link');
  const old = { ...inc, groupKey: { alertname: 'CheckoutErrors', service: 'checkout' }, lastSeenAt: t0 + 95 * 60_000 };
  assert.equal(chooseIncident(alert(96), [old], 15 * 60_000), null, 'the incident opened over 90 minutes ago');
  assert.ok(chooseIncident(alert(96), [{ ...old, openedAt: t0 + 30 * 60_000 }], 15 * 60_000));
});

test('likeliest origin: the failing component none of whose dependencies is failing', async () => {
  const { likelyOrigins } = await import('../servicemap/model.ts');
  const links = [
    { id: 'l1', fromId: 'checkout', toId: 'payments', kind: 'depends_on' as const },
    { id: 'l2', fromId: 'payments', toId: 'db-1', kind: 'depends_on' as const },
    { id: 'l3', fromId: 'search', toId: 'db-2', kind: 'depends_on' as const },
  ];
  const r = likelyOrigins(['checkout', 'payments', 'db-1', 'search'], links as never);
  assert.deepEqual(r.origins.sort(), ['db-1', 'search']);
  assert.deepEqual(r.effects.map((e) => [e.id, e.dependsOn]).sort(), [['checkout', 'payments'], ['payments', 'db-1']]);
});

test('node pressure signals exist, with danger levels on memory', async () => {
  const { SIGNALS } = await import('./signals.ts');
  const by = Object.fromEntries(SIGNALS.map((s) => [s.key, s]));
  for (const k of ['psi_memory', 'psi_io', 'psi_cpu', 'oom_kills', 'tcp_retransmits']) assert.ok(by[k], k);
  assert.deepEqual([by.memory!.warn, by.memory!.crit], [80, 95]);
});
