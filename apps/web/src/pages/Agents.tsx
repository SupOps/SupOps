import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Copy, Eye, Pencil, Plus, RotateCcw, Sparkles, Trash2, X } from 'lucide-react';
import { RISK_TIERS } from '@supops/shared';
import type { RiskTier } from '@supops/shared';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, RiskBadge, Segmented, Spinner, Switch } from '../components/ui';
import type { Agent, AgentBudget, Project } from '../lib/types';

interface ToolInfo {
  key: string;
  description: string;
  baselineRisk: 'read_only' | 'low' | 'medium' | 'high' | 'forbidden';
  targetKinds: string[];
  mutating: boolean;
}

const DEFAULT_BUDGET: AgentBudget = { maxIterations: 40, maxToolCalls: 120, maxWallClockMs: 30 * 60_000, maxOutputBytesPerCall: 16_384 };
const tokens = (s: string) => Math.round(s.length / 4);
const rank = (t: RiskTier) => RISK_TIERS.indexOf(t);

export function Agents() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [editing, setEditing] = useState<Agent | 'new' | null>(null);

  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const tools = useQuery({ queryKey: ['available-tools'], queryFn: () => api<ToolInfo[]>('/agents/available-tools') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const project = projects.data?.find((p) => p.id === projectId);

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="The agents you can put to work — what each one knows how to do, and how much it may do on its own"
        action={
          isAdmin && (
            <button className="btn-primary" onClick={() => setEditing('new')}>
              <Plus size={16} /> New agent
            </button>
          )
        }
      />

      <div className="grid gap-4 p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {agents.data?.length ? (
            agents.data.map((a) => (
              <Panel
                key={a.id}
                title={a.name}
                accent={a.enabled ? 'bg-violet' : 'bg-dim'}
                action={
                  <div className="flex items-center gap-2 text-xs text-muted">
                    {a.builtIn && <span className="chip border border-edge bg-tile-2 text-muted">built-in</span>}
                    {!a.enabled && <span className="chip border border-edge bg-tile-2 text-muted">disabled</span>}
                    <span>{a.role}</span>
                    {isAdmin && (
                      <button className="btn-quiet !min-h-[32px] !px-2" onClick={() => setEditing(a)} aria-label={`Edit ${a.name}`} title="Edit">
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                }
              >
                <div className="space-y-3 p-4">
                  {a.description && <p className="text-sm text-ink">{a.description}</p>}
                  <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-relaxed text-muted">{a.systemPrompt}</p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(a.toolKeys ?? ['(all project tools)']).map((k) => (
                      <span key={k} className="rounded border border-hairline bg-tile-2 px-2 py-0.5 font-mono text-[11px] text-cyan">
                        {k}
                      </span>
                    ))}
                    {a.effectivePolicy && (
                      <span className="ml-auto text-[11px] text-muted">
                        acts alone up to <span className="text-ink">{a.effectivePolicy.autoExecuteMaxTier.replace('_', '-')}</span>
                        {a.model && <> · model <span className="font-mono text-ink">{a.model}</span></>}
                      </span>
                    )}
                  </div>
                </div>
              </Panel>
            ))
          ) : (
            <Panel>
              <Empty icon={<Sparkles size={28} />} title="No agents" hint="Seed the project to create the default agents." />
            </Panel>
          )}
        </div>

        <Panel title="Available tools" accent="bg-violet">
          <ul className="divide-y divide-hairline">
            {tools.data?.map((t) => (
              <li key={t.key} className="px-4 py-3">
                <div className="mb-1 flex items-center gap-2">
                  <code className="font-mono text-xs text-ink">{t.key}</code>
                  <RiskBadge tier={t.baselineRisk} />
                </div>
                <p className="text-xs leading-relaxed text-muted">{t.description}</p>
              </li>
            ))}
          </ul>
          <p className="border-t border-hairline px-4 py-3 text-xs text-muted">
            Keep each agent's list short. Tool-call accuracy falls off noticeably past
            roughly a dozen tools, and much sooner on small local models.
          </p>
        </Panel>
      </div>

      {editing && projectId && (
        <AgentEditor
          agent={editing === 'new' ? null : editing}
          projectId={projectId}
          project={project}
          tools={tools.data ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function AgentEditor({
  agent, projectId, project, tools, onClose,
}: {
  agent: Agent | null;
  projectId: string;
  project?: Project;
  tools: ToolInfo[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const locked = !!agent?.healthAgent;
  const [form, setForm] = useState(() => ({
    slug: agent?.slug ?? '',
    name: agent?.name ?? '',
    role: agent?.role ?? 'assistant',
    description: agent?.description ?? '',
    systemPrompt: agent?.systemPrompt ?? '',
    model: agent?.model ?? '',
    toolKeys: agent?.toolKeys ?? ['ssh_exec', 'ssh_read_file', 'record_finding'],
    allTools: agent ? agent.toolKeys === null : false,
    enabled: agent?.enabled ?? true,
    autoRun: (agent?.riskPolicyOverride?.autoExecuteMaxTier ?? '') as RiskTier | '',
    budget: { ...DEFAULT_BUDGET, ...(agent?.budget ?? {}) },
  }));
  const [preview, setPreview] = useState<{ prompt: string; tokens: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const policy = project?.riskPolicy;
  const ceiling = (policy?.autoExecuteCeiling ?? policy?.autoExecuteMaxTier ?? 'low') as RiskTier;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['agents', projectId] });
    onClose();
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save');

  const body = () => ({
    name: form.name.trim(),
    role: form.role.trim() || 'assistant',
    description: form.description.trim() || null,
    systemPrompt: form.systemPrompt,
    model: form.model.trim() || null,
    toolKeys: form.allTools ? null : form.toolKeys,
    enabled: form.enabled,
    budget: form.budget,
    riskPolicyOverride: form.autoRun ? { autoExecuteMaxTier: form.autoRun } : null,
  });

  const save = useMutation({
    mutationFn: () =>
      agent
        ? patch(`/agents/${agent.id}`, locked ? { model: form.model.trim() || null, enabled: form.enabled } : body())
        : post('/agents', { projectId, slug: form.slug.trim(), ...body() }),
    onSuccess: done,
    onError: fail,
  });
  const duplicate = useMutation({ mutationFn: () => post(`/agents/${agent!.id}/duplicate`, {}), onSuccess: done, onError: fail });
  const reset = useMutation({ mutationFn: () => post(`/agents/${agent!.id}/reset`, {}), onSuccess: done, onError: fail });
  const remove = useMutation({ mutationFn: () => del(`/agents/${agent!.id}`), onSuccess: done, onError: fail });

  // MCP servers' tools are given per server (mcp_<name>_*); each call still waits for
  // approval unless an admin marked that tool read-only.
  const mcp = useQuery({
    queryKey: ['mcpServers', projectId],
    queryFn: () => api<{ servers: Array<{ id: string; name: string; wildcard: string; enabled: boolean; tools: unknown[] }> }>(`/mcp-servers?projectId=${projectId}`),
    enabled: !!projectId && !locked,
  });
  const toggleTool = (k: string) =>
    setForm((f) => ({ ...f, toolKeys: f.toolKeys.includes(k) ? f.toolKeys.filter((x) => x !== k) : [...f.toolKeys, k] }));
  const setBudget = (k: keyof AgentBudget, v: number) => setForm((f) => ({ ...f, budget: { ...f.budget, [k]: v } }));

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-ground/70 backdrop-blur-sm" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={agent ? `Edit ${agent.name}` : 'New agent'}
        className="flex h-full w-full max-w-2xl flex-col border-l border-hairline bg-tile shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-3 border-b border-hairline px-5 py-4">
          <h2 className="text-base font-semibold text-ink">{agent ? `Edit ${agent.name}` : 'New agent'}</h2>
          {agent?.builtIn && <span className="chip border border-edge bg-tile-2 text-muted">built-in</span>}
          <button className="btn-quiet ml-auto !min-h-[34px] !px-2" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {locked && (
            <p className="rounded-inner border border-hairline bg-tile-2/50 px-3 py-2 text-xs text-muted">
              Health-check agents follow their built-in definition so every scan behaves the same. Only the model and on/off can be changed here.
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name"><input className="input" value={form.name} disabled={locked} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            {agent ? (
              <Field label="Slug"><input className="input font-mono" value={form.slug} disabled /></Field>
            ) : (
              <Field label="Slug (lowercase, hyphens)"><input className="input font-mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} /></Field>
            )}
            <Field label="Role"><input className="input" value={form.role} disabled={locked} onChange={(e) => setForm({ ...form, role: e.target.value })} /></Field>
            <Field label="Model (blank = platform default)"><input className="input font-mono" value={form.model} placeholder="platform default" onChange={(e) => setForm({ ...form, model: e.target.value })} /></Field>
          </div>
          <Field label="Description (shown here only)">
            <input className="input" value={form.description} disabled={locked} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>

          <Field label={`Instructions · about ${tokens(form.systemPrompt)} tokens`}>
            <textarea
              className="input min-h-40 resize-y font-mono text-xs leading-relaxed"
              value={form.systemPrompt}
              disabled={locked}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
            {tokens(form.systemPrompt) > 1500 && <p className="mt-1 text-[11px] text-amber">Long instructions cost tokens on every turn and dilute the core guidance. Aim for under 1,500.</p>}
          </Field>

          {!locked && (
            <Field label={`Tools · ${form.allTools ? 'all project tools' : `${form.toolKeys.length} selected`}`}>
              <label className="mb-2 flex items-center gap-2 text-xs text-muted">
                <input type="checkbox" checked={form.allTools} onChange={(e) => setForm({ ...form, allTools: e.target.checked })} /> Every tool the project has
              </label>
              {!form.allTools && (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {tools.map((t) => (
                    <label key={t.key} className="flex items-center gap-2 rounded-inner border border-hairline px-2.5 py-1.5 text-xs">
                      <input type="checkbox" checked={form.toolKeys.includes(t.key)} onChange={() => toggleTool(t.key)} />
                      <code className="font-mono text-ink">{t.key}</code>
                      <span className="ml-auto"><RiskBadge tier={t.baselineRisk} /></span>
                    </label>
                  ))}
                </div>
              )}
              {!form.allTools && !!mcp.data?.servers.length && (
                <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {mcp.data.servers.map((m) => (
                    <label key={m.id} className={clsx('flex items-center gap-2 rounded-inner border border-hairline px-2.5 py-1.5 text-xs', !m.enabled && 'opacity-60')}>
                      <input type="checkbox" checked={form.toolKeys.includes(m.wildcard)} onChange={() => toggleTool(m.wildcard)} />
                      <code className="min-w-0 truncate font-mono text-ink">{m.wildcard}</code>
                      <span className="ml-auto shrink-0 text-[10.5px] text-muted">MCP · {m.tools.length} tools</span>
                    </label>
                  ))}
                </div>
              )}
              {!form.allTools && form.toolKeys.length > 12 && <p className="mt-1 text-[11px] text-amber">More than a dozen tools noticeably lowers how accurately models pick the right one.</p>}
            </Field>
          )}

          {!locked && (
            <Field label="Acts on its own up to">
              <Segmented
                label="Agent auto-run level"
                value={(form.autoRun || 'project') as 'project'}
                onChange={(v) => setForm({ ...form, autoRun: (v as string) === 'project' ? '' : (v as RiskTier) })}
                options={[
                  { value: 'project', label: `Project default (${(policy?.autoExecuteMaxTier ?? 'low').replace('_', '-')})` },
                  ...(['read_only', 'low', 'medium'] as const).map((t) => ({
                    value: t as 'project',
                    label: t === 'read_only' ? 'Read-only' : t === 'low' ? 'Low' : 'Medium',
                  })),
                ]}
              />
              {form.autoRun && rank(form.autoRun) > rank(ceiling) && (
                <p className="mt-1 text-[11px] text-red">This project allows agents up to {ceiling.replace('_', '-')}. Raise the ceiling in Settings › Autonomy first.</p>
              )}
              <p className="mt-1 text-[11px] text-muted">Production, alert-triggered runs and high-risk actions stay capped whatever this says.</p>
            </Field>
          )}

          {!locked && (
            <Field label="Limits per run (per turn in Console)">
              <div className="grid gap-2 sm:grid-cols-4">
                <NumberIn label="Steps" value={form.budget.maxIterations} min={1} max={200} onChange={(v) => setBudget('maxIterations', v)} />
                <NumberIn label="Tool calls" value={form.budget.maxToolCalls} min={1} max={500} onChange={(v) => setBudget('maxToolCalls', v)} />
                <NumberIn label="Minutes" value={Math.round(form.budget.maxWallClockMs / 60_000)} min={1} max={240} onChange={(v) => setBudget('maxWallClockMs', v * 60_000)} />
                <NumberIn label="Reply tokens" value={form.budget.maxOutputTokens ?? 8192} min={512} max={32768} onChange={(v) => setBudget('maxOutputTokens', v)} />
              </div>
            </Field>
          )}

          <div className="flex items-center gap-3">
            <Switch label="Enabled" checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
            <span className="text-sm text-ink">{form.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>

          {preview && (
            <div className="rounded-inner border border-hairline">
              <div className="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-[11px] text-muted">
                Full instructions a run gets · about {preview.tokens} tokens
                <button className="ml-auto hover:text-ink" onClick={() => setPreview(null)} aria-label="Close preview"><X size={13} /></button>
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap p-3 font-mono text-[11px] leading-relaxed text-muted">{preview.prompt}</pre>
            </div>
          )}
          {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-hairline px-5 py-3">
          <button className="btn-primary" disabled={save.isPending || !form.name.trim() || (!agent && !form.slug) || !form.systemPrompt.trim()} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner /> : null} {agent ? 'Save' : 'Create agent'}
          </button>
          {agent && (
            <>
              <button className="btn-ghost" onClick={async () => setPreview(await api(`/agents/${agent.id}/preview-prompt`))} title="See the full instructions a run gets">
                <Eye size={15} /> Preview
              </button>
              <button className="btn-ghost" onClick={() => duplicate.mutate()} disabled={duplicate.isPending}><Copy size={15} /> Duplicate</button>
              {agent.builtIn && !agent.healthAgent && (
                <button className="btn-ghost" onClick={() => reset.mutate()} disabled={reset.isPending}><RotateCcw size={15} /> Reset to default</button>
              )}
              {!agent.builtIn && (
                <button className={clsx('btn-ghost ml-auto hover:!text-red')} onClick={() => remove.mutate()} disabled={remove.isPending}>
                  <Trash2 size={15} /> Delete
                </button>
              )}
            </>
          )}
        </footer>
      </aside>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="label">{label}</div>
      {children}
    </div>
  );
}

function NumberIn({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[11px] text-muted">{label}</span>
      <input
        type="number"
        className="input tabular"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      />
    </label>
  );
}
