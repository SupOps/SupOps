import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Gauge, Plus, Trash2 } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { useLivePoll } from '../lib/live';
import { Empty, Field, Panel, Spinner, Switch } from '../components/ui';
import { PageHeader } from '../components/Layout';
import { LineChart } from '../components/viz';
import type { Target } from '../lib/types';

export interface Slo {
  id: string;
  name: string;
  service?: string | null;
  target: number;
  windowDays: number;
  alerting?: boolean;
  goodQuery?: string;
  totalQuery?: string;
  status: null | {
    at: number;
    sli: number | null;
    budgetRemaining: number | null;
    rates: Record<string, number | null>;
    firing: Array<{ rule: string; severity: 'critical' | 'warning'; long: string; short: string; burn: number }>;
    error?: string;
  };
}

const pctText = (v: number | null | undefined, digits = 2) => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(digits)}%`);

/** How one SLO stands: the SLI against its target, the budget left, and what is burning. */
export function SloCard({ slo, compact, onDelete }: { slo: Slo; compact?: boolean; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const st = slo.status;
  const left = st?.budgetRemaining ?? null;
  const tone = left === null ? 'text-muted' : left < 0 ? 'text-red' : left < 0.25 ? 'text-amber' : 'text-green';
  const budget = useQuery({ queryKey: ['slo-budget', slo.id], queryFn: () => api<{ points: Array<[number, number]> }>(`/slos/${slo.id}/budget`), enabled: open });
  return (
    <div className={clsx('rounded-inner border bg-tile-2/40 p-3.5', st?.firing.length ? 'border-red/40' : 'border-hairline')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[12rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{slo.name}</span>
            {st?.firing.map((f) => (
              <span key={f.rule} className={clsx('chip whitespace-nowrap !text-[10.5px]', f.severity === 'critical' ? 'border-red/30 bg-red/10 text-red' : 'border-amber/30 bg-amber/10 text-amber')}>
                burning {f.burn}× ({f.long}/{f.short})
              </span>
            ))}
          </div>
          <p className="mt-1 text-[11px] text-muted">
            Objective {pctText(slo.target, slo.target >= 0.999 ? 2 : 1)} over {slo.windowDays} days{slo.service && !compact ? <> · <Link className="text-blue-text hover:underline" to={`/services/${encodeURIComponent(slo.service)}`}>{slo.service}</Link></> : null}
            {st ? ` · checked ${timeAgo(new Date(st.at).toISOString())}` : ''}
          </p>
          {st?.error && <p className="mt-1 text-xs text-amber">{st.error}</p>}
        </div>
        <dl className="flex gap-5 text-right">
          <div><dt className="text-[10px] uppercase tracking-wide text-muted">Now</dt><dd className="font-mono text-sm text-ink">{pctText(st?.sli)}</dd></div>
          <div><dt className="text-[10px] uppercase tracking-wide text-muted">Budget left</dt><dd className={clsx('font-mono text-sm', tone)}>{left === null ? '–' : `${Math.round(left * 100)}%`}</dd></div>
        </dl>
        {onDelete && <button className="btn-ghost !px-2.5" onClick={onDelete} aria-label={`Remove ${slo.name}`}><Trash2 size={13} /></button>}
      </div>
      {left !== null && (
        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-hairline" aria-hidden>
          <div className={clsx('h-full rounded-full', left < 0 ? 'bg-red' : left < 0.25 ? 'bg-amber' : 'bg-green')} style={{ width: `${Math.max(2, Math.min(100, left * 100))}%` }} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        {st && ['5m', '1h', '6h', '24h'].map((w) => <span key={w}>burn {w}: <span className="font-mono text-ink/85">{st.rates[w] == null ? '–' : `${st.rates[w]!.toFixed(1)}×`}</span></span>)}
        <button className="ml-auto text-blue-text hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide the budget' : 'Budget over time'}</button>
      </div>
      {open && (
        <div className="mt-2">
          {budget.isLoading ? <Spinner /> : <LineChart series={[{ key: 'b', name: 'budget left', points: (budget.data?.points ?? []).map(([t, v]) => [t, v * 100] as [number, number]) }]} unit="percent" height={130} limit={0} empty="No history yet" />}
        </div>
      )}
    </div>
  );
}

export function Slos() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['slos', projectId], queryFn: () => api<Slo[]>(`/slos?projectId=${projectId}`), enabled: !!projectId, refetchInterval: useLivePoll(60_000) });
  const [adding, setAdding] = useState(false);
  const remove = useMutation({ mutationFn: (id: string) => del(`/slos/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['slos', projectId] }) });
  return (
    <>
      <PageHeader
        title="SLOs"
        subtitle="What good looks like for a service, and how fast its error budget is going. Burn-rate alerts (14.4× over 1h, 6× over 6h, 3× over a day, each confirmed by a short window) arrive as ordinary alerts."
        action={isAdmin && !adding ? <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> New SLO</button> : undefined}
      />
      <div className="space-y-3 px-4 pb-8 pt-2 sm:px-6">
        {adding && projectId && <SloForm projectId={projectId} onDone={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ['slos', projectId] }); }} onCancel={() => setAdding(false)} />}
        {list.isLoading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : list.data?.length ? (
          list.data.map((s) => <SloCard key={s.id} slo={s} {...(isAdmin ? { onDelete: () => remove.mutate(s.id) } : {})} />)
        ) : (
          !adding && (
            <Panel>
              <Empty icon={<Gauge size={26} />} title="No SLOs yet" hint="Define one from good and total PromQL, or open a service on the Services page and make an availability SLO from its request metrics in one click." />
            </Panel>
          )
        )}
      </div>
    </>
  );
}

function SloForm({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const conns = useQuery({ queryKey: ['targets', projectId], queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`) });
  const metrics = (conns.data ?? []).filter((t) => t.kind === 'prometheus' || t.kind === 'grafana');
  const [f, setF] = useState({ name: '', service: '', connectionId: '', good: 'sum(rate(http_requests_total{job="api",code!~"5.."}[$window]))', total: 'sum(rate(http_requests_total{job="api"}[$window]))', target: '99.9', windowDays: '30', alerting: true });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const conn = f.connectionId || metrics[0]?.id || '';
  const payload = { projectId, connectionId: conn, goodQuery: f.good.trim(), totalQuery: f.total.trim(), windowDays: Number(f.windowDays) };
  const preview = useMutation({ mutationFn: () => post<{ lastHour: number | null; window: number | null; ok: boolean }>('/slos/preview', payload) });
  const save = useMutation({
    mutationFn: () => post('/slos', { ...payload, name: f.name.trim(), ...(f.service.trim() ? { service: f.service.trim() } : {}), target: Number(f.target) / 100, alerting: f.alerting }),
    onSuccess: onDone,
  });
  return (
    <Panel title="New SLO" accent="bg-green">
      <div className="space-y-3 px-5 pb-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={f.name} onChange={set('name')} placeholder="Checkout availability" /></Field>
          <Field label="Service (optional)" hint="Shows the SLO on that service's page, and labels its alerts."><input className="input" value={f.service} onChange={set('service')} placeholder="checkout" /></Field>
        </div>
        <Field label="Metrics connection">
          <select className="input" value={conn} onChange={set('connectionId')}>
            {metrics.map((m) => <option key={m.id} value={m.id}>{m.slug}</option>)}
          </select>
        </Field>
        {!metrics.length && <p className="text-xs text-amber">Add a Prometheus or Grafana connection first.</p>}
        <Field label="Good events" hint="PromQL with $window where the window goes, e.g. requests that did not fail.">
          <textarea className="input min-h-16 font-mono text-xs" value={f.good} onChange={set('good')} />
        </Field>
        <Field label="All events"><textarea className="input min-h-16 font-mono text-xs" value={f.total} onChange={set('total')} /></Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Objective (%)"><input className="input font-mono" inputMode="decimal" value={f.target} onChange={set('target')} /></Field>
          <Field label="Window (days)"><input className="input font-mono" inputMode="numeric" value={f.windowDays} onChange={set('windowDays')} /></Field>
          <Field label="Burn-rate alerts">
            <label className="flex h-[38px] items-center gap-2 text-sm text-ink"><Switch label="Alert on burn rate" checked={f.alerting} onChange={(v) => setF({ ...f, alerting: v })} /> {f.alerting ? 'On' : 'Off'}</label>
          </Field>
        </div>
        {preview.data && (
          <p className={clsx('text-xs', preview.data.ok ? 'text-ink/85' : 'text-amber')}>
            {preview.data.ok ? `Now: ${pctText(preview.data.lastHour)} over the last hour, ${pctText(preview.data.window)} over the window.` : 'The queries return no data. Check the metric names and labels.'}
          </p>
        )}
        {(save.error || preview.error) && <p className="text-xs text-red">{((save.error || preview.error) as Error).message}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" disabled={!conn || preview.isPending} onClick={() => preview.mutate()}>{preview.isPending ? <Spinner /> : null} Try the queries</button>
          <button className="btn-primary" disabled={!conn || !f.name.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} Save</button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
