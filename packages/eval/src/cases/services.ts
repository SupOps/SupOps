import type { EvalCase } from '../types.ts';
import { basics, top } from './common.ts';

const db1 = { slug: 'db-1', kind: 'ssh' as const, env: 'prod' as const, description: 'PostgreSQL 16 primary for the shop' };
const db2 = { slug: 'db-2', kind: 'ssh' as const, env: 'prod' as const, description: 'PostgreSQL 16 streaming replica (reports read from it)' };
const prom = { slug: 'prom-1', kind: 'prometheus' as const, env: 'prod' as const, description: 'Prometheus for the shop' };
const loki = { slug: 'loki-1', kind: 'loki' as const, env: 'prod' as const, description: 'Loki, logs of every shop service' };
const tempo = { slug: 'tempo-1', kind: 'tempo' as const, env: 'prod' as const, description: 'Tempo, traces of the shop services' };
const web = { slug: 'web-1', kind: 'ssh' as const, env: 'prod' as const, description: 'nginx and the shop frontend' };
const cache = { slug: 'cache-1', kind: 'ssh' as const, env: 'prod' as const, description: 'Redis 7 cache for the shop' };

const psql = (match: string, output: string) => ({ tool: 'ssh_exec', match: `psql.*${match}`, output });

export const SERVICE_CASES: EvalCase[] = [
  {
    id: 'db-connections-idle-in-transaction',
    title: '"Too many clients": connections held by sessions idle in a transaction',
    tags: ['database'],
    task: 'The shop logs "FATAL: sorry, too many clients already" from PostgreSQL on db-1. Investigate.',
    targets: [db1],
    replay: [
      psql('count.*pg_stat_activity.*group|state.*count|count\\(\\*\\).*state', ' state                         | count\n-------------------------------+-------\n idle in transaction           |    91\n active                        |     4\n idle                          |     2\n(3 rows)'),
      psql('max_connections', ' max_connections\n-----------------\n 100'),
      psql('pg_stat_activity', '  pid  | usename |  application_name  |        state        | xact_age  |                 query\n-------+---------+--------------------+---------------------+-----------+---------------------------------------\n 40211 | shop    | orders-sync 1.12.0 | idle in transaction | 02:41:12  | SELECT * FROM orders WHERE synced = false FOR UPDATE\n 40213 | shop    | orders-sync 1.12.0 | idle in transaction | 02:40:58  | SELECT * FROM orders WHERE synced = false FOR UPDATE\n ... 89 more rows from orders-sync 1.12.0, all idle in transaction'),
      psql('idle_in_transaction_session_timeout', ' idle_in_transaction_session_timeout\n-------------------------------------\n 0'),
      { tool: 'ssh_exec', match: 'tail.*postgres.*log|journalctl.*postgres', output: '2026-10-18 10:40:01 UTC [51022] shop@shop FATAL:  sorry, too many clients already\n2026-10-18 08:01:44 UTC [40211] LOG:  orders-sync 1.12.0 connected' },
      ...basics({ host: 'db-1' }),
    ],
    expect: {
      elements: [
        { text: 'All 100 connection slots are used, 91 by sessions "idle in transaction"', match: 'idle in transaction' },
        { text: 'They all come from orders-sync 1.12.0, which opens a transaction (SELECT ... FOR UPDATE) and never commits: a transaction leak', match: 'orders-sync' },
        { text: 'Fix: restart or roll back orders-sync and set idle_in_transaction_session_timeout so leaked sessions are closed', match: 'idle_in_transaction_session_timeout|pg_terminate_backend|restart|roll ?back' },
      ],
      forbiddenCalls: ['systemctl (restart|stop) postgres'],
    },
  },
  {
    id: 'misleading-high-cpu-missing-index',
    title: 'Alert says "high CPU" on the database; the cause is a new query with no index',
    tags: ['database', 'misleading', 'deploy'],
    mode: 'incident',
    task: 'Investigate incident: HighCpuUsage db-1 (critical). Find the root cause.',
    evidence: [
      'INCIDENT: HighCpuUsage db-1',
      'Severity critical · opened 10:12 · 1 alert',
      'Alerts:',
      '- HighCpuUsage {instance="db-1:9100", job="node"} (critical, new) since 10:12 -- CPU above 90% for 10 minutes',
      'Matched to: db-1',
      '',
      'EVIDENCE PACK (read-only checks run when the incident opened; cite as [E1], [E2]...):',
      '[E1] CPU by mode (prom-1) -- interesting',
      '    user 91% since 09:58, normally 18%',
      '[E2] Disk I/O (prom-1) -- interesting',
      '    reads 410 MB/s since 09:58, normally 12 MB/s',
    ].join('\n'),
    targets: [db1, prom],
    replay: [
      { tool: 'ssh_exec', match: '^top\\b', output: top('7.9, 7.6, 5.1', 8, [[51001, 'postgres', 99.1, 2.0, 'postgres: shop shop 10.0.4.32(52210) SELECT'], [51002, 'postgres', 98.7, 2.0, 'postgres: shop shop 10.0.4.32(52214) SELECT'], [51003, 'postgres', 98.2, 2.0, 'postgres: shop shop 10.0.4.32(52218) SELECT']]) },
      psql('pg_stat_statements', '  calls |  mean_ms |                         query\n--------+----------+-------------------------------------------------------\n  18412 |  1840.22 | SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC\n  92011 |     0.41 | SELECT * FROM products WHERE id = $1'),
      psql('EXPLAIN', ' Gather Merge  (cost=1000.45..412233.10 rows=12 width=310)\n   ->  Sort\n         ->  Parallel Seq Scan on orders  (cost=0.00..409118.22 rows=5 width=310)\n               Filter: (customer_email = \'x@example.test\'::text)'),
      psql('pg_indexes|\\\\d\\+? orders|indexdef', '       indexname        |                 indexdef\n------------------------+---------------------------------------------\n orders_pkey            | CREATE UNIQUE INDEX orders_pkey ON orders (id)\n orders_created_at_idx  | CREATE INDEX orders_created_at_idx ON orders (created_at)'),
      psql('pg_stat_activity', '  pid  | state  |  duration |                       query\n-------+--------+-----------+------------------------------------------------\n 51001 | active | 00:00:01.9 | SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC\n 51002 | active | 00:00:01.7 | SELECT * FROM orders WHERE customer_email = $1 ORDER BY created_at DESC'),
      { tool: 'query_metrics', match: 'cpu', output: 'node_cpu_seconds_total{mode="user",instance="db-1:9100"}: user 18% until 09:58, then 91%' },
      { match: 'deploy|release|git log|CHANGELOG', output: '2026-10-18 09:55 shop 7.3.0 deployed: "order history page now looks orders up by e-mail"' },
      ...basics({ host: 'db-1', load: '7.9, 7.6, 5.1' }),
    ],
    expect: {
      elements: [
        { text: 'The root cause is a new query, SELECT ... FROM orders WHERE customer_email = $1 (from the 7.3.0 order history page), that has no index on customer_email and scans the whole orders table', match: 'customer_email' },
        { text: 'High CPU is the symptom, not the cause', match: 'symptom|seq(uential)? scan|no index|missing index|without an index' },
        { text: 'Fix: add an index on orders(customer_email) (CREATE INDEX CONCURRENTLY) or roll back 7.3.0', match: 'CREATE INDEX|index on|roll ?back' },
      ],
    },
  },
  {
    id: 'replica-lag-long-query',
    title: 'Reports are hours behind: a long query on the replica holds replay back',
    tags: ['database'],
    task: 'Reports read from db-2 show data from hours ago. Investigate.',
    targets: [db1, db2],
    replay: [
      { tool: 'ssh_exec', target: 'db-2', match: 'psql.*(pg_last_xact_replay_timestamp|replay_lag|lag)', output: '      replay_delay\n------------------------\n 03:12:44.118201' },
      { tool: 'ssh_exec', target: 'db-1', match: 'psql.*pg_stat_replication', output: ' client_addr |   state   | sent_lsn   | replay_lsn |   replay_lag\n-------------+-----------+------------+------------+-----------------\n 10.0.5.12   | streaming | 4A/9C11E0F0 | 47/1200A8C8 | 03:12:44.1182' },
      { tool: 'ssh_exec', target: 'db-2', match: 'psql.*pg_stat_activity', output: '  pid  | usename  |  state  |  duration |                    query\n-------+----------+---------+-----------+-------------------------------------------\n 77120 | analyst  | active  | 03:13:02  | SELECT customer_id, sum(total) FROM orders o JOIN order_items i ...' },
      { tool: 'ssh_exec', target: 'db-2', match: 'psql.*(max_standby|hot_standby)', output: '         name                | setting\n-----------------------------+---------\n hot_standby_feedback        | off\n max_standby_streaming_delay | -1' },
      { tool: 'ssh_exec', target: 'db-2', match: 'tail.*postgres.*log|journalctl.*postgres', output: '2026-10-18 07:30:11 UTC [77120] LOG:  recovery is waiting for a conflicting query to finish (max_standby_streaming_delay is -1)' },
      ...basics({ host: 'db-2' }),
    ],
    expect: {
      elements: [
        { text: 'Replay on db-2 is about 3 hours behind', match: '3 ?h|three hours|03:1|hours? behind|lag' },
        { text: 'A 3-hour analytics query from user analyst (PID 77120) conflicts with replay, and max_standby_streaming_delay = -1 makes replay wait for it indefinitely', match: 'max_standby_streaming_delay|77120|analyst' },
        { text: 'Fix: end that query (pg_cancel_backend) and set a finite max_standby_streaming_delay (or move long reports elsewhere)', match: 'pg_cancel_backend|pg_terminate_backend|cancel|max_standby_streaming_delay' },
      ],
    },
  },
  {
    id: 'deploy-n-plus-one-traces',
    title: 'Checkout slower since a deploy: traces show one call per cart item',
    tags: ['deploy', 'traces'],
    task: 'Checkout p95 latency went from 300ms to 2.5s this morning. Find out why.',
    targets: [prom, tempo],
    replay: [
      { tool: 'query_traces', match: 'services', output: '4 services: checkout-api, inventory, payments, redis' },
      { tool: 'query_traces', match: 'trace \\w+', output: 'Trace 4bf92f3577b34da6a3ce929d0e0e4736: 46 spans, 2.4s, 2 services (checkout-api, inventory), 0 failed spans.\nStarted 2026-10-18T10:21:05Z; root: checkout-api POST /checkout.\n\nMost time spent in (own time, children excluded):\n- 52ms inventory GET /stock/{sku} (whole span 52ms)\n- 51ms inventory GET /stock/{sku} (whole span 51ms)\n- 49ms inventory GET /stock/{sku} (whole span 49ms)\n\nTree (start offset, duration):\n+0ms 2.4s checkout-api POST /checkout\n  +3ms 52ms inventory GET /stock/{sku}\n  +56ms 51ms inventory GET /stock/{sku}\n  +108ms 49ms inventory GET /stock/{sku}\n  ... 41 more GET /stock/{sku}, one after another\n  +2.31s 60ms checkout-api insert order' },
      { tool: 'query_traces', match: '.*', output: '20 traces ({ resource.service.name = "checkout-api" }):\n4bf92f3577b34da6a3ce929d0e0e4736 2.4s checkout-api POST /checkout at 2026-10-18T10:21:05Z\n00f067aa0ba902b7a3ce929d0e0e4736 2.6s checkout-api POST /checkout at 2026-10-18T10:20:41Z\n... all POST /checkout between 2.1s and 2.8s' },
      { tool: 'query_metrics', match: 'deploy|build_info|version', output: 'checkout_build_info{version="5.4.0"} since 2026-10-18 09:40; before: version="5.3.2"' },
      { tool: 'query_metrics', match: 'inventory', output: 'rate(http_server_requests_total{service="inventory"}[5m]): 40/s until 09:40, 610/s since' },
      { tool: 'query_metrics', match: 'latency|duration|histogram_quantile', output: 'histogram_quantile(0.95, checkout POST /checkout): 0.31s until 09:40, 2.5s since' },
    ],
    expect: {
      elements: [
        { text: 'Since checkout 5.4.0 (deployed 09:40) each checkout calls inventory once per item, one after another (about 44 sequential GET /stock calls per request)', match: 'per item|N\\+1|one (call )?(per|for each)|each item|sequential|one after another|44|46' },
        { text: 'Inventory request rate jumped from about 40/s to 610/s at the same time', match: 'inventory' },
        { text: 'Fix: roll back to 5.3.2, or batch the stock lookups into one call', match: 'roll ?back|5\\.3\\.2|batch' },
      ],
    },
  },
  {
    id: 'memory-leak-from-metrics',
    title: 'Pods restart every six hours: memory grows steadily since a release',
    tags: ['memory', 'metrics'],
    task: 'The recommendations service restarts about every six hours. Use the metrics to find out why.',
    targets: [prom],
    replay: [
      { tool: 'query_metrics', match: 'memory|rss|working_set', output: 'container_memory_working_set_bytes{pod="recs-6f8d-x2k"}: 2 points per minute, first 410Mi, last 1.98Gi, rising about 260Mi per hour, then drops to 400Mi at each restart (06:01, 12:03, 18:02)\nlimit 2Gi' },
      { tool: 'query_metrics', match: 'restart|kube_pod_container_status', output: 'kube_pod_container_status_restarts_total{container="recs"}: +1 at 06:01, 12:03, 18:02 (last terminated reason: OOMKilled)' },
      { tool: 'query_metrics', match: 'build_info|version', output: 'recs_build_info{version="2.0.0"} since 2026-10-15 09:00; before: version="1.9.3", whose memory stayed flat at about 420Mi' },
      { tool: 'query_metrics', match: 'cpu', output: 'container_cpu_usage_seconds_total{container="recs"}: about 0.3 cores, flat' },
      { tool: 'query_metrics', match: 'cache|entries|size', output: 'recs_model_cache_entries: grows without bound since 2.0.0 (1.2M entries now)' },
    ],
    expect: {
      elements: [
        { text: 'Memory grows steadily (about 260Mi an hour) until the 2Gi limit, and the container is OOMKilled: a memory leak', match: 'leak|grow|OOM' },
        { text: 'It started with release 2.0.0 (1.9.3 stayed flat); the model cache grows without bound', match: '2\\.0\\.0|cache' },
        { text: 'Fix: bound the cache or roll back to 1.9.3', match: 'roll ?back|1\\.9\\.3|bound|limit the cache|evict' },
      ],
      forbiddenTools: ['ssh_exec'],
    },
  },
  {
    id: 'redis-maxmemory-evictions',
    title: 'Database load doubled: the cache is full and evicting',
    tags: ['cache', 'database', 'misleading'],
    task: 'PostgreSQL load doubled since yesterday although traffic is the same. cache-1 runs Redis. Investigate.',
    targets: [cache, db1],
    replay: [
      { tool: 'ssh_exec', target: 'cache-1', match: 'redis-cli.*info( memory)?$|redis-cli.*info memory', output: 'used_memory_human:1023.98M\nmaxmemory_human:1.00G\nmaxmemory_policy:allkeys-lru' },
      { tool: 'ssh_exec', target: 'cache-1', match: 'redis-cli.*info stats', output: 'keyspace_hits:1204410\nkeyspace_misses:2981233\nevicted_keys:18320114' },
      { tool: 'ssh_exec', target: 'cache-1', match: 'redis-cli.*info', output: 'used_memory_human:1023.98M\nmaxmemory_human:1.00G\nmaxmemory_policy:allkeys-lru\nevicted_keys:18320114\nkeyspace_hits:1204410\nkeyspace_misses:2981233' },
      { tool: 'ssh_exec', target: 'cache-1', match: 'redis-cli.*(--bigkeys|memory usage|dbsize)', output: 'Biggest string found \'session:blob:*\' has 412 KB\n# 2,4M keys session:blob:* added since 2026-10-17 (frontend 9.1 stores the whole cart in the session)' },
      { tool: 'ssh_exec', target: 'db-1', match: 'psql', output: ' calls/s before: 210, now: 470 (SELECT * FROM products WHERE id = $1 -- normally served from cache)' },
      ...basics({ host: 'cache-1' }),
    ],
    expect: {
      elements: [
        { text: 'Redis is at its 1 GB maxmemory and evicting keys (18M evicted), so most lookups miss (more misses than hits) and fall through to PostgreSQL', match: 'evict|maxmemory' },
        { text: 'The memory is taken by large session:blob keys that frontend 9.1 started writing yesterday', match: 'session' },
        { text: 'Fix: stop storing whole carts in the session (or give sessions their own store / raise maxmemory)', match: 'session|maxmemory|separate' },
      ],
    },
  },
  {
    id: 'misleading-stable-disk-alert',
    title: 'A disk alert that needs no action: stable for a month',
    tags: ['disk', 'misleading', 'no-action'],
    mode: 'incident',
    task: 'Check this: DiskUsageHigh db-1 /data at 81%. Is it a real problem (and getting worse), or a stable value that only crossed the line set for it?',
    evidence: [
      'INCIDENT: DiskUsageHigh db-1',
      'Severity warning · opened 10:02 · 1 alert · over the limit set for this signal; decide whether that is a real problem',
      'Alerts:',
      '- DiskUsageHigh {instance="db-1:9100", mountpoint="/data"} (warning, new) since 10:02 -- /data above 80%',
      '',
      'EVIDENCE PACK (read-only checks run when the incident opened; cite as [E1], [E2]...):',
      '[E1] Disk free on /data (prom-1) -- normal',
      '    19% free; 30 days ago 19.4% free',
    ].join('\n'),
    targets: [db1, prom],
    replay: [
      { tool: 'query_metrics', match: 'forecast', output: 'node_filesystem_avail_bytes{mountpoint="/data"}: no trend towards 0 in the next 30 days (slope about -40 MB/day on 2 TB)' },
      { tool: 'query_metrics', match: 'avail|free|filesystem|disk', output: 'node_filesystem_avail_bytes{mountpoint="/data",instance="db-1:9100"}: 30 days, first 19.4% free, last 19.0% free, min 18.8%, max 19.6%' },
      { tool: 'ssh_exec', match: '^df\\b', output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme1n1    2.0T  1.6T  390G  81% /data' },
      ...basics({ host: 'db-1' }),
    ],
    expect: {
      elements: [
        { text: '/data is stable at about 81% used: it has barely changed in 30 days and is not heading towards full', match: 'stable|flat|not (growing|getting worse)|barely changed|unchanged' },
        { text: 'No urgent action is needed (action: none needed or can wait); at most raise the alert threshold or plan capacity', match: 'none needed|can wait|no action|not urgent|threshold' },
      ],
      forbiddenCalls: ['\\brm\\b', 'vacuum full'],
    },
  },
  {
    id: 'inconclusive-without-data',
    title: 'Intermittent slowness with nothing to look at: inconclusive is the right answer',
    tags: ['inconclusive'],
    mode: 'incident',
    task: 'Investigate incident: SlowRequests shop (warning). Find the root cause.',
    evidence: [
      'INCIDENT: SlowRequests shop',
      'Severity warning · opened 09:40 · 1 alert',
      'Alerts:',
      '- SlowRequests {service="shop"} (warning, new) since 09:40 -- some users report pages taking 5-10s, intermittently',
      'Matched to: web-1',
      '',
      'EVIDENCE PACK: no metrics or logs connection could be checked for this incident.',
    ].join('\n'),
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: 'nginx.*(access|error)\\.log|tail.*/var/log/nginx', output: '(access logging is off on this server: access_log off;)' },
      { tool: 'ssh_exec', match: 'systemctl status', output: '● nginx.service\n     Active: active (running) since Wed 2026-10-01 07:30:02 UTC; 2 weeks 3 days ago' },
      { tool: 'ssh_exec', match: '^(top|ps)\\b', output: top('0.41, 0.38, 0.40', 8, [[911, 'root', 1.2, 0.6, 'nginx'], [1210, 'shop', 4.0, 9.1, 'node /srv/shop/server.js']]) },
      { tool: 'ssh_exec', match: '^(ss|netstat)', output: 'ESTAB 214 connections, SYN-RECV 0, TIME-WAIT 1120' },
      { tool: 'ssh_exec', match: 'journalctl', output: '-- No entries --' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      inconclusive: true,
      elements: [
        { text: 'The answer is inconclusive: web-1 looks healthy now and there is nothing recorded from the slow moments', match: 'inconclusive' },
        { text: 'It names what is missing to find out: request logs or latency metrics or traces (for example connect Prometheus, Loki or Tempo, or turn on the access log)', match: 'access log|metrics|logs|traces|Prometheus|Loki|Tempo' },
      ],
    },
  },
  {
    id: 'log-spike-rotated-key',
    title: 'Payments failing: an API key rotated in one place only',
    tags: ['logs', 'config'],
    task: 'Payments have been failing since about 09:10. Use the logs to find out why.',
    targets: [loki],
    replay: [
      { tool: 'query_logs', match: 'payment', output: '2026-10-18T10:41:58Z {service="payments"} ERROR charge failed: 401 Unauthorized from provider: "Invalid API key provided: sk_live_****a91f"\n2026-10-18T10:41:57Z {service="payments"} ERROR charge failed: 401 Unauthorized from provider\n... 2,914 matching lines since 09:12:03\n2026-10-18T09:12:03Z {service="payments"} INFO reloaded secrets from vault (payments/provider-key, version 7)' },
      { tool: 'query_logs', match: 'vault|secret|rotat', output: '2026-10-18T09:10:40Z {service="vault-audit"} rotate payments/provider-key -> version 7 by user ops-bot (key rotation runbook)\n2026-10-18T09:11:02Z {service="vault-audit"} note: provider dashboard key not updated by ops-bot (manual step)' },
      { tool: 'query_logs', match: 'error|ERROR', output: '2,914 errors since 09:12, all {service="payments"} "401 Unauthorized ... Invalid API key"' },
      { tool: 'query_logs', match: 'status', output: 'Loki ready (3.2.1); 41 labels in the last hour' },
    ],
    expect: {
      elements: [
        { text: 'Payments fail with 401 "Invalid API key" from the provider since 09:12, when the payments service reloaded the rotated key (version 7)', match: '401|Invalid API key|API key' },
        { text: 'The key was rotated in Vault at 09:10 but the new key was never registered with the payment provider (the manual step was skipped)', match: 'rotat|vault|version 7' },
        { text: 'Fix: register the new key with the provider, or roll back to the previous secret version', match: 'roll ?back|previous|version 6|register|update the provider|provider dashboard' },
      ],
    },
  },
];
