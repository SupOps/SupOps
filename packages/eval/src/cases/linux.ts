import type { EvalCase } from '../types.ts';
import { basics, top } from './common.ts';

const web = { slug: 'web-1', kind: 'ssh' as const, env: 'prod' as const, description: 'nginx and the shop frontend' };
const api = { slug: 'api-1', kind: 'ssh' as const, env: 'prod' as const, description: 'the orders API (Java, systemd unit orders-api)' };

export const LINUX_CASES: EvalCase[] = [
  {
    id: 'disk-full-journal',
    title: 'Root filesystem full: an uncapped systemd journal',
    tags: ['linux', 'disk'],
    task: 'web-1 is almost out of disk space. Find out what is using it.',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: '^df\\b(?!.*-i)', output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   40G   37G  2.1G  95% /\ntmpfs           3.9G     0  3.9G   0% /dev/shm' },
      { tool: 'ssh_exec', match: '^du\\b.*(/var/log|/var)\\b', output: '412M\t/var/log/nginx\n18G\t/var/log/journal\n38M\t/var/log/apt\n19G\t/var/log' },
      { tool: 'ssh_exec', match: '^du\\b', output: '19G\t/var\n2.1G\t/usr\n1.4G\t/home\n640M\t/opt\n23G\t/' },
      { tool: 'ssh_exec', match: 'journalctl.*--disk-usage', output: 'Archived and active journals take up 17.9G in the file system.' },
      { match: 'journald\\.conf', output: '[Journal]\n#Storage=auto\n#Compress=yes\n#SystemMaxUse=\n#SystemKeepFree=\n#MaxRetentionSec=' },
      { tool: 'ssh_exec', match: '^(ls|find)\\b.*journal', output: '-rw-r----- 1 root systemd-journal 128M Oct 18 10:01 system@00062e.journal\n... 141 files, 17.9G total' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'The systemd journal (/var/log/journal, about 18G) is what filled the disk', match: 'journal' },
        { text: 'The journal has no size cap (SystemMaxUse is not set), so it grows without limit', match: 'SystemMaxUse|no (size )?(cap|limit)|uncapped|unbounded' },
        { text: 'The fix trims the journal (journalctl --vacuum-size or --vacuum-time) and sets a cap', match: 'vacuum|SystemMaxUse' },
      ],
      mustCall: ['^df\\b'],
      forbiddenCalls: ['rm\\s+-rf?\\s+/var/log'],
    },
  },
  {
    id: 'disk-full-deleted-open-file',
    title: 'Disk full but du finds nothing: a deleted log still held open',
    tags: ['linux', 'disk'],
    task: 'api-1 says the disk is full but we cannot find what is using the space. Investigate.',
    targets: [api],
    replay: [
      { tool: 'ssh_exec', match: '^df\\b(?!.*-i)', output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   80G   79G  1.0G  99% /' },
      { tool: 'ssh_exec', match: '^df\\b.*-i', output: 'Filesystem      Inodes  IUsed   IFree IUse% Mounted on\n/dev/nvme0n1p1 5242880 312044 4930836    6% /' },
      { tool: 'ssh_exec', match: '^du\\b', output: '6.1G\t/var\n2.3G\t/usr\n1.1G\t/opt\n410M\t/home\n10G\t/' },
      {
        tool: 'ssh_exec',
        match: 'lsof.*(\\+L1|deleted|-a)|lsof\\b.*\\|?\\s*grep.*deleted|find /proc/.*/fd',
        output: 'COMMAND    PID   USER   FD   TYPE DEVICE    SIZE/OFF NLINK    NODE NAME\njava     21877 orders   41w   REG  259,1 70264655872     0 1048631 /var/log/orders/orders-api.log (deleted)',
      },
      { tool: 'ssh_exec', match: '^lsof\\b', output: 'java     21877 orders   41w   REG  259,1 70264655872     0 1048631 /var/log/orders/orders-api.log (deleted)\nnginx      911   root    4w   REG  259,1     2210334     1 1048120 /var/log/nginx/access.log' },
      { tool: 'ssh_exec', match: 'logrotate|/etc/logrotate\\.d', output: '/var/log/orders/*.log {\n    daily\n    rotate 7\n    missingok\n    compress\n    # no copytruncate and no postrotate: the app keeps writing to the old file\n}' },
      { match: '/etc/logrotate\\.d/orders', output: '/var/log/orders/*.log {\n    daily\n    rotate 7\n    missingok\n    compress\n}' },
      { tool: 'ssh_exec', match: 'systemctl status orders-api', output: '● orders-api.service - Orders API\n     Active: active (running) since Thu 2026-10-02 06:12:44 UTC; 2 weeks 2 days ago\n   Main PID: 21877 (java)' },
      ...basics({ host: 'api-1' }),
    ],
    expect: {
      elements: [
        { text: 'The space is held by a deleted file still open by the orders-api java process (PID 21877), about 65-70G', match: 'deleted' },
        { text: 'Log rotation removed the file while the process kept writing to it (no copytruncate or reopen signal)', match: 'logrotate|rotat' },
        { text: 'Restarting orders-api (or truncating the open descriptor via /proc) frees the space; fix the rotation with copytruncate or a postrotate reopen', match: 'restart|truncate|copytruncate|/proc/21877' },
      ],
      forbiddenCalls: ['rm\\s+-rf'],
    },
  },
  {
    id: 'oom-kill-java',
    title: 'Service keeps restarting: the kernel OOM killer',
    tags: ['linux', 'memory'],
    task: 'orders-api on api-1 restarted three times this morning. Why?',
    targets: [api],
    replay: [
      { tool: 'ssh_exec', match: 'systemctl status orders-api', output: '● orders-api.service - Orders API\n     Active: active (running) since Sat 2026-10-18 09:58:02 UTC; 44min ago\n    Process: 30112 ExecStart=/opt/orders/bin/start (code=killed, signal=KILL)\n   Main PID: 30440 (java)\n     Memory: 6.9G' },
      { tool: 'ssh_exec', match: 'journalctl.*orders-api', output: 'Oct 18 07:41:10 api-1 systemd[1]: orders-api.service: Main process exited, code=killed, status=9/KILL\nOct 18 08:52:31 api-1 systemd[1]: orders-api.service: Main process exited, code=killed, status=9/KILL\nOct 18 09:57:58 api-1 systemd[1]: orders-api.service: Main process exited, code=killed, status=9/KILL' },
      { tool: 'ssh_exec', match: 'dmesg|journalctl.*(-k|kernel)|oom', output: '[3542.118] Out of memory: Killed process 30112 (java) total-vm:9912340kB, anon-rss:7104412kB, file-rss:0kB, shmem-rss:0kB, UID:998 pgtables:14420kB oom_score_adj:0\n[3542.120] oom_reaper: reaped process 30112 (java), now anon-rss:0kB' },
      { match: '(/opt/orders/bin/start|orders.*\\.(conf|env)|ps .*java|cat /proc/.*/cmdline)', output: 'exec java -Xms6g -Xmx7g -XX:+UseG1GC -jar /opt/orders/orders-api.jar' },
      { tool: 'ssh_exec', match: '^ps\\b', output: 'USER       PID %CPU %MEM    VSZ   RSS COMMAND\norders   30440 41.2 88.1 9874120 7092312 java -Xms6g -Xmx7g -XX:+UseG1GC -jar /opt/orders/orders-api.jar\nroot       911  0.2  0.6  55000  48200 nginx: master process' },
      ...basics({ host: 'api-1', mem: '               total        used        free      shared  buff/cache   available\nMem:            7.7Gi       7.1Gi       160Mi        8Mi       420Mi       290Mi\nSwap:              0B          0B          0B' }),
    ],
    expect: {
      elements: [
        { text: 'The kernel OOM killer killed the java process (signal 9 / Out of memory in the kernel log)', match: 'OOM|out of memory' },
        { text: 'The JVM heap (-Xmx7g) is too large for a machine with 7.7G of RAM and no swap, leaving no room for the rest', match: 'Xmx|heap' },
        { text: 'The fix lowers the heap (or adds memory) so the process fits', match: 'lower|reduce|decrease|smaller|more memory|bigger|resize' },
      ],
      mustCall: ['dmesg|journalctl|oom'],
    },
  },
  {
    id: 'cert-expired-renewal-failing',
    title: 'Browsers reject the site: an expired certificate and a failing renewal',
    tags: ['linux', 'tls'],
    task: 'Customers get a certificate warning on https://shop.example.test. Investigate web-1.',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: 'openssl (s_client|x509)', output: 'subject=CN = shop.example.test\nissuer=C = US, O = Let\'s Encrypt, CN = R11\nnotBefore=Jul 19 03:12:01 2026 GMT\nnotAfter=Oct 17 03:12:00 2026 GMT' },
      { tool: 'ssh_exec', match: 'certbot certificates', output: 'Certificate Name: shop.example.test\n    Domains: shop.example.test\n    Expiry Date: 2026-10-17 03:12:00+00:00 (INVALID: EXPIRED)' },
      { tool: 'ssh_exec', match: 'systemctl (status|list-timers).*certbot', output: '● certbot.timer - Run certbot twice daily\n     Active: active (waiting)\n● certbot.service - Certbot\n     Active: failed (Result: exit-code) since Sat 2026-10-18 00:00:14 UTC' },
      { match: 'letsencrypt\\.log|journalctl.*certbot', output: 'Attempting to renew cert (shop.example.test) from /etc/letsencrypt/renewal/shop.example.test.conf produced an unexpected error: Failed authorization procedure. shop.example.test (http-01): urn:ietf:params:acme:error:connection :: Fetching http://shop.example.test/.well-known/acme-challenge/x9: Timeout during connect (likely firewall problem)' },
      { tool: 'ssh_exec', match: 'ufw|iptables|nft', output: 'Status: active\nTo                         Action      From\n--                         ------      ----\n443/tcp                    ALLOW       Anywhere\n22/tcp                     ALLOW       10.0.0.0/8\n# 80/tcp removed 2026-09-30 by hardening playbook' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'The certificate for shop.example.test expired on 17 October 2026', match: 'expire' },
        { text: 'Renewal fails because the HTTP-01 challenge on port 80 times out: port 80 was closed in the firewall', match: 'port 80|80/tcp|http-01' },
        { text: 'The fix reopens port 80 for the challenge (or switches to DNS-01) and renews the certificate', match: 'renew' },
      ],
    },
  },
  {
    id: 'dns-resolver-unreachable',
    title: 'Cannot reach the database: the DNS resolver is down, not the database',
    tags: ['linux', 'network', 'misleading'],
    task: 'api-1 logs say it cannot connect to db.internal.example.test. Is the database down?',
    targets: [api],
    replay: [
      { match: '(getent hosts|host|dig|nslookup|resolvectl query).*db\\.internal', output: ';; communications error to 10.0.0.2#53: timed out\n;; no servers could be reached', exitCode: 1 },
      { match: 'resolv\\.conf', output: '# Generated by NetworkManager\nnameserver 10.0.0.2\nsearch example.test' },
      { tool: 'ssh_exec', match: '(ping|nc|curl|telnet).*10\\.0\\.5\\.11|nc .* 5432', output: 'Connection to 10.0.5.11 5432 port [tcp/postgresql] succeeded!' },
      { tool: 'ssh_exec', match: '(ping|nc).*10\\.0\\.0\\.2', output: 'nc: connect to 10.0.0.2 port 53 (udp) timed out', exitCode: 1 },
      { match: '/etc/hosts', output: '127.0.0.1 localhost\n10.0.4.32 api-1' },
      { tool: 'ssh_exec', match: 'journalctl.*orders|tail.*orders', output: 'Oct 18 10:31:02 api-1 orders-api[30440]: java.net.UnknownHostException: db.internal.example.test: Temporary failure in name resolution' },
      { tool: 'ssh_exec', match: 'systemctl status (systemd-resolved|NetworkManager)', output: '● systemd-resolved.service\n     Active: inactive (dead)' },
      ...basics({ host: 'api-1' }),
    ],
    expect: {
      elements: [
        { text: 'Name resolution fails: the DNS server 10.0.0.2 does not answer (UnknownHostException / temporary failure in name resolution)', match: 'DNS|resolv|name resolution|10\\.0\\.0\\.2' },
        { text: 'The database itself is up and reachable by address (port 5432 on 10.0.5.11 accepts connections)', match: 'reachable|up|not the database|accepts|succeeded' },
      ],
    },
  },
  {
    id: 'inode-exhaustion',
    title: '"No space left on device" with free space: inodes are used up',
    tags: ['linux', 'disk'],
    task: 'The shop frontend on web-1 fails to write sessions: "No space left on device". df looks fine. Why?',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: '^df\\b.*-i', output: 'Filesystem      Inodes   IUsed  IFree IUse% Mounted on\n/dev/nvme0n1p1 2621440 2621440      0  100% /' },
      { tool: 'ssh_exec', match: '^df\\b', output: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   40G   16G   23G  41% /' },
      { tool: 'ssh_exec', match: '(find|du --inodes|ls).*(/var/lib/php|sessions)', output: '2398114 /var/lib/php/sessions' },
      { tool: 'ssh_exec', match: 'du --inodes|find / .*-xdev', output: '2398114\t/var/lib/php/sessions\n112004\t/usr\n41022\t/var/lib/dpkg\n2621440\t/' },
      { match: 'php.*\\.ini|session\\.gc', output: 'session.save_path = /var/lib/php/sessions\nsession.gc_probability = 0\nsession.gc_maxlifetime = 1440' },
      { tool: 'ssh_exec', match: 'crontab|/etc/cron', output: '# /etc/cron.d/php: the sessionclean job was removed in the 2026-09 image rebuild' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'The filesystem has run out of inodes (100% IUse), not bytes', match: 'inode' },
        { text: 'About 2.4 million PHP session files in /var/lib/php/sessions use them up', match: 'session' },
        { text: 'Session cleanup is not running (gc_probability is 0 and the sessionclean cron job is gone)', match: 'gc_probability|sessionclean|clean' },
      ],
      forbiddenCalls: ['rm\\s+-rf\\s+/var/lib/php/sessions/?\\s*$'],
    },
  },
  {
    id: 'overlapping-cron-load',
    title: 'Load average of 24: an overlapping cron job',
    tags: ['linux', 'cpu'],
    task: 'web-1 is very slow and the load average is huge. Find out why.',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: '^uptime', output: ' 10:42:07 up 41 days,  3:12,  1 user,  load average: 24.12, 22.80, 18.31' },
      { tool: 'ssh_exec', match: '^top\\b', output: top('24.12, 22.80, 18.31', 8, [[4411, 'www-data', 98.0, 1.1, 'php /srv/shop/bin/rebuild-sitemap.php'], [4398, 'www-data', 97.6, 1.1, 'php /srv/shop/bin/rebuild-sitemap.php'], [4372, 'www-data', 97.1, 1.0, 'php /srv/shop/bin/rebuild-sitemap.php'], [4351, 'www-data', 96.8, 1.0, 'php /srv/shop/bin/rebuild-sitemap.php'], [911, 'root', 2.0, 0.6, 'nginx']]) },
      { tool: 'ssh_exec', match: '^ps\\b', output: 'USER       PID  %CPU STARTED COMMAND\nwww-data  4351 96.8 10:38   php /srv/shop/bin/rebuild-sitemap.php\nwww-data  4372 97.1 10:39   php /srv/shop/bin/rebuild-sitemap.php\nwww-data  4398 97.6 10:40   php /srv/shop/bin/rebuild-sitemap.php\nwww-data  4411 98.0 10:41   php /srv/shop/bin/rebuild-sitemap.php\n... 19 more rebuild-sitemap.php started in the last 23 minutes' },
      { tool: 'ssh_exec', match: 'crontab|/etc/cron', output: '# m h dom mon dow command\n* * * * * php /srv/shop/bin/rebuild-sitemap.php   # changed from 0 * * * * on 2026-10-18 by deploy 4f2a91' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'rebuild-sitemap.php runs every minute from cron, each run takes longer than a minute, so copies pile up (over 20 at once)', match: 'sitemap' },
        { text: 'The schedule changed from hourly to every minute in a recent deploy', match: 'every minute|hourly|\\* \\* \\* \\* \\*|schedule' },
        { text: 'The fix restores the hourly schedule and prevents overlap (flock or a lock file)', match: 'flock|lock|hourly|overlap' },
      ],
    },
  },
  {
    id: 'too-many-open-files',
    title: '"Too many open files": a connection leak against the default limit',
    tags: ['linux', 'application'],
    task: 'The notifications service on api-1 started failing with "EMFILE: too many open files". Investigate.',
    targets: [api],
    replay: [
      { tool: 'ssh_exec', match: 'journalctl.*notif|tail.*notif', output: 'Oct 18 10:12:44 api-1 notify[7781]: Error: EMFILE: too many open files, open \'/srv/notify/templates/order.html\'\nOct 18 10:12:44 api-1 notify[7781]: Error: connect EMFILE 10.0.5.20:6379 - Local (undefined:undefined)' },
      { tool: 'ssh_exec', match: 'cat /proc/.*/limits|prlimit|ulimit', output: 'Limit                     Soft Limit           Hard Limit           Units\nMax open files            1024                 4096                 files' },
      { tool: 'ssh_exec', match: 'ls /proc/.*/fd.*wc|lsof -p 7781.*wc', output: '1024' },
      { tool: 'ssh_exec', match: 'lsof -p 7781|ss -tanp|netstat', output: 'node 7781 notify  ... TCP 10.0.4.32:51022->10.0.5.20:6379 (ESTABLISHED)\n... 1001 sockets to 10.0.5.20:6379 (redis), 18 regular files, 5 pipes' },
      { tool: 'ssh_exec', match: 'systemctl (status|cat) notif', output: '● notify.service - Notifications\n     Active: active (running) since Fri 2026-10-17 09:01:10 UTC; 1 day 1h ago\n   Main PID: 7781 (node)\n# no LimitNOFILE set; release 3.8.0 deployed Fri 2026-10-17 09:00' },
      ...basics({ host: 'api-1' }),
    ],
    expect: {
      elements: [
        { text: 'The process has reached its open-file limit of 1024', match: '1024|limit' },
        { text: 'Almost all descriptors are connections to redis (about 1000), so the service leaks redis connections, likely since release 3.8.0', match: 'redis|6379|leak' },
        { text: 'Raising LimitNOFILE only buys time; the leak must be fixed (or 3.8.0 rolled back)', match: 'leak|roll ?back|LimitNOFILE' },
      ],
    },
  },
  {
    id: 'clock-skew-ntp',
    title: 'Logins fail with "token not yet valid": the clock is wrong',
    tags: ['linux', 'misleading'],
    task: 'Users get "token used before issued" errors from api-1 since this morning. Investigate.',
    targets: [api],
    replay: [
      { tool: 'ssh_exec', match: '^date\\b', output: 'Sat Oct 18 10:51:19 UTC 2026' },
      { tool: 'ssh_exec', match: 'timedatectl', output: '               Local time: Sat 2026-10-18 10:51:19 UTC\n           Universal time: Sat 2026-10-18 10:51:19 UTC\nSystem clock synchronized: no\n              NTP service: inactive' },
      { tool: 'ssh_exec', match: 'chronyc|ntpq|ntpstat', output: '506 Cannot talk to daemon', exitCode: 1 },
      { tool: 'ssh_exec', match: 'systemctl status (chrony|ntp|systemd-timesyncd)', output: '● chrony.service - chrony, an NTP client/server\n     Active: inactive (dead) since Fri 2026-10-17 22:03:11 UTC\n# stopped by unattended-upgrades restart, failed to start: Could not open /var/lib/chrony/chrony.drift: Permission denied' },
      { tool: 'ssh_exec', match: 'journalctl.*(orders|auth)|tail.*(orders|auth)', output: 'Oct 18 10:51:02 api-1 orders-api: JWT rejected: iat 10:42:20 is in the future (now 10:51:02 local, token from auth-1)' },
      ...basics({ host: 'api-1' }).filter((r) => !/date/.test(r.match)),
    ],
    expect: {
      elements: [
        { text: "api-1's clock is wrong (about 9 minutes ahead) because time synchronisation is off: chrony is stopped and the clock is not synchronised", match: 'clock|time ?sync|NTP|chrony' },
        { text: 'Restart chrony (fixing its drift file permission) so the clock syncs again', match: 'chrony|NTP|timesync' },
      ],
    },
  },
  {
    id: 'memory-leak-swap',
    title: 'Slow since days: a worker leaking memory into swap',
    tags: ['linux', 'memory'],
    task: 'web-1 has become slower every day this week. Investigate.',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: '^free\\b', output: '               total        used        free      shared  buff/cache   available\nMem:            7.7Gi       7.4Gi       102Mi        4Mi       210Mi       118Mi\nSwap:           8.0Gi       7.6Gi       400Mi' },
      { tool: 'ssh_exec', match: '^vmstat', output: 'procs -----------memory---------- ---swap-- -----io----\n r  b   swpd   free   buff  cache   si   so    bi    bo\n 3  6 7969000 104000  1200 214000 4120 5210  8800  9100' },
      { tool: 'ssh_exec', match: '^(ps|top)\\b', output: 'USER       PID %CPU %MEM    VSZ   RSS STARTED COMMAND\nshop      2210 12.0 81.3 9120000 6550000 Oct 11 node /srv/shop/image-worker.js\nwww-data   911  1.1  0.6  55000  48200 Oct 01 nginx' },
      { tool: 'ssh_exec', match: 'systemctl status image-worker', output: '● image-worker.service\n     Active: active (running) since Sat 2026-10-11 07:00:03 UTC; 1 week 0 days ago\n     Memory: 6.2G (peak: 6.3G)' },
      { tool: 'ssh_exec', match: 'journalctl.*image-worker', output: 'Oct 11 07:00:03 web-1 image-worker: started v5.2.0 (resize cache: unbounded LRU disabled)' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'image-worker (PID 2210) has grown to about 6.5G resident since it started a week ago: a memory leak', match: 'image-worker|leak' },
        { text: 'The machine is swapping heavily (7.6G of swap used, high si/so), which is what makes everything slow', match: 'swap' },
        { text: 'Restart image-worker for relief, and fix the leak (its resize cache is unbounded since v5.2.0) or cap its memory', match: 'restart|cache|MemoryMax|limit' },
      ],
    },
  },
  {
    id: 'nginx-502-backend-down',
    title: '502 Bad Gateway: the app server failed to start after a deploy',
    tags: ['linux', 'deploy'],
    task: 'shop.example.test returns 502 Bad Gateway since the 10:00 deploy. Investigate web-1.',
    targets: [web],
    replay: [
      { tool: 'ssh_exec', match: 'nginx.*error\\.log|tail.*error\\.log', output: '2026/10/18 10:02:11 [error] 914#914: *4411 connect() failed (111: Connection refused) while connecting to upstream, client: 203.0.113.40, server: shop.example.test, upstream: "http://127.0.0.1:8000/"' },
      { match: 'nginx/error\\.log', output: '2026/10/18 10:02:11 [error] 914#914: *4411 connect() failed (111: Connection refused) while connecting to upstream, upstream: "http://127.0.0.1:8000/"' },
      { tool: 'ssh_exec', match: 'systemctl status (gunicorn|shop)', output: '● shop.service - Shop (gunicorn)\n     Active: failed (Result: exit-code) since Sat 2026-10-18 10:01:58 UTC; 41min ago\n    Process: 5521 ExecStart=/srv/shop/venv/bin/gunicorn shop.wsgi (code=exited, status=3)' },
      { tool: 'ssh_exec', match: 'journalctl.*(shop|gunicorn)', output: 'Oct 18 10:01:57 web-1 gunicorn[5521]: ModuleNotFoundError: No module named \'stripe\'\nOct 18 10:01:58 web-1 gunicorn[5521]: [ERROR] Worker failed to boot.' },
      { tool: 'ssh_exec', match: '(ss|netstat).*(8000|-l)', output: 'State  Recv-Q Send-Q Local Address:Port Peer Address:Port\nLISTEN 0      511    0.0.0.0:443        0.0.0.0:*\nLISTEN 0      511    0.0.0.0:80         0.0.0.0:*' },
      { match: 'requirements|pip (freeze|list)|venv/.*pip', output: 'Django==5.1.2\ngunicorn==23.0.0\npsycopg==3.2.3\n# stripe is in requirements.txt of release 2026.10.18 but was not installed: the deploy skipped "pip install"' },
      ...basics({ host: 'web-1' }),
    ],
    expect: {
      elements: [
        { text: 'nginx gets "connection refused" from its upstream on 127.0.0.1:8000 because the shop (gunicorn) service is not running', match: 'gunicorn|shop\\.service|upstream|8000' },
        { text: 'gunicorn fails to start with ModuleNotFoundError: the stripe package was not installed by the deploy', match: 'stripe|ModuleNotFound' },
        { text: 'Fix: install the missing dependency (pip install -r requirements.txt) and start the service, or roll back the deploy', match: 'pip install|requirements|roll ?back' },
      ],
    },
  },
  {
    id: 'outbound-firewall-rule',
    title: 'Payments time out: an outbound firewall rule',
    tags: ['linux', 'network'],
    task: 'Card payments from api-1 to payments.example.test time out since yesterday evening. Find out why.',
    targets: [api],
    replay: [
      { tool: 'ssh_exec', match: 'curl.*payments', output: 'curl: (28) Failed to connect to payments.example.test port 443 after 10001 ms: Timeout was reached', exitCode: 28 },
      { tool: 'ssh_exec', match: '(dig|host|getent|nslookup).*payments', output: 'payments.example.test has address 203.0.113.80' },
      { tool: 'ssh_exec', match: 'traceroute|tracepath|mtr', output: ' 1  10.0.4.1  0.412 ms\n 2  * * *\n 3  * * *' },
      { tool: 'ssh_exec', match: 'iptables|nft', output: 'Chain OUTPUT (policy ACCEPT)\nnum  target  prot opt source     destination\n1    ACCEPT  all  --  0.0.0.0/0  10.0.0.0/8\n2    DROP    tcp  --  0.0.0.0/0  203.0.113.0/24  tcp dpt:443   /* egress-lockdown 2026-10-17 */' },
      { tool: 'ssh_exec', match: 'curl.*(example\\.org|google|1\\.1\\.1\\.1)', output: 'HTTP/2 200' },
      { tool: 'ssh_exec', match: 'journalctl.*(ansible|salt|puppet)|/var/log/(ansible|salt)', output: 'Oct 17 19:02:44 api-1 ansible-egress: applied role egress-lockdown (rules: 14)' },
      ...basics({ host: 'api-1' }),
    ],
    expect: {
      elements: [
        { text: 'An iptables OUTPUT rule drops TCP 443 to 203.0.113.0/24, the range payments.example.test is in', match: 'iptables|OUTPUT|DROP|firewall' },
        { text: 'The rule came from the egress-lockdown role applied yesterday evening (17 October)', match: 'egress|lockdown|ansible' },
      ],
    },
  },
];
