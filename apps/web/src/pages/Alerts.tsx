import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell, ExternalLink, Search, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { SEVERITY_STYLE, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, Segmented, Spinner } from '../components/ui';

import type { Alert, AlertList, Run } from '../lib/types';
import { useLivePoll } from '../lib/live';
import { AlertSources } from '../components/alerts/AlertSources';
import { MaintenanceWindows } from '../components/alerts/MaintenanceWindows';
import { CorrelationRules } from '../components/alerts/CorrelationRules';
import { ExtractionRules } from '../components/alerts/ExtractionRules';

const SOURCE_LABEL: Record<string, string> = {
  alertmanager: 'Alertmanager',
  prometheus: 'Prometheus',
  grafana: 'Grafana',
  supops: 'SupOps forecast',
  slack: 'Slack',
  pagerduty: 'PagerDuty',
  opsgenie: 'Opsgenie',
  webhook: 'Webhook',
};

type Tab = 'alerts' | 'sources' | 'maintenance' | 'rules' | 'labels';

const SECTIONS: Array<{ value: Tab; label: string }> = [
  { value: 'alerts', label: 'Alerts' },
  { value: 'sources', label: 'Sources' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'rules', label: 'Grouping' },
  { value: 'labels', label: 'Labels' },
];

export function Alerts() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'alerts';
  const go = (t: Tab) => setParams(t === 'alerts' ? {} : { tab: t }, { replace: true });

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle="Every alert gets a read-only diagnosis as it arrives, like a health scan. Investigate starts the fix from it, and every change waits for your approval."
      />
      <div className="space-y-4 p-6">
        {/* Five sections do not fit a phone's width: a menu there, tabs from tablet width up. */}
        <select className="input sm:hidden" value={tab} aria-label="Section" onChange={(e) => go(e.target.value as Tab)}>
          {SECTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div className="hidden sm:block">
          <Segmented label="Section" value={tab} onChange={go} options={SECTIONS} />
        </div>
        {tab === 'sources' && projectId ? (
          <AlertSources projectId={projectId} isAdmin={isAdmin} />
        ) : tab === 'maintenance' && projectId ? (
          <MaintenanceWindows projectId={projectId} />
        ) : tab === 'rules' && projectId ? (
          <CorrelationRules projectId={projectId} isAdmin={isAdmin} />
        ) : tab === 'labels' && projectId ? (
          <ExtractionRules projectId={projectId} isAdmin={isAdmin} />
        ) : (
          <AlertFeed />
        )}
      </div>
    </>
  );
}

function AlertFeed() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [channel, setChannel] = useState<string | null>(null);
  const [view, setView] = useState<'new' | 'investigating' | 'resolved' | 'maintenance'>('new');

  const q = new URLSearchParams({ projectId: projectId ?? '', status: view });
  if (channel) q.set('channel', channel);

  const list = useQuery({
    queryKey: ['alerts', projectId, channel, view],
    queryFn: () => api<AlertList>(`/alerts?${q.toString()}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['alerts', projectId] });
    void qc.invalidateQueries({ queryKey: ['alertCount', projectId] });
  };

  const investigate = useMutation({
    mutationFn: (id: string) => post<{ run: Pick<Run, 'id'> | null; incidentId?: string; diagnosing?: boolean }>(`/alerts/${id}/investigate`, {}),
    onSuccess: ({ run, incidentId }) => {
      invalidate();
      navigate(run ? `/runs/${run.id}` : `/observability/incidents/${incidentId}`);
    },
  });
  const ignore = useMutation({
    mutationFn: (id: string) => post(`/alerts/${id}/ignore`, {}),
    onSuccess: invalidate,
  });

  const channels = list.data?.channels ?? [];

  return (
    <>
      <div className="space-y-4">
        <Segmented
          label="Show"
          value={view}
          onChange={setView}
          options={[
            { value: 'new', label: `New${list.data?.statusCounts.new ? ` ${list.data.statusCounts.new}` : ''}` },
            { value: 'investigating', label: 'Investigating' },
            { value: 'resolved', label: 'Resolved' },
            ...(list.data?.statusCounts.maintenance || view === 'maintenance'
              ? [{ value: 'maintenance' as const, label: `In maintenance${list.data?.statusCounts.maintenance ? ` ${list.data.statusCounts.maintenance}` : ''}` }]
              : []),
          ]}
        />
        {channels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">Channel</span>
            <button
              onClick={() => setChannel(null)}
              className={clsx(
                'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                !channel ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
              )}
            >
              All
            </button>
            {channels.map((c) => (
              <button
                key={c.channelId}
                onClick={() => setChannel(channel === c.channelId ? null : c.channelId)}
                className={clsx(
                  'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                  channel === c.channelId
                    ? 'border-blue/50 bg-blue/15 text-blue-text'
                    : 'border-edge bg-tile-2 text-muted hover:text-ink',
                )}
              >
                {c.channelName ?? c.channelId}
              </button>
            ))}
          </div>
        )}

        <Panel>
          {list.isLoading ? (
            <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
          ) : list.data?.alerts.length ? (
            <ul className="divide-y divide-hairline">
              {list.data.alerts.map((a) => (
                <AlertRow
                  key={a.id}
                  alert={a}
                  busy={investigate.isPending && investigate.variables === a.id}
                  onInvestigate={() => investigate.mutate(a.id)}
                  onIgnore={() => ignore.mutate(a.id)}
                  actions={view === 'new' || view === 'maintenance'}
                />
              ))}
            </ul>
          ) : (
            <Empty
              icon={<Bell size={26} />}
              title={view === 'new' ? 'No new alerts' : view === 'investigating' ? 'Nothing being investigated' : view === 'maintenance' ? 'Nothing held by maintenance' : 'No resolved alerts'}
              hint={view === 'resolved' ? 'Resolved alerts are kept for 15 days.' : 'New alerts appear here as they fire, and are grouped into incidents on the Observability page.'}
            />
          )}
        </Panel>

        {investigate.error && (
          <p className="text-sm text-red">
            {investigate.error instanceof Error ? investigate.error.message : 'Could not start the investigation'}
          </p>
        )}
      </div>
    </>
  );
}

function AlertRow({
  alert, busy, onInvestigate, onIgnore, actions,
}: {
  alert: Alert;
  busy: boolean;
  onInvestigate: () => void;
  onIgnore: () => void;
  actions: boolean;
}) {
  const sev = SEVERITY_STYLE[alert.severity] ?? SEVERITY_STYLE.unknown!;
  const diagnosing = alert.diagnosis?.triageState === 'evidence' || alert.diagnosis?.triageState === 'running';

  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 sm:flex-nowrap sm:px-5">
      <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', sev.dot)} aria-hidden />

      {/* On a phone the buttons drop below the text instead of squeezing it. */}
      <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-auto">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('chip border', sev.chip)}>{sev.label}</span>
          <span className="truncate text-[13px] font-medium text-ink">{alert.title}</span>
          {alert.count > 1 && (
            <span className="tabular rounded border border-edge px-1.5 py-px text-[10px] text-muted">×{alert.count}</span>
          )}
          {alert.maintenanceName && !alert.incidentId && (
            <span className="chip border border-blue/40 bg-blue/10 text-blue-text" title="Held by a maintenance window: no incident or diagnosis until it ends.">
              In maintenance: {alert.maintenanceName}
            </span>
          )}
          {alert.flapping && (
            <span className="chip border border-amber/40 bg-amber/10 text-amber" title="Firing and resolving over and over. It stays one incident, and is diagnosed once it settles.">
              Flapping
            </span>
          )}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          <span>{alert.channelName ? <span className="font-mono text-cyan">{alert.channelName}</span> : alert.sourceName ?? SOURCE_LABEL[alert.source] ?? alert.source}</span>
          {alert.labels?.instance && <><span aria-hidden>·</span><span className="font-mono">{alert.labels.instance}</span></>}
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">{timeAgo(alert.lastSeenAt)}</span>
          {alert.slackPermalink && (
            <a
              href={alert.slackPermalink}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-muted hover:text-ink"
            >
              <ExternalLink size={11} /> Slack
            </a>
          )}
          {alert.incidentId && (
            <Link to={`/observability/incidents/${alert.incidentId}`} className="text-blue-text hover:underline">incident</Link>
          )}
          {alert.runId && (
            <Link to={`/runs/${alert.runId}`} className="text-blue-text hover:underline">investigation</Link>
          )}
        </div>

        {alert.summary && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{alert.summary}</p>}
        <Diagnosis alert={alert} />
      </div>

      {actions && <div className="flex shrink-0 items-center gap-2 pl-[26px] sm:pl-0">
        <button
          className="btn-primary !min-h-[34px] !text-xs"
          disabled={busy}
          onClick={onInvestigate}
          title={diagnosing ? 'The read-only diagnosis is still running' : 'Starts from the diagnosis and proposes the fix; every change waits for your approval'}
        >
          {busy ? <Spinner /> : <Search size={13} />} {diagnosing ? 'View diagnosis' : 'Investigate'}
        </button>
        <button className="btn-ghost !min-h-[34px] !text-xs" onClick={onIgnore} title="Ignore this alert">
          <X size={13} /> Ignore
        </button>
      </div>}
    </li>
  );
}

/** What the automatic, read-only diagnosis found -- or that it is still running. */
function Diagnosis({ alert }: { alert: Alert }) {
  const d = alert.diagnosis;
  if (!d || !alert.incidentId) return null;
  const base = 'mt-2 flex items-start gap-2 rounded-inner border px-2.5 py-1.5 text-xs leading-relaxed';
  if (d.triageState === 'evidence' || d.triageState === 'running') {
    return (
      <div className={clsx(base, 'border-blue/25 bg-blue/[0.06] text-muted')}>
        <Spinner className="!mt-0.5 !h-3 !w-3 shrink-0 text-blue" />
        <span>
          {d.triageState === 'evidence' ? 'Gathering evidence' : 'Diagnosing, read-only'}…{' '}
          <Link className="text-blue-text hover:underline" to={d.runId ? `/runs/${d.runId}` : `/observability/incidents/${alert.incidentId}`}>watch</Link>
        </span>
      </div>
    );
  }
  if (d.triageState === 'done' && d.rootCause) {
    return (
      <div className={clsx(base, 'border-hairline bg-tile-2/50')}>
        <span className="shrink-0 font-medium text-ink">Diagnosis</span>
        <span className="min-w-0 text-ink/85">
          <span className="line-clamp-2">{d.rootCause}</span>
          <span className="text-[11px] text-muted">
            {d.confidence ? `${d.confidence} confidence · ` : ''}
            <Link className="text-blue-text hover:underline" to={`/observability/incidents/${alert.incidentId}`}>evidence</Link>
            {d.runId && <> · <Link className="text-blue-text hover:underline" to={`/runs/${d.runId}`}>report</Link></>}
          </span>
        </span>
      </div>
    );
  }
  if (d.triageNote) return <p className="mt-1.5 text-[11px] text-muted">{d.triageNote}</p>;
  return null;
}
