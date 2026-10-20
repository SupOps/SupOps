import { useState } from 'react';
import { Approvers } from '../components/Approvers';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { isTerminalRun } from '@supops/shared';
import { Terminal, Trash2, Zap } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { useApp } from '../lib/store';
import { STATUS_STYLE, duration, elapsed, tierCounts, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, Spinner, StatusPill } from '../components/ui';
import { RiskBar } from '../components/viz';

import type { Run } from '../lib/types';
import { useLivePoll } from '../lib/live';

const WINDOWS = [
  { label: 'All finished', days: 0 },
  { label: 'Older than 1 day', days: 1 },
  { label: 'Older than 7 days', days: 7 },
];

export function Runs() {
  const projectId = useApp((s) => s.projectId);
  /** Deleting runs erases the audit trail; the server only allows owners and admins. */
  const canDelete = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [days, setDays] = useState(0);
  /** Console sessions and Investigate runs are different kinds of work and mixing
      them in one list made both harder to scan. `interactive` already tells them
      apart on the row, so no new server field is needed. */
  const [kind, setKind] = useState<'all' | 'console' | 'alert' | 'health' | 'investigate'>('all');

  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => api<Run[]>(`/runs?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(4000),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['runs', projectId] });
    void qc.invalidateQueries({ queryKey: ['approvals'] });
  };

  const removeOne = useMutation({
    mutationFn: (id: string) => del(`/runs/${id}`),
    onSuccess: invalidate,
  });

  const prune = useMutation({
    mutationFn: () => post<{ deleted: number }>('/runs/prune', { projectId, olderThanDays: days }),
    onSuccess: () => {
      setConfirming(false);
      invalidate();
    },
  });

  // Only finished runs can be removed -- deleting one mid-command would lose the
  // record of what was already done to a machine.
  const finished = runs.data?.filter((r) => isTerminalRun(r.status)).length ?? 0;

  const isAlert = (r: Run) => r.trigger === 'alert';
  const isHealth = (r: Run) => r.trigger === 'health';
  const isInvestigate = (r: Run) => !r.interactive && !isAlert(r) && !isHealth(r);
  const visible = (runs.data ?? []).filter((r) =>
    kind === 'all' ? true
      : kind === 'console' ? r.interactive
      : kind === 'alert' ? isAlert(r)
      : kind === 'health' ? isHealth(r)
      : isInvestigate(r),
  );
  const counts = {
    all: runs.data?.length ?? 0,
    console: runs.data?.filter((r) => r.interactive).length ?? 0,
    alert: runs.data?.filter(isAlert).length ?? 0,
    health: runs.data?.filter(isHealth).length ?? 0,
    investigate: runs.data?.filter(isInvestigate).length ?? 0,
  };

  return (
    <>
      <PageHeader
        title="Runs"
        subtitle="A record of everything the agents have looked into and fixed"
        action={
          <div className="flex items-center gap-2">
            {canDelete && finished > 0 && (
              <button className="btn-ghost" onClick={() => setConfirming((v) => !v)}>
                <Trash2 size={15} /> Clear history
              </button>
            )}
            <Link to="/investigate" className="btn-primary">
              <Terminal size={16} /> Investigate
            </Link>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {canDelete && confirming && (
          <Panel title="Clear run history" accent="bg-red">
            <div className="flex flex-wrap items-end gap-3 p-4">
              <div className="min-w-52">
                <label className="label">Remove</label>
                <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                  {WINDOWS.map((w) => (
                    <option key={w.days} value={w.days}>{w.label}</option>
                  ))}
                </select>
              </div>
              <button className="btn-danger" onClick={() => prune.mutate()} disabled={prune.isPending}>
                {prune.isPending ? <Spinner /> : <Trash2 size={15} />} Delete
              </button>
              <button className="btn-ghost" onClick={() => setConfirming(false)}>Cancel</button>
              <p className="w-full text-xs text-muted">
                Runs still working or waiting for approval are never deleted — cancel those first.
                This also removes their transcripts and command history permanently.
              </p>
            </div>
          </Panel>
        )}

        {prune.data && (
          <div className="rounded-lg border border-hairline bg-tile px-4 py-3 text-sm text-muted">
            Deleted {prune.data.deleted} run{prune.data.deleted === 1 ? '' : 's'}.
          </div>
        )}
        {removeOne.error && (
          <div className="rounded-lg border border-red/30 bg-red/5 px-4 py-3 text-sm text-red">
            {removeOne.error instanceof Error ? removeOne.error.message : 'Could not delete that run'}
          </div>
        )}

        {counts.all > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(['all', 'console', 'alert', 'health', 'investigate'] as const).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={clsx(
                  'rounded-full border px-3 py-1.5 text-xs capitalize transition-colors',
                  kind === k
                    ? 'border-blue/50 bg-blue/15 text-blue-text'
                    : 'border-edge bg-tile-2 text-muted hover:text-ink',
                )}
              >
                {k} <span className="tabular ml-1 text-[11px] opacity-70">{counts[k]}</span>
              </button>
            ))}
          </div>
        )}

        <Panel>
          {visible.length ? (
            <ul className="divide-y divide-hairline">
              {visible.map((run) => (
                <li key={run.id} className="group flex items-center gap-2 hover:bg-tile-2">
                  <Link
                    to={`/runs/${run.id}`}
                    className="flex min-w-0 flex-1 items-center gap-4 py-3.5 pl-5 pr-3"
                  >
                    <span
                      className={clsx('h-9 w-[3px] shrink-0 rounded-full', STATUS_STYLE[run.status].rail)}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        {run.interactive && (
                          <span className={clsx('shrink-0 rounded border px-1.5 py-px text-[10px] uppercase tracking-wider', run.policySnapshot?.call ? 'border-violet/40 bg-violet/10 text-violet' : 'border-edge text-muted')}>
                            {run.policySnapshot?.call ? 'call' : 'console'}
                          </span>
                        )}
                        {run.trigger === 'alert' && (
                          <span className="shrink-0 rounded border border-amber/40 bg-amber/10 px-1.5 py-px text-[10px] uppercase tracking-wider text-amber">
                            alert
                          </span>
                        )}
                        {run.trigger === 'health' && (
                          <span className="shrink-0 rounded border border-green/40 bg-green/10 px-1.5 py-px text-[10px] uppercase tracking-wider text-green">
                            health
                          </span>
                        )}
                        <span className="truncate text-[13px] text-ink">{run.title}</span>
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] text-muted">
                        <StatusPill status={run.status} />
                        <span aria-hidden>·</span>
                        <span className="whitespace-nowrap">{timeAgo(run.startedAt)}</span>
                        {run.startedByName && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="whitespace-nowrap">by {run.startedByName}</span>
                          </>
                        )}
                        {run.approvals && (run.approvals.approved > 0 || run.approvals.denied > 0) && (
                          <>
                            <span aria-hidden>·</span>
                            <Approvers approvals={run.approvals} className="truncate" />
                          </>
                        )}
                        {run.endedAt && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="tabular whitespace-nowrap">
                              {duration(elapsed(run.startedAt, run.endedAt))}
                            </span>
                          </>
                        )}
                        {run.targets?.length ? (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate font-mono text-cyan">{run.targets.join(', ')}</span>
                          </>
                        ) : null}
                        {run.statusReason && (
                          <>
                            <span aria-hidden>·</span>
                            <span className="truncate">{run.statusReason.slice(0, 60)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {/* The run's risk fingerprint -- what it did and how risky, at a glance. */}
                    <RiskBar
                      counts={tierCounts(run.actions ?? [])}
                      inline
                      className="hidden shrink-0 sm:inline-flex"
                    />
                  </Link>
                  {/* The slot is always occupied: rendering the button only for
                      finished runs let the link stretch 56px further on every open
                      Console session, which is what made the risk bars ragged. */}
                  {canDelete && isTerminalRun(run.status) ? (
                    <button
                      className="mr-3 grid h-11 w-11 shrink-0 place-items-center rounded-inner text-muted transition-colors hover:bg-white/5 hover:text-red focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      title="Delete this run"
                      onClick={() => removeOne.mutate(run.id)}
                      disabled={removeOne.isPending}
                    >
                      <Trash2 size={14} />
                    </button>
                  ) : (
                    <span className="mr-3 h-11 w-11 shrink-0" aria-hidden />
                  )}
                </li>
              ))}
            </ul>
          ) : counts.all ? (
            <Empty
              icon={<Zap size={28} />}
              title={`No ${kind} runs`}
              hint="Nothing of this kind yet — switch the filter to see the rest."
            />
          ) : (
            <Empty
              icon={<Zap size={28} />}
              title="No runs yet"
              hint="Describe a problem and the agent will investigate it, acting where the risk is low enough."
              action={<Link to="/investigate" className="btn-primary">Investigate something</Link>}
            />
          )}
        </Panel>
      </div>
    </>
  );
}
