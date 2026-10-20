import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Activity, AlertTriangle, ArrowLeft, ChevronDown, Container, Cpu, Pencil, Plus, RadioTower, Search, SlidersHorizontal, X } from 'lucide-react';
import { formatValue } from '@supops/shared';
import { api, patch, post } from '../lib/api';
import { Empty, Panel, Segmented, Spinner, Switch } from './ui';
import { LineChart, seriesColor } from './viz';
import type { AtRiskItem, ObsConnection, SeriesChartData, Watch, WatchItem } from '../lib/types';

/**
 * Signals, one query at a time. A rail lists every watched query under its headline
 * (Resources, Kubernetes...), with what needs attention on top. The chosen query
 * opens on one graph of all its series; picking a series (a machine, a disk, a
 * queue) shows it alone, with its usual range and where it is heading.
 */

const GROUPS: Array<{ key: Watch['group']; label: string; icon: typeof Cpu }> = [
  // Your own signals first: they are what you chose to watch.
  { key: 'custom', label: 'Custom', icon: SlidersHorizontal },
  { key: 'resources', label: 'Resources', icon: Cpu },
  { key: 'kubernetes', label: 'Kubernetes', icon: Container },
  { key: 'traffic', label: 'Traffic', icon: Activity },
  { key: 'stack', label: 'Monitoring stack', icon: RadioTower },
];
const GROUP_LABEL = Object.fromEntries(GROUPS.map((g) => [g.key, g.label])) as Record<Watch['group'], string>;

type Hours = '6' | '24' | '168';
const WINDOWS: Array<{ value: Hours; label: string }> = [{ value: '6', label: '6h' }, { value: '24', label: '24h' }, { value: '168', label: '7d' }];

/** Every series a query keeps fits in its combined graph. */
const COMBINED_MAX = 50;

/** How close to trouble a score is, as a colour. */
const tone = (score: number) => (score >= 85 ? 'text-red' : score >= 60 ? 'text-amber' : 'text-muted');
/** A name's colour: plain when fine, amber or red when it needs a look. Markers never change. */
const nameTone = (score: number) => (score >= 85 ? 'text-red' : score >= NEEDS_LOOK ? 'text-amber' : 'text-ink/90');
/** The neutral square in front of a signal: its shape and colour stay put; the text says how it is. */
const Square = ({ color, className }: { color?: string; className?: string }) => (
  <span className={clsx('h-2.5 w-2.5 shrink-0 rounded-[3px]', !color && 'bg-muted/35', className)} style={color ? { background: color } : undefined} />
);
const NEEDS_LOOK = 60;


const FORECAST_MODEL = { linear: 'steady trend', daily: 'daily pattern', weekly: 'weekly pattern' } as const;
export function SignalsView({
  projectId,
  connections,
  renderForm,
}: {
  projectId: string;
  connections: ObsConnection[];
  /** The create/edit form for a signal (shared with the page). */
  renderForm: (props: { existing?: Watch; onDone: (msg?: string) => void }) => React.ReactNode;
}) {
  const list = useQuery({
    queryKey: ['watches', projectId],
    queryFn: () => api<Watch[]>(`/observability/watches?projectId=${projectId}`),
    refetchInterval: 60_000,
  });
  const atRisk = useQuery({
    queryKey: ['atRisk', projectId],
    queryFn: () => api<AtRiskItem[]>(`/observability/at-risk?projectId=${projectId}&limit=5`),
    refetchInterval: 60_000,
  });
  const [params, setParams] = useSearchParams();
  const [hours, setHours] = useState<Hours>('24');
  const [form, setForm] = useState<{ existing?: Watch } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [railOpen, setRailOpen] = useState(false);
  const metricConns = connections.filter((c) => c.kind === 'prometheus' || c.kind === 'grafana');
  const watches = list.data ?? [];
  const hot = (atRisk.data ?? []).filter((a) => a.score >= NEEDS_LOOK);

  // The query in view: from the address, else the one with the worst series, else the first.
  const current = useMemo(() => {
    const byId = (id: string | null | undefined) => (id ? watches.find((w) => w.id === id) : undefined);
    return byId(params.get('signal')) ?? byId(atRisk.data?.[0]?.watchId) ?? GROUPS.map((g) => watches.find((w) => w.group === g.key)).find(Boolean) ?? null;
  }, [watches, params, atRisk.data]);
  const focusKey = current && params.get('signal') === current.id ? params.get('series') : null;

  const select = (watchId: string, key: string | null = null) => {
    setParams((p) => {
      const n = new URLSearchParams(p);
      n.set('tab', 'signals');
      n.set('signal', watchId);
      if (key) n.set('series', key);
      else n.delete('series');
      return n;
    }, { replace: true });
    setRailOpen(false);
  };

  if (list.isLoading) return <div className="grid place-items-center py-10"><Spinner /></div>;
  if (!watches.length) {
    return (
      <Panel>
        <Empty
          title={metricConns.length ? 'Discovering signals…' : 'No metrics connection'}
          hint={metricConns.length ? 'SupOps looks for node_exporter, Kubernetes and monitoring-stack metrics, then checks every series every few minutes. Refresh the source on the Overview to do it now.' : 'Add a Prometheus or Grafana connection to watch signals.'}
          action={metricConns.length ? <button className="btn-ghost" onClick={() => setForm({})}><Plus size={14} /> Watch a query</button> : undefined}
        />
        {form && <FormDialog form={form} renderForm={renderForm} onClose={() => setForm(null)} onDone={(m) => { setForm(null); if (m) setNote(m); }} />}
      </Panel>
    );
  }

  return (
    <div className="space-y-3">
      {note && (
        <p className={clsx('flex items-center gap-2 rounded-inner border px-3 py-2 text-xs', note.includes('failed') ? 'border-red/30 bg-red/10 text-red' : 'border-green/30 bg-green/10 text-green')}>
          <span className="flex-1">{note}</span>
          <button onClick={() => setNote(null)} aria-label="Dismiss"><X size={13} /></button>
        </p>
      )}

      <div className="tile grid min-w-0 lg:grid-cols-[280px_minmax(0,1fr)]">
        {/* On a phone the rail folds into a picker above the query. */}
        <button
          className="flex items-center gap-3 border-b border-hairline px-4 py-3 text-left lg:hidden"
          onClick={() => setRailOpen((v) => !v)}
          aria-expanded={railOpen}
        >
          <Square />
          <span className="min-w-0 flex-1">
            <span className="block text-[10.5px] uppercase tracking-wider text-dim">{current ? GROUP_LABEL[current.group] : 'Signals'}</span>
            <span className={clsx('block truncate text-sm font-medium', nameTone(current?.series[0]?.score ?? 0))}>{current?.title ?? 'Pick a signal'}</span>
          </span>
          <span className="shrink-0 text-[11px] text-muted">{watches.length} signals</span>
          <ChevronDown size={15} className={clsx('shrink-0 text-muted transition-transform', railOpen && 'rotate-180')} />
        </button>

        {/* Pinned with its own scroll: it does not grow or empty out with the graph beside it. */}
        <div className={clsx('min-w-0 border-b border-hairline lg:sticky lg:top-3 lg:block lg:h-[calc(100vh-1.5rem)] lg:self-start lg:border-b-0', railOpen ? 'block' : 'hidden')}>
          <SignalRail
            watches={watches}
            hot={hot}
            currentId={current?.id ?? null}
            focusKey={focusKey}
            onSelect={select}
            onAdd={metricConns.length ? () => setForm({}) : undefined}
          />
        </div>

        <div className="min-w-0 lg:border-l lg:border-hairline">
          {current ? (
            <SignalDetail
              key={current.id}
              watch={current}
              focusKey={focusKey}
              hours={hours}
              onHours={setHours}
              onFocus={(key) => select(current.id, key)}
              onEdit={() => { setNote(null); setForm({ existing: current }); }}
            />
          ) : (
            <p className="p-8 text-sm text-muted">Pick a signal.</p>
          )}
        </div>
      </div>

      {form && <FormDialog form={form} renderForm={renderForm} onClose={() => setForm(null)} onDone={(m) => { setForm(null); if (m) setNote(m); }} />}
    </div>
  );
}

// ---- the rail ------------------------------------------------------------------------------

function SignalRail({
  watches, hot, currentId, focusKey, onSelect, onAdd,
}: {
  watches: Watch[];
  hot: AtRiskItem[];
  currentId: string | null;
  focusKey: string | null;
  onSelect: (watchId: string, key?: string | null) => void;
  onAdd?: () => void;
}) {
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const needle = q.trim().toLowerCase();
  const groups = GROUPS.map((g) => ({
    ...g,
    watches: watches.filter((w) => w.group === g.key && (!needle || `${w.title} ${w.query} ${w.series.map((s) => s.name).join(' ')}`.toLowerCase().includes(needle))),
  })).filter((g) => g.watches.length);

  return (
    <nav aria-label="Signals" className="flex max-h-[70vh] flex-col lg:h-full lg:max-h-none">
      <div className="flex items-center gap-2 p-3">
        <div className="relative min-w-0 flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
          <input className="input !min-h-[34px] !py-1 !pl-8 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a signal or machine" aria-label="Find a signal or machine" />
        </div>
        {onAdd && (
          <button className="btn-ghost !min-h-[34px] !px-2.5" onClick={onAdd} aria-label="Watch a query" title="Watch a query">
            <Plus size={14} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-2 pb-4 pt-1">
        {!needle && hot.length > 0 && (
          <section className="rounded-inner border border-amber/25 bg-amber/[0.06]" aria-label="Needs a look">
            <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
              <AlertTriangle size={13} className="text-amber" />
              <span className="flex-1 text-[12px] font-semibold text-amber">Needs a look</span>
              <span className="rounded-full bg-amber/15 px-1.5 font-mono text-[10px] text-amber">{hot.length}</span>
            </div>
            <div className="space-y-px p-1">
              {hot.map((a) => {
                const active = a.watchId === currentId && a.key === focusKey;
                return (
                  <button
                    key={`${a.watchId}|${a.key}`}
                    onClick={() => onSelect(a.watchId, a.key)}
                    aria-current={active || undefined}
                    className={clsx('block w-full rounded-[8px] px-2.5 py-1.5 text-left transition-colors', active ? 'bg-blue/15' : 'hover:bg-white/[0.05]')}
                  >
                    <span className={clsx('block truncate text-[12.5px] font-medium', nameTone(a.score))}>{a.name}</span>
                    <span className="block truncate text-[11px] text-muted">{a.title} · {a.reasons[0] ?? formatValue(a.value, a.unit)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {groups.map((g) => {
          const isClosed = !needle && closed[g.key];
          return (
            <RailSection
              key={g.key}
              icon={g.icon}
              label={g.label}
              count={g.watches.length}
              closed={isClosed}
              onToggle={needle ? undefined : () => setClosed((c) => ({ ...c, [g.key]: !c[g.key] }))}
            >
              {!isClosed && [...g.watches].sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.series[0]?.score ?? -1) - (a.series[0]?.score ?? -1)).map((w) => (
                <SignalRow key={w.id} watch={w} active={w.id === currentId} onClick={() => onSelect(w.id)} />
              ))}
            </RailSection>
          );
        })}
        {!groups.length && <p className="px-3 py-6 text-center text-xs text-muted">Nothing matches.</p>}
      </div>
    </nav>
  );
}

function RailSection({
  icon: Icon, label, count, closed, onToggle, children,
}: {
  icon: typeof Cpu;
  label: string;
  count: number;
  closed?: boolean;
  onToggle?: () => void;
  children: React.ReactNode;
}) {
  // A heading, not a row: an icon tile, the name in full, a count, and its rows hung off a guide line.
  const head = (
    <>
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-[7px] bg-tile-2 text-muted ring-1 ring-hairline"><Icon size={13} /></span>
      <span className="flex-1 text-left text-[12.5px] font-semibold text-ink">{label}</span>
      <span className="rounded-full bg-tile-2 px-1.5 font-mono text-[10px] text-muted">{count}</span>
      {onToggle && <ChevronDown size={13} className={clsx('text-dim transition-transform', closed && '-rotate-90')} />}
    </>
  );
  const cls = 'flex w-full items-center gap-2.5 rounded-inner px-1.5 py-1';
  return (
    <section>
      {onToggle ? <button className={clsx(cls, 'hover:bg-white/[0.03]')} onClick={onToggle} aria-expanded={!closed}>{head}</button> : <div className={cls}>{head}</div>}
      {!closed && <div className="ml-[18px] mt-1 space-y-px border-l border-hairline pl-1.5">{children}</div>}
    </section>
  );
}

function SignalRow({ watch: w, active, onClick }: { watch: Watch; active: boolean; onClick: () => void }) {
  const worst = w.series[0]?.score ?? 0;
  const needs = w.series.filter((s) => s.score >= NEEDS_LOOK).length;
  const failing = w.enabled && !!w.lastError;
  return (
    <button
      onClick={onClick}
      aria-current={active || undefined}
      className={clsx(
        'relative flex w-full items-center gap-2.5 rounded-inner px-2.5 py-1.5 text-left transition-colors',
        active ? 'bg-blue/10' : 'hover:bg-white/[0.04]',
        !w.enabled && 'opacity-50',
      )}
    >
      {active && <span className="absolute inset-y-1.5 -left-[7px] w-0.5 rounded-full bg-blue" />}
      <Square className={active ? '!bg-blue' : undefined} />
      <span className={clsx('min-w-0 flex-1 truncate text-[12.5px]', failing ? 'text-red' : w.enabled ? nameTone(worst) : 'text-muted', active && worst < NEEDS_LOOK && !failing && '!text-ink')}>{w.title}</span>
      {failing ? (
        <AlertTriangle size={12} className="shrink-0 text-red" aria-label="Last check failed" />
      ) : !w.enabled ? (
        <span className="shrink-0 text-[10.5px] text-dim">off</span>
      ) : needs > 0 ? (
        <span className={clsx('shrink-0 font-mono text-[10.5px]', tone(worst))} title={`${needs} of ${w.series.length} need a look`}>{needs}/{w.series.length}</span>
      ) : (
        <span className="shrink-0 font-mono text-[10.5px] text-dim" title={`${w.series.length} series, all normal`}>{w.series.length || '-'}</span>
      )}
    </button>
  );
}

// ---- one query -----------------------------------------------------------------------------

function SignalDetail({
  watch: w, focusKey, hours, onHours, onFocus, onEdit,
}: {
  watch: Watch;
  focusKey: string | null;
  hours: Hours;
  onHours: (h: Hours) => void;
  onFocus: (key: string | null) => void;
  onEdit: () => void;
}) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => patch(`/observability/watches/${w.id}`, { enabled }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['watches'] }),
  });
  const [queryOpen, setQueryOpen] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const single = w.series.length === 1;
  const focused = (focusKey ? w.series.find((s) => s.key === focusKey) : undefined) ?? (single ? w.series[0] : undefined);
  const needs = w.series.filter((s) => s.score >= NEEDS_LOOK).length;
  const worst = w.series[0];

  const combined = useQuery({
    queryKey: ['combinedChart', w.id, hours],
    queryFn: () => api<{ unit: string; limit: Watch['limit']; total: number; series: Array<{ key: string; name: string; points: Array<[number, number]> }> }>(`/observability/watches/${w.id}/combined?hours=${hours}&max=${COMBINED_MAX}`),
    // Fetched even with one series picked: it fixes each series' colour.
    enabled: w.enabled && w.series.length > 1,
    staleTime: 60_000,
    // Refresh on the same cadence as the list, so the graph never trails the headline.
    refetchInterval: 60_000,
  });
  // A series keeps its colour between the graph and the list.
  const colorOf = useMemo(() => new Map((combined.data?.series ?? []).map((s, i) => [s.key, seriesColor(i)])), [combined.data]);

  return (
    <div className="min-w-0">
      {/* What this query is */}
      <header className="border-b border-hairline px-4 py-4 sm:px-5">
        <div className="flex items-start gap-3">
          {/* On a phone the picker above already names it. */}
          <div className="min-w-0 flex-1 max-lg:invisible max-lg:h-0">
            <div className="flex flex-wrap items-center gap-x-2 text-[10.5px] uppercase tracking-wider text-dim">
              <span>{GROUP_LABEL[w.group]}</span>
              {w.connection && <><span>·</span><span className="font-mono normal-case tracking-normal">{w.connection}</span></>}
              {w.builtin ? null : <><span>·</span><span>yours</span></>}
            </div>
            <h2 className="mt-0.5 truncate text-[17px] font-semibold text-ink">{w.title}</h2>
          </div>
          <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" onClick={onEdit} title="Change the query, unit or limit">
            <Pencil size={13} /> <span className="hidden sm:inline">Edit</span>
          </button>
          <div className="pt-1.5"><Switch label={`Watch ${w.title}`} checked={w.enabled} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} /></div>
        </div>
        <button
          className={clsx('mt-2 block w-full rounded-inner bg-ground/50 px-2.5 py-1.5 text-left font-mono text-[11px] text-muted transition-colors hover:text-ink', queryOpen ? 'whitespace-pre-wrap break-all' : 'truncate')}
          onClick={() => setQueryOpen((v) => !v)}
          title={queryOpen ? 'Fold the query' : 'Show the whole query'}
        >
          {w.query}
        </button>
      </header>

      {w.enabled && w.lastError && (
        <p className="mx-4 mt-4 flex items-start gap-2 rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-xs text-red sm:mx-5">
          <AlertTriangle size={13} className="mt-px shrink-0" /> <span className="min-w-0 break-words">The last check failed: {w.lastError}</span>
        </p>
      )}

      {!w.enabled ? (
        <Empty title="Not being watched" hint="Turn it on to check every series of this query every few minutes." className="py-14" />
      ) : !w.series.length ? (
        <Empty title="No series yet" hint="The query has not returned anything so far. It is checked again every few minutes." className="py-14" />
      ) : (
        <>
          {/* Three numbers */}
          <dl className="grid grid-cols-3 border-b border-hairline">
            <Stat label="Watching" value={String(w.series.length)} sub={w.seriesCount > w.series.length ? `of ${w.seriesCount} returned` : 'series'} />
            <Stat label="At risk" value={String(needs)} valueClass={needs ? tone(worst?.score ?? 0) : 'text-green'} sub={needs ? 'near trouble' : 'all normal'} />
            <Stat label="Worst" value={worst ? formatValue(worst.value, w.unit) : '-'} valueClass={worst ? tone(worst.score) : undefined} sub={worst?.name} />
          </dl>

          {/* The graph: all together, or the one picked */}
          <div className="px-4 pt-4 sm:px-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {focused && !single ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                  <button className="inline-flex shrink-0 items-center gap-1 rounded-full border border-hairline px-2.5 py-1 text-xs text-muted transition-colors hover:border-edge hover:text-ink" onClick={() => onFocus(null)}>
                    <ArrowLeft size={12} /> All {w.series.length}
                  </button>
                  <Square color={colorOf.get(focused.key)} />
                  <span className={clsx('truncate font-medium', nameTone(focused.score))}>{focused.name}</span>
                </div>
              ) : (
                <div className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
                  {single ? focused?.name : `All ${w.series.length} together`}
                  {!single && combined.data && combined.data.series.length < w.series.length && (
                    <span className="ml-2 text-[11px] font-normal text-muted">{combined.data.series.length} with data in this window</span>
                  )}
                </div>
              )}
              <Segmented label="Window" value={hours} onChange={onHours} options={WINDOWS} />
            </div>

            {focused ? (
              <SingleChart key={`${focused.key}-${hours}`} watch={w} item={focused} hours={hours} color={colorOf.get(focused.key)} />
            ) : combined.isLoading ? (
              <div className="grid h-[260px] place-items-center"><Spinner /></div>
            ) : combined.isError ? (
              <p className="grid h-[260px] place-items-center text-xs text-red">{(combined.error as Error).message}</p>
            ) : combined.data ? (
              <>
                <LineChart
                  height={260}
                  unit={combined.data.unit}
                  limit={combined.data.limit?.value ?? null}
                  highlight={hoverKey}
                  series={combined.data.series.map((x) => ({ key: x.key, name: x.name, points: x.points }))}
                />
                <p className="mt-2 text-[10.5px] text-dim">Point at a row below to pick out its line; click it for its own graph.</p>
              </>
            ) : null}
          </div>

          <SeriesList
            watch={w}
            focusKey={focused?.key ?? null}
            colorOf={colorOf}
            onHover={setHoverKey}
            onPick={(key) => onFocus(single ? null : key === focusKey ? null : key)}
          />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, sub, valueClass }: { label: string; value: string; sub?: string; valueClass?: string }) {
  return (
    <div className="min-w-0 border-r border-hairline px-4 py-3 last:border-r-0 sm:px-5">
      <dt className="truncate text-[10.5px] uppercase tracking-wider text-dim">{label}</dt>
      <dd className={clsx('mt-0.5 truncate font-mono text-lg font-semibold leading-tight', valueClass ?? 'text-ink')}>{value}</dd>
      {sub && <dd className="truncate text-[11px] text-muted" title={sub}>{sub}</dd>}
    </div>
  );
}

/** Every series of the query, worst first: the graph's legend and its picker. */
function SeriesList({
  watch: w, focusKey, colorOf, onHover, onPick,
}: {
  watch: Watch;
  focusKey: string | null;
  colorOf: Map<string, string>;
  onHover: (key: string | null) => void;
  onPick: (key: string) => void;
}) {
  const [q, setQ] = useState('');
  useEffect(() => setQ(''), [w.id]);
  const needle = q.trim().toLowerCase();
  const rows = needle ? w.series.filter((s) => `${s.name} ${s.target ?? ''}`.toLowerCase().includes(needle)) : w.series;
  if (w.series.length < 2) return <div className="h-4" />;
  return (
    <div className="mt-4 border-t border-hairline">
      <div className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
        <h3 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Each series <span className="font-mono font-normal text-dim">{w.series.length}</span></h3>
        {w.series.length > 8 && (
          <div className="relative w-44">
            <Search size={12} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input className="input !min-h-[30px] !py-0.5 !pl-7 text-[11.5px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter series" />
          </div>
        )}
      </div>
      <ul className="max-h-[360px] overflow-y-auto overscroll-contain pb-2" onMouseLeave={() => onHover(null)}>
        {rows.map((s) => (
          <SeriesRow key={s.key} item={s} unit={w.unit} color={colorOf.get(s.key)} active={s.key === focusKey} onHover={onHover} onPick={onPick} />
        ))}
        {!rows.length && <li className="px-5 py-4 text-center text-xs text-muted">Nothing matches.</li>}
      </ul>
    </div>
  );
}

function SeriesRow({ item: s, unit, color, active, onHover, onPick }: { item: WatchItem; unit: string; color: string | undefined; active: boolean; onHover: (k: string | null) => void; onPick: (k: string) => void }) {
  return (
    <li>
      <button
        onMouseEnter={() => onHover(s.key)}
        onFocus={() => onHover(s.key)}
        onClick={() => onPick(s.key)}
        aria-pressed={active}
        className={clsx('grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-2 text-left transition-colors sm:grid-cols-[auto_minmax(0,1fr)_minmax(0,auto)_auto] sm:px-5', active ? 'bg-blue/10' : 'hover:bg-white/[0.04]')}
      >
        <Square color={color} />
        <span className="min-w-0">
          <span className={clsx('block truncate text-[12.5px]', nameTone(s.score), active && 'font-medium')}>{s.name}</span>
          {s.reasons[0] && <span className={clsx('block truncate text-[11px] sm:hidden', tone(s.score))}>{s.reasons[0]}</span>}
        </span>
        <span className={clsx('hidden max-w-[260px] truncate text-right text-[11px] sm:block', tone(s.score))}>{s.reasons[0] ?? ''}</span>
        <span className={clsx('font-mono text-[12px]', s.score >= NEEDS_LOOK ? tone(s.score) : 'text-ink/80')}>{formatValue(s.value, unit)}</span>
      </button>
    </li>
  );
}

/** One series alone: its usual range, its trend, and a way to investigate it. */
function SingleChart({ watch: w, item, hours, color }: { watch: Watch; item: WatchItem; hours: Hours; color?: string }) {
  const navigate = useNavigate();
  const chart = useQuery({
    queryKey: ['seriesChart', w.id, item.key, hours],
    queryFn: () => api<SeriesChartData>(`/observability/watches/${w.id}/chart?key=${encodeURIComponent(item.key)}&hours=${hours}`),
    staleTime: 60_000,
    // Refresh on the same cadence as the list, so the graph never trails the headline.
    refetchInterval: 60_000,
  });
  const investigate = useMutation({
    mutationFn: () => post<{ runId: string }>(`/observability/watches/${w.id}/investigate`, { key: item.key }),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });
  const d = chart.data;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-2xl font-semibold text-ink">{formatValue(item.value, w.unit)}</span>
        {item.reasons.length ? (
          <span className={clsx('text-xs', tone(item.score))}>{item.reasons.join(' · ')}</span>
        ) : (
          <span className="text-xs text-green">Within its usual range</span>
        )}
        {item.target && <span className="text-[11px] text-dim">on {item.target}</span>}
      </div>
      {chart.isLoading ? (
        <div className="grid h-[260px] place-items-center"><Spinner /></div>
      ) : chart.isError ? (
        <p className="grid h-[260px] place-items-center text-xs text-red">{(chart.error as Error).message}</p>
      ) : d ? (
        <LineChart
          height={260}
          unit={d.unit}
          limit={d.limit?.value ?? null}
          series={[{ key: item.key, name: item.name, points: d.points, band: d.band, forecast: d.forecast, flagged: item.score >= NEEDS_LOOK, color }]}
        />
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex flex-1 flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-dim">
          {d?.band && <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-4 rounded-sm bg-blue/15" /> Usual range (last day)</span>}
          {d?.forecast && (
            <span className="inline-flex items-center gap-1.5" title={d.forecast.path ? 'Forecast from up to 15 days of history: trend plus its daily or weekly pattern, chosen by how well it predicted the last day. The shaded band is where it lands 9 times in 10.' : undefined}>
              <span className="w-4 border-t border-dashed border-blue" /> Where it is heading
              {d.forecast.model && <span className="text-dim">({FORECAST_MODEL[d.forecast.model]}{d.forecast.path ? ', shaded: likely range' : ''})</span>}
            </span>
          )}
          {d?.limit && <span className="inline-flex items-center gap-1.5"><span className="w-4 border-t border-dashed border-red/70" /> Runs out at {formatValue(d.limit.value, w.unit)}</span>}
        </div>
        <button className="btn-ghost !min-h-[32px] !px-3 text-xs" disabled={investigate.isPending} onClick={() => investigate.mutate()} title="Finds out why and proposes the fix. Every change waits for your approval.">
          {investigate.isPending ? <Spinner className="!h-3 !w-3" /> : <Search size={13} />} Investigate
        </button>
      </div>
      {investigate.isError && <p className="mt-1 text-xs text-red">{(investigate.error as Error).message}</p>}
    </div>
  );
}

// ---- add / edit ----------------------------------------------------------------------------

function FormDialog({
  form, renderForm, onClose, onDone,
}: {
  form: { existing?: Watch };
  renderForm: (props: { existing?: Watch; onDone: (msg?: string) => void }) => React.ReactNode;
  onClose: () => void;
  onDone: (msg?: string) => void;
}) {
  const w = form.existing;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="tile max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={w ? `Edit ${w.title}` : 'Watch a query'}>
        <div className="mb-4 flex items-center gap-3">
          <h2 className="flex-1 text-base font-semibold text-ink">{w ? `Edit ${w.title}` : 'Watch a query'}</h2>
          <button className="btn-ghost !min-h-[32px] !px-2" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        {renderForm({ existing: w, onDone })}
        {w?.builtin && <ResetLink watch={w} onDone={(msg) => onDone(msg)} />}
      </div>
    </div>
  );
}

function ResetLink({ watch, onDone }: { watch: Watch; onDone: (msg: string) => void }) {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: () => patch<{ error?: string }>(`/observability/watches/${watch.id}`, { reset: true }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['watches'] });
      onDone(r.error ? `Reset, but the query failed: ${r.error}` : 'Back to the built-in definition, and re-evaluated.');
    },
  });
  return (
    <button className="mt-3 text-[11px] text-muted underline-offset-2 hover:text-ink hover:underline" disabled={reset.isPending} onClick={() => reset.mutate()}>
      Reset to SupOps' built-in definition
    </button>
  );
}
