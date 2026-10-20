import { useState } from 'react';
import { Link } from 'react-router-dom';
import { clsx } from 'clsx';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDownRight, ArrowRight, ArrowUpRight, Check, ChevronDown, RefreshCw } from 'lucide-react';
import { post } from '../lib/api';
import { Spinner } from './ui';
import { formatEta, formatValue } from '@supops/shared';
import { timeAgo } from '../lib/format';
import { ORIGIN_LABEL, VERDICT, urgency, verdictOf } from '../lib/observe-ui';
import type { Incident, Observation, ObservabilityOverview } from '../lib/types';

/**
 * Observability at a glance. One sentence says how things are; below it, only what a
 * person might act on, in plain words: what needs you (with the diagnosis' verdict),
 * what is over its limit or coming up (with how long is left), and what is out of
 * the ordinary (now against usual). Uncertain guesses and things checked and found
 * fine are folded away, not mixed in.
 */
export function ObsOverview({ data, onNavigate }: { data: ObservabilityOverview; onNavigate: (tab: 'incidents' | 'signals') => void }) {
  const open = [...data.incidents].sort((a, b) => urgency(a) - urgency(b));
  const needs = open.filter((i) => verdictOf(i) !== 'none');
  const fine = open.filter((i) => verdictOf(i) === 'none');
  const actNow = needs.filter((i) => verdictOf(i) === 'act_now' || (verdictOf(i) !== 'can_wait' && i.severity === 'critical'));

  const forecasts = data.observations.filter((o) => o.kind === 'forecast');
  const over = forecasts.filter((o) => o.details?.over);
  const coming = forecasts.filter((o) => !o.details?.over && o.details?.confidence !== 'low').sort((a, b) => (a.details?.etaMs ?? Infinity) - (b.details?.etaMs ?? Infinity));
  const unsure = forecasts.filter((o) => !o.details?.over && o.details?.confidence === 'low');
  const unusual = data.observations.filter((o) => o.kind === 'anomaly');

  const tone = actNow.length ? 'red' : needs.length || over.length || coming.some((c) => (c.details?.etaMs ?? Infinity) <= 86_400_000) ? 'amber' : 'green';

  return (
    <div className="space-y-5">
      {/* How things are, in one sentence */}
      <section className={clsx('tile relative overflow-hidden px-5 py-5 sm:px-6', tone === 'red' && 'ring-1 ring-red/30', tone === 'amber' && 'ring-1 ring-amber/25')}>
        <span className={clsx('absolute inset-y-0 left-0 w-1', tone === 'red' ? 'bg-red' : tone === 'amber' ? 'bg-amber' : 'bg-green')} aria-hidden />
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="min-w-0 flex-1">
            <p className="text-[19px] font-semibold leading-snug tracking-tight text-ink sm:text-[21px]">
              {actNow.length
                ? `${actNow.length} ${actNow.length === 1 ? 'problem needs' : 'problems need'} you now`
                : needs.length
                  ? `${needs.length} ${needs.length === 1 ? 'thing' : 'things'} to look at, nothing urgent`
                  : over.length || coming.length
                    ? 'No problems right now'
                    : 'All clear'}
            </p>
            <p className="mt-1 text-sm text-muted">
              {data.watched ? `Watching ${data.watched} things` : 'Watching your metrics'}
              {fine.length ? ` · ${fine.length} checked and found fine` : ''}
              {data.settings.autoTriage ? ' · every alert is checked as it arrives' : ''}
            </p>
          </div>
          <div className="grid w-full grid-cols-2 gap-2 sm:w-auto sm:grid-cols-4 sm:gap-3">
            <Count n={needs.length} label="Need you" color={actNow.length ? 'text-red' : needs.length ? 'text-amber' : 'text-ink'} />
            <Count n={over.length} label="Over limit" color={over.length ? 'text-amber' : 'text-ink'} />
            <Count n={coming.length} label="Coming up" color={coming.some((c) => (c.details?.etaMs ?? Infinity) <= 86_400_000) ? 'text-amber' : 'text-ink'} />
            <Count n={unusual.length} label="Unusual" color={unusual.length ? 'text-violet' : 'text-ink'} />
          </div>
        </div>
      </section>

      {/* What needs a person */}
      <Section title="Needs you" empty={needs.length ? null : 'Nothing needs you. New alerts are checked as they arrive and show here only if they matter.'} action={<button className="text-xs text-blue-text hover:underline" onClick={() => onNavigate('incidents')}>All incidents</button>}>
        <ul className="divide-y divide-hairline">
          {needs.map((i) => <NeedRow key={i.id} i={i} />)}
        </ul>
        {fine.length > 0 && <Folded label={`${fine.length} checked, nothing to do`}>{fine.map((i) => <NeedRow key={i.id} i={i} quiet />)}</Folded>}
      </Section>

      <div className="grid items-start gap-5 xl:grid-cols-2">
        {/* Over the line, or heading for it */}
        <Section
          title="Limits"
          empty={over.length || coming.length ? null : 'Nothing is over its limit or heading for it in the next 7 days.'}
          action={<button className="text-xs text-blue-text hover:underline" onClick={() => onNavigate('signals')}>All signals</button>}
        >
          <ul className="divide-y divide-hairline">
            {over.map((o) => <LimitRow key={o.id} o={o} />)}
            {coming.slice(0, 8).map((o) => <LimitRow key={o.id} o={o} />)}
          </ul>
          {coming.length > 8 && <Folded label={`${coming.length - 8} more further out`}>{coming.slice(8).map((o) => <LimitRow key={o.id} o={o} />)}</Folded>}
          {unsure.length > 0 && (
            <Folded label={`${unsure.length} uncertain ${unsure.length === 1 ? 'guess' : 'guesses'}`} hint="Trends too unsteady to call. Shown for completeness, not as warnings.">
              {unsure.map((o) => <LimitRow key={o.id} o={o} quiet />)}
            </Folded>
          )}
        </Section>

        {/* Out of the ordinary */}
        <Section title="Out of the ordinary" empty={unusual.length ? null : 'Everything is within its usual range for the time of day.'}>
          <ul className="divide-y divide-hairline">
            {unusual.map((o) => <UnusualRow key={o.id} o={o} />)}
          </ul>
        </Section>
      </div>

      <Sources data={data} />
    </div>
  );
}

function Count({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div className="min-w-0 rounded-inner border border-hairline bg-tile-2/50 px-3 py-2 text-center sm:min-w-[84px]">
      <div className={clsx('text-xl font-semibold tabular-nums leading-none', color)}>{n}</div>
      <div className="mt-1 truncate text-[10.5px] text-muted">{label}</div>
    </div>
  );
}

function Section({ title, empty, action, children }: { title: string; empty: string | null; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="tile overflow-hidden">
      <header className="flex items-center gap-3 px-5 pb-2.5 pt-4">
        <h2 className="text-[13px] font-semibold tracking-tight text-ink">{title}</h2>
        <div className="ml-auto">{action}</div>
      </header>
      {empty ? (
        <p className="flex items-center gap-2 border-t border-hairline px-5 py-4 text-sm text-muted"><Check size={14} className="shrink-0 text-green" /> {empty}</p>
      ) : (
        <div className="border-t border-hairline">{children}</div>
      )}
    </section>
  );
}

function Folded({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-hairline">
      <button className="flex w-full items-center gap-1.5 px-5 py-2.5 text-left text-xs text-muted hover:text-ink" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <ChevronDown size={13} className={clsx('transition-transform', open && 'rotate-180')} /> {label}
      </button>
      {open && (
        <div className="pb-1">
          {hint && <p className="px-5 pb-1 text-[11px] text-dim">{hint}</p>}
          <ul className="divide-y divide-hairline opacity-80">{children}</ul>
        </div>
      )}
    </div>
  );
}

/** A diagnosis sentence for reading: without its evidence references ([E2]) or "Inconclusive --". */
export const plain = (t: string) => t.replace(/\s*\[E\d+\]/g, '').replace(/^inconclusive\s*[-–—]+\s*/i, 'Unclear: ').trim();

/** One incident: what it is, the verdict, and where. */
function NeedRow({ i, quiet }: { i: Incident; quiet?: boolean }) {
  const v = VERDICT[verdictOf(i)];
  return (
    <li>
      <Link to={`/observability/incidents/${i.id}`} className="group flex items-stretch gap-4 py-3 pl-0 pr-5 transition-colors hover:bg-white/[0.03]">
        <span className={clsx('w-1 shrink-0 rounded-r', quiet ? 'bg-dim/50' : v.bar)} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('chip whitespace-nowrap', v.chip)} title={v.hint}>
              {verdictOf(i) === 'checking' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
              {v.label}
            </span>
            <span className="line-clamp-2 text-[14px] font-medium text-ink sm:line-clamp-1">{i.title}</span>
            {i.acknowledgedAt && <span className="chip whitespace-nowrap border border-green/40 bg-green/10 text-green" title="Someone is on it">Acknowledged</span>}
            {i.assigneeName && <span className="whitespace-nowrap text-[11px] text-muted">· {i.assigneeName}</span>}
          </div>
          <p className="mt-1 line-clamp-1 text-[12.5px] text-muted">
            {i.rootCause ? plain(i.rootCause) : verdictOf(i) === 'checking' ? 'Gathering evidence and finding the cause…' : v.hint}
          </p>
        </div>
        <div className="hidden shrink-0 flex-col items-end justify-center gap-0.5 text-[11px] text-dim sm:flex">
          <span>{ORIGIN_LABEL[i.origin]}{i.alertCount ? ` · ${i.alertCount} alert${i.alertCount > 1 ? 's' : ''}` : ''}</span>
          <span>{timeAgo(i.openedAt)}</span>
        </div>
        <ArrowRight size={14} className="shrink-0 self-center text-dim transition-transform group-hover:translate-x-0.5" />
      </Link>
    </li>
  );
}

/** Name and signal of a finding, from its details or (older findings) its message. */
function subject(o: Observation): { name: string; signal: string } {
  if (o.details?.name && o.details.signal) return { name: o.details.name, signal: o.details.signal };
  const m = o.message.match(/^(.*?) on (.*?) (?:is |runs |reaches |has |: )/);
  return { name: m?.[2] ?? o.title ?? '', signal: m?.[1] ?? o.title ?? '' };
}

/** Over its limit, or how long until it gets there -- with a fill bar for percentages. */
function LimitRow({ o, quiet }: { o: Observation; quiet?: boolean }) {
  const d = o.details ?? {};
  const unit = d.unit ?? o.unit ?? 'count';
  const { name, signal } = subject(o);
  const eta = d.etaMs ?? null;
  const urgent = d.over ? !!d.worsening : eta !== null && eta <= 4 * 3_600_000;
  const soon = d.over || (eta !== null && eta <= 86_400_000);
  const pct = unit === 'percent' && typeof d.value === 'number' ? Math.max(0, Math.min(100, d.value)) : null;
  const limitPct = unit === 'percent' && d.limit ? Math.max(0, Math.min(100, d.limit.value)) : null;
  const when = d.over ? (d.worsening ? 'Over limit, rising' : 'Over limit') : eta !== null ? `in ${formatEta(eta)}` : '';
  return (
    <li className="px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
          <span className="truncate text-[12px] text-muted">{signal}</span>
        </div>
        <span className={clsx('shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-center text-[12px] font-medium sm:w-[118px]', quiet ? 'bg-tile-2 text-muted' : urgent ? 'bg-red/15 text-red' : soon ? 'bg-amber/15 text-amber' : 'bg-tile-2 text-ink/80')}>
          {when}
        </span>
        <span className="hidden w-4 shrink-0 sm:block">
          {o.incidentId && !quiet && (
            <Link to={`/observability/incidents/${o.incidentId}`} className="text-dim hover:text-ink" aria-label="Open incident"><ArrowRight size={14} /></Link>
          )}
        </span>
      </div>
      {pct !== null ? (
        <div className="mt-2 flex items-center gap-3 sm:pr-7">
          <div className="relative h-1.5 flex-1 rounded-full bg-tile-2">
            <span className={clsx('absolute inset-y-0 left-0 rounded-full', urgent ? 'bg-red' : d.over || soon ? 'bg-amber' : 'bg-blue/70')} style={{ width: `${pct}%` }} />
            {limitPct !== null && limitPct < 100 && <span className="absolute -inset-y-1 w-0.5 rounded bg-ink/80" style={{ left: `${limitPct}%` }} title={`Limit ${formatValue(d.limit!.value, unit)}`} />}
          </div>
          <span className="shrink-0 text-right font-mono text-[11px] text-muted">{formatValue(d.value!, unit)}{d.limit ? <span className="text-dim"> / {formatValue(d.limit.value, unit)}</span> : null}</span>
        </div>
      ) : (
        <p className="mt-1 text-[12px] text-muted">
          {typeof d.value === 'number' ? <>now <span className="font-mono text-ink/80">{formatValue(d.value, unit)}</span></> : o.message}
          {d.limit && typeof d.value === 'number' ? <span className="text-dim"> · limit {formatValue(d.limit.value, unit)}</span> : null}
          {typeof d.slopePerHour === 'number' && d.slopePerHour !== 0 ? <span className="text-dim"> · {d.slopePerHour > 0 ? '+' : ''}{formatValue(d.slopePerHour, unit)} an hour</span> : null}
        </p>
      )}
      {o.incidentId && !quiet && (
        <Link to={`/observability/incidents/${o.incidentId}`} className="mt-1 inline-block text-[11px] text-blue-text hover:underline sm:hidden">Open incident</Link>
      )}
    </li>
  );
}

/** Out of the ordinary: now against usual, and which way. */
function UnusualRow({ o }: { o: Observation }) {
  const d = o.details ?? {};
  const unit = d.unit ?? o.unit ?? 'count';
  const { name, signal } = subject(o);
  const up = (d.direction ?? 'up') === 'up';
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <li className="flex items-center gap-4 px-5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{name}</span>
          <span className="truncate text-[12px] text-muted">{signal}</span>
        </div>
        <p className="mt-0.5 text-[12px] text-muted">
          {typeof d.value === 'number' && typeof d.baseline === 'number' ? (
            <>
              <span className="font-mono text-ink/90">{formatValue(d.value, unit)}</span>
              <span className="text-dim"> · usually {formatValue(d.baseline, unit)}</span>
            </>
          ) : (
            o.message
          )}
          <span className="text-dim"> · since {timeAgo(o.startedAt)}</span>
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-violet/10 px-2.5 py-1 text-[12px] font-medium text-violet">
        <Arrow size={13} /> {up ? 'Higher' : 'Lower'}<span className="hidden sm:inline"> than usual</span>
      </span>
    </li>
  );
}

function Sources({ data }: { data: ObservabilityOverview }) {
  const bad = data.connections.filter((c) => (c.poll && !c.poll.ok) || c.watchErrors > 0);
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => Promise.all(data.connections.filter((c) => c.importsAlerts || c.watches).map((c) => post(`/observability/connections/${c.id}/refresh`, {}))),
    onSettled: () => void qc.invalidateQueries(),
  });
  return (
    <p className="flex flex-wrap items-center gap-x-1 px-1 text-[11.5px] text-muted">
      Reading from{' '}
      {data.connections.map((c, i) => (
        <span key={c.id}>
          {i > 0 && ', '}
          <span className={clsx('font-mono', bad.includes(c) ? 'text-red' : 'text-ink/80')}>{c.slug}</span>
        </span>
      ))}
      {bad.length ? <span className="text-red"> · {bad.length === 1 ? 'one source has' : `${bad.length} sources have`} a problem, see Targets</span> : <span> · all reachable</span>}
      <button className="ml-2 inline-flex items-center gap-1 text-blue-text hover:underline disabled:opacity-60" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
        {refresh.isPending ? <Spinner className="!h-3 !w-3" /> : <RefreshCw size={11} />} Check now
      </button>
    </p>
  );
}
