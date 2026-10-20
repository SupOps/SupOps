import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Gauge, Globe, Play, Plus, Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { useLivePoll } from '../lib/live';
import { Empty, Field, Panel, Spinner, Switch } from '../components/ui';
import { PageHeader } from '../components/Layout';

interface Check {
  id: string;
  name: string;
  kind: 'http' | 'tcp' | 'dns' | 'tls';
  target: string;
  port: number | null;
  intervalSec: number;
  failThreshold: number;
  allowPrivate: boolean;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: 'up' | 'degraded' | 'down' | null;
  lastError: string | null;
  uptime: { day: number | null; week: number | null; month: number | null };
  latencyP50: number | null;
  recent: Array<{ at: number; ok: boolean; latencyMs: number | null }>;
}

const DOT = { up: 'bg-green', degraded: 'bg-amber', down: 'bg-red' } as const;
const pct = (v: number | null) => (v === null ? '–' : `${(v * 100).toFixed(v >= 0.9995 || v === 0 ? 0 : 2)}%`);
const every = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

export function Synthetics() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['synthetics', projectId], queryFn: () => api<Check[]>(`/synthetics?projectId=${projectId}`), enabled: !!projectId, refetchInterval: useLivePoll(30_000) });
  const [adding, setAdding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['synthetics', projectId] });
  return (
    <>
      <PageHeader
        title="Synthetics"
        subtitle="Checks SupOps runs on a schedule from its own server: is the site up and saying the right thing, does the port answer, does the name resolve, when does the certificate expire. Failures in a row raise an alert; every run counts towards availability."
        action={isAdmin && !adding ? <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> New check</button> : undefined}
      />
      <div className="space-y-3 px-4 pb-8 pt-2 sm:px-6">
        {adding && projectId && <CheckForm projectId={projectId} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}
        {list.isLoading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : list.data?.length ? (
          list.data.map((c) => <CheckRow key={c.id} c={c} isAdmin={isAdmin} onChanged={refresh} />)
        ) : (
          !adding && <Panel><Empty icon={<Globe size={26} />} title="No checks yet" hint="Add one for each address people depend on: the shop's home page, its API health endpoint, the database port, the domain's certificate." /></Panel>
        )}
      </div>
    </>
  );
}

function CheckRow({ c, isAdmin, onChanged }: { c: Check; isAdmin: boolean; onChanged: () => void }) {
  const [sure, setSure] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = useMutation({ mutationFn: () => post<{ result: { status: string; latencyMs: number | null; error?: string } }>(`/synthetics/${c.id}/run`, {}), onSuccess: (r) => { setNote(`${r.result.status}${r.result.latencyMs !== null ? ` in ${r.result.latencyMs} ms` : ''}${r.result.error ? `: ${r.result.error}` : ''}`); onChanged(); } });
  const toggle = useMutation({ mutationFn: () => patch(`/synthetics/${c.id}`, { enabled: !c.enabled }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => del(`/synthetics/${c.id}`), onSuccess: onChanged });
  const slo = useMutation({ mutationFn: () => post(`/synthetics/${c.id}/slo`, { target: 0.999 }), onSuccess: () => setNote('A 99.9% availability SLO now measures this check (see SLOs).') });
  return (
    <div className={clsx('rounded-inner border bg-tile-2/40 p-3.5', c.lastStatus === 'down' ? 'border-red/40' : 'border-hairline', !c.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', c.lastStatus ? DOT[c.lastStatus] : 'bg-dim')} aria-label={c.lastStatus ?? 'not run yet'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{c.name}</span>
            <span className="chip border border-edge bg-tile-2 text-muted">{c.kind.toUpperCase()}</span>
            {c.allowPrivate && <span className="chip border border-edge bg-tile-2 text-muted">internal</span>}
          </div>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted">{c.target}{c.port ? `:${c.port}` : ''}</p>
          <p className="mt-0.5 text-[11px] text-muted">every {every(c.intervalSec)} · alert after {c.failThreshold} failure{c.failThreshold === 1 ? '' : 's'} in a row{c.lastRunAt ? ` · last run ${timeAgo(c.lastRunAt)}` : ''}{c.latencyP50 !== null ? ` · median ${c.latencyP50} ms` : ''}</p>
          {c.lastError && <p className={clsx('mt-1 text-xs', c.lastStatus === 'down' ? 'text-red' : 'text-amber')}>{c.lastError}</p>}
        </div>
        <dl className="flex gap-4 text-right">
          {(['day', 'week', 'month'] as const).map((k) => (
            <div key={k}><dt className="text-[10px] uppercase tracking-wide text-muted">{k === 'day' ? '24 h' : k === 'week' ? '7 d' : '30 d'}</dt><dd className="font-mono text-sm text-ink">{pct(c.uptime[k])}</dd></div>
          ))}
        </dl>
      </div>
      {c.recent.length > 0 && (
        <div className="mt-2.5 flex h-4 gap-px" aria-label="Recent runs, oldest first">
          {c.recent.map((r) => <span key={r.at} title={`${new Date(r.at).toLocaleString()}: ${r.ok ? 'ok' : 'failed'}${r.latencyMs !== null ? `, ${r.latencyMs} ms` : ''}`} className={clsx('min-w-[3px] flex-1 rounded-sm', r.ok ? 'bg-green/70' : 'bg-red')} />)}
        </div>
      )}
      {isAdmin && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <button className="btn-ghost !min-h-[32px] !text-xs" disabled={run.isPending} onClick={() => run.mutate()}>{run.isPending ? <Spinner /> : <Play size={13} />} Run now</button>
          <button className="btn-ghost !min-h-[32px] !text-xs" disabled={slo.isPending} onClick={() => slo.mutate()}><Gauge size={13} /> Make an SLO</button>
          <span className="flex items-center gap-2 text-xs text-muted"><Switch label={c.enabled ? 'Pause' : 'Resume'} checked={c.enabled} onChange={() => toggle.mutate()} /> {c.enabled ? 'On' : 'Paused'}</span>
          <div className="flex-1" />
          {sure ? <button className="btn-ghost !min-h-[32px] !text-xs !text-red" onClick={() => remove.mutate()}>Remove it and its history?</button> : <button className="btn-ghost !min-h-[32px] !px-2.5" onClick={() => setSure(true)} aria-label={`Remove ${c.name}`}><Trash2 size={13} /></button>}
        </div>
      )}
      {note && <p className="mt-2 text-xs text-ink/85">{note}</p>}
      {(run.error || slo.error || toggle.error || remove.error) && <p className="mt-2 text-xs text-red">{((run.error || slo.error || toggle.error || remove.error) as Error).message}</p>}
    </div>
  );
}

function CheckForm({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const [f, setF] = useState({ name: '', kind: 'http' as Check['kind'], target: 'https://', port: '', contains: '', expectStatus: '', maxLatencyMs: '', intervalSec: '300', failThreshold: '2', allowPrivate: false });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const num = (v: string) => (v.trim() ? Number(v) : null);
  const save = useMutation({
    mutationFn: () =>
      post('/synthetics', {
        projectId, name: f.name.trim(), kind: f.kind, target: f.target.trim(), port: num(f.port), contains: f.contains || null, expectStatus: f.expectStatus.trim() || null,
        maxLatencyMs: num(f.maxLatencyMs), intervalSec: Number(f.intervalSec), failThreshold: Number(f.failThreshold), allowPrivate: f.allowPrivate,
      }),
    onSuccess: onDone,
  });
  return (
    <Panel title="New check" accent="bg-cyan">
      <div className="space-y-3 px-5 pb-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name"><input className="input" value={f.name} onChange={set('name')} placeholder="Shop home page" /></Field>
          <Field label="Kind">
            <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Check['kind'], target: e.target.value === 'http' ? 'https://' : '' })}>
              <option value="http">HTTP: the page answers as it should</option>
              <option value="tcp">TCP: the port accepts connections</option>
              <option value="dns">DNS: the name resolves</option>
              <option value="tls">TLS: the certificate is valid and not expiring</option>
            </select>
          </Field>
          <Field label={f.kind === 'http' ? 'URL' : 'Host'}><input className="input font-mono text-xs" value={f.target} onChange={set('target')} placeholder={f.kind === 'http' ? 'https://shop.example.test/' : 'db.example.test'} /></Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {(f.kind === 'tcp' || f.kind === 'tls') && <Field label="Port"><input className="input font-mono" inputMode="numeric" value={f.port} onChange={set('port')} placeholder={f.kind === 'tls' ? '443' : '5432'} /></Field>}
          {(f.kind === 'http' || f.kind === 'dns') && <Field label={f.kind === 'http' ? 'Must contain (optional)' : 'Must resolve to (optional)'}><input className="input" value={f.contains} onChange={set('contains')} /></Field>}
          {f.kind === 'http' && <Field label="Accepted status (optional)"><input className="input font-mono" value={f.expectStatus} onChange={set('expectStatus')} placeholder="200-399" /></Field>}
          <Field label="Slow above (ms, optional)"><input className="input font-mono" inputMode="numeric" value={f.maxLatencyMs} onChange={set('maxLatencyMs')} /></Field>
          <Field label="Every">
            <select className="input" value={f.intervalSec} onChange={set('intervalSec')}>
              {[60, 300, 900, 3600].map((s) => <option key={s} value={s}>{every(s)}</option>)}
            </select>
          </Field>
          <Field label="Alert after failures"><select className="input" value={f.failThreshold} onChange={set('failThreshold')}>{[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n} in a row</option>)}</select></Field>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={f.allowPrivate} onChange={(e) => setF({ ...f, allowPrivate: e.target.checked })} /> Allow an internal address (10.x, 192.168.x, *.internal). Cloud metadata addresses are always refused.
        </label>
        {save.error && <p className="text-sm text-red">{(save.error as Error).message}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="btn-primary" disabled={!f.name.trim() || !f.target.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} Save and run</button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
