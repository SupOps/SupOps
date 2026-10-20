import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Bell, Pencil, Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { api, del, patch, post, put } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from './ui';
import type { ChannelKind, NotificationChannel, NotificationDelivery, NotificationRoute, NotifyEvent } from '../lib/types';

const KIND: Record<ChannelKind, { label: string; hint: string }> = {
  slack: { label: 'Slack', hint: 'A channel the SupOps bot is in. Each incident gets one message, with updates in its thread.' },
  teams: { label: 'Microsoft Teams', hint: 'A Workflows webhook: in Teams, "Post to a channel when a webhook request is received".' },
  email: { label: 'Email', hint: 'Through your SMTP server.' },
  webhook: { label: 'Webhook', hint: 'JSON to any URL, signed with a shared secret (X-SupOps-Signature).' },
  pagerduty: { label: 'PagerDuty', hint: 'Events v2: an integration key on a PagerDuty service. Opens, acknowledges and resolves the PagerDuty incident with SupOps.' },
  opsgenie: { label: 'Opsgenie', hint: 'An API integration key. Creates, acknowledges and closes the Opsgenie alert with SupOps.' },
};

const EVENTS: Array<{ value: NotifyEvent; label: string }> = [
  { value: 'opened', label: 'Opened' },
  { value: 'escalated', label: 'Got worse' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'diagnosed', label: 'Diagnosed' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'reopened', label: 'Came back' },
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function NotificationsPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const [view, setView] = useState<'channels' | 'routes' | 'history'>('channels');
  return (
    <Panel title="Notifications" accent="bg-violet">
      <div className="space-y-4 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          Where SupOps tells people about incidents, and which incidents go where. Every event goes out once per channel; a failed send is retried a few times.
        </p>
        <AddressField isAdmin={isAdmin} />
        <Segmented
          label="Notifications"
          value={view}
          onChange={setView}
          options={[
            { value: 'channels', label: 'Channels' },
            { value: 'routes', label: 'Routing' },
            { value: 'history', label: 'History' },
          ]}
        />
        {view === 'channels' ? <Channels projectId={projectId} isAdmin={isAdmin} /> : view === 'routes' ? <Routes projectId={projectId} isAdmin={isAdmin} /> : <History projectId={projectId} isAdmin={isAdmin} />}
      </div>
    </Panel>
  );
}

/** SupOps' own address, so messages can link to the incident. */
function AddressField({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const s = useQuery({ queryKey: ['notifySettings'], queryFn: () => api<{ publicUrl: string | null; fromEnvironment: boolean }>('/notifications/settings') });
  const [v, setV] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (publicUrl: string) => put('/notifications/settings', { publicUrl }), onSuccess: () => { setV(null); void qc.invalidateQueries({ queryKey: ['notifySettings'] }); } });
  const value = v ?? s.data?.publicUrl ?? '';
  return (
    <Field
      label="SupOps' address"
      hint={s.data?.fromEnvironment ? 'Set by SUPOPS_PUBLIC_URL on the server.' : 'As people open it in a browser. Messages link to the incident here; without it they have no link.'}
    >
      <div className="flex flex-wrap gap-2">
        <input
          className="input min-w-0 flex-1 font-mono text-xs"
          value={value}
          disabled={!isAdmin || s.data?.fromEnvironment}
          placeholder={window.location.origin}
          onChange={(e) => setV(e.target.value)}
        />
        {isAdmin && !s.data?.fromEnvironment && (
          <>
            {!value && <button className="btn-ghost !text-xs" onClick={() => setV(window.location.origin)}>Use this address</button>}
            <button className="btn-ghost !text-xs" disabled={v === null || save.isPending} onClick={() => save.mutate(value)}>{save.isPending ? <Spinner /> : null} Save</button>
          </>
        )}
      </div>
      {save.error && <p className="mt-1 text-xs text-red">{(save.error as Error).message}</p>}
    </Field>
  );
}

// ---- channels ----------------------------------------------------------------------

function Channels({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['notifyChannels', projectId], queryFn: () => api<NotificationChannel[]>(`/notifications/channels?projectId=${projectId}`) });
  const [editing, setEditing] = useState<NotificationChannel | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notifyChannels', projectId] });
  return (
    <div className="space-y-3">
      {isAdmin && !editing && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> Add a channel</button>}
      {editing && <ChannelForm projectId={projectId} existing={editing === 'new' ? null : editing} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />}
      {list.isLoading ? <div className="grid place-items-center py-8 text-muted"><Spinner /></div> : list.data?.length ? (
        list.data.map((c) => <ChannelRow key={c.id} c={c} isAdmin={isAdmin} onEdit={() => setEditing(c)} onChanged={refresh} />)
      ) : !editing && <Empty icon={<Bell size={24} />} title="No channels yet" hint="Add Slack, Teams, email, a webhook, PagerDuty or Opsgenie." />}
    </div>
  );
}

const target = (c: NotificationChannel) =>
  c.kind === 'slack' ? String(c.config.channelName ?? c.config.channelId)
  : c.kind === 'email' ? (c.config.to as string[] | undefined)?.join(', ') ?? ''
  : c.kind === 'teams' || c.kind === 'webhook' ? String(c.config.target ?? '')
  : `${String(c.config.region ?? 'us').toUpperCase()} region`;

function ChannelRow({ c, isAdmin, onEdit, onChanged }: { c: NotificationChannel; isAdmin: boolean; onEdit: () => void; onChanged: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [sure, setSure] = useState(false);
  const test = useMutation({ mutationFn: () => post<{ ok: boolean; error?: string }>(`/notifications/channels/${c.id}/test`, {}), onSuccess: (r) => { setResult(r); onChanged(); } });
  const toggle = useMutation({ mutationFn: () => patch(`/notifications/channels/${c.id}`, { enabled: !c.enabled }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => del(`/notifications/channels/${c.id}`), onSuccess: onChanged });
  const failing = !!c.lastErrorAt && (!c.lastSentAt || new Date(c.lastErrorAt).getTime() > new Date(c.lastSentAt).getTime());
  return (
    <div className={clsx('rounded-inner border border-hairline bg-tile-2/40 p-3.5', !c.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={clsx('mt-1.5 h-2 w-2 shrink-0 rounded-full', !c.enabled ? 'bg-dim' : failing ? 'bg-amber' : c.lastSentAt ? 'bg-green' : 'bg-muted')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{c.name}</span>
            <span className="chip border border-edge bg-tile-2 text-muted">{KIND[c.kind].label}</span>
            <span className="break-all font-mono text-[11px] text-muted">{target(c)}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-muted">{c.sent} sent{c.failed ? ` · ${c.failed} failed` : ''}{c.lastSentAt ? ` · last ${timeAgo(c.lastSentAt)}` : ''}</p>
          {failing && <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber"><AlertTriangle size={12} className="mt-0.5 shrink-0" /> {c.lastError}</p>}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            <Switch label={c.enabled ? 'Turn off' : 'Turn on'} checked={c.enabled} onChange={() => toggle.mutate()} />
            <button className="btn-ghost !min-h-[32px] !text-xs" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? <Spinner /> : <Send size={12} />} Test</button>
            <button className="btn-ghost !min-h-[32px] !text-xs" onClick={onEdit} aria-label={`Edit ${c.name}`}><Pencil size={12} /></button>
            {sure ? (
              <>
                <button className="btn-ghost !min-h-[32px] !text-xs text-red" onClick={() => remove.mutate()}>Remove</button>
                <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setSure(false)}>Keep</button>
              </>
            ) : (
              <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setSure(true)} aria-label={`Remove ${c.name}`}><Trash2 size={12} /></button>
            )}
          </div>
        )}
      </div>
      {result && <p className={clsx('mt-2 text-xs', result.ok ? 'text-green' : 'text-red')}>{result.ok ? 'Sent. Check that it arrived.' : result.error}</p>}
    </div>
  );
}

function ChannelForm({ projectId, existing, onDone, onCancel }: { projectId: string; existing: NotificationChannel | null; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<ChannelKind>(existing?.kind ?? 'slack');
  const [name, setName] = useState(existing?.name ?? '');
  const cfg = existing?.config ?? {};
  const [f, setF] = useState<Record<string, string>>({
    channelId: String(cfg.channelId ?? ''),
    url: '',
    secret: '',
    routingKey: '',
    apiKey: '',
    region: String(cfg.region ?? 'us'),
    host: String(cfg.host ?? ''),
    port: String(cfg.port ?? '587'),
    secure: String(cfg.secure ?? false),
    user: String(cfg.user ?? ''),
    password: '',
    from: String(cfg.from ?? ''),
    to: ((cfg.to as string[] | undefined) ?? []).join(', '),
    allowPrivateNetwork: String(cfg.allowPrivateNetwork ?? false),
  });
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const slackChannels = useQuery({
    queryKey: ['slackChannels'],
    queryFn: () => api<Array<{ id: string; name: string }>>('/integrations/slack/channels'),
    enabled: kind === 'slack',
    retry: false,
  });
  const keep = (v?: string) => (v?.trim() ? v.trim() : undefined);
  const settings = () => {
    switch (kind) {
      case 'slack': return { kind, channelId: f.channelId, channelName: slackChannels.data?.find((c) => c.id === f.channelId)?.name };
      case 'teams': return { kind, url: keep(f.url) };
      case 'webhook': return { kind, url: keep(f.url), secret: keep(f.secret), allowPrivateNetwork: f.allowPrivateNetwork === 'true' };
      case 'pagerduty': return { kind, routingKey: keep(f.routingKey), region: f.region };
      case 'opsgenie': return { kind, apiKey: keep(f.apiKey), region: f.region };
      case 'email': return { kind, host: f.host, port: Number(f.port) || 587, secure: f.secure === 'true', user: keep(f.user), password: keep(f.password), from: f.from, to: (f.to ?? '').split(',').map((t) => t.trim()).filter(Boolean) };
    }
  };
  const save = useMutation({
    mutationFn: () => (existing ? patch(`/notifications/channels/${existing.id}`, { name: name.trim() || KIND[kind].label, settings: settings() }) : post('/notifications/channels', { projectId, name: name.trim() || KIND[kind].label, settings: settings() })),
    onSuccess: onDone,
  });
  const secretHint = (has: boolean) => (existing && has ? 'Stored. Leave empty to keep it.' : undefined);

  return (
    <div className="space-y-3 rounded-inner border border-hairline bg-ground/40 p-4">
      {!existing && (
        <div role="radiogroup" aria-label="Kind" className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(KIND) as ChannelKind[]).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={clsx('rounded-inner border px-3 py-2.5 text-left', kind === k ? 'border-blue/60 bg-blue/10' : 'border-edge bg-tile-2 hover:border-muted/50')}>
              <span className="block text-[13px] font-medium text-ink">{KIND[k].label}</span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted">{KIND[k].hint}</span>
            </button>
          ))}
        </div>
      )}
      <Field label="Name"><input className="input" value={name} maxLength={80} placeholder={KIND[kind].label} onChange={(e) => setName(e.target.value)} /></Field>
      {kind === 'slack' && (
        <Field label="Channel" hint={slackChannels.isError ? 'Connect Slack first (Settings → Slack), and invite the bot to the channel.' : 'Only channels the SupOps bot is in are listed.'}>
          <select className="input" value={f.channelId} onChange={(e) => set('channelId', e.target.value)}>
            <option value="">Pick a channel…</option>
            {(slackChannels.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      )}
      {(kind === 'teams' || kind === 'webhook') && (
        <Field label="Address" hint={secretHint(!!existing?.has.url) ?? 'Kept secret: anyone with it could post.'}>
          <input className="input font-mono text-xs" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://…" />
        </Field>
      )}
      {kind === 'webhook' && (
        <>
          <Field label="Signing secret (recommended)" hint={secretHint(!!existing?.has.secret) ?? 'The receiver checks X-SupOps-Signature: sha256 of "<timestamp>.<body>".'}>
            <input className="input font-mono text-xs" value={f.secret} onChange={(e) => set('secret', e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={f.allowPrivateNetwork === 'true'} onChange={(e) => set('allowPrivateNetwork', String(e.target.checked))} /> The receiver is on a private network (10.x, 192.168.x…)
          </label>
        </>
      )}
      {(kind === 'pagerduty' || kind === 'opsgenie') && (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          <Field label={kind === 'pagerduty' ? 'Integration (routing) key' : 'API key'} hint={secretHint(kind === 'pagerduty' ? !!existing?.has.routingKey : !!existing?.has.apiKey)}>
            <input className="input font-mono text-xs" value={kind === 'pagerduty' ? f.routingKey : f.apiKey} onChange={(e) => set(kind === 'pagerduty' ? 'routingKey' : 'apiKey', e.target.value)} />
          </Field>
          <Field label="Region">
            <Segmented label="Region" value={f.region as 'us' | 'eu'} onChange={(v) => set('region', v)} options={[{ value: 'us', label: 'US' }, { value: 'eu', label: 'EU' }]} />
          </Field>
        </div>
      )}
      {kind === 'email' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="SMTP server"><input className="input" value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.example.com" /></Field>
          <Field label="Port and security">
            <div className="flex gap-2">
              <input className="input !w-24" value={f.port} onChange={(e) => set('port', e.target.value)} />
              <Segmented label="Security" value={f.secure as 'true' | 'false'} onChange={(v) => set('secure', v)} options={[{ value: 'false', label: 'STARTTLS' }, { value: 'true', label: 'TLS' }]} />
            </div>
          </Field>
          <Field label="User (optional)"><input className="input" value={f.user} onChange={(e) => set('user', e.target.value)} /></Field>
          <Field label="Password" hint={secretHint(!!existing?.has.password)}><input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} /></Field>
          <Field label="From"><input className="input" value={f.from} onChange={(e) => set('from', e.target.value)} placeholder="supops@example.com" /></Field>
          <Field label="To" hint="Comma-separated."><input className="input" value={f.to} onChange={(e) => set('to', e.target.value)} placeholder="oncall@example.com" /></Field>
        </div>
      )}
      {save.error && <p className="text-xs text-red">{(save.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} {existing ? 'Save' : 'Add the channel'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---- routes ------------------------------------------------------------------------

function Routes({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const routes = useQuery({ queryKey: ['notifyRoutes', projectId], queryFn: () => api<NotificationRoute[]>(`/notifications/routes?projectId=${projectId}`) });
  const channels = useQuery({ queryKey: ['notifyChannels', projectId], queryFn: () => api<NotificationChannel[]>(`/notifications/channels?projectId=${projectId}`) });
  const [editing, setEditing] = useState<NotificationRoute | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['notifyRoutes', projectId] });
  const toggle = useMutation({ mutationFn: (r: NotificationRoute) => patch(`/notifications/routes/${r.id}`, { enabled: !r.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/notifications/routes/${id}`), onSuccess: refresh });
  const chName = (id: string) => channels.data?.find((c) => c.id === id)?.name ?? 'a removed channel';
  if (!channels.data?.length && !channels.isLoading) return <p className="text-xs text-muted">Add a channel first: a route sends incidents to channels.</p>;
  return (
    <div className="space-y-3">
      {isAdmin && !editing && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> Add a route</button>}
      {editing && <RouteForm projectId={projectId} channels={channels.data ?? []} existing={editing === 'new' ? null : editing} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />}
      {(routes.data ?? []).map((r) => (
        <div key={r.id} className={clsx('rounded-inner border border-hairline bg-tile-2/40 p-3.5', !r.enabled && 'opacity-70')}>
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <span className="text-[13px] font-medium text-ink">{r.name}</span>
              <p className="mt-1 text-[11px] leading-relaxed text-muted">
                {r.matcherText ? <>Incidents with <span className="font-mono text-ink/80">{r.matcherText}</span></> : 'Every incident'}, {r.minSeverity} and up:{' '}
                {r.events.map((e) => EVENTS.find((x) => x.value === e)?.label.toLowerCase()).join(', ')} → {r.channelIds.map(chName).join(', ')}.
                {r.quietHours && <> Quiet {r.quietHours.days.map((d) => DAYS[d]).join(', ')} {r.quietHours.start}–{r.quietHours.end} ({r.quietHours.timezone}): only critical.</>}
                {r.digestHour !== null && <> Daily digest at {String(r.digestHour).padStart(2, '0')}:00.</>}
              </p>
            </div>
            {isAdmin && (
              <div className="flex shrink-0 items-center gap-1.5">
                <Switch label={r.enabled ? 'Turn off' : 'Turn on'} checked={r.enabled} onChange={() => toggle.mutate(r)} />
                <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setEditing(r)} aria-label={`Edit ${r.name}`}><Pencil size={12} /></button>
                <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => remove.mutate(r.id)} aria-label={`Delete ${r.name}`}><Trash2 size={12} /></button>
              </div>
            )}
          </div>
        </div>
      ))}
      {!routes.data?.length && !editing && <Empty icon={<Bell size={24} />} title="No routes yet" hint="Nothing is sent until a route says which incidents go to which channels." />}
    </div>
  );
}

function RouteForm({ projectId, channels, existing, onDone, onCancel }: { projectId: string; channels: NotificationChannel[]; existing: NotificationRoute | null; onDone: () => void; onCancel: () => void }) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [name, setName] = useState(existing?.name ?? '');
  const [matchers, setMatchers] = useState(existing?.matcherText ?? '');
  const [minSeverity, setMin] = useState<NotificationRoute['minSeverity']>(existing?.minSeverity ?? 'warning');
  const [events, setEvents] = useState<NotifyEvent[]>(existing?.events ?? ['opened', 'escalated', 'diagnosed', 'resolved']);
  const [channelIds, setChannels] = useState<string[]>(existing?.channelIds ?? (channels[0] ? [channels[0].id] : []));
  const [quiet, setQuiet] = useState(!!existing?.quietHours);
  const [qh, setQh] = useState(existing?.quietHours ?? { days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '08:00', timezone: tz });
  const [digest, setDigest] = useState<string>(existing?.digestHour !== null && existing?.digestHour !== undefined ? String(existing.digestHour) : '');
  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const body = () => ({ name: name.trim() || 'Route', matchers, minSeverity, events, channelIds, quietHours: quiet ? qh : null, digestHour: digest === '' ? null : Number(digest) });
  const save = useMutation({ mutationFn: () => (existing ? patch(`/notifications/routes/${existing.id}`, body()) : post('/notifications/routes', { projectId, ...body() })), onSuccess: onDone });
  return (
    <div className="space-y-3 rounded-inner border border-hairline bg-ground/40 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><input className="input" value={name} maxLength={120} placeholder="Storage team" onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Which incidents" hint={<>Label matchers on its alerts, e.g. <span className="font-mono">team="storage"</span>. Empty: all.</>}>
          <input className="input font-mono text-xs" value={matchers} onChange={(e) => setMatchers(e.target.value)} placeholder='team="storage"' />
        </Field>
      </div>
      <Field label="From severity">
        <Segmented label="Minimum severity" value={minSeverity} onChange={setMin} options={[{ value: 'info', label: 'Everything' }, { value: 'warning', label: 'Warning and up' }, { value: 'critical', label: 'Critical' }]} />
      </Field>
      <Field label="When">
        <div className="flex flex-wrap gap-1.5">
          {EVENTS.map((e) => (
            <button key={e.value} type="button" aria-pressed={events.includes(e.value)} onClick={() => setEvents(toggleIn(events, e.value))} className={clsx('min-h-[34px] rounded-full border px-3 text-xs', events.includes(e.value) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink')}>
              {e.label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="To">
        <div className="flex flex-wrap gap-1.5">
          {channels.map((c) => (
            <button key={c.id} type="button" aria-pressed={channelIds.includes(c.id)} onClick={() => setChannels(toggleIn(channelIds, c.id))} className={clsx('min-h-[34px] rounded-full border px-3 text-xs', channelIds.includes(c.id) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink')}>
              {c.name}
            </button>
          ))}
        </div>
      </Field>
      <label className="flex items-center gap-2 text-xs text-ink"><input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} /> Quiet hours: only critical incidents notify</label>
      {quiet && (
        <div className="space-y-2 pl-5">
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d, i) => (
              <button key={d} type="button" aria-pressed={qh.days.includes(i)} onClick={() => setQh({ ...qh, days: toggleIn(qh.days, i).sort() })} className={clsx('min-h-[32px] rounded-full border px-2.5 text-[11px]', qh.days.includes(i) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted')}>{d}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <input type="time" className="input !w-32" value={qh.start} onChange={(e) => setQh({ ...qh, start: e.target.value })} aria-label="Quiet from" />
            to
            <input type="time" className="input !w-32" value={qh.end} onChange={(e) => setQh({ ...qh, end: e.target.value })} aria-label="Quiet until" />
            <span>({qh.timezone})</span>
          </div>
        </div>
      )}
      <Field label="Daily digest" hint="A summary of the last day: new, open and resolved incidents, and what was held back.">
        <select className="input !w-auto" value={digest} onChange={(e) => setDigest(e.target.value)}>
          <option value="">None</option>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
        </select>
      </Field>
      {save.error && <p className="text-xs text-red">{(save.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" disabled={save.isPending || !events.length || !channelIds.length} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} {existing ? 'Save' : 'Add the route'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---- history -----------------------------------------------------------------------

const STATUS: Record<NotificationDelivery['status'], string> = {
  sent: 'text-green',
  pending: 'text-blue-text',
  failed: 'text-red',
  skipped: 'text-muted',
};

function History({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['notifyDeliveries', projectId], queryFn: () => api<NotificationDelivery[]>(`/notifications/deliveries?projectId=${projectId}`), refetchInterval: 15_000 });
  const channels = useQuery({ queryKey: ['notifyChannels', projectId], queryFn: () => api<NotificationChannel[]>(`/notifications/channels?projectId=${projectId}`) });
  const retry = useMutation({ mutationFn: (id: string) => post(`/notifications/deliveries/${id}/retry`, {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notifyDeliveries', projectId] }) });
  if (!list.data?.length) return <p className="text-xs text-muted">{list.isLoading ? 'Loading…' : 'Nothing sent yet.'}</p>;
  return (
    <ul className="divide-y divide-hairline rounded-inner border border-hairline">
      {list.data.map((d) => (
        <li key={d.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3.5 py-2.5 text-xs">
          <span className={clsx('w-16 shrink-0 font-medium', STATUS[d.status])}>{d.status}</span>
          <div className="min-w-0 flex-1">
            <span className="text-ink">{d.event === 'digest' ? 'Daily digest' : d.incidentTitle ?? 'Incident'}</span>
            <span className="text-muted"> · {d.event} → {channels.data?.find((c) => c.id === d.channelId)?.name ?? 'channel'}</span>
            {(d.reason || d.error) && <span className={clsx('block', d.error ? 'text-red' : 'text-muted')}>{d.error ?? d.reason}</span>}
          </div>
          <span className="shrink-0 text-dim">{timeAgo(d.sentAt ?? d.createdAt)}</span>
          {isAdmin && d.status === 'failed' && (
            <button className="btn-ghost !min-h-[28px] !px-2 !text-[11px]" onClick={() => retry.mutate(d.id)}><RotateCcw size={11} /> Retry</button>
          )}
        </li>
      ))}
    </ul>
  );
}
