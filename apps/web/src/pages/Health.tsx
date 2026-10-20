import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, ChevronDown, RadioTower, Search, Server, ShieldCheck, X, Zap } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { useApp } from '../lib/store';
import { HEALTH_STYLE, SEVERITY_STYLE, targetAddress, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, EnvBadge, HealthBadge, Panel, Segmented, Spinner, Switch } from '../components/ui';
import { topLevelTargets } from '../lib/types';
import type { HealthIssue, HealthOverview, HealthSchedule, HealthTargetMetric, Target } from '../lib/types';
import { useLivePoll } from '../lib/live';

/** The cadences the timer offers -- must match the server's ALLOWED_INTERVALS. */
const INTERVALS: Array<{ ms: number; label: string; long: string }> = [
  { ms: 15 * 60_000, label: '15m', long: '15 minutes' },
  { ms: 30 * 60_000, label: '30m', long: '30 minutes' },
  { ms: 60 * 60_000, label: '1h', long: '1 hour' },
  { ms: 180 * 60_000, label: '3h', long: '3 hours' },
  { ms: 360 * 60_000, label: '6h', long: '6 hours' },
  { ms: 720 * 60_000, label: '12h', long: '12 hours' },
  { ms: 1440 * 60_000, label: '24h', long: '24 hours' },
];

export function Health() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [scopeId, setScopeId] = useState<string>('');
  const [showNotes, setShowNotes] = useState(false);

  const overview = useQuery({
    queryKey: ['health', projectId],
    queryFn: () => api<HealthOverview>(`/health/overview?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });

  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    enabled: !!projectId,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['health', projectId] });
    void qc.invalidateQueries({ queryKey: ['healthCount', projectId] });
    void qc.invalidateQueries({ queryKey: ['targets', projectId] });
  };

  const scan = useMutation({
    mutationFn: (type: 'quick' | 'deep') =>
      post<{ runId?: string }>('/health/scan', {
        projectId,
        type,
        ...(scopeId ? { targetId: scopeId } : {}),
      }),
    onSuccess: (res) => {
      invalidate();
      // Both Quick and Deep are agent runs now -- jump to the run so it can be watched.
      if (res.runId) navigate(`/runs/${res.runId}`);
    },
  });

  const schedule = overview.data?.schedule;
  const saveSchedule = useMutation({
    mutationFn: (patch: Partial<Pick<HealthSchedule, 'enabled' | 'intervalMs' | 'scanType'>>) =>
      put<HealthSchedule>('/health/schedule', {
        enabled: patch.enabled ?? schedule?.enabled ?? false,
        intervalMs: patch.intervalMs ?? schedule?.intervalMs ?? 30 * 60_000,
        scanType: patch.scanType ?? schedule?.scanType ?? 'quick',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['health', projectId] }),
  });

  const investigate = useMutation({
    mutationFn: (id: string) => post<{ runId: string }>(`/health/issues/${id}/investigate`, {}),
    onSuccess: ({ runId }) => {
      invalidate();
      navigate(`/runs/${runId}`);
    },
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => post(`/health/issues/${id}/resolve`, {}),
    onSuccess: invalidate,
  });

  const tops = topLevelTargets(targets.data);
  // Essential problems are "issues"; non-essential findings are quieter "notes" that
  // never degrade a target.
  const all = overview.data?.issues ?? [];
  const issues = all.filter((i) => i.severity !== 'notice');
  const notes = all.filter((i) => i.severity === 'notice');
  const notesByTarget = new Map<string, number>();
  for (const n of notes) notesByTarget.set(n.targetId, (notesByTarget.get(n.targetId) ?? 0) + 1);
  const latest = overview.data?.latest;
  const scanning = scan.isPending;
  const metricsById = new Map(
    (latest?.summaryJson?.targets ?? []).map((m) => [m.targetId, m]),
  );

  return (
    <>
      <PageHeader
        title="Health"
        subtitle="Sweep every machine for the essentials — reachability, disk, memory, load and failed services. Run it now or leave it on a timer."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              className="btn-ghost !min-h-[38px]"
              disabled={scanning || !projectId}
              onClick={() => scan.mutate('quick')}
              title="A fast, light read-only pass over the essentials."
            >
              {scanning && scan.variables === 'quick' ? <Spinner /> : <Zap size={15} />} Quick scan
            </button>
            <button
              className="!min-h-[38px] inline-flex items-center gap-2 rounded-inner border border-violet/40 bg-violet/15 px-3.5 text-sm font-medium text-violet transition-colors hover:bg-violet/25 disabled:opacity-50"
              disabled={scanning || !projectId}
              onClick={() => scan.mutate('deep')}
              title="A full AI investigation of each target. Opens a run."
            >
              {scanning && scan.variables === 'deep' ? <Spinner /> : <Search size={15} />} Deep scan
            </button>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {/* Timer control */}
        <Panel
          title="Automatic checks"
          accent="bg-cyan"
          action={
            <Switch
              label="Automatic checks"
              checked={!!schedule?.enabled}
              disabled={!schedule}
              onChange={(enabled) => saveSchedule.mutate({ enabled })}
            />
          }
        >
          <div className="flex flex-wrap items-end gap-x-8 gap-y-4 px-5 pb-5 pt-1">
            <IntervalSlider
              valueMs={schedule?.intervalMs ?? 30 * 60_000}
              disabled={!schedule?.enabled}
              onCommit={(intervalMs) => saveSchedule.mutate({ enabled: true, intervalMs })}
            />

            <div className="flex items-center gap-2 pb-5">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Using</span>
              <Segmented
                label="Scan type"
                value={schedule?.scanType ?? 'quick'}
                disabled={!schedule?.enabled}
                onChange={(scanType) => saveSchedule.mutate({ scanType })}
                options={[
                  { value: 'quick', label: 'Quick' },
                  { value: 'deep', label: 'Deep', active: 'bg-violet/20 text-violet' },
                ]}
              />
            </div>

            <div className="ml-auto pb-5 text-right text-[11px] text-muted">
              {schedule?.enabled && schedule.nextCheckAt
                ? `Next check ${timeAgo(schedule.nextCheckAt).replace(' ago', ' from now').replace('just now', 'imminently')}`
                : 'Automatic checks are off'}
              {latest && <> · last scan {timeAgo(latest.startedAt)}</>}
              {saveSchedule.error && <div className="mt-1 text-red">Could not save the schedule</div>}
            </div>
          </div>
        </Panel>

        {/* Latest scan summary */}
        {latest?.summaryJson && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Checked" value={latest.summaryJson.checked} tone="text-ink" />
            <Stat
              label="Healthy"
              value={latest.summaryJson.ok}
              tone="text-green"
              sub={latest.summaryJson.notes ? `${latest.summaryJson.notes} note${latest.summaryJson.notes === 1 ? '' : 's'}` : undefined}
            />
            <Stat label="Degraded" value={latest.summaryJson.degraded} tone="text-amber" />
            <Stat label="Unreachable" value={latest.summaryJson.unreachable} tone="text-red" />
          </div>
        )}

        {/* Open issues */}
        <Panel
          title="Open issues"
          accent="bg-amber"
          action={<span className="text-[11px] text-muted">{issues.length || 'none'}</span>}
        >
          {overview.isLoading ? (
            <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
          ) : issues.length ? (
            <ul className="divide-y divide-hairline">
              {issues.map((issue) => (
                <IssueRow
                  key={issue.id}
                  issue={issue}
                  targetName={tops.find((t) => t.id === issue.targetId)?.name}
                  busy={investigate.isPending && investigate.variables === issue.id}
                  onInvestigate={() => investigate.mutate(issue.id)}
                  onDismiss={() => dismiss.mutate(issue.id)}
                />
              ))}
            </ul>
          ) : (
            <Empty
              icon={<ShieldCheck size={26} />}
              title="Nothing needs attention"
              hint="No open issues. Problems a scan finds show up here, each with a one-click deep investigation."
            />
          )}
        </Panel>

        {/* Non-essential findings: collapsed by default, they never degrade a target. */}
        {notes.length > 0 && (
          <Panel
            title={`Notes · ${notes.length}`}
            accent="bg-cyan/70"
            action={
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-ink"
                aria-expanded={showNotes}
                onClick={() => setShowNotes((v) => !v)}
              >
                {showNotes ? 'Hide' : 'Show'}
                <ChevronDown size={13} className={clsx('transition-transform', showNotes && 'rotate-180')} />
              </button>
            }
          >
            {showNotes ? (
              <ul className="divide-y divide-hairline">
                {notes.map((issue) => (
                  <IssueRow
                    key={issue.id}
                    issue={issue}
                    quiet
                    targetName={tops.find((t) => t.id === issue.targetId)?.name}
                    busy={investigate.isPending && investigate.variables === issue.id}
                    onInvestigate={() => investigate.mutate(issue.id)}
                    onDismiss={() => dismiss.mutate(issue.id)}
                  />
                ))}
              </ul>
            ) : (
              <p className="px-5 pb-4 text-xs text-muted">
                Minor findings, such as pending updates or unused failed units. They don't affect a target's health.
              </p>
            )}
          </Panel>
        )}

        {/* Per-target health -- click a card to scope the next scan to it. */}
        <Panel
          title="Targets"
          accent="bg-blue"
          action={
            <span className="text-[11px] text-muted">
              {scopeId
                ? <>Scanning <span className="text-blue-text">{tops.find((t) => t.id === scopeId)?.name}</span> · <button className="hover:text-ink" onClick={() => setScopeId('')}>scan all</button></>
                : 'Click a target to scope a scan'}
            </span>
          }
        >
          {tops.length ? (
            <div className="grid gap-3 p-4 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
              {tops.map((t) => {
                const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
                const selected = scopeId === t.id;
                const cfg = t.config as { host?: string; user?: string };
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setScopeId(selected ? '' : t.id)}
                    aria-pressed={selected}
                    className="tile flex items-start gap-3 border border-hairline p-4 text-left"
                  >
                    <span className={clsx('mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-inner', h.text)} style={{ background: `color-mix(in srgb, ${h.hex} 14%, transparent)` }}>
                      <Server size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-ink">{t.name}</span>
                        <EnvBadge env={t.env} />
                      </div>
                      {(cfg.host || cfg.user || t.kind === 'k8s') && (
                        <div className="mt-1 truncate font-mono text-[11px] text-muted">
                          {targetAddress(t)}
                        </div>
                      )}
                      <div className="mt-2 flex items-center gap-2 border-t border-hairline pt-2">
                        <HealthBadge state={t.healthState} />
                        {!!notesByTarget.get(t.id) && (
                          <span className="text-[11px] text-muted">
                            · {notesByTarget.get(t.id)} note{notesByTarget.get(t.id) === 1 ? '' : 's'}
                          </span>
                        )}
                        <span className="text-[11px] text-muted">· checked {timeAgo(t.lastCheckedAt)}</span>
                      </div>
                      <TargetMetrics metric={metricsById.get(t.id)} />
                    </div>
                    {selected && <Check size={16} className="shrink-0 text-blue-text" />}
                  </button>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={<RadioTower size={26} />}
              title="No targets yet"
              hint="Register a target to start checking its health."
            />
          )}
        </Panel>

        {scan.error && (
          <p className="text-sm text-red">
            {scan.error instanceof Error ? scan.error.message : 'Could not run the scan'}
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The check interval as a stepped slider. The thumb follows the drag locally and the
 * choice is saved once, on release, so dragging across seven stops is one request.
 */
function IntervalSlider({
  valueMs, disabled, onCommit,
}: {
  valueMs: number;
  disabled: boolean;
  onCommit: (ms: number) => void;
}) {
  const saved = Math.max(0, INTERVALS.findIndex((i) => i.ms === valueMs));
  const [draft, setDraft] = useState<number | null>(null);
  // The server's answer is the source of truth again once it arrives.
  useEffect(() => setDraft(null), [valueMs]);

  const at = draft ?? saved;
  const last = INTERVALS.length - 1;
  const commit = () => {
    if (draft !== null && draft !== saved) onCommit(INTERVALS[draft]!.ms);
  };
  // Tick positions line up with the thumb centre (16px thumb).
  const pos = (i: number) => `calc(${(i / last) * 100}% + ${8 - (i / last) * 16}px)`;

  return (
    <div className="min-w-[240px] max-w-md flex-1">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">Every</span>
        <span className={clsx('text-sm font-medium', disabled ? 'text-muted' : 'text-ink')}>
          {INTERVALS[at]!.long}
        </span>
      </div>
      <input
        type="range"
        className="range"
        min={0}
        max={last}
        step={1}
        value={at}
        disabled={disabled}
        aria-label="Check interval"
        aria-valuetext={`every ${INTERVALS[at]!.long}`}
        style={{ '--fill': `${(at / last) * 100}%` } as CSSProperties}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <div className="relative mt-1 h-4" aria-hidden>
        {INTERVALS.map((iv, i) => (
          <span
            key={iv.ms}
            className={clsx(
              'absolute -translate-x-1/2 text-[10px] tabular',
              i === at && !disabled ? 'font-semibold text-blue-text' : 'text-muted',
            )}
            style={{ left: pos(i) }}
          >
            {iv.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The at-a-glance numbers a Quick scan surfaced for one target. */
function TargetMetrics({ metric }: { metric?: HealthTargetMetric }) {
  if (!metric || metric.healthState === 'unreachable') return null;

  const chips: Array<{ label: string; value: string; warn?: boolean }> = [];
  if (metric.diskPct !== null) chips.push({ label: 'disk', value: `${metric.diskPct}%`, warn: metric.diskPct >= 90 });
  if (metric.memPct !== null) chips.push({ label: 'mem free', value: `${metric.memPct}%`, warn: metric.memPct < 8 });
  if (metric.load1 !== null && metric.cores) {
    chips.push({ label: 'cpu', value: `${metric.load1.toFixed(2)}/${metric.cores}`, warn: metric.load1 / metric.cores > 4 });
  }
  if (metric.failedUnits > 0) chips.push({ label: 'failed', value: String(metric.failedUnits), warn: true });
  if (metric.namespaces !== null) chips.push({ label: 'ns', value: String(metric.namespaces) });
  if (metric.pods !== null) {
    chips.push({
      label: 'pods',
      value: metric.badPods ? `${metric.pods} · ${metric.badPods} bad` : String(metric.pods),
      warn: !!metric.badPods,
    });
  }
  if (chips.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <span
          key={c.label}
          className={clsx(
            'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
            c.warn ? 'border-amber/40 bg-amber/10 text-amber' : 'border-edge bg-tile-2 text-muted',
          )}
        >
          <span className="uppercase tracking-wide opacity-70">{c.label}</span>
          <span className="tabular font-semibold">{c.value}</span>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: number; tone: string; sub?: string }) {
  return (
    <div className="tile flex flex-col gap-1 p-4">
      <span className={clsx('tabular text-2xl font-semibold', tone)}>{value}</span>
      <span className="text-[11px] uppercase tracking-wider text-muted">
        {label}
        {sub && <span className="normal-case tracking-normal"> · {sub}</span>}
      </span>
    </div>
  );
}

function IssueRow({
  issue, targetName, busy, onInvestigate, onDismiss, quiet,
}: {
  issue: HealthIssue;
  /** A note: same row, but the Investigate button steps back. */
  quiet?: boolean;
  targetName?: string;
  busy: boolean;
  onInvestigate: () => void;
  onDismiss: () => void;
}) {
  const sev = SEVERITY_STYLE[issue.severity] ?? SEVERITY_STYLE.unknown!;
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <span className={clsx('mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full', sev.dot)} aria-hidden />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={clsx('chip border', sev.chip)}>{sev.label}</span>
          <span className="truncate text-[13px] font-medium text-ink">{issue.title}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
          {targetName && <span className="font-mono text-cyan">{targetName}</span>}
          <span aria-hidden>·</span>
          <span className="whitespace-nowrap">seen {timeAgo(issue.lastSeenAt)}</span>
          {issue.state === 'investigating' && <span className="text-blue-text">· investigating</span>}
        </div>
        {issue.detail && issue.detail !== issue.title && (
          <p className="mt-1.5 line-clamp-2 break-words text-xs text-muted">{issue.detail}</p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button className={clsx(quiet ? 'btn-ghost' : 'btn-primary', '!min-h-[34px] !text-xs')} disabled={busy} onClick={onInvestigate}>
          {busy ? <Spinner /> : <Search size={13} />} Investigate
        </button>
        <button className="btn-ghost !min-h-[34px] !text-xs" onClick={onDismiss} title="Dismiss this issue">
          <X size={13} /> Dismiss
        </button>
      </div>
    </li>
  );
}
