/**
 * What this run can and cannot see. A model that does not know Loki is down will
 * guess at the logs; told so, it says "fix the Loki connection to see the logs".
 */
export interface SourceState {
  slug: string;
  kind: string;
  /** Why it is not working right now, or null when it is (or nothing says otherwise). */
  problem: string | null;
}

export interface Coverage {
  sources: SourceState[];
  /** Machines (SSH) and clusters (Kubernetes) the project can reach. */
  machines: number;
  clusters: number;
  /** Webhook senders pushing alerts in. */
  alertSenders: number;
}

const ROWS: Array<{ label: string; kinds: string[]; missing: string }> = [
  { label: 'Metrics', kinds: ['prometheus', 'grafana'], missing: 'none connected (add Prometheus or Grafana to read metrics)' },
  { label: 'Logs', kinds: ['loki', 'elasticsearch'], missing: 'none connected (add Loki or Elasticsearch to read logs)' },
  { label: 'Traces', kinds: ['tempo', 'jaeger', 'signoz'], missing: 'none connected (add Tempo, Jaeger or SigNoz to read traces)' },
  { label: 'Alerts', kinds: ['alertmanager', 'prometheus', 'grafana'], missing: 'none connected' },
];

const name = (s: SourceState) => (s.problem ? `${s.slug} -- NOT WORKING: ${s.problem.replace(/\s+/g, ' ').slice(0, 160)}` : s.slug);

export function coverageBlock(c: Coverage): string {
  const lines = ROWS.map((r) => {
    const have = c.sources.filter((s) => r.kinds.includes(s.kind));
    const extra = r.label === 'Alerts' && c.alertSenders ? [`${c.alertSenders} webhook sender${c.alertSenders === 1 ? '' : 's'}`] : [];
    const parts = [...have.map(name), ...extra];
    return `- ${r.label}: ${parts.length ? parts.join('; ') : r.missing}`;
  });
  lines.push(`- Machines: ${c.machines ? `${c.machines} reachable over SSH` : 'none'}; Kubernetes clusters: ${c.clusters || 'none'}`);
  // A missing Kubernetes data source is not a dead end when there are SSH machines: a
  // reachable host with kubectl/oc (a jump/bastion or an OpenShift/ROSA login host) can
  // inspect the cluster. Say so, so the agent runs it rather than declining -- weak
  // models otherwise read "clusters: none" as "pod health cannot be checked".
  if (c.machines && !c.clusters) {
    lines.push('  (No cluster is connected as a data source, but you can still inspect Kubernetes/OpenShift: run kubectl or oc on a reachable machine that has it -- a jump/bastion or a login host, e.g. one whose description mentions OpenShift/ROSA -- with ssh_exec. Try that before reporting that pods or cluster state cannot be checked.)');
  }
  const gaps = c.sources.some((s) => s.problem) || lines.some((l) => l.includes('none connected'));
  return [
    'DATA SOURCES (what this project lets you see right now)',
    ...lines,
    gaps
      ? 'First use what you DO have -- that includes running commands on the machines you can reach (for example kubectl or oc on a host that has it). Recommend connecting or fixing a source ONLY when there is genuinely no other way to get the answer -- then name it (for example "connect Loki to see the logs") rather than guessing what it would show, and lower your confidence. Do not refuse a task just because a data source is missing if a reachable machine can get the answer.'
      : null,
  ]
    .filter((l): l is string => !!l)
    .join('\n');
}
