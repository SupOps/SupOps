/**
 * Domain playbooks, injected into the system prompt only when a run touches that
 * domain (a target kind in scope, or the task mentioning it). One prompt covering
 * every technology would cost thousands of tokens on every turn; most runs need one
 * or two playbooks.
 *
 * Each body is short and fixed: the order to check things in, what a symptom usually
 * means, the reversible fix to reach for first, what never to do, and how to verify.
 * Adding an entry needs no other code change.
 */
export interface Skill {
  id: string;
  title: string;
  /** Static text, at most MAX_SKILL_CHARS. Part of the byte-stable system prompt. */
  body: string;
  /** Selected when a target or connection of one of these kinds is in scope. */
  kinds?: string[];
  /** Selected when the task mentions the domain. */
  keywords?: RegExp;
}

export const MAX_SKILL_CHARS = 1200;
export const MAX_INJECTED_SKILLS = 4;

export const SKILLS: Skill[] = [
  {
    id: 'linux',
    title: 'Linux hosts',
    kinds: ['ssh'],
    keywords: /\b(linux|systemd|systemctl|journalctl|disk|inode|oom|load average|swap)\b/i,
    body: `Check in this order: uptime (load against nproc), free -m (read "available"), df -h and df -i (inodes fill too), systemctl --failed, journalctl -p err -n 100 --no-pager, then the service: systemctl status <svc> and journalctl -u <svc> -n 200 --no-pager.
What it usually means: disk full but du finds nothing big = a deleted file still held open (lsof +L1). High load with idle CPU = processes waiting on I/O (vmstat 1 5, iostat -x). OOM kills in dmesg = a leak or a limit set too low; more swap is not the fix. "Too many open files" = LimitNOFILE.
Reversible first: reload before restart. Empty a log the service still writes with truncate -s 0 rather than deleting it. Free space from old rotated logs, never from data.
Never: rm -rf on a path you have not listed; kill sshd or PID 1; edit fstab or sshd_config without a rollback; chmod -R 777.
Verify with the check that showed the problem, and systemctl is-active <svc>.`,
  },
  {
    id: 'containers',
    title: 'Docker containers',
    kinds: ['docker'],
    keywords: /\b(docker|container|compose|image)s?\b/i,
    body: `Check: docker ps -a (status, restarts, exit code), docker logs --tail 200 <c>, docker inspect <c> (State, RestartCount, Config.Env names), docker stats --no-stream, docker system df.
Exit codes: 137 = killed (OOM when State.OOMKilled is true, otherwise a kill or stop timeout); 139 = segfault; 1 or 2 = the app failed at start, so read its last log lines; 125-127 = bad command or entrypoint.
A restart loop right after a deploy is usually a missing environment variable, a changed mounted config or a failed migration: compare with the image that worked.
Disk: docker system df splits images, stopped containers and build cache. Prune only dangling items (docker image prune, without -a) unless the operator agrees.
Never: docker system prune -a --volumes (deletes data); docker rm -f a database container; run --privileged to look around.
Verify: the container stays Up past its old restart interval and its health check passes.`,
  },
  {
    id: 'kubernetes',
    title: 'Kubernetes',
    kinds: ['k8s'],
    keywords: /\b(kubernetes|k8s|kubectl|pods?|deployments?|namespaces?|crashloop\w*|statefulsets?|ingress)\b/i,
    body: `Check: kubectl get pods -o wide (status, restarts, node), kubectl describe pod (Events at the end), kubectl logs <pod> --previous for the crash itself, kubectl get events --sort-by=.lastTimestamp, kubectl top pods and nodes.
Status to cause: CrashLoopBackOff = read the --previous logs (missing env or config, failed migration, bad flag). OOMKilled = limit too low or a leak; compare usage with the limit. ImagePullBackOff = wrong tag or registry secret. Pending = describe names it: not enough cpu or memory, a taint, an unbound PVC. Probe failures = the probe is stricter than the app's start time.
After a bad deploy, kubectl rollout undo deployment/<name> is the fastest safe fix; check rollout history first.
Reversible first: rollout undo, scale, rollout restart. Change limits in the manifest, not with kubectl edit on prod.
Never: delete a namespace, a PVC or a StatefulSet's volume; force-delete StatefulSet pods; drain a node without checking PodDisruptionBudgets.
Verify: rollout status completes, restarts stop rising, the service has ready endpoints.`,
  },
  {
    id: 'networking',
    title: 'Networking, DNS and TLS',
    kinds: ['http'],
    keywords: /\b(dns|tls|ssl|certificates?|cert|50[234]|timeouts?|timed out|connection refused|unreachable|port|latency|proxy|nginx|haproxy)\b/i,
    body: `Work up the stack: does the name resolve (dig +short, against each resolver), does the port answer (net_check, or nc -zv), does TLS complete (openssl s_client -connect host:443 -servername host shows the chain and its dates), then HTTP (curl -sv with timings).
What errors mean: connection refused = nothing listening there (ss -ltnp) or the wrong port. Timeout = a firewall, security group or route. 502 = the proxy reached the backend but it closed or crashed. 503 = no healthy backend. 504 = the backend is slower than the proxy's timeout. TLS errors = expired certificate, missing intermediate, or the wrong name (SNI).
DNS: compare the authoritative answer with cached ones; a recent change may only be waiting out its TTL.
Look from both ends: the client's resolver and route can differ from the server's.
Never: turn off certificate checks as a fix, open a port to 0.0.0.0/0 to debug, or flush firewall rules on a remote host (you lose the session).
Verify with the same probe from where the users are, not only from the server.`,
  },
  {
    id: 'databases',
    title: 'Databases',
    keywords: /\b(postgres\w*|psql|mysql|mariadb|redis|mongo\w*|database|db|replication|replica|deadlocks?|connection pool|slow quer\w+)\b/i,
    body: `Connections first: count them against the limit (pg_stat_activity, SHOW PROCESSLIST, INFO clients). Running out is usually a pool leak or slow queries holding connections, rarely a limit that is too low.
Slow: find the longest-running and lock-waiting queries (pg_stat_activity with wait_event, pg_locks; SHOW ENGINE INNODB STATUS) and EXPLAIN the worst. A deploy that changed a query often lost an index.
Replication: the lag in seconds and whether it grows. A replica far behind serves stale reads.
Disk: WAL or binlog growth from a stuck replication slot or a long-open transaction.
Redis: used_memory against maxmemory, evicted_keys, hit rate. A burst of evictions means memory pressure.
Reversible first: cancel one query (pg_cancel_backend) before terminating it; end one idle-in-transaction session before restarting anything.
Never: DROP, TRUNCATE, or DELETE/UPDATE without WHERE; restart a primary without checking its replicas; FLUSHALL; change data to test a theory.
Verify: connections and latency back to normal, replication lag falling.`,
  },
  {
    id: 'observability',
    title: 'Metrics, logs and traces',
    kinds: ['prometheus', 'alertmanager', 'loki', 'elasticsearch', 'grafana', 'tempo', 'jaeger', 'signoz'],
    keywords: /\b(promql|logql|metrics?|traces?|spans?|grafana|prometheus|loki|error rate|p9[59]|percentile)\b/i,
    body: `Start from the signal that fired. Query it over a window before and after it started, then widen. Rate and errors first (sum by service), then latency percentiles from histograms (histogram_quantile over the rate of _bucket).
Ask what changed at the start: deploys, config, traffic. Compare with the same hour yesterday to rule out a daily pattern.
Logs explain a metric: filter to the service and the error level in the same window, group similar lines, and look at what is new.
Traces explain latency: find the slowest spans and the downstream call that takes most of their time.
A metric that drops to zero is often a scrape or exporter failure, not an outage: check up{} for that job first.
Never state a cause from one data point, never silence an alert as the fix, and never widen a silence beyond the alert's own labels or a few hours.
Verify: the alert's own query returns to normal and stays there for a few evaluation intervals.`,
  },
  {
    id: 'aws',
    title: 'AWS',
    keywords: /\b(aws|ec2|s3|rds|eks|iam|cloudwatch|elb|alb|nlb|lambda|route ?53|ecs)\b/i,
    body: `Region and account first: most "missing" resources are in another region or account (aws sts get-caller-identity).
Instances: aws ec2 describe-instance-status shows system and instance check failures. A failed system check is the host: stop and start (not reboot) moves the instance.
Load balancers: read target health (describe-target-health) and its reason code before anything else.
AccessDenied names the action and the resource: read the role's policy and any SCP or permission boundary; never widen it to *.
RDS: CPU, connections, FreeStorageSpace and ReplicaLag in CloudWatch. A full disk turns RDS read-only.
Sudden launch failures are often a service quota.
Never: delete snapshots, S3 objects or buckets, terminate instances, or open a security group to 0.0.0.0/0 to debug; never print secret values.
Verify: the CloudWatch metric or target health returns to healthy.`,
  },
  {
    id: 'gcp',
    title: 'Google Cloud',
    keywords: /\b(gcp|google cloud|gcloud|gke|cloud run|cloud sql|gce|bigquery|pub\/?sub)\b/i,
    body: `Project and region first: gcloud config list shows which project the commands go to.
GKE: treat it as Kubernetes; node problems also show in gcloud container operations list and node pool autoscaler events.
Cloud Run: revisions and traffic split (gcloud run revisions list); a bad revision is fixed by moving traffic back to the last good one.
Cloud SQL: CPU, connections, disk and replication lag in Cloud Monitoring; a full disk stops writes unless auto-resize is on.
Permissions: "PERMISSION_DENIED" names the permission; grant the narrowest role to the one service account, never Owner or Editor.
Quotas (CPU, IPs) cause sudden create failures.
Never: delete projects, buckets, disks or snapshots, or open firewall rules to 0.0.0.0/0 to debug.
Verify in Cloud Monitoring with the metric that showed the problem.`,
  },
  {
    id: 'azure',
    title: 'Azure',
    keywords: /\b(azure|az cli|aks|app service|azure sql|cosmos ?db|vmss|resource group)\b/i,
    body: `Subscription first: az account show; most "missing" resources are in another subscription or resource group.
VMs: az vm get-instance-view shows power and provisioning state; boot diagnostics show a stuck boot. Redeploy moves the VM to a new host.
AKS: treat it as Kubernetes; node pool and upgrade problems show in az aks show and the activity log.
App Service: the log stream and the deployment slot; a bad release is fixed by swapping slots back.
The activity log answers "who changed what, when" for any resource.
Authorization errors name the action: assign the narrowest built-in role at the narrowest scope.
Never: delete resource groups, disks or snapshots, or open an NSG to the internet to debug.
Verify with Azure Monitor using the metric that showed the problem.`,
  },
  {
    id: 'terraform',
    title: 'Terraform',
    keywords: /\b(terraform|tfstate|tf plan|tf apply|opentofu|drift)\b/i,
    body: `Always plan before apply, and read the plan: a destroy or a replace (-/+) of anything that holds data is a stop sign. Find the attribute that forces the replacement and change that instead.
Drift: terraform plan -refresh-only shows what changed outside Terraform. Decide with the operator whether to bring the change into the code or revert it.
A state lock error means a run holds the lock, or crashed holding it: find out which before any force-unlock.
Errors after an upgrade: check provider versions and the lock file; pin what changed.
Never: apply without a reviewed plan; terraform destroy; state rm, import or force-unlock without the operator; edit the state file by hand.
Verify: a second plan shows no changes.`,
  },
  {
    id: 'helm',
    title: 'Helm',
    keywords: /\b(helm|charts?|helmfile)\b/i,
    body: `helm list -A shows each release and its status. A release stuck in pending-upgrade or failed blocks the next upgrade.
helm history <release> -n <ns> lists revisions; helm rollback <release> <revision> is the fast, reversible fix after a bad upgrade.
Before an upgrade, see what would change: helm get values for the current values, and helm template (or helm diff) for the rendered result.
Failed hooks, such as a migration job, leave jobs behind: read their logs before retrying.
Never: helm uninstall a release that owns persistent data; use --force on a stateful chart without the operator.
Verify: helm status shows deployed and the workload's rollout is complete.`,
  },
  {
    id: 'git',
    title: 'Git',
    kinds: ['github', 'gitlab'],
    keywords: /\b(git|commits?|branch(es)?|merge|rebase|github|gitlab|pull request|merge request|regression)\b/i,
    body: `Git answers "what changed": git log --oneline --since="2 days ago", git log -p -- <path>, git diff <good>..<bad>, git blame for one line.
For a regression, find the last good and the first bad version, then narrow the commits between them (git bisect when there are many).
On a server, a working copy with local changes (git status) means someone edited in place: report it before any pull.
Never: force-push, reset --hard, clean -fdx or rewrite history on a shared branch; commit secrets.
Verify: the version actually deployed (tag or commit) is the one you think is running.`,
  },
  {
    id: 'cicd',
    title: 'CI/CD and deploys',
    kinds: ['github', 'gitlab'],
    keywords: /\b(ci|cd|ci\/cd|pipelines?|builds?|deploy\w*|release|github actions|gitlab ci|jenkins|argo ?cd|flux)\b/i,
    body: `A failed pipeline: read the first error, not the last; later failures usually follow from it. Check whether the same job passes on the main branch (flaky or real).
Usual causes: a dependency version that moved, an expired token or secret, a runner out of disk, a stale cache, a rate limit.
A bad deploy: find the exact version deployed and when, compare it with the one before, and roll back through the pipeline (deploy the last good version) rather than by hand.
GitOps (Argo CD, Flux): the cluster follows git, so a manual kubectl change gets reverted. Fix it in git, or pause the sync on purpose and say so.
Never: skip tests or checks to force a release; re-run a production deploy without the operator; print secrets in job logs.
Verify: the pipeline is green and the deployed version is the expected one.`,
  },
];

export interface SkillSelection {
  injected: Skill[];
  /** Ids of playbooks that matched but did not fit, for a one-line pointer. */
  others: string[];
}

/**
 * Choose the playbooks for a run: agent pins first, then in-scope kinds, then task
 * keywords. At most MAX_INJECTED_SKILLS, in a stable order so the prompt prefix is
 * the same for the same inputs.
 */
export function selectSkills(
  i: { kinds: string[]; task: string; pinned?: string[] },
  registry: Skill[] = SKILLS,
): SkillSelection {
  const score = new Map<string, number>();
  for (const s of registry) {
    let v = 0;
    if (i.pinned?.includes(s.id)) v = 3;
    else if (s.kinds?.some((k) => i.kinds.includes(k))) v = 2;
    else if (s.keywords?.test(i.task)) v = 1;
    if (v) score.set(s.id, v);
  }
  const ranked = registry
    .filter((s) => score.has(s.id))
    .sort((a, b) => score.get(b.id)! - score.get(a.id)! || a.id.localeCompare(b.id));
  const injected = ranked.slice(0, MAX_INJECTED_SKILLS).sort((a, b) => a.id.localeCompare(b.id));
  return { injected, others: ranked.slice(MAX_INJECTED_SKILLS).map((s) => s.id) };
}

/** The system-prompt section for the selected playbooks, or '' when there are none. */
export function renderSkills(sel: SkillSelection): string {
  if (!sel.injected.length) return '';
  const blocks = sel.injected.map((s) => `${s.title.toUpperCase()}\n${s.body.trim()}`);
  const more = sel.others.length ? `\n\nOther playbooks apply too: ${sel.others.join(', ')}.` : '';
  return `PLAYBOOKS FOR THIS RUN\n\n${blocks.join('\n\n')}${more}`;
}
