import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Layers, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from '../ui';
import type { CorrelationRule, RulePreview } from '../../lib/types';

const RESOLVE: Record<CorrelationRule['resolveOn'], string> = {
  all: 'when all its alerts have resolved',
  first: 'as soon as one alert resolves',
  never: 'only by a person',
};

type Draft = Pick<CorrelationRule, 'name' | 'windowMin' | 'threshold' | 'resolveOn' | 'titleTemplate'> & { matchers: string; groupBy: string };

const EMPTY: Draft = { name: '', matchers: '', groupBy: 'service', windowMin: 15, threshold: 1, resolveOn: 'all', titleTemplate: '' };

const toBody = (d: Draft) => ({
  name: d.name.trim() || 'Rule',
  matchers: d.matchers,
  groupBy: d.groupBy.split(',').map((s) => s.trim()).filter(Boolean),
  windowMin: d.windowMin,
  threshold: d.threshold,
  resolveOn: d.resolveOn,
  titleTemplate: d.titleTemplate,
});

export function CorrelationRules({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['correlationRules', projectId], queryFn: () => api<CorrelationRule[]>(`/correlation-rules?projectId=${projectId}`) });
  const [editing, setEditing] = useState<CorrelationRule | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['correlationRules', projectId] });
  const rules = list.data ?? [];

  const move = useMutation({
    mutationFn: async ({ i, dir }: { i: number; dir: -1 | 1 }) => {
      const a = rules[i]!;
      const b = rules[i + dir]!;
      // Swap places; if they share a number, spread them out first.
      const pa = a.priority === b.priority ? a.priority + dir : b.priority;
      await patch(`/correlation-rules/${a.id}`, { priority: pa });
      await patch(`/correlation-rules/${b.id}`, { priority: a.priority });
    },
    onSuccess: refresh,
  });
  const toggle = useMutation({ mutationFn: (r: CorrelationRule) => patch(`/correlation-rules/${r.id}`, { enabled: !r.enabled }), onSuccess: refresh });

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-xs leading-relaxed text-muted">
        How your team wants alerts grouped into incidents. Rules are tried top to bottom and the first that matches an alert decides its incident.
        Alerts no rule matches are grouped the built-in way: same machine, a connection on the service map, same service or namespace.
      </p>
      {isAdmin && !editing && (
        <button className="btn-primary" onClick={() => setEditing('new')}>
          <Plus size={15} /> Add a rule
        </button>
      )}
      {editing && (
        <RuleEditor
          projectId={projectId}
          rule={editing === 'new' ? null : editing}
          onDone={() => {
            setEditing(null);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {list.isLoading ? (
        <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
      ) : rules.length ? (
        rules.map((r, i) => (
          <Panel key={r.id} className={clsx('p-4 sm:p-5', !r.enabled && 'opacity-70')}>
            <div className="flex flex-wrap items-start gap-3">
              <span className="mt-0.5 w-6 shrink-0 text-center font-mono text-[11px] text-muted">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{r.name}</span>
                  {!r.enabled && <span className="chip border border-edge text-muted">Off</span>}
                </div>
                <p className="mt-1 break-all font-mono text-[11.5px] text-ink/90">{r.matcherText}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted">
                  {r.groupBy.length ? <>Same <span className="font-mono text-ink/80">{r.groupBy.join(', ')}</span></> : 'All of them'} within {r.windowMin} min is one incident
                  {r.threshold > 1 ? <>, shown once it has {r.threshold} alerts</> : null}. Resolved {RESOLVE[r.resolveOn]}.
                  {r.titleTemplate && <> Title: <span className="font-mono text-ink/80">{r.titleTemplate}</span>.</>}
                </p>
                <p className="mt-1 text-[11px] text-dim">
                  {r.alertsGrouped ? `Grouped ${r.alertsGrouped} alert${r.alertsGrouped === 1 ? '' : 's'} into ${r.incidentsMade} incident${r.incidentsMade === 1 ? '' : 's'}, last ${timeAgo(r.lastMatchedAt!)}` : 'Has not matched an alert yet'}
                </p>
              </div>
              {isAdmin && (
                <div className="flex shrink-0 items-center gap-1">
                  <Switch label={r.enabled ? 'Turn off' : 'Turn on'} checked={r.enabled} onChange={() => toggle.mutate(r)} />
                  <IconBtn label="Move up" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ i, dir: -1 })}><ArrowUp size={14} /></IconBtn>
                  <IconBtn label="Move down" disabled={i === rules.length - 1 || move.isPending} onClick={() => move.mutate({ i, dir: 1 })}><ArrowDown size={14} /></IconBtn>
                  <IconBtn label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil size={14} /></IconBtn>
                  <DeleteRule rule={r} onDone={refresh} />
                </div>
              )}
            </div>
          </Panel>
        ))
      ) : (
        !editing && (
          <Panel>
            <Empty icon={<Layers size={26} />} title="No rules yet" hint="The built-in grouping is used. Add a rule when your team groups alerts its own way, e.g. one incident per service and cluster." />
          </Panel>
        )
      )}
    </div>
  );
}

function IconBtn({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="grid h-9 w-9 place-items-center rounded-md text-muted hover:bg-white/5 hover:text-ink disabled:opacity-40">
      {children}
    </button>
  );
}

function DeleteRule({ rule, onDone }: { rule: CorrelationRule; onDone: () => void }) {
  const [sure, setSure] = useState(false);
  const remove = useMutation({ mutationFn: () => del(`/correlation-rules/${rule.id}`), onSuccess: onDone });
  return sure ? (
    <span className="flex items-center gap-1 text-xs">
      <button className="btn-ghost !min-h-[32px] !text-xs text-red" onClick={() => remove.mutate()} disabled={remove.isPending}>Delete</button>
      <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setSure(false)}>Keep</button>
    </span>
  ) : (
    <IconBtn label={`Delete ${rule.name}`} onClick={() => setSure(true)}><Trash2 size={14} /></IconBtn>
  );
}

function RuleEditor({ projectId, rule, onDone, onCancel }: { projectId: string; rule: CorrelationRule | null; onDone: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(
    rule ? { name: rule.name, matchers: rule.matcherText, groupBy: rule.groupBy.join(', '), windowMin: rule.windowMin, threshold: rule.threshold, resolveOn: rule.resolveOn, titleTemplate: rule.titleTemplate } : EMPTY,
  );
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  const [preview, setPreview] = useState<RulePreview | null>(null);
  useEffect(() => {
    if (!d.matchers.trim()) return setPreview(null);
    const t = setTimeout(() => {
      post<RulePreview>('/correlation-rules/preview', { projectId, ...toBody(d) }).then(setPreview, () => setPreview(null));
    }, 400);
    return () => clearTimeout(t);
  }, [d, projectId]);
  const save = useMutation({
    mutationFn: () => (rule ? patch(`/correlation-rules/${rule.id}`, toBody(d)) : post('/correlation-rules', { projectId, ...toBody(d) })),
    onSuccess: onDone,
  });

  return (
    <Panel title={rule ? `Edit "${rule.name}"` : 'Add a correlation rule'} className="p-5 pt-0">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className="input" value={d.name} maxLength={120} placeholder="One incident per service" onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Which alerts" hint={<>Label matchers, e.g. <span className="font-mono">team="shop", severity!="info"</span>.</>}>
            <input className="input font-mono text-xs" value={d.matchers} onChange={(e) => set({ matchers: e.target.value })} placeholder='team="shop"' />
          </Field>
          <Field label="Group by labels" hint="Comma-separated. Alerts with the same values are one incident. Empty: all of them together.">
            <input className="input font-mono text-xs" value={d.groupBy} onChange={(e) => set({ groupBy: e.target.value })} placeholder="service, cluster" />
          </Field>
          <Field label="Title" hint={<>Optional. <span className="font-mono">{'{{label}}'}</span> is replaced by its values.</>}>
            <input className="input font-mono text-xs" value={d.titleTemplate} maxLength={200} onChange={(e) => set({ titleTemplate: e.target.value })} placeholder="{{service}}: {{alertname}}" />
          </Field>
          <Field label="Within (minutes)" hint="An alert joins a group incident that saw activity this recently.">
            <input type="number" className="input" min={1} max={1440} value={d.windowMin} onChange={(e) => set({ windowMin: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
          <Field label="Show it once it has" hint="Fewer alerts than this: kept out of the incident lists and not diagnosed yet.">
            <div className="flex items-center gap-2">
              <input type="number" className="input !w-24" min={1} max={1000} value={d.threshold} onChange={(e) => set({ threshold: Math.max(1, Number(e.target.value) || 1) })} />
              <span className="text-xs text-muted">alert{d.threshold === 1 ? '' : 's'}</span>
            </div>
          </Field>
        </div>
        <Field label="Resolved">
          <Segmented
            label="Resolve"
            value={d.resolveOn}
            onChange={(v) => set({ resolveOn: v })}
            options={[{ value: 'all', label: 'When all resolve' }, { value: 'first', label: 'When one resolves' }, { value: 'never', label: 'By a person' }]}
          />
        </Field>

        {preview && (
          <div className={clsx('rounded-inner border p-3 text-xs', preview.ok ? 'border-hairline bg-ground/40 text-muted' : 'border-amber/30 bg-amber/[0.06] text-amber')}>
            {preview.ok ? (
              <>
                <p>
                  On the last day&apos;s <span className="text-ink">{preview.considered}</span> alerts, this matches <span className="text-ink">{preview.matched}</span> and would make{' '}
                  <span className="text-ink">{preview.incidents}</span> incident{preview.incidents === 1 ? '' : 's'}
                  {preview.held ? <>, plus {preview.held} group{preview.held === 1 ? '' : 's'} that never reached the threshold</> : null}.
                </p>
                {preview.groups!.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {preview.groups!.slice(0, 8).map((g, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', g.visible ? 'bg-blue' : 'bg-dim')} />
                        <span className={g.visible ? 'text-ink' : 'text-muted'}>{g.title}</span>
                        <span className="text-dim">{g.alerts} alert{g.alerts === 1 ? '' : 's'}</span>
                      </li>
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
          <button className="btn-primary" disabled={save.isPending || !d.matchers.trim() || preview?.ok === false} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner /> : null} {rule ? 'Save' : 'Add the rule'}
          </button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
