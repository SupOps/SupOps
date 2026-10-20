import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RotateCcw, ShieldCheck, ShieldOff, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { CallCommand, Empty, Panel, RiskBadge, Segmented, Spinner } from '../components/ui';
import { Approvers } from '../components/Approvers';
import type { ApprovalHistoryEntry, PendingApproval, TrustedCommand } from '../lib/types';
import { useLivePoll } from '../lib/live';

type Tab = 'waiting' | 'trusted' | 'history';

/** Same kind colours as the Runs list chips. */
const KIND_CHIP: Record<ApprovalHistoryEntry['kind'], string> = {
  investigate: 'border-blue/40 bg-blue/10 text-blue-text',
  console: 'border-edge text-muted',
  health: 'border-green/40 bg-green/10 text-green',
  alert: 'border-amber/40 bg-amber/10 text-amber',
};

export function Approvals() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'waiting';
  const trusted = useQuery({
    queryKey: ['trusted', projectId],
    queryFn: () => api<TrustedCommand[]>(`/trusted-commands?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const activeTrusted = (trusted.data ?? []).filter((t) => t.status === 'active').length;
  const suggested = (trusted.data ?? []).filter((t) => t.status === 'suggested').length;
  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => api<PendingApproval[]>(`/runs/approvals/pending?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(4000),
  });
  const history = useQuery({
    queryKey: ['approvalHistory', projectId],
    queryFn: () => api<ApprovalHistoryEntry[]>(`/runs/approvals/history?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(8000),
  });

  return (
    <>
      <PageHeader title="Approvals" subtitle="An agent wanted to do something risky and stopped to ask. Your call." />
      <div className="space-y-3 p-6">
        <Segmented
          label="View"
          value={tab}
          onChange={(t) => setParams(t === 'waiting' ? {} : { tab: t }, { replace: true })}
          options={[
            { value: 'waiting', label: `Waiting${approvals.data?.length ? ` ${approvals.data.length}` : ''}` },
            { value: 'trusted', label: `Trusted${activeTrusted ? ` ${activeTrusted}` : ''}${suggested ? ` · ${suggested} suggested` : ''}` },
            { value: 'history', label: 'History' },
          ]}
        />
        {tab === 'trusted' ? (
          <TrustedList rules={trusted.data ?? []} loading={trusted.isLoading} isAdmin={isAdmin} projectId={projectId!} />
        ) : tab === 'waiting' ? (
        approvals.data?.length ? (
          approvals.data.map(({ toolCall, run }) => (
            <Panel key={toolCall.id} className="p-4">
              <div className="mb-3 flex items-center gap-2">
                <RiskBadge tier={toolCall.tier} />
                <span className="font-mono text-xs text-muted">{toolCall.toolKey}</span>
                <div className="flex-1" />
                <span className="text-xs text-muted">{run && timeAgo(run.startedAt)}</span>
              </div>
              <CallCommand call={toolCall} className="mb-3" />
              <div className="flex items-center justify-between gap-3">
                <p className="min-w-0 truncate text-xs text-muted">{run?.title}</p>
                {/* Decisions are made on the run page, in the context that justifies them. */}
                <Link to={`/runs/${toolCall.runId}`} className="btn-primary shrink-0">
                  Review in context
                </Link>
              </div>
            </Panel>
          ))
        ) : (
          <Panel>
            <Empty
              icon={<ShieldCheck size={28} />}
              title="Nothing waiting"
              hint="When an agent proposes something riskier than your policy allows it to run on its own, it will appear here."
            />
          </Panel>
        )
        ) : null}

        {/* Decided history, one row per run: which investigation / console / health
            check it was and who approved or rejected its steps. Per-step detail is on
            the run page. */}
        {tab === 'history' && !history.data?.length && (
          <Panel><Empty icon={<Check size={24} />} title="No decisions yet" hint="Approved and rejected actions show up here, one row per run." /></Panel>
        )}
        {tab === 'history' && history.data && history.data.length > 0 && (
          <Panel title="Recently decided" accent="bg-muted">
            <ul className="divide-y divide-hairline">
              {history.data.map((h) => (
                <li key={h.runId}>
                  <Link to={`/runs/${h.runId}`} className="flex items-start gap-3 px-5 py-3 hover:bg-tile-2">
                    <span
                      className={clsx(
                        'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full',
                        h.denied === 0 ? 'bg-green/15 text-green' : h.approved === 0 ? 'bg-red/15 text-red' : 'bg-amber/15 text-amber',
                      )}
                      aria-hidden
                    >
                      {h.denied === 0 ? <Check size={12} /> : <X size={12} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className={clsx('shrink-0 rounded border px-1.5 py-px text-[10px] uppercase tracking-wider', KIND_CHIP[h.kind])}>
                          {h.kind}
                        </span>
                        <span className="truncate text-[13px] text-ink">{h.runTitle}</span>
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
                        <Approvers approvals={h} />
                        <span aria-hidden>·</span>
                        <span className="tabular whitespace-nowrap">
                          {h.approved} approved{h.denied ? `, ${h.denied} rejected` : ''}
                        </span>
                        {h.startedByName && <><span aria-hidden>·</span><span className="whitespace-nowrap">started by {h.startedByName}</span></>}
                        {h.lastDecidedAt && <><span aria-hidden>·</span><span className="whitespace-nowrap">{timeAgo(h.lastDecidedAt)}</span></>}
                      </div>
                      {h.lastComment && (
                        <p className="mt-1 line-clamp-2 text-[11px] text-muted">“{h.lastComment}”</p>
                      )}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

/**
 * Trusted commands: standing approvals, per project. Each says exactly what it covers,
 * where, who trusted it and how often it has been used. Untrusting keeps it listed for
 * 30 days, so a mistake is one click to undo.
 */
function TrustedList({ rules, loading, isAdmin, projectId }: { rules: TrustedCommand[]; loading: boolean; isAdmin: boolean; projectId: string }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: ['trusted', projectId] });
  const untrust = useMutation({ mutationFn: (id: string) => del(`/trusted-commands/${id}`), onSuccess: () => { setConfirm(null); done(); } });
  const restore = useMutation({ mutationFn: (id: string) => post(`/trusted-commands/${id}/restore`, {}), onSuccess: done });
  const decide = useMutation({ mutationFn: (v: { id: string; action: 'approve' | 'reject' }) => patch(`/trusted-commands/${v.id}`, { action: v.action }), onSuccess: done });
  const err = (untrust.error ?? restore.error ?? decide.error) as Error | null;

  if (loading) return <div className="grid h-32 place-items-center"><Spinner /></div>;
  if (!rules.length) {
    return (
      <Panel>
        <Empty
          icon={<ShieldCheck size={28} />}
          title="No trusted commands"
          hint="Routine actions you approve again and again, like deleting rotated logs, can be trusted: choose Approve & trust on an approval, or Trust this command on an action in a run. A trusted command keeps its risk rating and never runs in automatic diagnosis."
        />
      </Panel>
    );
  }
  const groups: Array<{ title: string; status: TrustedCommand['status'] }> = [
    { title: 'Suggested', status: 'suggested' },
    { title: 'Trusted', status: 'active' },
    { title: 'Untrusted recently', status: 'revoked' },
  ];
  return (
    <div className="space-y-3">
      {err && <p className="text-xs text-red">{err.message}</p>}
      {groups.map((g) => {
        const rows = rules.filter((r) => r.status === g.status);
        if (!rows.length) return null;
        return (
          <Panel key={g.status} title={`${g.title} · ${rows.length}`} accent={g.status === 'active' ? 'bg-green' : g.status === 'suggested' ? 'bg-amber' : 'bg-muted'}>
            <ul className="divide-y divide-hairline">
              {rows.map((r) => (
                <li key={r.id} className={clsx('px-5 py-3', r.status === 'revoked' && 'opacity-70')}>
                  <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <code className="block break-all font-mono text-[12.5px] text-ink">{r.matchKind === 'exact' ? r.canonical : `${[r.program, ...(r.flags ?? [])].join(' ')} ${r.folder}/${r.glob}`}</code>
                      <p className="mt-1 text-[11.5px] text-muted">
                        {r.matchKind === 'exact' ? 'This exact command' : <>Any file named <span className="font-mono text-ink/80">{r.glob}</span> under <span className="font-mono text-ink/80">{r.folder}/</span>, nothing outside it</>}
                        {' · '}{r.toolKey === 'k8s_kubectl' ? 'kubectl' : 'shell'}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        {r.envs.map((e) => (
                          <span key={e} className={clsx('rounded-full border px-2 py-px', e === 'prod' ? 'border-red/40 text-red' : 'border-edge text-ink/80')}>{e === 'prod' ? 'production' : e}</span>
                        ))}
                        {/* Each fact carries its own separator, so a wrapped line never starts or ends with a stray dot. */}
                        <span className="whitespace-nowrap before:mr-1.5 before:content-['·']">
                          {r.status === 'suggested' ? `suggested by ${r.createdByName ?? 'someone'}` : `trusted by ${r.approvedByName ?? r.createdByName ?? 'someone'}`} {timeAgo(r.approvedAt ?? r.createdAt)}
                        </span>
                        {r.status !== 'suggested' && <span className="whitespace-nowrap before:mr-1.5 before:content-['·']">ran {r.hits}×{r.lastUsedAt ? `, last ${timeAgo(r.lastUsedAt)}` : ''}</span>}
                        {r.status === 'revoked' && <span className="whitespace-nowrap before:mr-1.5 before:content-['·']">untrusted by {r.revokedByName ?? 'someone'} {timeAgo(r.revokedAt)}</span>}
                      </div>
                      {r.note && <p className="mt-1 text-[11.5px] italic text-muted">“{r.note}”</p>}
                    </div>
                    {isAdmin && (
                      <div className="flex shrink-0 items-center gap-2">
                        {r.status === 'suggested' && (
                          <>
                            <button className="btn-primary !min-h-[32px] !px-3 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: 'approve' })}><Check size={13} /> Trust</button>
                            <button className="btn-ghost !min-h-[32px] !px-3 text-xs" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, action: 'reject' })}><X size={13} /> Reject</button>
                          </>
                        )}
                        {r.status === 'active' && (confirm === r.id ? (
                          <>
                            <span className="text-[11.5px] text-muted">It will wait for approval again.</span>
                            <button className="btn-danger !min-h-[32px] !px-3 text-xs" disabled={untrust.isPending} onClick={() => untrust.mutate(r.id)}>Untrust</button>
                            <button className="btn-ghost !min-h-[32px] !px-2 text-xs" onClick={() => setConfirm(null)}>Keep</button>
                          </>
                        ) : (
                          <button className="btn-ghost !min-h-[32px] !px-3 text-xs" onClick={() => setConfirm(r.id)}><ShieldOff size={13} /> Untrust</button>
                        ))}
                        {r.status === 'revoked' && (
                          <button className="btn-ghost !min-h-[32px] !px-3 text-xs" disabled={restore.isPending} onClick={() => restore.mutate(r.id)} title="Trust it again"><RotateCcw size={13} /> Restore</button>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        );
      })}
    </div>
  );
}
