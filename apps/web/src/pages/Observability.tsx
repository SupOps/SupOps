import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Activity, ArrowRight, Hourglass, Pencil, Plus, RadioTower, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import { formatEta, formatValue } from '@supops/shared';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from '../components/ui';
import { LineChart, seriesColor } from '../components/viz';
import type { Incident, ObsConnection, Observation, ObservabilityOverview, Watch } from '../lib/types';
import { SignalsView } from '../components/SignalsView';
import { ObsOverview, plain } from '../components/ObsOverview';
import { ORIGIN_LABEL, VERDICT, verdictOf } from '../lib/observe-ui';
import { useLivePoll } from '../lib/live';
import { ChangeList } from '../components/Changes';
import { ErrorList } from '../components/Errors';
import { LogPatterns } from '../components/LogPatterns';

type Tab = 'overview' | 'incidents' | 'signals' | 'changes' | 'errors' | 'logs';

const SEV_DOT: Record<string, string> = { critical: 'bg-red', warning: 'bg-amber', info: 'bg-cyan', unknown: 'bg-dim' };
const SEV_TEXT: Record<string, string> = { critical: 'text-red', warning: 'text-amber', info: 'text-cyan', unknown: 'text-muted' };

export function Observability() {
  const projectId = useApp((s) => s.projectId);
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const navigate = useNavigate();

  const overview = useQuery({
    queryKey: ['obs', projectId],
    queryFn: () => api<ObservabilityOverview>(`/observability/overview?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(10_000),
  });

  const stack = useMutation({
    mutationFn: () => post<{ run: { id: string } }>('/observability/stack-investigate', { projectId }),
    onSuccess: ({ run }) => navigate(`/runs/${run.id}`),
  });

  const conns = overview.data?.connections ?? [];
  return (
    <>
      <PageHeader
        title="Observability"
        subtitle="Alerts grouped into incidents, investigated as they open. Signals watched for what is unusual and what is about to run out."
        action={
          conns.length > 0 ? (
            <button className="btn-ghost !min-h-[38px]" disabled={stack.isPending} onClick={() => stack.mutate()} title="Check that the monitoring itself works: scraping, rules, notifications, storage.">
              {stack.isPending ? <Spinner /> : <Search size={15} />} Check the stack
            </button>
          ) : undefined
        }
      />
      <div className="space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <Segmented
          label="View"
          value={tab}
          onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'incidents', label: 'Incidents' },
            { value: 'signals', label: 'Signals' },
            { value: 'changes', label: 'Changes' },
            { value: 'errors', label: 'Errors' },
            { value: 'logs', label: 'Logs' },
          ]}
        />
        {stack.isError && <p className="text-sm text-red">{(stack.error as Error).message}</p>}
        {tab === 'changes' ? (
          // Changes come from CI and SupOps itself too: they need no connection.
          <ChangeList projectId={projectId!} />
        ) : overview.isLoading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : !conns.length ? (
          <Panel>
            <Empty
              icon={<RadioTower size={28} />}
              title="No metrics, logs or alerts connected"
              hint="Add a Prometheus, Grafana, Alertmanager, Loki or Elasticsearch connection. SupOps reads alerts from it, watches its signals and gathers evidence when something breaks. Everything it does there is read-only."
              action={<Link to="/targets" className="btn-primary">Add a connection</Link>}
            />
          </Panel>
        ) : tab === 'logs' ? (
          <LogPatterns projectId={projectId!} connections={conns} />
        ) : tab === 'errors' ? (
          <ErrorList projectId={projectId!} />
        ) : tab === 'incidents' ? (
          <IncidentList projectId={projectId!} />
        ) : tab === 'signals' ? (
          <Signals projectId={projectId!} connections={conns} />
        ) : (
          <ObsOverview data={overview.data!} onNavigate={(t) => setParams({ tab: t }, { replace: true })} />
        )}
      </div>
    </>
  );
}

// ---- overview ----------------------------------------------------------------------

export function IncidentRow({ incident: i }: { incident: Incident }) {
  const v = VERDICT[verdictOf(i)];
  return (
    <li>
      <Link to={`/observability/incidents/${i.id}`} className="group flex items-start gap-3 px-5 py-3 transition-colors hover:bg-white/[0.03]">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {i.status === 'open' && <span className={clsx('chip whitespace-nowrap', v.chip)} title={v.hint}>{v.label}</span>}
            <span className="truncate text-sm font-medium text-ink">{i.title}</span>
            {i.acknowledgedAt && <span className="chip whitespace-nowrap border border-green/40 bg-green/10 text-green" title="Someone is on it">Acknowledged</span>}
            {i.assigneeName && <span className="whitespace-nowrap text-[11px] text-muted">· {i.assigneeName}</span>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted">
            {i.status === 'ignored' ? (
              <>Ignored{i.ignoredBy ? ` by ${i.ignoredBy}` : ''}{i.ignoredUntil ? ` until ${new Date(i.ignoredUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}{i.ignoreReason ? ` · ${i.ignoreReason}` : ''}</>
            ) : (
              i.rootCause ? plain(i.rootCause) : v.hint
            )}
          </div>
        </div>
        <div className="hidden shrink-0 text-right text-[11px] text-dim sm:block">
          <div>{ORIGIN_LABEL[i.origin]}</div>
          <div>{timeAgo(i.status === 'open' ? i.openedAt : i.resolvedAt)}</div>
        </div>
        <ArrowRight size={13} className="mt-1 shrink-0 text-dim" />
      </Link>
    </li>
  );
}

// ---- incidents -----------------------------------------------------------------------

function IncidentList({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<'open' | 'ignored' | 'resolved'>('open');
  const list = useQuery({
    queryKey: ['incidents', projectId, status],
    queryFn: () => api<Incident[]>(`/observability/incidents?projectId=${projectId}&status=${status}`),
    refetchInterval: useLivePoll(10_000),
  });
  const title = { open: 'Open incidents', ignored: 'Ignored incidents', resolved: 'Resolved incidents' }[status];
  const empty = {
    open: 'No open incidents.',
    ignored: 'Nothing is ignored. An ignore always ends: the incident is checked again then and reopens if it is still happening.',
    resolved: 'No resolved incidents in the last 15 days.',
  }[status];
  return (
    <Panel
      title={title}
      accent={status === 'open' ? 'bg-red' : status === 'ignored' ? 'bg-dim' : 'bg-green'}
      action={
        <Segmented
          label="Status"
          value={status}
          onChange={setStatus}
          options={[{ value: 'open', label: 'Open' }, { value: 'ignored', label: 'Ignored' }, { value: 'resolved', label: 'Resolved' }]}
        />
      }
    >
      {list.isLoading ? (
        <div className="grid place-items-center py-10"><Spinner /></div>
      ) : list.data?.length ? (
        <ul className="divide-y divide-hairline border-t border-hairline">{list.data.map((i) => <IncidentRow key={i.id} incident={i} />)}</ul>
      ) : (
        <p className="px-5 pb-5 text-sm text-muted">{empty}</p>
      )}
    </Panel>
  );
}

// ---- signals ---------------------------------------------------------------------------

function Signals({ projectId, connections }: { projectId: string; connections: ObsConnection[] }) {
  const metricConns = connections.filter((c) => c.kind === 'prometheus' || c.kind === 'grafana');
  return (
    <SignalsView
      projectId={projectId}
      connections={connections}
      renderForm={({ existing, onDone }) =>
        existing ? <WatchForm projectId={projectId} connections={metricConns} existing={existing} onDone={onDone} /> : <AddWatch projectId={projectId} connections={metricConns} onDone={onDone} />
      }
    />
  );
}

function AddWatch({ projectId, connections, onDone }: { projectId: string; connections: ObsConnection[]; onDone: () => void }) {
  return <WatchForm projectId={projectId} connections={connections} onDone={onDone} />;
}

/**
 * Create or edit a watched signal. Saving an edit re-evaluates it straight away:
 * what it flags as unusual or running out, and the incidents it predicted, follow
 * the new settings rather than the old ones.
 */
function WatchForm({ projectId, connections, existing, onDone }: { projectId: string; connections: ObsConnection[]; existing?: Watch; onDone: (msg?: string) => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    connectionId: existing?.connectionId ?? connections[0]?.id ?? '',
    title: existing?.title ?? '',
    query: existing?.query ?? '',
    unit: existing?.unit ?? 'count',
    badDirection: existing?.badDirection ?? ('up' as 'up' | 'down' | 'both'),
    limit: existing?.limit ? String(existing.limit.value) : '',
    when: existing?.limit?.when ?? ('below' as 'below' | 'above'),
    adaptive: existing?.adaptive ? String(existing.adaptive.iqrs) : '',
  });
  const limit = form.limit.trim() ? { value: Number(form.limit), when: form.when } : null;
  const adaptive = form.adaptive ? { iqrs: Number(form.adaptive) } : null;
  const save = useMutation({
    mutationFn: () =>
      existing
        ? patch<{ reevaluated: boolean; error?: string }>(`/observability/watches/${existing.id}`, { title: form.title, query: form.query, unit: form.unit, badDirection: form.badDirection, limit, adaptive })
        : post('/observability/watches', { projectId, connectionId: form.connectionId, title: form.title, query: form.query, unit: form.unit, badDirection: form.badDirection, limit, adaptive }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['watches', projectId] });
      void qc.invalidateQueries({ queryKey: ['watch'] });
      void qc.invalidateQueries({ queryKey: ['obs', projectId] });
      const res = r as { reevaluated?: boolean; error?: string } | undefined;
      onDone(res?.error ? `Saved, but the query failed: ${res.error}` : res?.reevaluated ? 'Saved and re-evaluated: what it flags now follows the new settings.' : 'Saved.');
    },
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const queryChanged = !!existing && form.query.trim() !== existing.query;
  const body = (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={form.title} placeholder="Checkout queue depth" onChange={set('title')} /></Field>
        <Field label="Connection">
          <select className="input" value={form.connectionId} onChange={set('connectionId')} disabled={!!existing}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.slug}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="PromQL" hint={queryChanged ? 'A new query starts fresh: the samples kept so far are dropped and the history reloaded.' : 'Aggregate it (sum by …) so it returns a few series, not thousands. At most 50 are kept. Replace Grafana variables like $Vm_Name.'}>
            <textarea className="input min-h-[64px] font-mono text-[12px]" value={form.query} placeholder='sum by (queue) (rabbitmq_queue_messages_ready)' onChange={set('query')} />
          </Field>
        </div>
        <Field label="Unit">
          <select className="input" value={form.unit} onChange={set('unit')}>
            {['count', 'percent', 'bytes', 'seconds', 'per_second', 'ratio', 'days'].map((u) => <option key={u} value={u}>{u.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="A problem when it goes">
          <select className="input" value={form.badDirection} onChange={set('badDirection')}>
            <option value="up">up</option>
            <option value="down">down</option>
            <option value="both">either way</option>
          </select>
        </Field>
        <Field label="Runs out at (optional)" hint="Forecast when the value reaches this. Clear it to stop forecasting.">
          <div className="flex gap-2">
            <select className="input !w-auto" value={form.when} onChange={set('when')}>
              <option value="below">below</option>
              <option value="above">above</option>
            </select>
            <input className="input font-mono" inputMode="decimal" value={form.limit} placeholder="e.g. 0" onChange={set('limit')} />
          </div>
        </Field>
        <Field label="Self-adjusting threshold" hint="Each series learns its own limit from its last 7 days (its 99th percentile, plus a margin of its usual spread) and relearns it daily. 3 of 5 minutes past it raise an alert.">
          <select className="input" value={form.adaptive} onChange={set('adaptive')}>
            <option value="">Off</option>
            <option value="1">On, tight (1x spread)</option>
            <option value="2">On (2x spread)</option>
            <option value="3">On, loose (3x spread)</option>
          </select>
        </Field>
      </div>
      {save.isError && <p className="mt-3 text-sm text-red">{(save.error as Error).message}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-primary" disabled={save.isPending || !form.title.trim() || !form.query.trim() || !form.connectionId || (!!form.limit.trim() && !Number.isFinite(Number(form.limit)))} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : <Sparkles size={14} />} {existing ? (save.isPending ? 'Saving and re-evaluating…' : 'Save') : 'Start watching'}
        </button>
        <button className="btn-ghost" onClick={() => onDone()}>Cancel</button>
      </div>
    </>
  );
  return <div>{body}</div>;
}
