import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { BookOpen, Brain, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import type { RiskTier } from '@supops/shared';
import { api, del, patch, post, put } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, RiskBadge, Segmented, Spinner, Switch } from '../components/ui';

interface LearnedRule {
  id: string;
  signature: string;
  example: string;
  targetId: string | null;
  targetSlug: string | null;
  effect: 'raise' | 'block';
  minTier: RiskTier;
  trigger: 'denied' | 'failed_change' | 'manual';
  reason: string;
  evidenceJson: Array<{ runId: string | null; at: number; by: string | null; comment: string | null; state: string }>;
  status: 'active' | 'disabled';
  hits: number;
  lastHitAt: string | null;
  resetBatch: string | null;
  createdAt: string;
}

/** What SupOps learned from what happened in earlier runs, and the controls over it. */
export function Learning() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  return (
    <div>
      <PageHeader
        title="Learning"
        subtitle="What SupOps learned from earlier runs. Actions people keep denying, and changes that keep failing, need more approval next time. Learning only ever makes SupOps stricter; switching a rule off returns to the normal rules."
      />
      <div className="space-y-4 p-6">
        {projectId && <RulesPanel projectId={projectId} isAdmin={isAdmin} />}
        {projectId && <LessonsPanel projectId={projectId} isAdmin={isAdmin} />}
        {projectId && <RankingPanel projectId={projectId} />}
      </div>
    </div>
  );
}

function RulesPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['learnedRules', projectId], queryFn: () => api<{ killSwitch: boolean; undoableReset: string | null; rules: LearnedRule[] }>(`/learning/rules?projectId=${projectId}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['learnedRules', projectId] });
  const [sure, setSure] = useState(false);
  const reset = useMutation({ mutationFn: () => post('/learning/reset', { projectId }), onSuccess: () => { setSure(false); refresh(); } });
  const undo = useMutation({ mutationFn: (batch: string) => post(`/learning/reset/${batch}/undo`, {}), onSuccess: refresh });
  const rules = q.data?.rules ?? [];
  const active = rules.filter((r) => r.status === 'active').length;
  return (
    <Panel title="Learned rules" accent="bg-violet">
      <div className="space-y-3 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          Built only from what was recorded: who denied an action and why, and whether a change that ran on its own failed. Denied twice on the same machine,
          an action needs one tier more approval; denied three times by two or more people (or with two comments), it is blocked. A change that ran on its own and
          failed twice waits for a person next time.
        </p>
        {q.data?.killSwitch && <p className="rounded-inner border border-amber/30 bg-amber/10 p-2.5 text-xs text-amber">Learned rules are switched off on this server (SUPOPS_LEARNED_RULES=off): they are listed, but not applied.</p>}
        {isAdmin && (rules.length > 0 || q.data?.undoableReset) && (
          <div className="flex flex-wrap items-center gap-2">
            {active > 0 && (sure ? (
              <>
                <button className="btn-ghost !text-xs !text-red" disabled={reset.isPending} onClick={() => reset.mutate()}>Switch off all {active}</button>
                <button className="btn-ghost !text-xs" onClick={() => setSure(false)}>Keep them</button>
              </>
            ) : (
              <button className="btn-ghost !text-xs" onClick={() => setSure(true)}><RotateCcw size={13} /> Reset</button>
            ))}
            {q.data?.undoableReset && (
              <button className="btn-ghost !text-xs" disabled={undo.isPending} onClick={() => undo.mutate(q.data!.undoableReset!)}><Undo2 size={13} /> Undo the last reset</button>
            )}
          </div>
        )}
        {q.isLoading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
        ) : rules.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">
            {rules.map((r) => <RuleRow key={r.id} r={r} isAdmin={isAdmin} onChanged={refresh} />)}
          </ul>
        ) : (
          <Empty icon={<Brain size={24} />} title="Nothing learned yet" hint="When the same action is denied twice, or a change that ran on its own fails twice, the rule SupOps learns shows here." />
        )}
      </div>
    </Panel>
  );
}

function RuleRow({ r, isAdmin, onChanged }: { r: LearnedRule; isAdmin: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const toggle = useMutation({ mutationFn: () => patch(`/learning/rules/${r.id}`, { status: r.status === 'active' ? 'disabled' : 'active' }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => del(`/learning/rules/${r.id}`), onSuccess: onChanged });
  return (
    <li className={clsx('px-3.5 py-3', r.status === 'disabled' && 'opacity-60')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {r.effect === 'block' ? <span className="chip border-red/30 bg-red/10 text-red">blocked</span> : <><span className="text-xs text-muted">needs</span><RiskBadge tier={r.minTier} /></>}
            <span className="text-xs text-muted">on {r.targetSlug ?? 'any machine'}</span>
            {r.status === 'disabled' && <span className="chip border-edge bg-tile-2 text-muted">off</span>}
          </div>
          <code className="mt-1.5 block break-all font-mono text-[11.5px] text-ink">{r.example}</code>
          <p className="mt-1 text-[11px] text-muted">
            {r.reason} · {r.hits ? `applied ${r.hits} time${r.hits === 1 ? '' : 's'}, last ${timeAgo(r.lastHitAt!)}` : 'not applied yet'} · learned {timeAgo(r.createdAt)}
          </p>
          <button className="mt-1 text-xs text-blue-text hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide' : 'Show'} the evidence ({r.evidenceJson.length})</button>
          {open && (
            <ul className="mt-1.5 space-y-1 text-[11px] text-muted">
              {r.evidenceJson.map((e, i) => (
                <li key={i}>
                  {e.state === 'denied' ? `Denied${e.by ? ` by ${e.by}` : ''}` : 'Ran on its own and failed'} {timeAgo(new Date(e.at).toISOString())}
                  {e.comment ? <>: <span className="text-ink/80">"{e.comment}"</span></> : null}
                  {e.runId && <> · <Link className="text-blue-text hover:underline" to={`/runs/${e.runId}`}>the run</Link></>}
                </li>
              ))}
            </ul>
          )}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-2">
            <Switch label={r.status === 'active' ? 'Switch off' : 'Switch on'} checked={r.status === 'active'} onChange={() => toggle.mutate()} />
            {sure ? (
              <button className="btn-ghost !px-2.5 !text-xs !text-red" onClick={() => remove.mutate()}>Delete?</button>
            ) : (
              <button className="btn-ghost !px-2.5" onClick={() => setSure(true)} aria-label="Delete"><Trash2 size={13} /></button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

interface Lesson {
  id: string;
  runId: string | null;
  runTitle: string | null;
  kind: 'fact' | 'pitfall' | 'runbook_step';
  title: string;
  body: string;
  evidence: string[];
  targetSlugs: string[];
  verdict: 'approved' | 'draft' | 'rejected';
  reasons: string[];
  knowledgeDocId: string | null;
  docStatus: 'draft' | 'approved' | 'archived' | null;
  createdAt: string;
}
type Reflect = 'off' | 'drafts' | 'auto';

const VERDICT: Record<Lesson['verdict'], string> = {
  approved: 'border-green/30 bg-green/10 text-green',
  draft: 'border-amber/30 bg-amber/10 text-amber',
  rejected: 'border-edge bg-tile-2 text-muted',
};

/** What finished runs taught: the model proposes, the lesson gate decides, and every verdict is shown. */
function LessonsPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['lessons', projectId], queryFn: () => api<{ settings: { reflect: Reflect; reflectMinActions: number }; lessons: Lesson[] }>(`/learning/lessons?projectId=${projectId}`) });
  const save = useMutation({ mutationFn: (reflect: Reflect) => put('/learning/settings', { reflect }), onSuccess: () => void qc.invalidateQueries({ queryKey: ['lessons', projectId] }) });
  const [showRejected, setShowRejected] = useState(false);
  const all = q.data?.lessons ?? [];
  const shown = showRejected ? all : all.filter((l) => l.verdict !== 'rejected');
  const rejected = all.length - all.filter((l) => l.verdict !== 'rejected').length;
  return (
    <Panel title="Lessons from runs" accent="bg-cyan">
      <div className="space-y-3 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          After a run with at least {q.data?.settings.reflectMinActions ?? 3} actions, the model reviews it once and proposes what it taught. A gate in plain code decides:
          a lesson must cite actions from that run, and is rejected for a secret, an unknown machine, a duplicate, a forbidden command, or wording that tries to tell
          future runs what to approve. Kept lessons go to Knowledge, as drafts an admin approves.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="After each run"
            value={q.data?.settings.reflect ?? 'drafts'}
            onChange={(v) => isAdmin && save.mutate(v as Reflect)}
            options={[{ value: 'off', label: 'Off' }, { value: 'drafts', label: 'Drafts' }, { value: 'auto', label: 'Approve facts' }]}
          />
          <span className="text-[11px] text-muted">
            {q.data?.settings.reflect === 'auto'
              ? 'An observed fact with evidence and no commands is approved at once, scoped to its machines and never pinned; the rest are drafts.'
              : q.data?.settings.reflect === 'off'
                ? 'Runs are not reviewed. (Each review is one extra model call.)'
                : 'Every lesson waits for an admin in Knowledge.'}
          </span>
        </div>
        {q.isLoading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
        ) : shown.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">
            {shown.map((l) => (
              <li key={l.id} className={clsx('px-3.5 py-3', l.verdict === 'rejected' && 'opacity-70')}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={clsx('chip', VERDICT[l.verdict])}>{l.verdict === 'approved' ? 'in knowledge' : l.verdict === 'draft' ? (l.docStatus === 'approved' ? 'approved by a person' : 'draft') : 'rejected'}</span>
                  <span className="chip border-edge bg-tile-2 text-ink/80">{l.kind.replace('_', ' ')}</span>
                  <span className="font-medium text-ink">{l.title}</span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-xs text-ink/85">{l.body}</p>
                <p className="mt-1 text-[11px] text-muted">
                  {l.reasons.join('; ')}
                  {l.targetSlugs.length ? ` · about ${l.targetSlugs.join(', ')}` : ''}
                  {' · '}{timeAgo(l.createdAt)}
                  {l.runId && <> · <Link className="text-blue-text hover:underline" to={`/runs/${l.runId}`}>{l.runTitle ?? 'the run'}</Link></>}
                  {l.knowledgeDocId && <> · <Link className="text-blue-text hover:underline" to="/knowledge">in Knowledge</Link></>}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<BookOpen size={24} />} title="No lessons yet" hint="Lessons appear after runs that did real work, when reviews are on." />
        )}
        {rejected > 0 && (
          <button className="text-xs text-blue-text hover:underline" onClick={() => setShowRejected((v) => !v)} aria-expanded={showRejected}>
            {showRejected ? 'Hide' : 'Show'} {rejected} rejected
          </button>
        )}
      </div>
    </Panel>
  );
}

/** The suspect ranking's learned weights: what this team's confirmed causes taught it. */
function RankingPanel({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ['ranking', projectId],
    queryFn: () => api<{ model: { examples: number; influence: number; weights: Array<{ feature: string; weight: number }> } | null; marks: Array<{ id: string; incidentId: string; changeTitle: string; verdict: 'cause' | 'not_cause'; createdAt: string }> }>(`/learning/ranking?projectId=${projectId}`),
  });
  const m = q.data?.model;
  const max = Math.max(0.01, ...(m?.weights.map((w) => Math.abs(w.weight)) ?? []));
  return (
    <Panel title="Which change caused it: learned ranking" accent="bg-amber">
      <div className="space-y-3 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          On an incident, mark a suspected change "This was the cause" or "Not this". A small model learns from those marks how much each clue matters for this
          project, and its score is added to the fixed ranking. Its say grows with the number of marks (none below three, full after about thirty), and it only
          ever changes the order of the suggestions.
        </p>
        {q.isLoading ? (
          <div className="grid place-items-center py-6 text-muted"><Spinner /></div>
        ) : m ? (
          <>
            <p className="text-xs text-ink">Learned from {m.examples} marks · its weight in the ranking: {m.influence.toFixed(2)} of 1.50</p>
            <ul className="max-w-xl space-y-1.5">
              {m.weights.map((w) => (
                <li key={w.feature} className="grid grid-cols-[10rem_1fr_3.5rem] items-center gap-2 text-[11px]">
                  <span className="text-ink/85">{w.feature}</span>
                  <span className="relative h-2 rounded-full bg-tile-2">
                    <span className={clsx('absolute top-0 h-2 rounded-full', w.weight >= 0 ? 'left-1/2 bg-amber' : 'right-1/2 bg-blue')} style={{ width: `${(Math.abs(w.weight) / max) * 50}%` }} />
                  </span>
                  <span className={clsx('text-right font-mono', w.weight >= 0 ? 'text-amber' : 'text-blue-text')}>{w.weight > 0 ? '+' : ''}{w.weight.toFixed(2)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-muted">Amber pushes a change up the list; blue pushes it down.</p>
          </>
        ) : (
          <p className="text-xs text-muted">Not enough marks yet ({q.data?.marks.length ?? 0} of 3). Until then the fixed ranking is used unchanged.</p>
        )}
        {!!q.data?.marks.length && (
          <p className="text-[11px] text-muted">
            A confirmed cause can become an accuracy test: the export replays that incident's real tool outputs (secrets masked) and expects the answer to name the
            change. It contains your systems' output, so review it, and replace real names and addresses, before adding it to <code className="font-mono">packages/eval/src/cases</code>.
          </p>
        )}
        {!!q.data?.marks.length && (
          <ul className="space-y-1 text-[11px] text-muted">
            {q.data.marks.slice(0, 8).map((f) => (
              <li key={f.id}>
                <span className={f.verdict === 'cause' ? 'text-red' : 'text-muted'}>{f.verdict === 'cause' ? 'Cause' : 'Not the cause'}</span>: {f.changeTitle} ·{' '}
                <Link className="text-blue-text hover:underline" to={`/observability/incidents/${f.incidentId}`}>the incident</Link> · {timeAgo(f.createdAt)}
                {f.verdict === 'cause' && <> · <button className="text-blue-text hover:underline" onClick={() => void exportEvalCase(f.incidentId)}>export as an eval case</button></>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

/** Download an incident's confirmed cause as an eval case JSON file. */
async function exportEvalCase(incidentId: string) {
  const c = await api<{ id: string }>(`/learning/eval-case/${incidentId}`);
  const url = URL.createObjectURL(new Blob([JSON.stringify(c, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${c.id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
