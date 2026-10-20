import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from '../ui';
import type { ExtractionRuleView } from '../../lib/types';

interface Preview {
  ok: boolean;
  error?: string;
  considered?: number;
  seen?: number;
  applied?: number;
  examples?: Array<{ title: string; added: Record<string, string> }>;
}

const FIELD_LABEL = { title: 'title', summary: 'description', label: 'label' } as const;

export function ExtractionRules({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['extractionRules', projectId], queryFn: () => api<ExtractionRuleView[]>(`/extraction-rules?projectId=${projectId}`) });
  const [adding, setAdding] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['extractionRules', projectId] });
  const toggle = useMutation({ mutationFn: (r: ExtractionRuleView) => patch(`/extraction-rules/${r.id}`, { enabled: !r.enabled }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: string) => del(`/extraction-rules/${id}`), onSuccess: refresh });

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        Labels pulled out of an alert&apos;s own text as it arrives: each named group in the pattern becomes a label, e.g. <span className="font-mono text-ink">exit=(?&lt;exit_code&gt;\d+)</span> gives <span className="font-mono text-ink">exit_code</span>.
        Labels the sender set are never replaced. Owner, team and runbook come from the service map: set them on a component under Knowledge.
      </p>
      {isAdmin && !adding && (
        <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Add a label rule</button>
      )}
      {adding && <NewRule projectId={projectId} onDone={() => { setAdding(false); refresh(); }} onCancel={() => setAdding(false)} />}
      {list.isLoading ? (
        <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
      ) : list.data?.length ? (
        list.data.map((r) => (
          <Panel key={r.id} className={clsx('p-4 sm:p-5', !r.enabled && 'opacity-70')}>
            <div className="flex flex-wrap items-start gap-3">
              <div className="min-w-0 flex-1">
                <span className="text-[13px] font-medium text-ink">{r.name}</span>
                <p className="mt-1 break-all font-mono text-[11.5px] text-ink/90">{r.pattern}</p>
                <p className="mt-1 text-[11px] text-muted">
                  On the {r.field === 'label' ? <>label <span className="font-mono">{r.labelName}</span></> : FIELD_LABEL[r.field]}
                  {r.matcherText ? <> of alerts matching <span className="font-mono">{r.matcherText}</span></> : ' of every alert'}.
                  {' '}{r.seen ? `Added labels to ${r.applied} of ${r.seen} alerts` : 'Has not seen an alert yet'}
                  {r.lastAppliedAt ? `, last ${timeAgo(r.lastAppliedAt)}` : ''}.
                </p>
                {r.lastExample && <p className="mt-1 break-all font-mono text-[11px] text-dim">{Object.entries(r.lastExample).map(([k, v]) => `${k}=${v}`).join('  ')}</p>}
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-1">
                  <Switch label={r.enabled ? 'Turn off' : 'Turn on'} checked={r.enabled} onChange={() => toggle.mutate(r)} />
                  <button type="button" aria-label={`Delete ${r.name}`} title="Delete" onClick={() => remove.mutate(r.id)} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-white/5 hover:text-red">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          </Panel>
        ))
      ) : (
        !adding && (
          <Panel>
            <Empty icon={<Tags size={26} />} title="No label rules" hint="Useful when a sender puts the details in the message instead of labels: a job name, an error code, a customer." />
          </Panel>
        )
      )}
    </div>
  );
}

function NewRule({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState({ name: '', matchers: '', field: 'summary' as 'title' | 'summary' | 'label', labelName: '', pattern: '' });
  const set = (p: Partial<typeof d>) => setD((x) => ({ ...x, ...p }));
  const body = () => ({ projectId, name: d.name.trim() || 'Label rule', matchers: d.matchers, field: d.field, labelName: d.field === 'label' ? d.labelName.trim() : null, pattern: d.pattern });
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (!d.pattern.trim()) return setPreview(null);
    const t = setTimeout(() => {
      post<Preview>('/extraction-rules/preview', body()).then(setPreview, () => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, projectId]);
  const save = useMutation({ mutationFn: () => post('/extraction-rules', body()), onSuccess: onDone });

  return (
    <Panel title="Add a label rule" className="p-5 pt-0">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={d.name} maxLength={120} placeholder="Backup job name" onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Only alerts matching (optional)" hint="Empty: every alert.">
            <input className="input font-mono text-xs" value={d.matchers} onChange={(e) => set({ matchers: e.target.value })} placeholder='alertname="JobFailed"' />
          </Field>
        </div>
        <Field label="Read from">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented label="Field" value={d.field} onChange={(v) => set({ field: v })} options={[{ value: 'summary', label: 'Description' }, { value: 'title', label: 'Title' }, { value: 'label', label: 'A label' }]} />
            {d.field === 'label' && <input className="input !w-48 font-mono text-xs" value={d.labelName} onChange={(e) => set({ labelName: e.target.value })} placeholder="message" aria-label="Label name" />}
          </div>
        </Field>
        <Field label="Pattern" hint="A regular expression with named groups. Patterns that can take exponential time are refused.">
          <input className="input font-mono text-xs" value={d.pattern} maxLength={256} onChange={(e) => set({ pattern: e.target.value })} placeholder="job=(?<job>[\w-]+)" />
        </Field>
        {preview && (
          <div className={clsx('rounded-inner border p-3 text-xs', preview.ok ? 'border-hairline bg-ground/40 text-muted' : 'border-amber/30 bg-amber/[0.06] text-amber')}>
            {preview.ok ? (
              <>
                <p>Of the last day&apos;s {preview.considered} alerts, {preview.seen} are in scope and it adds labels to <span className="text-ink">{preview.applied}</span>.</p>
                {preview.examples!.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {preview.examples!.slice(0, 6).map((e, i) => (
                      <li key={i}><span className="text-ink">{e.title}</span> <span className="font-mono text-[11px]">{Object.entries(e.added).map(([k, v]) => `${k}=${v}`).join('  ')}</span></li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              preview.error
            )}
          </div>
        )}
        {save.error && <p className="text-xs text-red">{(save.error as Error).message}</p>}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={save.isPending || !d.pattern.trim() || preview?.ok === false} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} Add the rule</button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
