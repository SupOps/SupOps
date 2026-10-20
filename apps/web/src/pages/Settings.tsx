import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertOctagon, Check, Plug, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { Field, Panel, Spinner } from '../components/ui';
import { SlackPanel } from '../components/SlackPanel';
import { StoragePanel } from '../components/StoragePanel';
import { ObservabilityPanel } from '../components/ObservabilityPanel';
import { AutonomyPanel } from '../components/AutonomyPanel';
import { NotificationsPanel } from '../components/NotificationsPanel';
import { McpPanel } from '../components/McpPanel';
import { ApiKeysPanel } from '../components/ApiKeysPanel';
import type { Project } from '../lib/types';

interface DeleteImpact {
  slug: string;
  targets: number;
  agents: number;
  runs: number;
  credentials: number;
  activeRuns: number;
  isLastProject: boolean;
}

interface LlmSettings {
  baseUrl: string;
  model: string;
  classifierModel: string;
  fallbackModel: string;
  runConcurrency: number;
  apiKeyConfigured: boolean;
  apiKeySource: 'database' | 'environment' | 'none';
}

/** One click to move the whole platform between providers. */
const PRESETS = [
  {
    name: 'Gemini (free tier)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-3.8-flash',
    classifierModel: 'gemini-3.5-flash-lite',
    // An older generation: an outage or overload of the newest model rarely reaches it.
    fallbackModel: 'gemini-3.5-flash',
    note: 'Needs a key from aistudio.google.com/apikey',
  },
  {
    name: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1/',
    model: 'qwen3:8b',
    classifierModel: 'qwen3:8b',
    fallbackModel: '',
    note: 'No key needed; runs on your own machine',
  },
  {
    name: 'LM Studio (local)',
    baseUrl: 'http://localhost:1234/v1/',
    model: 'local-model',
    classifierModel: 'local-model',
    fallbackModel: '',
    note: 'No key needed',
  },
];

export function Settings() {
  const projectId = useApp((s) => s.projectId);
  const setProjectId = useApp((s) => s.setProjectId);
  const canDelete = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmSlug, setConfirmSlug] = useState('');

  const saved = useQuery({ queryKey: ['llm'], queryFn: () => api<LlmSettings>('/settings/llm') });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api<Project[]>('/projects') });
  const project = projects.data?.find((p) => p.id === projectId);

  const [form, setForm] = useState<LlmSettings | null>(null);
  // The key is never sent to the browser. Empty means "leave it as it is";
  // the user clears it explicitly with the Clear button.
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);

  useEffect(() => {
    if (saved.data && !form) setForm(saved.data);
  }, [saved.data, form]);

  const test = useMutation({
    mutationFn: () =>
      post<{ ok: boolean; detail: string; model: string; baseUrl: string; fallback?: { model: string; ok: boolean; detail: string } }>('/settings/llm/test', {
        baseUrl: form?.baseUrl,
        model: form?.model,
        fallbackModel: form?.fallbackModel ?? '',
        ...(apiKey ? { apiKey } : {}),
      }),
  });

  const save = useMutation({
    mutationFn: () =>
      put<LlmSettings>('/settings/llm', {
        baseUrl: form?.baseUrl,
        model: form?.model,
        classifierModel: form?.classifierModel,
        fallbackModel: form?.fallbackModel?.trim() ?? '',
        runConcurrency: Number(form?.runConcurrency),
        ...(clearKey ? { apiKey: '' } : apiKey ? { apiKey } : {}),
      }),
    onSuccess: (next) => {
      setForm(next);
      setApiKey('');
      setClearKey(false);
      test.reset();
      void qc.invalidateQueries({ queryKey: ['llm'] });
    },
  });

  const impact = useQuery({
    queryKey: ['project-impact', projectId],
    queryFn: () => api<DeleteImpact>(`/projects/${projectId}/impact`),
    enabled: !!projectId && canDelete,
  });

  const removeProject = useMutation({
    mutationFn: () => del(`/projects/${projectId}`, { confirm: confirmSlug }),
    onSuccess: () => {
      // Drop the stored selection so the app falls back to the first remaining
      // project rather than pointing at an id that no longer exists.
      setProjectId(null);
      void qc.invalidateQueries();
      navigate('/');
    },
  });

  const toggleKill = useMutation({
    mutationFn: (active: boolean) => post(`/projects/${projectId}/kill-switch`, { active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['projects'] }),
  });

  const dirty =
    !!form &&
    !!saved.data &&
    (form.baseUrl !== saved.data.baseUrl ||
      form.model !== saved.data.model ||
      form.classifierModel !== saved.data.classifierModel ||
      (form.fallbackModel ?? '').trim() !== (saved.data.fallbackModel ?? '') ||
      Number(form.runConcurrency) !== saved.data.runConcurrency ||
      !!apiKey ||
      clearKey);

  const set = (k: keyof LlmSettings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <>
      <PageHeader title="Settings" subtitle="Pick which model to use, and set the guardrails for this project" />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <Panel title="Model provider">
          {!form ? (
            <div className="grid place-items-center py-10 text-muted"><Spinner /></div>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 border-b border-hairline px-4 py-3">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    title={p.note}
                    onClick={() =>
                      setForm((f) =>
                        f ? { ...f, baseUrl: p.baseUrl, model: p.model, classifierModel: p.classifierModel, fallbackModel: p.fallbackModel } : f,
                      )
                    }
                    className={clsx(
                      'rounded-full border px-3 py-1.5 text-xs transition-colors',
                      form.baseUrl === p.baseUrl
                        ? 'border-blue/60 bg-blue/10 text-blue-text'
                        : 'border-hairline bg-tile text-muted hover:text-ink',
                    )}
                  >
                    {p.name}
                  </button>
                ))}
              </div>

              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <div className="sm:col-span-2">
                  <Field label="Endpoint" hint="Any OpenAI-compatible /chat/completions base URL.">
                    <input className="input font-mono text-xs" value={form.baseUrl} onChange={set('baseUrl')} />
                  </Field>
                </div>

                <div className="sm:col-span-2">
                  <Field
                    label="API key"
                    hint={
                      clearKey
                        ? 'Will be cleared on save, falling back to LLM_API_KEY in .env.'
                        : form.apiKeyConfigured
                          ? `A key is set (from the ${form.apiKeySource}). Leave blank to keep it.`
                          : 'No key set. Runs will fail until you add one.'
                    }
                  >
                    <div className="flex gap-2">
                      <input
                        className="input font-mono text-xs"
                        type="password"
                        placeholder={form.apiKeyConfigured ? '•••••••••••• (unchanged)' : 'paste your key'}
                        value={apiKey}
                        onChange={(e) => {
                          setApiKey(e.target.value);
                          setClearKey(false);
                        }}
                        autoComplete="off"
                      />
                      {form.apiKeyConfigured && (
                        <button
                          className={clsx('btn-ghost shrink-0', clearKey && 'text-red')}
                          onClick={() => {
                            setClearKey((v) => !v);
                            setApiKey('');
                          }}
                          title="Remove the stored key"
                        >
                          <RotateCcw size={14} /> {clearKey ? 'Undo' : 'Clear'}
                        </button>
                      )}
                    </div>
                  </Field>
                </div>

                <Field label="Model" hint="Used for the agent loop.">
                  <input className="input font-mono text-xs" value={form.model} onChange={set('model')} />
                </Field>
                <Field label="Fallback model" hint="Tried when the main model is down, overloaded or rate limited. Empty for none.">
                  <input
                    className="input font-mono text-xs"
                    value={form.fallbackModel ?? ''}
                    onChange={set('fallbackModel')}
                    placeholder="e.g. gemini-3.5-flash"
                  />
                </Field>

                <Field
                  label="Run concurrency"
                  hint="Keep at 1 on a free tier or a local model; parallel runs just produce 429s."
                >
                  <input
                    className="input"
                    type="number"
                    min={1}
                    max={20}
                    value={form.runConcurrency}
                    onChange={set('runConcurrency')}
                  />
                </Field>
              </div>

              {test.data && (
                <div
                  className={clsx(
                    'mx-4 mb-3 rounded-lg border px-3 py-2 text-sm',
                    test.data.ok
                      ? 'border-green/30 bg-green/5 text-green'
                      : 'border-red/30 bg-red/5 text-red',
                  )}
                >
                  {test.data.ok
                    ? `${test.data.model} responded: “${test.data.detail}”`
                    : `${test.data.model}: ${test.data.detail}`}
                  {test.data.fallback && (
                    <span className={clsx('mt-1 block text-xs', test.data.fallback.ok ? 'text-green' : 'text-red')}>
                      Fallback {test.data.fallback.model}: {test.data.fallback.ok ? 'responded' : test.data.fallback.detail}
                    </span>
                  )}
                </div>
              )}
              {save.error && (
                <p className="mx-4 mb-3 text-sm text-red">
                  {save.error instanceof Error ? save.error.message : 'Could not save'}
                </p>
              )}

              <div className="flex items-center gap-2 border-t border-hairline px-4 py-3">
                <button className="btn-ghost" onClick={() => test.mutate()} disabled={test.isPending}>
                  {test.isPending ? <Spinner /> : <Plug size={15} />} Test connection
                </button>
                <span className="flex-1 text-xs text-muted">
                  {dirty ? 'Unsaved changes' : 'Tests the values shown, saved or not'}
                </span>
                <button className="btn-primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                  {save.isPending ? <Spinner /> : save.isSuccess && !dirty ? <Check size={15} /> : <Save size={15} />}
                  Save
                </button>
              </div>

              <p className="border-t border-hairline px-4 py-3 text-xs leading-relaxed text-muted">
                Saved settings override <code className="font-mono">.env</code> and take effect
                immediately — no restart. The key is encrypted with the same AES-256-GCM envelope as
                SSH credentials and is never sent back to the browser.
              </p>
            </>
          )}
        </Panel>

        {projectId && <SlackPanel projectId={projectId} />}

        {projectId && <NotificationsPanel projectId={projectId} isAdmin={canDelete} />}

        {projectId && <McpPanel projectId={projectId} isAdmin={canDelete} />}

        {project && <AutonomyPanel project={project} canEdit={canDelete} />}

        <ObservabilityPanel canEdit={canDelete} />

        <StoragePanel canEdit={canDelete} />

        {canDelete && <ApiKeysPanel />}

        <Panel title="Kill switch" accent="bg-red">
          <div className="flex items-start gap-4 p-4">
            <div
              className={clsx(
                'grid h-10 w-10 shrink-0 place-items-center rounded-xl',
                project?.killSwitch ? 'bg-red/15 text-red' : 'bg-tile-2 text-muted',
              )}
            >
              <AlertOctagon size={20} />
            </div>
            <div className="flex-1">
              <p className="text-sm text-ink">
                {project?.killSwitch
                  ? 'Agents in this project are halted. No tool call will execute.'
                  : 'Agents in this project may act within their risk policy.'}
              </p>
              <p className="mt-1 text-xs text-muted">
                Checked before every model call and again immediately before every command is
                dispatched, so turning it on stops work already in flight.
              </p>
            </div>
            <button
              className={project?.killSwitch ? 'btn-ghost' : 'btn-danger'}
              onClick={() => toggleKill.mutate(!project?.killSwitch)}
              disabled={toggleKill.isPending}
            >
              {project?.killSwitch ? 'Resume agents' : 'Halt all agents'}
            </button>
          </div>
        </Panel>

        {canDelete && (
        <Panel title="Delete this project" accent="bg-red">
          <div className="space-y-4 p-4">
            <p className="text-sm text-muted">
              Removes <span className="font-medium text-ink">{project?.name}</span> and everything
              inside it. This cannot be undone.
            </p>

            {impact.data && (
              <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-inner border border-hairline bg-tile-2/60 p-3 text-xs sm:grid-cols-4">
                <Impact k="Targets" v={impact.data.targets} />
                <Impact k="Credentials" v={impact.data.credentials} />
                <Impact k="Agents" v={impact.data.agents} />
                <Impact k="Runs" v={impact.data.runs} />
              </ul>
            )}

            <p className="text-xs leading-relaxed text-muted">
              The run history is the audit record of what an agent did to real machines — deleting
              the project destroys it, along with the stored SSH credentials.
            </p>

            {impact.data?.isLastProject ? (
              <p className="rounded-inner border border-hairline bg-tile-2/60 px-3 py-2.5 text-xs text-muted">
                This is your only project, so it cannot be deleted. Create another first.
              </p>
            ) : (
              <>
                <Field label={`Type "${impact.data?.slug ?? ''}" to confirm`}>
                  <input
                    className="input font-mono text-xs"
                    value={confirmSlug}
                    onChange={(e) => setConfirmSlug(e.target.value)}
                    placeholder={impact.data?.slug}
                    autoComplete="off"
                  />
                </Field>

                {removeProject.error && (
                  <p className="text-sm text-red">
                    {removeProject.error instanceof Error
                      ? removeProject.error.message
                      : 'Could not delete the project'}
                  </p>
                )}

                <button
                  className="btn-danger"
                  disabled={removeProject.isPending || !impact.data || confirmSlug !== impact.data.slug}
                  onClick={() => removeProject.mutate()}
                >
                  {removeProject.isPending ? <Spinner /> : <Trash2 size={15} />} Delete project
                </button>
              </>
            )}
          </div>
        </Panel>
        )}
      </div>
    </>
  );
}

const Impact = ({ k, v }: { k: string; v: number }) => (
  <li className="flex items-center justify-between gap-2 sm:block">
    <span className="text-muted">{k}</span>
    <span className="tabular block font-semibold text-ink">{v}</span>
  </li>
);
