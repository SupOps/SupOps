import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ChevronDown, ChevronRight, KeyRound, Plus, Radio, Send, Trash2 } from 'lucide-react';
import { api, del, patch, post, put } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Empty, Field, Panel, Spinner, Switch } from '../ui';
import type { AlertSource, AlertSourceKind, GenericMapping } from '../../lib/types';
import { KIND_HINT, KIND_LABEL, SourceSetup } from './SourceSetup';

const KINDS: AlertSourceKind[] = ['alertmanager', 'grafana', 'pagerduty', 'opsgenie', 'generic', 'changes'];

/** A token, shown once: right after the source is created or its token rotated. */
interface Revealed {
  id: string;
  token: string;
}

export function AlertSources({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['alertSources', projectId], queryFn: () => api<AlertSource[]>(`/alert-sources?projectId=${projectId}`) });
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alertSources', projectId] });

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        Senders that push alerts to SupOps the moment they fire. Each has its own token, so one can be rotated or removed without touching the others.
        Alertmanager, Grafana and Prometheus can also be read by SupOps directly: add them as connections on the <Link className="text-blue-text hover:underline" to="/targets">Targets</Link> page.
      </p>

      {isAdmin && !adding && (
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Add a source
        </button>
      )}
      {adding && (
        <AddSource
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onCreated={(source, token) => {
            setAdding(false);
            setRevealed({ id: source.id, token });
            refresh();
          }}
        />
      )}

      {list.isLoading ? (
        <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
      ) : list.data?.length ? (
        list.data.map((s) => (
          <SourceCard
            key={s.id}
            source={s}
            isAdmin={isAdmin}
            token={revealed?.id === s.id ? revealed.token : null}
            onToken={(token) => setRevealed({ id: s.id, token })}
            onChanged={refresh}
          />
        ))
      ) : (
        !adding && (
          <Panel>
            <Empty
              icon={<Radio size={26} />}
              title="No alert sources yet"
              hint={isAdmin ? 'Add one to receive alerts from Alertmanager, Grafana, PagerDuty, Opsgenie or any tool that can send a webhook.' : 'An admin can add one.'}
            />
          </Panel>
        )
      )}
    </div>
  );
}

function AddSource({ projectId, onCancel, onCreated }: { projectId: string; onCancel: () => void; onCreated: (s: AlertSource, token: string) => void }) {
  const [kind, setKind] = useState<AlertSourceKind>('alertmanager');
  const [name, setName] = useState('');
  const [mapping, setMapping] = useState<GenericMapping>({});
  const create = useMutation({
    mutationFn: () => post<{ source: AlertSource; token: string }>('/alert-sources', { projectId, kind, name: name.trim() || KIND_LABEL[kind], mapping: kind === 'generic' ? mapping : undefined }),
    onSuccess: (r) => onCreated(r.source, r.token),
  });

  return (
    <Panel title="Add an alert source" className="p-5 pt-0">
      <div className="space-y-4">
        <div role="radiogroup" aria-label="What sends the alerts" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => setKind(k)}
              className={clsx(
                'rounded-inner border px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue/50',
                kind === k ? 'border-blue/60 bg-blue/10' : 'border-edge bg-tile-2 hover:border-muted/50',
              )}
            >
              <span className="block text-[13px] font-medium text-ink">{KIND_LABEL[k]}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">{KIND_HINT[k]}</span>
            </button>
          ))}
        </div>
        <Field label="Name" hint="Shown on each alert it sends, e.g. the cluster or team it belongs to.">
          <input className="input" value={name} maxLength={80} placeholder={KIND_LABEL[kind]} onChange={(e) => setName(e.target.value)} />
        </Field>
        {kind === 'generic' && <MappingEditor mapping={mapping} onChange={setMapping} />}
        {create.error && <p className="text-xs text-red">{(create.error as Error).message}</p>}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Spinner /> : <KeyRound size={15} />} Create and show the token
          </button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}

const MAPPING_FIELDS: Array<{ key: keyof GenericMapping; label: string; placeholder: string }> = [
  { key: 'titlePath', label: 'Title', placeholder: 'title, name, alertname…' },
  { key: 'severityPath', label: 'Severity', placeholder: 'severity, priority, level…' },
  { key: 'statusPath', label: 'Status', placeholder: 'status, state' },
  { key: 'hostPath', label: 'Host', placeholder: 'host, hostname, instance…' },
  { key: 'servicePath', label: 'Service', placeholder: 'service, app…' },
  { key: 'fingerprintPath', label: 'Unique id', placeholder: 'id, fingerprint, dedup_key…' },
  { key: 'summaryPath', label: 'Description', placeholder: 'description, message…' },
  { key: 'labelsPath', label: 'Labels object', placeholder: 'labels, tags' },
  { key: 'linkPath', label: 'Link', placeholder: 'url, link' },
  { key: 'alertsPath', label: 'List of alerts', placeholder: 'empty: the body is one alert' },
];

/** Field paths for a generic sender, checked live against a sample of its JSON. */
function MappingEditor({ mapping, onChange }: { mapping: GenericMapping; onChange: (m: GenericMapping) => void }) {
  const [sample, setSample] = useState('');
  const preview = useMutation({
    mutationFn: () => {
      let payload: unknown;
      try {
        payload = JSON.parse(sample);
      } catch {
        throw new Error('The sample is not valid JSON.');
      }
      return post<{ ok: boolean; error?: string; alerts?: Array<{ title: string; severity: string; status: string; labels: Record<string, string>; fingerprint: string }> }>('/alert-sources/preview', { kind: 'generic', mapping, payload });
    },
  });
  return (
    <div className="space-y-3 rounded-inner border border-hairline bg-ground/40 p-4">
      <p className="text-xs leading-relaxed text-muted">
        Common field names are found on their own. Set a path only where the sender uses its own names: dotted, with indexes, e.g. <span className="font-mono text-ink">check.label</span> or <span className="font-mono text-ink">items[0].name</span>.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {MAPPING_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <input className="input font-mono text-xs" value={(mapping[f.key] as string | undefined) ?? ''} placeholder={f.placeholder} onChange={(e) => onChange({ ...mapping, [f.key]: e.target.value })} />
          </Field>
        ))}
        <Field label="Values that mean resolved" hint="Comma-separated. Empty: resolved, ok, closed, recovered.">
          <input
            className="input font-mono text-xs"
            value={(mapping.resolvedValues ?? []).join(', ')}
            onChange={(e) => onChange({ ...mapping, resolvedValues: e.target.value.split(',').map((v) => v.trim()).filter(Boolean) })}
          />
        </Field>
      </div>
      <Field label="Try it on a sample" hint="Paste one request body the sender would post. Nothing is stored.">
        <textarea className="input min-h-[110px] font-mono text-xs" value={sample} onChange={(e) => setSample(e.target.value)} placeholder='{"name": "Queue backlog", "level": "critical", "hostname": "worker-3"}' />
      </Field>
      <button className="btn-ghost" disabled={!sample.trim() || preview.isPending} onClick={() => preview.mutate()}>
        {preview.isPending ? <Spinner /> : null} Check
      </button>
      {preview.error && <p className="text-xs text-red">{(preview.error as Error).message}</p>}
      {preview.data && !preview.data.ok && <p className="text-xs text-amber">{preview.data.error}</p>}
      {preview.data?.ok && (
        <ul className="space-y-1.5 text-xs">
          {preview.data.alerts!.map((a, i) => (
            <li key={i} className="rounded-inner border border-hairline bg-tile-2/60 px-3 py-2">
              <span className="font-medium text-ink">{a.title}</span>
              <span className="text-muted"> · {a.severity} · {a.status}</span>
              <span className="mt-0.5 block break-all font-mono text-[11px] text-muted">{Object.entries(a.labels).map(([k, v]) => `${k}=${v}`).join('  ')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SourceCard({ source: s, isAdmin, token, onToken, onChanged }: { source: AlertSource; isAdmin: boolean; token: string | null; onToken: (t: string) => void; onChanged: () => void }) {
  const [open, setOpen] = useState(!!token);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const toggle = useMutation({ mutationFn: (enabled: boolean) => patch(`/alert-sources/${s.id}`, { enabled }), onSuccess: onChanged });
  const rotate = useMutation({
    mutationFn: () => post<{ source: AlertSource; token: string }>(`/alert-sources/${s.id}/rotate`, {}),
    onSuccess: (r) => {
      onToken(r.token);
      setOpen(true);
      onChanged();
    },
  });
  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; alert?: { id: string; incidentId: string | null } | null; change?: { title: string } | null }>(`/alert-sources/${s.id}/test`, {}),
    onSuccess: (r) => {
      setTestResult(
        s.kind === 'changes'
          ? r.change ? `Received "${r.change.title}" and stored it, then removed it again (a test change is never a suspect).` : 'Sent, but no change was stored.'
          : r.alert ? 'Received and stored, then resolved. It is on the Alerts list under Resolved.' : 'Sent, but no alert was stored.',
      );
      onChanged();
    },
  });
  const remove = useMutation({ mutationFn: () => del(`/alert-sources/${s.id}`), onSuccess: onChanged });
  const repeatPct = s.alertsIn ? Math.round((s.repeats / s.alertsIn) * 100) : 0;
  const failing = !!s.lastErrorAt && (!s.lastReceivedAt || new Date(s.lastErrorAt).getTime() > new Date(s.lastReceivedAt).getTime());

  return (
    <Panel className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', !s.enabled ? 'bg-dim' : failing ? 'bg-amber' : s.lastReceivedAt ? 'bg-green' : 'bg-muted')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{s.name}</span>
            <span className="chip border border-edge bg-tile-2 text-muted">{KIND_LABEL[s.kind]}</span>
            {!s.enabled && <span className="chip border border-edge text-muted">Off</span>}
            {s.rotating && <span className="chip border border-amber/40 bg-amber/10 text-amber">Old token works until {new Date(s.previousTokenUntil!).toLocaleString()}</span>}
          </div>
          <p className="mt-1 text-[11px] text-muted">
            {s.lastReceivedAt ? `Last alert ${timeAgo(s.lastReceivedAt)}` : 'Nothing received yet'}
            {s.received > 0 && <> · {s.received} requests · {s.alertsIn} {s.kind === 'changes' ? 'changes' : 'alerts'}{s.repeats > 0 && <> · {repeatPct}% exact repeats, not stored again</>}</>}
            {s.rejected > 0 && <> · {s.rejected} refused</>}
            <> · token <span className="font-mono">{s.tokenPrefix}…</span></>
          </p>
          {failing && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" /> Last refused {timeAgo(s.lastErrorAt!)}: {s.lastError}
            </p>
          )}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-2">
            <Switch label={s.enabled ? 'Turn off' : 'Turn on'} checked={s.enabled} onChange={(v) => toggle.mutate(v)} />
          </div>
        )}
      </div>

      {token && (
        <div className="mt-4 rounded-inner border border-green/40 bg-green/[0.07] p-3.5">
          <p className="text-xs font-medium text-ink">The token. Copy it now: SupOps keeps only a hash and cannot show it again.</p>
          <p className="mt-2 break-all rounded-inner border border-hairline bg-ground/70 px-3 py-2 font-mono text-[12px] text-ink">{token}</p>
        </div>
      )}

      <button className="mt-3 inline-flex items-center gap-1 text-xs text-blue-text hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} How to connect it
      </button>
      {open && (
        <div className="mt-3">
          <SourceSetup kind={s.kind} id={s.id} token={token} />
        </div>
      )}

      {isAdmin && (s.kind === 'pagerduty' || s.kind === 'opsgenie') && <Writeback source={s} onChanged={onChanged} />}

      {isAdmin && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-3">
          <button className="btn-ghost !min-h-[34px] !text-xs" disabled={test.isPending || !s.enabled} onClick={() => test.mutate()}>
            {test.isPending ? <Spinner /> : <Send size={13} />} {s.kind === 'changes' ? 'Send a test change' : 'Send a test alert'}
          </button>
          <button className="btn-ghost !min-h-[34px] !text-xs" disabled={rotate.isPending} onClick={() => rotate.mutate()} title="A new token; the old one keeps working for a day">
            {rotate.isPending ? <Spinner /> : <KeyRound size={13} />} New token
          </button>
          <div className="flex-1" />
          {confirmDelete ? (
            <>
              <span className="text-xs text-muted">Remove it? {s.kind === 'changes' ? 'Changes' : 'Alerts'} it sent are kept.</span>
              <button className="btn-ghost !min-h-[34px] !text-xs text-red" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</button>
              <button className="btn-ghost !min-h-[34px] !text-xs" onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button className="btn-ghost !min-h-[34px] !text-xs" onClick={() => setConfirmDelete(true)} aria-label={`Remove ${s.name}`}>
              <Trash2 size={13} /> Remove
            </button>
          )}
        </div>
      )}
      {testResult && <p className="mt-2 text-xs text-green">{testResult}</p>}
      {(test.error || rotate.error || toggle.error || remove.error) && (
        <p className="mt-2 text-xs text-red">{((test.error || rotate.error || toggle.error || remove.error) as Error).message}</p>
      )}
    </Panel>
  );
}

/** Optional credentials so SupOps acknowledges, resolves and notes the diagnosis at the source too. */
function Writeback({ source: s, onChanged }: { source: AlertSource; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [region, setRegion] = useState<'us' | 'eu'>('us');
  const save = useMutation({
    mutationFn: (credentials: unknown) => put(`/alert-sources/${s.id}/writeback`, { credentials }),
    onSuccess: () => {
      setOpen(false);
      setApiKey('');
      onChanged();
    },
  });
  const pd = s.kind === 'pagerduty';
  return (
    <div className="mt-3 rounded-inner border border-hairline bg-ground/40 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink">Write back to {pd ? 'PagerDuty' : 'Opsgenie'}</span>
        <span className={s.writeback ? 'text-green' : 'text-muted'}>{s.writeback ? 'on' : 'off'}</span>
        <span className="text-muted">· acknowledging or resolving in SupOps does the same there, and the diagnosis is added as a note. Acknowledging there acknowledges here either way.</span>
        <div className="flex-1" />
        {s.writeback && <button className="text-red hover:underline" onClick={() => save.mutate(null)}>Turn off</button>}
        <button className="text-blue-text hover:underline" onClick={() => setOpen(!open)}>{s.writeback ? 'Change' : 'Set up'}</button>
      </div>
      {open && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label={pd ? 'REST API token' : 'API key'} hint={pd ? 'A user or general access token that can update incidents.' : 'An API integration key with read and update access.'}>
            <input className="input font-mono text-xs" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </Field>
          {pd ? (
            <Field label="Acts as (email)" hint="PagerDuty records changes as this user.">
              <input className="input" value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="ops@example.com" />
            </Field>
          ) : (
            <Field label="Region">
              <select className="input" value={region} onChange={(e) => setRegion(e.target.value as 'us' | 'eu')}><option value="us">US</option><option value="eu">EU</option></select>
            </Field>
          )}
          <div className="flex items-center gap-2 sm:col-span-2">
            <button className="btn-primary !min-h-[34px] !text-xs" disabled={!apiKey.trim() || save.isPending} onClick={() => save.mutate({ apiKey, ...(pd ? { fromEmail } : { region }) })}>{save.isPending ? <Spinner /> : null} Save</button>
            {save.error && <span className="text-red">{(save.error as Error).message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
