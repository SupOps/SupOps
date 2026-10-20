import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { CalendarClock, Plus, Square } from 'lucide-react';
import { api, post } from '../../lib/api';
import { Empty, Field, Panel, Segmented, Spinner } from '../ui';
import type { MaintenanceWindow } from '../../lib/types';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const STATE: Record<MaintenanceWindow['state'], { label: string; chip: string }> = {
  active: { label: 'Active now', chip: 'border-amber/40 bg-amber/10 text-amber' },
  waiting: { label: 'Between slots', chip: 'border-edge bg-tile-2 text-muted' },
  scheduled: { label: 'Scheduled', chip: 'border-blue/40 bg-blue/10 text-blue-text' },
  ended: { label: 'Ended', chip: 'border-edge text-muted' },
  cancelled: { label: 'Cancelled', chip: 'border-edge text-muted' },
};

const fmt = (t: string | number) => new Date(t).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** `datetime-local` wants local time without a zone. */
const toLocalInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function MaintenanceWindows({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['maintenanceWindows', projectId], queryFn: () => api<MaintenanceWindow[]>(`/maintenance-windows?projectId=${projectId}`), refetchInterval: 30_000 });
  const [adding, setAdding] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['maintenanceWindows', projectId] });
    void qc.invalidateQueries({ queryKey: ['alerts', projectId] });
  };
  const end = useMutation({ mutationFn: (id: string) => post(`/maintenance-windows/${id}/end`, {}), onSuccess: refresh });
  const live = (list.data ?? []).filter((w) => w.state === 'active' || w.state === 'scheduled' || w.state === 'waiting');
  const past = (list.data ?? []).filter((w) => w.state === 'ended' || w.state === 'cancelled');

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        Planned work. While a window is active, new alerts that match it are stored and shown under <span className="text-ink">In maintenance</span>, but open no incident and start no diagnosis.
        When it ends, the ones still firing are handled as if they had just arrived. Nothing is ever dropped.
      </p>
      {!adding && (
        <button className="btn-primary" onClick={() => setAdding(true)}>
          <Plus size={15} /> Plan a window
        </button>
      )}
      {adding && <NewWindow projectId={projectId} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}

      {list.isLoading ? (
        <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
      ) : !list.data?.length ? (
        !adding && (
          <Panel>
            <Empty icon={<CalendarClock size={26} />} title="No maintenance planned" hint="Plan a window before an upgrade, a migration or a reboot, so the alerts it causes do not page anyone." />
          </Panel>
        )
      ) : (
        <>
          {live.map((w) => <WindowCard key={w.id} w={w} onEnd={() => end.mutate(w.id)} ending={end.isPending && end.variables === w.id} />)}
          {past.length > 0 && <h3 className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Last 14 days</h3>}
          {past.map((w) => <WindowCard key={w.id} w={w} />)}
        </>
      )}
      {end.error && <p className="text-xs text-red">{(end.error as Error).message}</p>}
    </div>
  );
}

function WindowCard({ w, onEnd, ending }: { w: MaintenanceWindow; onEnd?: () => void; ending?: boolean }) {
  const s = STATE[w.state];
  return (
    <Panel className={clsx('p-4 sm:p-5', (w.state === 'ended' || w.state === 'cancelled') && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium text-ink">{w.name}</span>
            <span className={clsx('chip border', s.chip)}>{s.label}</span>
            {w.alertsMuted > 0 && <span className="chip border border-edge bg-tile-2 text-muted">{w.alertsMuted} alert{w.alertsMuted === 1 ? '' : 's'} held</span>}
          </div>
          <p className="mt-1.5 break-all font-mono text-[11.5px] text-ink/90">{w.matcherText}</p>
          <p className="mt-1 text-[11px] text-muted">
            {w.recurrence
              ? `Every ${w.recurrence.days.map((d) => DAYS[d]).join(', ')}, ${w.recurrence.start}–${w.recurrence.end} (${w.recurrence.timezone}), until ${fmt(w.endsAt)}`
              : `${fmt(w.startsAt)} – ${fmt(w.endsAt)}`}
            {w.createdByName && <> · planned by {w.createdByName}</>}
            {w.cancelledAt && <> · ended early{w.cancelledByName ? ` by ${w.cancelledByName}` : ''}</>}
          </p>
          {w.reason && <p className="mt-1 text-xs text-muted">{w.reason}</p>}
        </div>
        {onEnd && (
          <button className="btn-ghost !min-h-[34px] shrink-0 !text-xs" onClick={onEnd} disabled={ending}>
            {ending ? <Spinner /> : <Square size={12} />} {w.state === 'scheduled' ? 'Cancel' : 'End now'}
          </button>
        )}
      </div>
    </Panel>
  );
}

const DURATIONS = [
  { value: '1', label: '1h' },
  { value: '4', label: '4h' },
  { value: '24', label: '24h' },
  { value: 'custom', label: 'Until…' },
] as const;

function NewWindow({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [reason, setReason] = useState('');
  const [matchers, setMatchers] = useState('');
  const [kind, setKind] = useState<'once' | 'weekly'>('once');
  const [startNow, setStartNow] = useState(true);
  const [start, setStart] = useState(toLocalInput(Date.now() + 3_600_000));
  const [dur, setDur] = useState<(typeof DURATIONS)[number]['value']>('1');
  const [until, setUntil] = useState(toLocalInput(Date.now() + 2 * 3_600_000));
  const [days, setDays] = useState<number[]>([0]);
  const [slotStart, setSlotStart] = useState('02:00');
  const [slotEnd, setSlotEnd] = useState('04:00');
  const [weeks, setWeeks] = useState('12');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // What these matchers would catch, checked as they are typed.
  const [preview, setPreview] = useState<{ ok: boolean; error?: string; lastDay?: number; openNow?: number; sample?: string[] } | null>(null);
  useEffect(() => {
    if (!matchers.trim()) return setPreview(null);
    const t = setTimeout(() => {
      post<typeof preview>('/maintenance-windows/preview', { projectId, matchers }).then(setPreview, () => setPreview(null));
    }, 350);
    return () => clearTimeout(t);
  }, [matchers, projectId]);

  const create = useMutation({
    mutationFn: () => {
      const startsAt = kind === 'weekly' || startNow ? Date.now() : new Date(start).getTime();
      const endsAt =
        kind === 'weekly' ? Date.now() + Number(weeks) * 7 * 86_400_000 : dur === 'custom' ? new Date(until).getTime() : startsAt + Number(dur) * 3_600_000;
      return post('/maintenance-windows', {
        projectId,
        name: name.trim() || 'Maintenance',
        reason: reason.trim() || undefined,
        matchers,
        startsAt,
        endsAt,
        recurrence: kind === 'weekly' ? { days, start: slotStart, end: slotEnd, timezone: tz } : null,
      });
    },
    onSuccess: onDone,
  });

  return (
    <Panel title="Plan a maintenance window" className="p-5 pt-0">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={name} maxLength={120} placeholder="Database upgrade" onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Why (optional)">
            <input className="input" value={reason} maxLength={500} placeholder="Shown with the alerts it holds" onChange={(e) => setReason(e.target.value)} />
          </Field>
        </div>
        <Field
          label="Which alerts"
          hint={<>Label matchers, as in Alertmanager: <span className="font-mono">service="db", env=~"prod|staging"</span>. Also <span className="font-mono">alertname</span>, <span className="font-mono">severity</span> and <span className="font-mono">source</span>.</>}
        >
          <input className="input font-mono text-xs" value={matchers} onChange={(e) => setMatchers(e.target.value)} placeholder='service="db", env="prod"' />
        </Field>
        {preview && (
          <p className={clsx('text-xs', preview.ok ? 'text-muted' : 'text-amber')}>
            {preview.ok
              ? <>Matches <span className="text-ink">{preview.openNow}</span> open alert{preview.openNow === 1 ? '' : 's'} now and <span className="text-ink">{preview.lastDay}</span> in the last day{preview.sample?.length ? `: ${preview.sample.join(', ')}` : ''}. Open ones keep going; only new alerts are held.</>
              : preview.error}
          </p>
        )}

        <Segmented label="When" value={kind} onChange={setKind} options={[{ value: 'once', label: 'Once' }, { value: 'weekly', label: 'Every week' }]} />
        {kind === 'once' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Starts">
              <div className="space-y-2">
                <Segmented label="Start" value={startNow ? 'now' : 'later'} onChange={(v) => setStartNow(v === 'now')} options={[{ value: 'now', label: 'Now' }, { value: 'later', label: 'Later' }]} />
                {!startNow && <input type="datetime-local" className="input" value={start} onChange={(e) => setStart(e.target.value)} />}
              </div>
            </Field>
            <Field label="Lasts">
              <div className="space-y-2">
                <Segmented label="Duration" value={dur} onChange={setDur} options={[...DURATIONS]} />
                {dur === 'custom' && <input type="datetime-local" className="input" value={until} onChange={(e) => setUntil(e.target.value)} />}
              </div>
            </Field>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
              {DAYS.map((d, i) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days.includes(i)}
                  onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}
                  className={clsx('min-h-[36px] rounded-full border px-3 text-xs', days.includes(i) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink')}
                >
                  {d}
                </button>
              ))}
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="From"><input type="time" className="input" value={slotStart} onChange={(e) => setSlotStart(e.target.value)} /></Field>
              <Field label="To" hint="Earlier than the start runs past midnight."><input type="time" className="input" value={slotEnd} onChange={(e) => setSlotEnd(e.target.value)} /></Field>
              <Field label="For">
                <select className="input" value={weeks} onChange={(e) => setWeeks(e.target.value)}>
                  <option value="4">4 weeks</option>
                  <option value="12">12 weeks</option>
                  <option value="26">26 weeks</option>
                  <option value="52">a year</option>
                </select>
              </Field>
            </div>
            <p className="text-[11px] text-muted">In your time zone, {tz}.</p>
          </div>
        )}
        {create.error && <p className="text-xs text-red">{(create.error as Error).message}</p>}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={create.isPending || !matchers.trim() || (preview !== null && !preview.ok)} onClick={() => create.mutate()}>
            {create.isPending ? <Spinner /> : <CalendarClock size={15} />} Plan it
          </button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
