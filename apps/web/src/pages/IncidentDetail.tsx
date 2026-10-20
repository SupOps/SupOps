import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowLeft, BellOff, ChevronDown, ExternalLink, EyeOff, GitMerge, MessageSquare, Play, RefreshCw, RotateCcw, Scissors, ShieldCheck } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { Empty, Panel, Segmented, Spinner, StatusPill } from '../components/ui';
import type { Evidence, IncidentDetail as Detail } from '../lib/types';
import { SURE, VERDICT, verdictOf } from '../lib/observe-ui';
import { ChangeSuspects } from '../components/Changes';

const SEV_CHIP: Record<string, string> = {
  critical: 'border-red/40 bg-red/10 text-red',
  warning: 'border-amber/40 bg-amber/10 text-amber',
  info: 'border-cyan/40 bg-cyan/10 text-cyan',
  unknown: 'border-edge bg-tile-2 text-muted',
};
const CONFIDENCE: Record<string, string> = {
  high: 'text-green',
  medium: 'text-amber',
  low: 'text-muted',
  inconclusive: 'text-muted',
};
const EV_DOT: Record<Evidence['status'], string> = {
  interesting: 'bg-amber',
  normal: 'bg-green/70',
  error: 'bg-red',
  unavailable: 'bg-dim',
};

export function IncidentDetail() {
  const { id } = useParams();
  const projectId = useApp((s) => s.projectId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const d = useQuery({
    queryKey: ['incident', id],
    queryFn: () => api<Detail>(`/observability/incidents/${id}`),
    refetchInterval: (q) => (q.state.data?.incident.triageState === 'running' || q.state.data?.incident.triageState === 'evidence' ? 4000 : 15_000),
  });
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['incident', id] });
    void qc.invalidateQueries({ queryKey: ['obs', projectId] });
    void qc.invalidateQueries({ queryKey: ['incidents', projectId] });
  };
  const investigate = useMutation({
    mutationFn: () => post<{ runId: string }>(`/observability/incidents/${id}/investigate`, {}),
    onSuccess: ({ runId }) => navigate(`/runs/${runId}`),
  });
  const recheck = useMutation({ mutationFn: () => post(`/observability/incidents/${id}/evidence`, {}), onSuccess: invalidate });
  const resolve = useMutation({ mutationFn: () => post(`/observability/incidents/${id}/resolve`, {}), onSuccess: invalidate });
  const ignore = useMutation({
    mutationFn: (v: { hours: number; reason: string }) => post(`/observability/incidents/${id}/ignore`, v),
    onSuccess: () => {
      setIgnoring(false);
      invalidate();
    },
  });
  const reopen = useMutation({ mutationFn: () => post(`/observability/incidents/${id}/reopen`, {}), onSuccess: invalidate });
  const [ignoring, setIgnoring] = useState(false);
  const merge = useMutation({ mutationFn: (into: string) => post(`/observability/incidents/${id}/merge`, { into }), onSuccess: () => navigate('/observability?tab=incidents') });
  // Merging a suggestion keeps this page: the other incident's alerts come here.
  const absorb = useMutation({ mutationFn: (other: string) => post(`/observability/incidents/${other}/merge`, { into: id }), onSuccess: invalidate });
  const notRelated = useMutation({ mutationFn: (other: string) => post(`/observability/incidents/${id}/not-related`, { other }), onSuccess: invalidate });
  const acknowledge = useMutation({ mutationFn: (on: boolean) => post(`/observability/incidents/${id}/${on ? 'acknowledge' : 'unacknowledge'}`, {}), onSuccess: invalidate });
  const assign = useMutation({ mutationFn: (userId: string | null) => post(`/observability/incidents/${id}/assign`, { userId }), onSuccess: invalidate });
  const severity = useMutation({ mutationFn: (v: string) => post(`/observability/incidents/${id}/severity`, { severity: v }), onSuccess: invalidate });
  const assignees = useQuery({ queryKey: ['assignees'], queryFn: () => api<Array<{ id: string; name: string }>>('/observability/assignees'), staleTime: 5 * 60_000 });
  const me = useApp((s) => s.user);
  const [splitting, setSplitting] = useState<Set<string> | null>(null);
  const split = useMutation({
    mutationFn: () => post<{ id: string }>(`/observability/incidents/${id}/split`, { alertIds: [...(splitting ?? [])] }),
    onSuccess: () => {
      setSplitting(null);
      invalidate();
    },
  });

  if (d.isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;
  if (!d.data) return <Empty title="Incident not found" hint="It may have been cleaned up after 15 days." action={<Link className="btn-ghost" to="/observability">Back</Link>} />;
  const { incident: inc, alerts, evidence, run, fixRun, timeline, mergeCandidates, suggestions = [] } = d.data;
  const cited = evidence.filter((e) => e.ref !== '-');
  const missing = evidence.filter((e) => e.ref === '-');
  const busy = inc.triageState === 'evidence' || inc.triageState === 'running';
  const error = [investigate, recheck, resolve, merge, split, ignore, reopen, acknowledge, assign, severity].find((m) => m.isError)?.error as Error | undefined;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 pb-10 pt-5 sm:px-6">
      <Link to="/observability" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"><ArrowLeft size={13} /> Observability</Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          {inc.status === 'open' && <span className={clsx('chip', VERDICT[verdictOf(inc)].chip)} title={VERDICT[verdictOf(inc)].hint}>{VERDICT[verdictOf(inc)].label}</span>}
          <span className={clsx('chip uppercase', SEV_CHIP[inc.severity])}>{inc.severity}</span>
          <span className={clsx('text-xs', inc.status === 'open' ? 'text-amber' : inc.status === 'ignored' ? 'text-muted' : 'text-green')}>
            {inc.status === 'open' ? 'Open' : inc.status === 'ignored' ? 'Ignored' : 'Resolved'}
          </span>
          {inc.origin === 'prediction' && <span className="text-xs text-amber">· forecast, nothing has failed yet</span>}
          {inc.origin === 'threshold' && <span className="text-xs text-amber">· over the limit set for it</span>}
          <span className="text-xs text-muted">· opened {timeAgo(inc.openedAt)}</span>
          {inc.acknowledgedAt && (
            <span className="chip border border-green/40 bg-green/10 text-green" title="Lapses by itself if the incident gets worse">
              Acknowledged{inc.acknowledgedByName ? ` by ${inc.acknowledgedByName}` : ''} {timeAgo(inc.acknowledgedAt)}
            </span>
          )}
        </div>
        <h1 className="text-[22px] font-semibold leading-snug tracking-[-0.01em] text-ink">{inc.title}</h1>
        {(inc.targets.length > 0 || inc.groupReason) && (
          <p className="text-xs text-muted">
            {inc.targets.length > 0 && <>On <span className="font-mono text-ink/80">{inc.targets.join(', ')}</span>. </>}
            {inc.groupReason && <>Grouped because {inc.groupReason}.</>}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            <span>Owner</span>
            <select
              className="input !min-h-[32px] !w-auto !py-1 text-xs"
              value={inc.assigneeId ?? ''}
              disabled={assign.isPending}
              onChange={(e) => assign.mutate(e.target.value || null)}
              aria-label="Assign to"
            >
              <option value="">Nobody</option>
              {me && !assignees.data?.some((u) => u.id === me.id) && <option value={me.id}>{me.name} (me)</option>}
              {(assignees.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}{u.id === me?.id ? ' (me)' : ''}</option>)}
            </select>
          </label>
          {me && inc.assigneeId !== me.id && (
            <button className="text-blue-text hover:underline" onClick={() => assign.mutate(me.id)} disabled={assign.isPending}>Assign to me</button>
          )}
          <label className="flex items-center gap-1.5">
            <span>Severity</span>
            <select
              className="input !min-h-[32px] !w-auto !py-1 text-xs"
              value={inc.severity === 'unknown' ? '' : inc.severity}
              disabled={severity.isPending}
              onChange={(e) => e.target.value && severity.mutate(e.target.value)}
              aria-label="Severity"
              title={inc.severityPinned ? 'Set by a person: new alerts no longer change it' : 'Follows its worst alert until you set it'}
            >
              {inc.severity === 'unknown' && <option value="">Unknown</option>}
              <option value="critical">Critical</option>
              <option value="warning">Warning</option>
              <option value="info">Info</option>
            </select>
          </label>
          {inc.severityPinned && <span className="text-[11px]">set by hand</span>}
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {inc.status === 'open' && (
            <button
              className="btn-ghost !min-h-[36px]"
              disabled={acknowledge.isPending}
              onClick={() => acknowledge.mutate(!inc.acknowledgedAt)}
              title={inc.acknowledgedAt ? 'Take it back: the incident is news again' : 'You are on it. It lapses by itself if the incident gets worse.'}
            >
              {acknowledge.isPending ? <Spinner /> : <BellOff size={14} />} {inc.acknowledgedAt ? 'Unacknowledge' : 'Acknowledge'}
            </button>
          )}
          {busy && run ? (
            <Link to={`/runs/${run.id}`} className="btn-primary !min-h-[36px]"><Play size={14} /> Watch the diagnosis</Link>
          ) : inc.status === 'open' || !fixRun ? (
            <button className="btn-primary !min-h-[36px]" disabled={investigate.isPending || busy} onClick={() => investigate.mutate()} title="Starts from the diagnosis and proposes the fix; every change waits for your approval">
              {investigate.isPending ? <Spinner /> : <ShieldCheck size={14} />} Investigate
            </button>
          ) : null}
          {fixRun && (
            <Link to={`/runs/${fixRun.id}`} className="btn-ghost !min-h-[36px]"><Play size={14} /> Open fix run</Link>
          )}
          {run && !busy && (
            <Link to={`/runs/${run.id}`} className="btn-ghost !min-h-[36px]"><Play size={14} /> Diagnosis report</Link>
          )}
          <button className="btn-ghost !min-h-[36px]" disabled={recheck.isPending || busy} onClick={() => recheck.mutate()}>
            {recheck.isPending ? <Spinner /> : <RefreshCw size={14} />} Re-run checks
          </button>
          {inc.status === 'open' && (
            <>
              <button className="btn-ghost !min-h-[36px]" disabled={resolve.isPending} onClick={() => resolve.mutate()} title="Closes it now; if its alerts are in fact still firing they come back as a new incident">Mark resolved</button>
              <button className="btn-ghost !min-h-[36px]" onClick={() => setIgnoring((v) => !v)} aria-expanded={ignoring}><EyeOff size={14} /> Ignore…</button>
            </>
          )}
          {inc.status !== 'open' && !inc.mergedInto && (
            <button className="btn-ghost !min-h-[36px]" disabled={reopen.isPending} onClick={() => reopen.mutate()}>{reopen.isPending ? <Spinner /> : <RotateCcw size={14} />} Reopen</button>
          )}
        </div>
        {inc.held && d.data.rule && (
          <p className="rounded-inner border border-blue/30 bg-blue/[0.06] px-3 py-2 text-xs leading-relaxed text-muted">
            Waiting: the rule <span className="text-ink">{d.data.rule.name}</span> shows an incident once it has {d.data.rule.threshold} alerts, and this one has {alerts.length}.
            Until then it is not listed and not diagnosed. Its alerts are on the Alerts page.
          </p>
        )}
        {ignoring && <IgnoreForm busy={ignore.isPending} onCancel={() => setIgnoring(false)} onIgnore={(hours, reason) => ignore.mutate({ hours, reason })} />}
        {inc.status === 'ignored' && (
          <p className="rounded-inner border border-hairline bg-tile-2/60 px-3 py-2 text-xs leading-relaxed text-muted">
            Ignored{inc.ignoredBy ? ` by ${inc.ignoredBy}` : ''}{inc.ignoreReason ? ` (${inc.ignoreReason})` : ''}
            {inc.ignoredUntil && <> until <span className="text-ink">{new Date(inc.ignoredUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></>}.
            {' '}Then it is checked again and reopens if its alerts still fire. If one gets worse, it reopens straight away.
          </p>
        )}
        {!busy && inc.status === 'open' && <p className="text-[11px] text-muted">Investigate builds on the read-only diagnosis below and proposes the fix. Nothing changes without your approval.</p>}
        {error && <p className="text-sm text-red">{error.message}</p>}
      </header>

      {/* The verdict */}
      <Panel title="Diagnosis" accent="bg-blue">
        <div className="px-5 pb-5">
          {busy ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner className="!h-3.5 !w-3.5 text-blue" />
              {inc.triageState === 'evidence' ? 'Running the read-only checks…' : 'Diagnosing, read-only. Nothing is changed.'}
              {run && <Link className="text-blue-text hover:underline" to={`/runs/${run.id}`}>Watch</Link>}
            </p>
          ) : inc.rootCause ? (
            <>
              <p className="text-[15px] leading-relaxed text-ink">{inc.rootCause}</p>
              <p className="mt-1.5 text-xs text-muted">
                <span className={clsx('font-medium', CONFIDENCE[inc.confidence ?? 'low'])}>{SURE[inc.confidence ?? ''] ?? 'Certainty not stated'}</span>
                {run && <> · <Link className="text-blue-text hover:underline" to={`/runs/${run.id}`}>full report</Link></>}
              </p>
              <Weighed hypotheses={inc.hypotheses ?? []} />
              {inc.blastRadius && <BlastRadius r={inc.blastRadius} />}
            </>
          ) : (
            <p className="text-sm text-muted">
              {inc.triageState === 'done' ? 'The diagnosis finished without naming a root cause.' : 'Not diagnosed yet. Investigate diagnoses it first.'}
            </p>
          )}
          {inc.triageNote && <p className="mt-3 rounded-inner border border-amber/30 bg-amber/[0.06] px-3 py-2 text-xs leading-relaxed text-amber">{inc.triageNote}</p>}
          {run && !busy && (
            <div className="mt-3 flex items-center gap-2 text-[11px] text-muted"><StatusPill status={run.status} /> <span>started {timeAgo(run.startedAt)}</span></div>
          )}
        </div>
      </Panel>

      <ChangeSuspects incidentId={inc.id} />

      {/* Evidence */}
      <Panel title="Evidence" accent="bg-amber" action={<span className="text-[11px] text-muted">{cited.filter((e) => e.status === 'interesting').length} of {cited.length} notable</span>}>
        {cited.length ? (
          <ul className="divide-y divide-hairline border-t border-hairline">
            {cited.map((e) => <EvidenceRow key={e.id} e={e} />)}
          </ul>
        ) : (
          <p className="px-5 pb-4 text-sm text-muted">{busy ? 'Gathering…' : 'No metrics or logs connection could be checked.'}</p>
        )}
        {missing.length > 0 && (
          <p className="border-t border-hairline px-5 py-2.5 text-[11px] text-muted">Not measured here: {[...new Set(missing.map((e) => e.title))].join(', ')}.</p>
        )}
      </Panel>

      {(d.data.map.dependsOn.length > 0 || d.data.map.affected.length > 0) && (
        <Panel title="Connected systems" accent="bg-cyan" action={<Link to="/knowledge" className="text-[11px] text-blue-text hover:underline">Service map</Link>}>
          <div className="grid gap-0 border-t border-hairline sm:grid-cols-2 sm:divide-x sm:divide-hairline">
            {([['It relies on', d.data.map.dependsOn, 'A problem here is a likely origin.'], ['Affected if it is down', d.data.map.affected, 'What else feels this.']] as const).map(([title, rows, hint]) => (
              <div key={title} className="px-5 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-dim">{title}</div>
                <p className="text-[10.5px] text-dim">{hint}</p>
                {rows.length ? (
                  <ul className="mt-2 space-y-1">
                    {rows.slice(0, 10).map((r) => (
                      <li key={r.id} className="text-[12.5px]">
                        <span className={clsx('mr-1.5 inline-block h-1.5 w-1.5 rounded-full', r.problems.length ? 'bg-red' : 'bg-green/70')} />
                        <span className="text-ink">{r.name}</span>
                        {r.depth > 1 && <span className="text-[10.5px] text-dim"> · {r.depth} steps</span>}
                        {r.problems.map((p) => <span key={p} className="block pl-3 text-[11px] text-red">{p}</span>)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted">Nothing on the map.</p>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
        {/* Alerts */}
        <Panel
          title={`Alerts (${alerts.length})`}
          accent="bg-red"
          action={
            alerts.length > 1 && inc.status === 'open' ? (
              splitting ? (
                <div className="flex gap-1.5">
                  <button className="btn-ghost !min-h-[28px] !px-2 text-[11px]" onClick={() => setSplitting(null)}>Cancel</button>
                  <button className="btn-primary !min-h-[28px] !px-2 text-[11px]" disabled={!splitting.size || splitting.size === alerts.length || split.isPending} onClick={() => split.mutate()}>Split {splitting.size || ''}</button>
                </div>
              ) : (
                <button className="btn-ghost !min-h-[28px] !px-2 text-[11px]" onClick={() => setSplitting(new Set())}><Scissors size={12} /> Split</button>
              )
            ) : undefined
          }
        >
          {alerts.length ? (
            <ul className="divide-y divide-hairline border-t border-hairline">
              {alerts.map((a) => (
                <li key={a.id} className="flex items-start gap-2.5 px-5 py-2.5">
                  {splitting && (
                    <input type="checkbox" className="mt-1" checked={splitting.has(a.id)} aria-label={`Split out ${a.title}`}
                      onChange={(e) => {
                        const next = new Set(splitting);
                        if (e.target.checked) next.add(a.id);
                        else next.delete(a.id);
                        setSplitting(next);
                      }} />
                  )}
                  <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', a.status === 'resolved' ? 'bg-green' : a.severity === 'critical' ? 'bg-red' : 'bg-amber')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
                      <span className="text-ink">{a.title}</span>
                      {a.labels?.instance && <span className="font-mono text-[11px] text-muted">{a.labels.instance}</span>}
                      {a.status === 'resolved' && <span className="text-[11px] text-green">resolved</span>}
                    </div>
                    {a.summary && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{a.summary}</p>}
                    <div className="mt-0.5 text-[10.5px] text-dim">
                      {a.source} · {timeAgo(a.startsAt ?? a.receivedAt)}
                      {a.slackPermalink && <> · <a className="inline-flex items-center gap-0.5 hover:text-ink" href={a.slackPermalink} target="_blank" rel="noreferrer">Slack <ExternalLink size={9} /></a></>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-5 pb-4 text-sm text-muted">{inc.origin === 'prediction' ? 'Raised by a forecast, before any alert fired.' : 'No alerts.'}</p>
          )}
          {suggestions.length > 0 && inc.status === 'open' && (
            <div className="space-y-2 border-t border-hairline px-5 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted">Possibly the same problem</p>
              {suggestions.map((sg) => (
                <div key={sg.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-inner border border-hairline bg-tile-2/40 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <Link to={`/observability/incidents/${sg.id}`} className="text-[13px] text-ink hover:underline">{sg.title}</Link>
                    <p className="text-[11px] text-muted">{sg.reason}</p>
                  </div>
                  <button className="btn-ghost !min-h-[30px] !text-xs" disabled={absorb.isPending} onClick={() => absorb.mutate(sg.id)}><GitMerge size={13} /> Merge into this one</button>
                  <button className="btn-ghost !min-h-[30px] !text-xs" disabled={notRelated.isPending} onClick={() => notRelated.mutate(sg.id)}>Not related</button>
                </div>
              ))}
            </div>
          )}
          {mergeCandidates.length > 0 && inc.status === 'open' && (
            <div className="flex items-center gap-2 border-t border-hairline px-5 py-2.5">
              <GitMerge size={13} className="shrink-0 text-muted" />
              <select className="input !min-h-[30px] !py-1 text-xs" defaultValue="" onChange={(e) => e.target.value && merge.mutate(e.target.value)} aria-label="Merge into another incident">
                <option value="" disabled>Same problem as…</option>
                {mergeCandidates.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </div>
          )}
        </Panel>

        {/* Timeline */}
        <Panel title="Timeline" accent="bg-cyan">
          <CommentBox incidentId={inc.id} onAdded={invalidate} />
          <ol className="relative space-y-3 border-t border-hairline px-5 pb-5 pt-4">
            {timeline.map((t, i) => (
              <li key={i} className="relative pl-4">
                <span className={clsx('absolute left-0 top-1.5 h-1.5 w-1.5 rounded-full', t.kind === 'alert' ? 'bg-red' : t.kind === 'resolved' || t.kind === 'closed' ? 'bg-green' : t.kind === 'change' || t.kind === 'deploy' ? 'bg-amber' : t.kind === 'ignored' || t.kind === 'pending' ? 'bg-dim' : t.kind === 'person' || t.kind === 'comment' ? 'bg-violet' : 'bg-blue')} />
                {i < timeline.length - 1 && <span className="absolute left-[2.5px] top-3.5 h-[calc(100%+4px)] w-px bg-hairline" />}
                <div className={clsx('text-[12.5px] leading-snug text-ink', t.kind === 'comment' && 'whitespace-pre-wrap break-words rounded-inner border border-hairline bg-tile-2/60 px-2.5 py-1.5')}>{t.text}</div>
                <div className="font-mono text-[10.5px] text-dim">{new Date(t.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </div>
  );
}

/** Ignore for a while -- always for a while, so a mistake cannot hide a problem for good. */
function IgnoreForm({ busy, onIgnore, onCancel }: { busy: boolean; onIgnore: (hours: number, reason: string) => void; onCancel: () => void }) {
  const [hours, setHours] = useState<'1' | '4' | '24' | '168'>('4');
  const [reason, setReason] = useState('');
  return (
    <div className="space-y-3 rounded-inner border border-hairline bg-tile-2/60 p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Ignore for</span>
        <Segmented label="Ignore for" value={hours} onChange={setHours} options={[{ value: '1', label: '1 hour' }, { value: '4', label: '4 hours' }, { value: '24', label: '24 hours' }, { value: '168', label: '7 days' }]} />
      </div>
      <input className="input text-sm" value={reason} maxLength={300} placeholder="Why (optional) -- e.g. planned maintenance" onChange={(e) => setReason(e.target.value)} />
      <p className="text-[11px] leading-relaxed text-muted">Its alerts leave the queue and nothing more is investigated. When the time is up it is checked again and reopens if it is still happening; if an alert gets worse, it reopens straight away.</p>
      <div className="flex gap-2">
        <button className="btn-primary !min-h-[34px]" disabled={busy} onClick={() => onIgnore(Number(hours), reason)}>{busy ? <Spinner /> : <EyeOff size={14} />} Ignore</button>
        <button className="btn-ghost !min-h-[34px]" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function EvidenceRow({ e }: { e: Evidence }) {
  const [open, setOpen] = useState(e.status === 'interesting');
  const [head, ...rest] = e.summary.split('\n');
  return (
    <li>
      <button className="flex w-full items-start gap-3 px-5 py-2.5 text-left transition-colors hover:bg-white/[0.03]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="mt-0.5 w-7 shrink-0 font-mono text-[11px] text-muted">{e.ref}</span>
        <span className={clsx('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', EV_DOT[e.status])} aria-label={e.status} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={clsx('text-[13px]', e.status === 'interesting' ? 'font-medium text-ink' : 'text-ink/85')}>{e.title}</span>
            {e.connection && <span className="font-mono text-[10.5px] text-dim">{e.connection}</span>}
          </div>
          <div className={clsx('mt-0.5 text-xs', e.status === 'error' ? 'text-red' : 'text-muted', !open && 'truncate')}>{head}</div>
        </div>
        <ChevronDown size={13} className={clsx('mt-1 shrink-0 text-dim transition-transform', open && 'rotate-180')} />
      </button>
      {open && (rest.length > 0 || e.query) && (
        <div className="space-y-2 pb-3 pl-5 pr-5 sm:pl-[78px]">
          {rest.length > 0 && <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink/90">{rest.join('\n')}</pre>}
          {e.query && <pre className="whitespace-pre-wrap break-all rounded-inner border border-hairline bg-ground/60 px-2.5 py-1.5 font-mono text-[10.5px] text-muted">{e.query}</pre>}
        </div>
      )}
    </li>
  );
}

/** Notes for whoever picks this up next: append-only, on the timeline with the rest. */
function CommentBox({ incidentId, onAdded }: { incidentId: string; onAdded: () => void }) {
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => post(`/observability/incidents/${incidentId}/comments`, { text }),
    onSuccess: () => {
      setText('');
      onAdded();
    },
  });
  return (
    <div className="space-y-2 border-t border-hairline px-5 py-3">
      <textarea
        className="input min-h-[64px] text-[13px]"
        value={text}
        maxLength={4000}
        placeholder="Add a note: what you checked, what you are trying…"
        aria-label="Add a note"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) add.mutate();
        }}
      />
      <div className="flex items-center gap-2">
        <button className="btn-ghost !min-h-[32px] !text-xs" disabled={!text.trim() || add.isPending} onClick={() => add.mutate()}>
          {add.isPending ? <Spinner /> : <MessageSquare size={13} />} Add note
        </button>
        {add.error && <span className="text-[11px] text-red">{(add.error as Error).message}</span>}
      </div>
    </div>
  );
}

const HYPOTHESIS: Record<'confirmed' | 'ruled_out' | 'untested', { label: string; tone: string }> = {
  confirmed: { label: 'Confirmed', tone: 'border-green/30 bg-green/10 text-green' },
  ruled_out: { label: 'Ruled out', tone: 'border-hairline bg-tile-2 text-muted' },
  untested: { label: 'Untested', tone: 'border-amber/30 bg-amber/10 text-amber' },
};

/** Every cause the diagnosis weighed, not only the winner: what was ruled out is evidence too. */
function Weighed({ hypotheses }: { hypotheses: NonNullable<Detail['incident']['hypotheses']> }) {
  if (!hypotheses.length) return null;
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Causes weighed</h3>
      <ul className="divide-y divide-hairline rounded-inner border border-hairline">
        {hypotheses.map((h, i) => (
          <li key={i} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-start sm:gap-3">
            <span className={clsx('chip w-fit shrink-0 !text-[10.5px]', HYPOTHESIS[h.verdict].tone)}>{HYPOTHESIS[h.verdict].label}</span>
            <span className="min-w-0 text-[13px] leading-snug">
              <span className={clsx(h.verdict === 'ruled_out' ? 'text-muted' : 'text-ink')}>{h.hypothesis}</span>
              {h.evidence && <span className="block break-words text-xs text-muted">{h.evidence}</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Affected, checked and fine, and not checked: what a person still has to look at is explicit. */
function BlastRadius({ r }: { r: NonNullable<Detail['incident']['blastRadius']> }) {
  const rows: Array<[string, string | null, string]> = [
    ['Affected', r.affected, 'text-red'],
    ['Checked, healthy', r.healthy, 'text-green'],
    ['Not checked', r.unchecked, 'text-amber'],
  ];
  return (
    <div className="mt-4">
      <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Blast radius</h3>
      <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[max-content_1fr]">
        {rows.filter(([, v]) => v).map(([k, v, tone]) => (
          <div key={k} className="contents">
            <dt className={clsx('text-xs font-medium sm:pt-px', tone)}>{k}</dt>
            <dd className="min-w-0 break-words text-ink/90">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
