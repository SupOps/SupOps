import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Download, Pencil, Play, Plus, Trash2, Upload, Workflow as WorkflowIcon, X } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from '../components/ui';
import type { NotificationChannel, Workflow, WorkflowRun, WorkflowStep, WorkflowTrigger } from '../lib/types';

const STEP_LABEL: Record<WorkflowStep['kind'], string> = {
  notify: 'Send a message',
  diagnose: 'Start a read-only diagnosis',
  recheck: 'Run the evidence checks again',
  assign: 'Assign the incident',
  severity: 'Set the severity',
  acknowledge: 'Acknowledge the incident',
  note: 'Add a note to the incident',
  wait: 'Wait',
  if: 'Only carry on if…',
};

const NEW_STEP: Record<WorkflowStep['kind'], WorkflowStep> = {
  notify: { kind: 'notify', channelIds: [], message: '{{incident.title}} ({{incident.severity}})' },
  diagnose: { kind: 'diagnose' },
  recheck: { kind: 'recheck' },
  assign: { kind: 'assign', userId: null },
  severity: { kind: 'severity', severity: 'critical' },
  acknowledge: { kind: 'acknowledge' },
  note: { kind: 'note', text: '' },
  wait: { kind: 'wait', minutes: 15 },
  if: { kind: 'if', matchers: '', severityAtLeast: null, stillOpen: true },
};

const ON = [
  { value: 'opened', label: 'Opened' },
  { value: 'escalated', label: 'Got worse' },
  { value: 'acknowledged', label: 'Acknowledged' },
  { value: 'diagnosed', label: 'Diagnosed' },
  { value: 'resolved', label: 'Resolved' },
] as const;

function describeTrigger(t: WorkflowTrigger): string {
  if (t.type === 'manual') return 'Run by hand';
  if (t.type === 'schedule') return `Every ${t.everyMinutes >= 60 && t.everyMinutes % 60 === 0 ? `${t.everyMinutes / 60} hour${t.everyMinutes === 60 ? '' : 's'}` : `${t.everyMinutes} minutes`}`;
  return `When an incident ${t.on.map((o) => ON.find((x) => x.value === o)?.label.toLowerCase()).join(' or ')}${t.matchers ? ` with ${t.matchers}` : ''}, ${t.minSeverity} and up`;
}

export function Workflows() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['workflows', projectId], queryFn: () => api<Workflow[]>(`/workflows?projectId=${projectId}`), enabled: !!projectId });
  const [editing, setEditing] = useState<Workflow | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['workflows', projectId] });

  return (
    <>
      <PageHeader
        title="Workflows"
        subtitle="When something happens to an incident, on a schedule, or by hand: do these steps. A workflow can message people, diagnose read-only, and update SupOps' record of an incident. It never changes a system: that always waits for a person."
      />
      <div className="space-y-3 p-6">
        {isAdmin && !editing && (
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> New workflow</button>
            <button className="btn-ghost" onClick={() => setImporting(!importing)}><Upload size={14} /> Import</button>
          </div>
        )}
        {importing && projectId && <ImportBox projectId={projectId} onDone={() => { setImporting(false); refresh(); }} />}
        {editing && projectId && <Editor projectId={projectId} existing={editing === 'new' ? null : editing} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />}
        {list.isLoading ? (
          <div className="grid place-items-center py-16 text-muted"><Spinner /></div>
        ) : list.data?.length ? (
          list.data.map((w) => <WorkflowCard key={w.id} w={w} isAdmin={isAdmin} onEdit={() => setEditing(w)} onChanged={refresh} />)
        ) : (
          !editing && (
            <Panel>
              <Empty icon={<WorkflowIcon size={26} />} title="No workflows yet" hint="For example: when a critical incident opens in prod, assign it to on-call, message the team, and if it is still open after 15 minutes, message the lead." />
            </Panel>
          )
        )}
      </div>
    </>
  );
}

function WorkflowCard({ w, isAdmin, onEdit, onChanged }: { w: Workflow; isAdmin: boolean; onEdit: () => void; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [sure, setSure] = useState(false);
  const toggle = useMutation({ mutationFn: () => patch(`/workflows/${w.id}`, { enabled: !w.enabled }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => del(`/workflows/${w.id}`), onSuccess: onChanged });
  const runNow = useMutation({ mutationFn: () => post(`/workflows/${w.id}/run`, {}), onSuccess: () => { setOpen(true); onChanged(); } });
  const exportIt = async () => {
    const data = await api<unknown>(`/workflows/${w.id}/export`);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${w.name.replace(/[^\w-]+/g, '-').toLowerCase()}.supops-workflow.json` });
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Panel className={clsx('p-4 sm:p-5', !w.enabled && 'opacity-75')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[14px] font-medium text-ink">{w.name}</span>
            {!w.enabled && <span className="chip border border-edge text-muted">Off</span>}
            <span className="text-[11px] text-dim">revision {w.revision}</span>
          </div>
          {w.description && <p className="mt-0.5 text-xs text-muted">{w.description}</p>}
          <p className="mt-1.5 text-[12px] text-ink/85">{describeTrigger(w.trigger)}:</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-[12px] text-muted">
            {w.steps.map((s, i) => <li key={i}>{STEP_LABEL[s.kind]}{s.kind === 'wait' ? ` ${s.minutes} min` : s.kind === 'severity' ? `: ${s.severity}` : ''}</li>)}
          </ol>
          {w.lastRunAt && <p className="mt-1.5 text-[11px] text-dim">Last ran {timeAgo(w.lastRunAt)}</p>}
        </div>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Switch label={w.enabled ? 'Turn off' : 'Turn on'} checked={w.enabled} onChange={() => toggle.mutate()} />
            <button className="btn-ghost !min-h-[32px] !text-xs" disabled={runNow.isPending} onClick={() => runNow.mutate()} title={w.trigger.type === 'incident' ? 'Runs without an incident: incident steps are skipped' : 'Run it now'}>
              {runNow.isPending ? <Spinner /> : <Play size={12} />} Run now
            </button>
            <button className="btn-ghost !min-h-[32px] !text-xs" onClick={onEdit} aria-label={`Edit ${w.name}`}><Pencil size={12} /></button>
            <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => void exportIt()} aria-label={`Export ${w.name}`} title="Export as JSON"><Download size={12} /></button>
            {sure ? (
              <>
                <button className="btn-ghost !min-h-[32px] !text-xs text-red" onClick={() => remove.mutate()}>Delete</button>
                <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setSure(false)}>Keep</button>
              </>
            ) : (
              <button className="btn-ghost !min-h-[32px] !text-xs" onClick={() => setSure(true)} aria-label={`Delete ${w.name}`}><Trash2 size={12} /></button>
            )}
          </div>
        )}
      </div>
      <button className="mt-3 inline-flex items-center gap-1 text-xs text-blue-text hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Runs
      </button>
      {open && <Runs workflowId={w.id} isAdmin={isAdmin} />}
    </Panel>
  );
}

const RUN_STATUS: Record<WorkflowRun['status'], string> = { running: 'text-blue-text', waiting: 'text-amber', succeeded: 'text-green', failed: 'text-red', stopped: 'text-muted' };

function Runs({ workflowId, isAdmin }: { workflowId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const runs = useQuery({ queryKey: ['workflowRuns', workflowId], queryFn: () => api<WorkflowRun[]>(`/workflows/${workflowId}/runs`), refetchInterval: 5000 });
  const stop = useMutation({ mutationFn: (id: string) => post(`/workflows/runs/${id}/stop`, {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['workflowRuns', workflowId] }) });
  if (!runs.data?.length) return <p className="mt-2 text-xs text-muted">{runs.isLoading ? 'Loading…' : 'It has not run yet.'}</p>;
  return (
    <ul className="mt-2 space-y-2">
      {runs.data.map((r) => (
        <li key={r.id} className="rounded-inner border border-hairline bg-ground/40 p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className={clsx('font-medium', RUN_STATUS[r.status])}>{r.status}</span>
            <span className="text-muted">{timeAgo(r.startedAt)}, because {r.reason}</span>
            {r.incidentId && <Link className="text-blue-text hover:underline" to={`/observability/incidents/${r.incidentId}`}>incident</Link>}
            {r.status === 'waiting' && r.resumeAt && <span className="text-muted">· continues {new Date(r.resumeAt).toLocaleTimeString()}</span>}
            <div className="flex-1" />
            {isAdmin && r.status === 'waiting' && <button className="text-red hover:underline" onClick={() => stop.mutate(r.id)}><X size={11} className="inline" /> Stop</button>}
          </div>
          <ol className="mt-1.5 space-y-0.5">
            {r.log.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="w-5 shrink-0 text-right font-mono text-dim">{l.step + 1}</span>
                <span className={clsx(l.status === 'failed' ? 'text-red' : l.status === 'skipped' || l.status === 'stopped' ? 'text-muted' : 'text-ink/90')}>{l.text}</span>
              </li>
            ))}
          </ol>
        </li>
      ))}
    </ul>
  );
}

function ImportBox({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const imp = useMutation({
    mutationFn: () => {
      let workflow: unknown;
      try {
        workflow = JSON.parse(text);
      } catch {
        throw new Error('That is not valid JSON.');
      }
      return post('/workflows/import', { projectId, workflow });
    },
    onSuccess: onDone,
  });
  return (
    <Panel title="Import a workflow" className="p-5 pt-0">
      <div className="space-y-3">
        <textarea className="input min-h-[140px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder='{"supopsWorkflow": 1, "name": "…", "trigger": {…}, "steps": […]}' />
        <p className="text-[11px] text-muted">It is imported turned off, so you can check its channels and owner before it runs.</p>
        {imp.error && <p className="text-xs text-red">{(imp.error as Error).message}</p>}
        <button className="btn-primary" disabled={!text.trim() || imp.isPending} onClick={() => imp.mutate()}>{imp.isPending ? <Spinner /> : <Upload size={14} />} Import</button>
      </div>
    </Panel>
  );
}

function Editor({ projectId, existing, onDone, onCancel }: { projectId: string; existing: Workflow | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [trigger, setTrigger] = useState<WorkflowTrigger>(existing?.trigger ?? { type: 'incident', on: ['opened'], matchers: '', minSeverity: 'critical' });
  const [steps, setSteps] = useState<WorkflowStep[]>(existing?.steps ?? [NEW_STEP.notify]);
  const channels = useQuery({ queryKey: ['notifyChannels', projectId], queryFn: () => api<NotificationChannel[]>(`/notifications/channels?projectId=${projectId}`) });
  const users = useQuery({ queryKey: ['assignees'], queryFn: () => api<Array<{ id: string; name: string }>>('/observability/assignees') });
  const save = useMutation({
    mutationFn: () => {
      const b = { name: name.trim() || 'Workflow', description: description.trim() || undefined, trigger, steps };
      return existing ? patch(`/workflows/${existing.id}`, b) : post('/workflows', { projectId, ...b });
    },
    onSuccess: onDone,
  });
  const setStep = (i: number, s: WorkflowStep) => setSteps(steps.map((x, j) => (j === i ? s : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...steps];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    setSteps(next);
  };

  return (
    <Panel title={existing ? `Edit "${existing.name}"` : 'New workflow'} className="p-5 pt-0">
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className="input" value={name} maxLength={120} placeholder="Page on-call for prod" onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="What it is for (optional)"><input className="input" value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} /></Field>
        </div>

        <Field label="Starts">
          <div className="space-y-3">
            <Segmented
              label="Trigger"
              value={trigger.type}
              onChange={(t) => setTrigger(t === 'incident' ? { type: 'incident', on: ['opened'], matchers: '', minSeverity: 'critical' } : t === 'schedule' ? { type: 'schedule', everyMinutes: 60 } : { type: 'manual' })}
              options={[{ value: 'incident', label: 'On an incident' }, { value: 'schedule', label: 'On a schedule' }, { value: 'manual', label: 'By hand' }]}
            />
            {trigger.type === 'incident' && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-1.5">
                  {ON.map((o) => (
                    <button key={o.value} type="button" aria-pressed={trigger.on.includes(o.value)} onClick={() => setTrigger({ ...trigger, on: trigger.on.includes(o.value) ? trigger.on.filter((x) => x !== o.value) : [...trigger.on, o.value] })} className={clsx('min-h-[34px] rounded-full border px-3 text-xs', trigger.on.includes(o.value) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted')}>
                      {o.label}
                    </button>
                  ))}
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <input className="input font-mono text-xs" value={trigger.matchers} onChange={(e) => setTrigger({ ...trigger, matchers: e.target.value })} placeholder='Only incidents with, e.g. env="prod"' aria-label="Incident matchers" />
                  <Segmented label="Minimum severity" value={trigger.minSeverity} onChange={(v) => setTrigger({ ...trigger, minSeverity: v })} options={[{ value: 'info', label: 'Any' }, { value: 'warning', label: 'Warning+' }, { value: 'critical', label: 'Critical' }]} />
                </div>
              </div>
            )}
            {trigger.type === 'schedule' && (
              <div className="flex items-center gap-2 text-xs text-muted">
                Every
                <select className="input !w-auto" value={trigger.everyMinutes} onChange={(e) => setTrigger({ type: 'schedule', everyMinutes: Number(e.target.value) })}>
                  {[15, 30, 60, 240, 720, 1440, 10080].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m < 1440 ? `${m / 60} hours` : m === 1440 ? 'day' : 'week'}</option>)}
                </select>
              </div>
            )}
          </div>
        </Field>

        <Field label="Steps" hint={<>Messages and notes can use <span className="font-mono">{'{{incident.title}}'}</span>, <span className="font-mono">{'{{incident.severity}}'}</span>, <span className="font-mono">{'{{incident.url}}'}</span>, <span className="font-mono">{'{{incident.rootCause}}'}</span>, <span className="font-mono">{'{{incident.targets}}'}</span>, <span className="font-mono">{'{{incident.owner}}'}</span>.</>}>
          <ol className="space-y-2">
            {steps.map((s, i) => (
              <li key={i} className="rounded-inner border border-hairline bg-ground/40 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-dim">{i + 1}</span>
                  <select className="input !w-auto !min-h-[32px] !py-1 text-xs" value={s.kind} onChange={(e) => setStep(i, NEW_STEP[e.target.value as WorkflowStep['kind']])} aria-label={`Step ${i + 1}`}>
                    {(Object.keys(STEP_LABEL) as Array<WorkflowStep['kind']>).filter((k) => trigger.type !== 'schedule' || k === 'notify' || k === 'wait').map((k) => <option key={k} value={k}>{STEP_LABEL[k]}</option>)}
                  </select>
                  <div className="flex-1" />
                  <button className="grid h-8 w-8 place-items-center text-muted hover:text-ink disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp size={13} /></button>
                  <button className="grid h-8 w-8 place-items-center text-muted hover:text-ink disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown size={13} /></button>
                  <button className="grid h-8 w-8 place-items-center text-muted hover:text-red" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step"><X size={13} /></button>
                </div>
                <StepFields step={s} onChange={(n) => setStep(i, n)} channels={channels.data ?? []} users={users.data ?? []} />
              </li>
            ))}
          </ol>
          {steps.length < 20 && <button className="btn-ghost mt-2 !text-xs" onClick={() => setSteps([...steps, NEW_STEP.note])}><Plus size={13} /> Add a step</button>}
        </Field>

        {save.error && <p className="text-xs text-red">{(save.error as Error).message}</p>}
        <div className="flex gap-2">
          <button className="btn-primary" disabled={save.isPending || !steps.length} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} {existing ? 'Save as a new revision' : 'Create'}</button>
          <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}

function StepFields({ step: s, onChange, channels, users }: { step: WorkflowStep; onChange: (s: WorkflowStep) => void; channels: NotificationChannel[]; users: Array<{ id: string; name: string }> }) {
  if (s.kind === 'notify') {
    return (
      <div className="mt-2 space-y-2">
        {channels.length ? (
          <div className="flex flex-wrap gap-1.5">
            {channels.map((c) => (
              <button key={c.id} type="button" aria-pressed={s.channelIds.includes(c.id)} onClick={() => onChange({ ...s, channelIds: s.channelIds.includes(c.id) ? s.channelIds.filter((x) => x !== c.id) : [...s.channelIds, c.id] })} className={clsx('min-h-[32px] rounded-full border px-2.5 text-[11px]', s.channelIds.includes(c.id) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted')}>{c.name}</button>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-amber">Add a channel under Settings → Notifications first.</p>
        )}
        <textarea className="input min-h-[60px] text-xs" value={s.message} maxLength={4000} onChange={(e) => onChange({ ...s, message: e.target.value })} aria-label="Message" />
      </div>
    );
  }
  if (s.kind === 'assign') {
    return (
      <select className="input mt-2 !w-auto text-xs" value={s.userId ?? ''} onChange={(e) => onChange({ ...s, userId: e.target.value || null })} aria-label="Assign to">
        <option value="">Nobody (unassign)</option>
        {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
      </select>
    );
  }
  if (s.kind === 'severity') {
    return <div className="mt-2"><Segmented label="Severity" value={s.severity} onChange={(v) => onChange({ ...s, severity: v })} options={[{ value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }]} /></div>;
  }
  if (s.kind === 'note') return <textarea className="input mt-2 min-h-[56px] text-xs" value={s.text} maxLength={4000} onChange={(e) => onChange({ ...s, text: e.target.value })} placeholder="Paged on-call for {{incident.title}}" aria-label="Note" />;
  if (s.kind === 'wait') {
    return (
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <input type="number" className="input !w-24" min={1} max={1440} value={s.minutes} onChange={(e) => onChange({ ...s, minutes: Math.max(1, Number(e.target.value) || 1) })} aria-label="Minutes" /> minutes
      </div>
    );
  }
  if (s.kind === 'if') {
    return (
      <div className="mt-2 space-y-2 text-xs text-muted">
        <label className="flex items-center gap-2"><input type="checkbox" checked={s.stillOpen} onChange={(e) => onChange({ ...s, stillOpen: e.target.checked })} /> it is still open</label>
        <div className="flex flex-wrap items-center gap-2">
          and at least
          <select className="input !w-auto text-xs" value={s.severityAtLeast ?? ''} onChange={(e) => onChange({ ...s, severityAtLeast: (e.target.value || null) as typeof s.severityAtLeast })} aria-label="Severity at least">
            <option value="">any severity</option>
            <option value="warning">warning</option>
            <option value="critical">critical</option>
          </select>
        </div>
        <input className="input font-mono text-xs" value={s.matchers} onChange={(e) => onChange({ ...s, matchers: e.target.value })} placeholder='and its alerts match, e.g. env="prod" (optional)' aria-label="Condition matchers" />
        <p>Otherwise the workflow stops here.</p>
      </div>
    );
  }
  return <p className="mt-1.5 text-[11px] text-muted">{s.kind === 'diagnose' ? 'Read-only and unattended: anything that would change a system is refused.' : s.kind === 'recheck' ? 'The same read-only checks the incident got when it opened.' : 'Acknowledged until it gets worse.'}</p>;
}
