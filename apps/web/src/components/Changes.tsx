import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, ExternalLink, GitCommitHorizontal, Plus, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, Panel, Spinner } from './ui';

export interface Change {
  id: string;
  source: 'api' | 'kubernetes' | 'grafana' | 'supops' | 'manual';
  kind: 'deploy' | 'config' | 'rollback' | 'flag' | 'infra' | 'action' | 'other';
  title: string;
  service: string | null;
  environment: string | null;
  version: string | null;
  previousVersion: string | null;
  author: string | null;
  url: string | null;
  status: 'started' | 'succeeded' | 'failed' | null;
  runId: string | null;
  startedAt: string;
  verdict?: { overall: 'better' | 'worse' | 'same' | 'unknown'; signals: Array<{ name: string; before: number | null; after: number | null; unit: string; change: number | null; flag: boolean; note?: string }> } | null;
}
type Suspect = Change & { reason: string; relation: 'same' | 'upstream' | 'other'; learned?: number; feedback?: 'cause' | 'not_cause' | null };

const SOURCE: Record<Change['source'], string> = { api: 'CI/CD', kubernetes: 'cluster', grafana: 'Grafana', supops: 'SupOps', manual: 'by hand' };
const KIND_TONE: Record<Change['kind'], string> = {
  deploy: 'border-blue/30 bg-blue/10 text-blue-text',
  rollback: 'border-amber/30 bg-amber/10 text-amber',
  config: 'border-violet/30 bg-violet/10 text-violet',
  action: 'border-cyan/30 bg-cyan/10 text-cyan',
  flag: 'border-edge bg-tile-2 text-muted',
  infra: 'border-edge bg-tile-2 text-muted',
  other: 'border-edge bg-tile-2 text-muted',
};
const VERDICT_TONE = { worse: 'text-red', better: 'text-green', same: 'text-muted', unknown: 'text-muted' } as const;

/** One change: what, where, who, when, and how the deploy went when that is known. */
export function ChangeLine({ c, extra }: { c: Change; extra?: ReactNode }) {
  const flagged = c.verdict?.signals.filter((s) => s.flag) ?? [];
  return (
    <div className="flex min-w-0 flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3">
      <span className={clsx('chip w-fit shrink-0 !text-[10.5px]', KIND_TONE[c.kind])}>{c.kind}</span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-1.5 text-[13px] text-ink">
          <span className="min-w-0 break-words">{c.title}</span>
          {c.url && (
            <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-muted hover:text-ink" aria-label="Open where it was recorded">
              <ExternalLink size={12} />
            </a>
          )}
          {c.runId && c.source === 'supops' && (
            <Link to={`/runs/${c.runId}`} className="shrink-0 text-[11px] text-blue-text hover:underline">run</Link>
          )}
        </div>
        <p className="mt-0.5 text-[11px] text-muted">
          {[c.service, c.version && `${c.previousVersion ? `${c.previousVersion} → ` : ''}${c.version}`, c.environment, c.author, SOURCE[c.source], c.status === 'failed' ? 'failed' : null, timeAgo(c.startedAt)].filter(Boolean).join(' · ')}
        </p>
        {c.verdict && c.verdict.overall !== 'unknown' && (
          <p className={clsx('mt-0.5 text-[11px]', VERDICT_TONE[c.verdict.overall])}>
            After the deploy: {c.verdict.overall === 'worse' ? flagged.map((s) => `${s.name} ${s.note ?? 'worse'}`).join(', ') : c.verdict.overall === 'better' ? 'better' : 'no change worth noting'}
          </p>
        )}
        {extra}
      </div>
    </div>
  );
}

/** On an incident: what changed shortly before it, likeliest cause first. */
export function ChangeSuspects({ incidentId }: { incidentId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['suspects', incidentId], queryFn: () => api<Suspect[]>(`/changes/suspects/${incidentId}`) });
  // Marking causes teaches the ranking; it only ever reorders these suggestions.
  const mark = useMutation({
    mutationFn: (v: { changeId: string; verdict: 'cause' | 'not_cause' | null }) => post(`/changes/suspects/${incidentId}/feedback`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['suspects', incidentId] }),
  });
  return (
    <Panel title="What changed before it" accent="bg-violet">
      <div className="px-5 pb-5">
        {q.isLoading ? (
          <Spinner />
        ) : q.data?.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">
            {q.data.map((c, i) => (
              <li key={c.id}>
                <ChangeLine
                  c={c}
                  extra={
                    <>
                      <p className="mt-0.5 text-[11px] text-ink/80">
                        {i === 0 && c.relation !== 'other' ? <span className="font-medium text-amber">Likeliest suspect: </span> : null}
                        {c.reason}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        {c.feedback === 'cause' ? (
                          <span className="chip border-red/30 bg-red/10 text-red">the cause</span>
                        ) : c.feedback === 'not_cause' ? (
                          <span className="chip border-edge bg-tile-2 text-muted">not the cause</span>
                        ) : null}
                        {c.feedback !== 'cause' && (
                          <button className="btn-ghost !min-h-[28px] !px-2 !text-[11px]" disabled={mark.isPending} onClick={() => mark.mutate({ changeId: c.id, verdict: 'cause' })}><Check size={12} /> This was the cause</button>
                        )}
                        {c.feedback !== 'not_cause' && (
                          <button className="btn-ghost !min-h-[28px] !px-2 !text-[11px]" disabled={mark.isPending} onClick={() => mark.mutate({ changeId: c.id, verdict: 'not_cause' })}><X size={12} /> Not this</button>
                        )}
                        {c.feedback && <button className="text-[11px] text-blue-text hover:underline" onClick={() => mark.mutate({ changeId: c.id, verdict: null })}>Undo</button>}
                      </div>
                    </>
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">
            No change recorded in the day before it. Changes come from your CI (add a <span className="text-ink">Deploys and changes</span> sender under Alerts → Sources), from clusters SupOps can read, from Grafana annotations, and from what SupOps itself changed.
          </p>
        )}
      </div>
    </Panel>
  );
}

/** Everything that changed recently, newest first, with a way to record one by hand. */
export function ChangeList({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [hours, setHours] = useState(72);
  const q = useQuery({ queryKey: ['changes', projectId, hours], queryFn: () => api<Change[]>(`/changes?projectId=${projectId}&hours=${hours}`) });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [service, setService] = useState('');
  const add = useMutation({
    mutationFn: () => post('/changes', { projectId, title: title.trim(), kind: 'other', ...(service.trim() ? { service: service.trim() } : {}) }),
    onSuccess: () => {
      setAdding(false);
      setTitle('');
      setService('');
      void qc.invalidateQueries({ queryKey: ['changes', projectId] });
    },
  });
  return (
    <Panel
      title="Changes"
      accent="bg-violet"
      action={
        <div className="flex items-center gap-2">
          <select className="input !min-h-[32px] !py-1 !text-xs" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="How far back">
            <option value={24}>Last day</option>
            <option value={72}>Last 3 days</option>
            <option value={168}>Last week</option>
            <option value={720}>Last 30 days</option>
          </select>
          <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setAdding((v) => !v)}><Plus size={13} /> Record one</button>
        </div>
      }
    >
      <div className="space-y-3 px-5 pb-5">
        {adding && (
          <div className="flex flex-col gap-2 rounded-inner border border-blue/30 bg-blue/[0.04] p-3 sm:flex-row">
            <input className="input min-w-0 flex-1" placeholder="What changed, e.g. raised the payments pool to 50" value={title} onChange={(e) => setTitle(e.target.value)} />
            <input className="input sm:w-44" placeholder="Service (optional)" value={service} onChange={(e) => setService(e.target.value)} />
            <button className="btn-primary" disabled={!title.trim() || add.isPending} onClick={() => add.mutate()}>{add.isPending ? <Spinner /> : null} Save</button>
          </div>
        )}
        {add.error && <p className="text-xs text-red">{(add.error as Error).message}</p>}
        {q.isLoading ? (
          <div className="grid place-items-center py-8"><Spinner /></div>
        ) : q.data?.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">{q.data.map((c) => <li key={c.id}><ChangeLine c={c} /></li>)}</ul>
        ) : (
          <Empty
            icon={<GitCommitHorizontal size={24} />}
            title="No changes recorded"
            hint="Add a Deploys and changes sender under Alerts → Sources and call it from your pipeline. Cluster rollouts, Grafana deploy annotations and SupOps' own approved actions appear here by themselves."
          />
        )}
      </div>
    </Panel>
  );
}
