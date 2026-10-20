import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../../lib/clipboard';
import type { AlertSourceKind } from '../../lib/types';

export const KIND_LABEL: Record<AlertSourceKind, string> = {
  alertmanager: 'Alertmanager',
  grafana: 'Grafana',
  pagerduty: 'PagerDuty',
  opsgenie: 'Opsgenie',
  generic: 'Any JSON webhook',
  changes: 'Deploys and changes (CI/CD)',
};

export const KIND_HINT: Record<AlertSourceKind, string> = {
  alertmanager: 'Prometheus alerts, pushed the moment they fire and resolve.',
  grafana: 'Grafana-managed alert rules, through a webhook contact point.',
  pagerduty: 'PagerDuty incidents (v3 webhooks): triggered, acknowledged, resolved.',
  opsgenie: 'Opsgenie alerts, through an outgoing webhook integration.',
  generic: 'Anything that can POST JSON. Point SupOps at the fields it uses.',
  changes: 'Your pipeline reports each deploy or config change; when something breaks, the changes just before it are the first suspects.',
};

/** Where this sender posts. Same origin the browser is on: that is where SupOps is reachable. */
export const hookUrl = (id: string) => `${window.location.origin}/api/hooks/${id}`;

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre rounded-inner border border-hairline bg-ground/70 px-3.5 py-2.5 pr-11 font-mono text-[11.5px] leading-relaxed text-ink">{text}</pre>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        title="Copy"
        className="absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-white/5 hover:text-ink"
        onClick={async () => {
          if (await copyText(text)) {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          }
        }}
      >
        {done ? <Check size={14} className="text-green" /> : <Copy size={14} />}
      </button>
    </div>
  );
}

/**
 * How to point a sender at SupOps: the exact config, with the URL filled in and the
 * token either shown (right after creating or rotating) or as a placeholder.
 */
export function SourceSetup({ kind, id, token }: { kind: AlertSourceKind; id: string; token?: string | null }) {
  const url = hookUrl(id);
  const t = token ?? '<the token shown when this source was created>';
  const curl = `curl -X POST '${url}' \\\n  -H 'Authorization: Bearer ${t}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${
    kind === 'alertmanager' || kind === 'grafana'
      ? '{"alerts":[{"status":"firing","labels":{"alertname":"TestAlert","severity":"info","instance":"test-host"}}]}'
      : kind === 'pagerduty'
        ? '{"event":{"event_type":"incident.triggered","data":{"id":"TEST1","type":"incident","title":"Test","urgency":"low"}}}'
        : kind === 'opsgenie'
          ? '{"action":"Create","alert":{"alias":"test-1","message":"Test","priority":"P5"}}'
          : kind === 'changes'
            ? '{"service":"checkout","version":"2.14.0","environment":"prod","status":"success","author":"ci","url":"https://ci.example.test/runs/41"}'
            : '{"title":"Test alert","severity":"info","status":"firing","host":"test-host"}'
  }'`;

  return (
    <div className="space-y-3 text-xs leading-relaxed text-muted">
      {kind === 'alertmanager' && (
        <>
          <p>Add a receiver to <span className="font-mono text-ink">alertmanager.yml</span> and route alerts to it. <span className="font-mono text-ink">send_resolved</span> lets SupOps close alerts the moment they resolve.</p>
          <CopyBlock
            label="Alertmanager config"
            text={`receivers:\n  - name: supops\n    webhook_configs:\n      - url: '${url}'\n        send_resolved: true\n        http_config:\n          authorization:\n            credentials: '${t}'\n\nroute:\n  # Keep your existing receiver as the default and add SupOps alongside it:\n  routes:\n    - receiver: supops\n      continue: true\n      # Hours, not minutes: SupOps counts repeats, it does not need to be reminded.\n      repeat_interval: 4h`}
          />
        </>
      )}
      {kind === 'grafana' && (
        <ol className="list-decimal space-y-1 pl-4">
          <li>In Grafana, go to <span className="text-ink">Alerting → Contact points → Add contact point</span> and choose <span className="text-ink">Webhook</span>.</li>
          <li>URL: <span className="break-all font-mono text-ink">{url}</span></li>
          <li>Under <span className="text-ink">Optional webhook settings</span>, set <span className="text-ink">Authorization header scheme</span> to <span className="font-mono text-ink">Bearer</span> and <span className="text-ink">credentials</span> to the token.</li>
          <li>Add the contact point to a notification policy, then press <span className="text-ink">Test</span> in Grafana or <span className="text-ink">Send test alert</span> here.</li>
        </ol>
      )}
      {kind === 'pagerduty' && (
        <ol className="list-decimal space-y-1 pl-4">
          <li>In PagerDuty, go to <span className="text-ink">Integrations → Generic Webhooks (v3) → New Webhook</span>.</li>
          <li>Webhook URL: <span className="break-all font-mono text-ink">{url}</span></li>
          <li>Scope it to the services SupOps should see, and pick the <span className="text-ink">incident.triggered</span>, <span className="text-ink">incident.acknowledged</span> and <span className="text-ink">incident.resolved</span> events.</li>
          <li>Add a custom header: <span className="font-mono text-ink">Authorization</span> = <span className="break-all font-mono text-ink">Bearer {t}</span></li>
        </ol>
      )}
      {kind === 'opsgenie' && (
        <ol className="list-decimal space-y-1 pl-4">
          <li>In Opsgenie, go to <span className="text-ink">Settings → Integrations → Add integration → Webhook</span>.</li>
          <li>Webhook URL: <span className="break-all font-mono text-ink">{url}</span></li>
          <li>Tick <span className="text-ink">Add Alert Description to Payload</span> and <span className="text-ink">Add Alert Details to Payload</span>, so labels arrive.</li>
          <li>Add a header: <span className="font-mono text-ink">Authorization</span> = <span className="break-all font-mono text-ink">Bearer {t}</span>. Tags like <span className="font-mono text-ink">team:storage</span> become labels.</li>
        </ol>
      )}
      {kind === 'generic' && (
        <p>POST the sender&apos;s JSON to the URL with the token in an <span className="font-mono text-ink">Authorization: Bearer</span> header (or <span className="font-mono text-ink">X-SupOps-Token</span>). A status of <span className="font-mono text-ink">resolved</span>, <span className="font-mono text-ink">ok</span> or <span className="font-mono text-ink">closed</span> closes the alert.</p>
      )}
      {kind === 'changes' && (
        <>
          <p>
            Add a step at the end of each deploy that POSTs what was deployed. Fields: <span className="font-mono text-ink">service</span>, <span className="font-mono text-ink">version</span>,{' '}
            <span className="font-mono text-ink">environment</span>, <span className="font-mono text-ink">status</span>, <span className="font-mono text-ink">author</span>, <span className="font-mono text-ink">url</span>,{' '}
            <span className="font-mono text-ink">kind</span> (deploy, config, rollback, flag, infra), <span className="font-mono text-ink">id</span> (the same id later updates it), <span className="font-mono text-ink">started_at</span>.
            GitHub <span className="font-mono text-ink">deployment_status</span> webhooks are understood as they are. Changes never open incidents.
          </p>
          <CopyBlock
            label="GitHub Actions step"
            text={`- name: Tell SupOps
  if: always()
  run: |
    curl -sf -X POST '${url}' \\
      -H "Authorization: Bearer \${{ secrets.SUPOPS_CHANGES_TOKEN }}" \\
      -H 'Content-Type: application/json' \\
      -d '{"id":"\${{ github.run_id }}","service":"\${{ github.event.repository.name }}","version":"\${{ github.sha }}","status":"\${{ job.status }}","author":"\${{ github.actor }}","url":"\${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}"}'`}
          />
        </>
      )}
      <p className="pt-1">Or try it from a terminal:</p>
      <CopyBlock label="curl command" text={curl} />
    </div>
  );
}
