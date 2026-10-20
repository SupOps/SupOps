import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { BookOpen, Check, Send, Server } from 'lucide-react';
import { ObservabilityIcon } from '../components/icons/ObservabilityIcon';
import { isObservabilityKind } from '@supops/shared';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { EnvBadge, Field, HealthBadge, Panel, Spinner, Switch } from '../components/ui';
import { HealthRing } from '../components/viz';
import { HEALTH_STYLE } from '../lib/format';
import type { Agent, Run, Target } from '../lib/types';
import { useImageAttachments } from '../lib/images';
import { AttachButton, AttachmentStrip } from '../components/Attachments';
import { MicButton } from '../components/MicButton';
import { useDictation } from '../lib/useDictation';

const EXAMPLES = [
  'Disk usage is climbing. Work out what is filling it.',
  'The service stopped responding after the last deploy. Diagnose and fix it.',
  'Report disk, memory and load, and flag anything unhealthy.',
];

export function Investigate() {
  const projectId = useApp((s) => s.projectId);
  const navigate = useNavigate();
  const [task, setTask] = useState('');
  const [params] = useSearchParams();
  const [runbookId, setRunbookId] = useState<string>(params.get('runbook') ?? '');
  const [agentId, setAgentId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const att = useImageAttachments();
  const dictation = useDictation(task, setTask);
  /**
   * Live works on the project's systems. Advisory has no access to anything: it
   * reasons from the description, screenshots and the project's runbooks and facts,
   * and hands back commands for a person to run. With no systems registered it is
   * the only mode there is.
   */
  const [mode, setMode] = useState<'live' | 'advisory'>('live');
  /** Advisory only: read-only network checks (curl, ping, DNS, TLS...) from the SupOps server. */
  const [networkChecks, setNetworkChecks] = useState(true);
  const hasInput = !!task.trim() || att.images.length > 0 || !!runbookId;

  const runbooks = useQuery({
    queryKey: ['knowledge', projectId, 'runbooks'],
    queryFn: () => api<Array<{ id: string; title: string; kind: string }>>(`/knowledge?projectId=${projectId}&status=approved`).then((d) => d.filter((x) => x.kind === 'runbook')),
    enabled: !!projectId,
  });
  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    enabled: !!projectId,
  });

  // VMs reached via a jump are hidden from the picker: you select the jump ("prod")
  // and the run includes the machines behind it, so the agent can decide which node
  // to check. Each VM is still its own target for scoping/audit.
  const allTargets = targets.data ?? [];
  const isVia = (t: Target) => !!(t.config as { via?: { alias?: string } }).via?.alias;
  const hostOf = (t: Target) => (t.config as { host?: string }).host ?? '';
  const childrenByHost = new Map<string, Target[]>();
  for (const t of allTargets) {
    if (isVia(t)) {
      const list = childrenByHost.get(hostOf(t)) ?? [];
      list.push(t);
      childrenByHost.set(hostOf(t), list);
    }
  }
  // Metrics, logs and alerts connections are not machines: they are always in reach
  // of a run, and listed on their own.
  const connections = allTargets.filter((t) => isObservabilityKind(t.kind));
  const primaries = allTargets.filter((t) => !isVia(t) && !isObservabilityKind(t.kind));
  /** Investigate the monitoring itself (Prometheus, Alertmanager, Loki...) instead of a system. */
  const [stackMode, setStackMode] = useState(false);
  const childrenOf = (t: Target) => childrenByHost.get(hostOf(t)) ?? [];

  // With a single primary there is nothing to choose, so preselect it and let the
  // operator write "check disk usage" rather than naming the host every time.
  useEffect(() => {
    if (primaries.length === 1 && selected.length === 0) {
      setSelected([primaries[0]!.id]);
    }
  }, [primaries.length, selected.length]);

  // Default to the Triage agent when the operator hasn't picked one.
  const chosenAgent =
    agentId ||
    agents.data?.find((a) => a.slug === 'triage')?.id ||
    agents.data?.[0]?.id ||
    '';
  const scoped = selected.length > 0 && selected.length < primaries.length;
  const chosenTargets = primaries.filter((t) => selected.includes(t.id));
  // Only connections and no machines: advisory, reading metrics and logs.
  const noTargets = !!targets.data && primaries.length === 0 && allTargets.filter((t) => !isObservabilityKind(t.kind)).length === 0;
  const advisory = !stackMode && (noTargets || mode === 'advisory');
  const hiddenVmCount = chosenTargets.reduce((n, t) => n + childrenOf(t).length, 0);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  async function start() {
    if (!hasInput || !chosenAgent || !projectId) return;
    dictation.cancel();
    setBusy(true);
    setError(null);
    try {
      // Expand each selected jump to include the machines behind it, so the agent
      // can reach whichever node the investigation points to.
      const ids = new Set(selected);
      for (const id of selected) {
        const t = allTargets.find((x) => x.id === id);
        if (t) for (const c of childrenOf(t)) ids.add(c.id);
      }
      if (stackMode) {
        const { run } = await post<{ run: Run }>('/observability/stack-investigate', { projectId, agentId: chosenAgent, task: task.trim() || undefined });
        navigate(`/runs/${run.id}`);
        return;
      }
      const run = await post<Run>('/runs', {
        projectId,
        agentId: chosenAgent,
        task: task.trim() || (runbookId ? 'Follow the runbook.' : 'Look at the attached screenshot(s) and investigate what they show.'),
        ...(advisory ? { advisory: true, networkChecks } : ids.size ? { targetIds: [...ids] } : {}),
        ...(att.images.length ? { images: att.payload() } : {}),
        ...(runbookId ? { runbookId } : {}),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the run');
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Investigate" subtitle="Tell it what's wrong. It digs through the evidence and figures out why." />

      <div className="mx-auto w-full max-w-3xl space-y-4 p-6">
        <Panel className="p-4">
          <div className="space-y-4">
            {noTargets ? (
              <p className="flex gap-2.5 rounded-inner border border-hairline bg-tile-2/60 px-3.5 py-3 text-xs leading-relaxed text-muted">
                <BookOpen size={15} className="mt-px shrink-0 text-blue-text" />
                <span>
                  <span className="font-medium text-ink">Advisory mode.</span> No machines or clusters are connected, so SupOps
                  cannot run anything on them. It works from your description, screenshots and this project's runbooks and
                  facts{connections.length ? ', reads your metrics, logs and alerts,' : ''} and gives you the checks and the fix to run yourself.
                </span>
              </p>
            ) : stackMode ? null : (
              <div role="radiogroup" aria-label="Mode" className="grid grid-cols-2 gap-1 rounded-inner border border-hairline bg-tile-2/60 p-1">
                {([
                  ['live', Server, 'Live systems', 'Checks your systems itself'],
                  ['advisory', BookOpen, 'Advisory', 'No access — advises from facts'],
                ] as const).map(([m, Icon, title, hint]) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => setMode(m)}
                    className={clsx(
                      'flex min-h-[44px] items-center gap-2.5 rounded-[10px] px-3 py-2 text-left transition-colors',
                      mode === m ? 'bg-tile text-ink shadow-sm ring-1 ring-edge' : 'text-muted hover:text-ink',
                    )}
                  >
                    <Icon size={15} className={mode === m ? 'text-blue-text' : ''} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{title}</span>
                      <span className="block truncate text-[11px] text-muted">{hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            {advisory && (
              <div className="flex items-start gap-3 rounded-inner border border-hairline bg-tile-2/40 px-3.5 py-3">
                <Switch label="Network checks from SupOps" checked={networkChecks} onChange={setNetworkChecks} />
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-ink">Network checks from SupOps</div>
                  <p className="mt-0.5 leading-relaxed text-muted">
                    {networkChecks
                      ? 'The agent may check URLs, DNS, ping, ports, TLS certificates, traceroute and domain registration from the SupOps server. Read-only; internal addresses ask you first.'
                      : 'Off: the agent only advises from what you give it and the runbooks.'}
                  </p>
                </div>
              </div>
            )}

            {connections.length > 0 && (
              <Field
                label="Metrics, logs and alerts"
                hint={stackMode
                  ? 'Checks the monitoring itself first: scrape targets, alert rules, notifications, storage and log ingestion. Read-only.'
                  : 'Always readable by the agent, whatever else is selected.'}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {connections.map((c) => (
                    <span key={c.id} className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-tile-2/60 px-2.5 py-1 font-mono text-[11px] text-muted">
                      <span className={clsx('h-1.5 w-1.5 rounded-full', (HEALTH_STYLE[c.healthState] ?? HEALTH_STYLE.unknown!).dot)} />
                      {c.slug}
                    </span>
                  ))}
                  <button
                    type="button"
                    aria-pressed={stackMode}
                    onClick={() => setStackMode((v) => !v)}
                    className={clsx(
                      'inline-flex min-h-[32px] items-center gap-1.5 rounded-full border px-3 text-xs transition-colors',
                      stackMode ? 'border-blue/60 bg-blue/10 text-ink' : 'border-hairline text-muted hover:border-edge hover:text-ink',
                    )}
                  >
                    {stackMode ? <Check size={12} strokeWidth={3} /> : <ObservabilityIcon size={12} />} Investigate the stack itself
                  </button>
                </div>
              </Field>
            )}

            {!advisory && !stackMode && (
            <Field
              label="Targets"
              hint={
                selected.length === 0
                  ? 'Nothing selected — the agent may use any target in the project.'
                  : hiddenVmCount > 0
                    ? `Includes ${hiddenVmCount} machine${hiddenVmCount === 1 ? '' : 's'} behind the selected jump${selected.length === 1 ? '' : 's'} — the agent picks which to check.`
                    : selected.length === 1
                      ? `Scoped to ${chosenTargets[0]?.slug}. You do not need to name it in the task.`
                      : `Scoped to ${selected.length} targets. Nothing else is reachable.`
              }
            >
              <div className="flex flex-wrap gap-2">
                {primaries.map((t) => {
                  const on = selected.includes(t.id);
                  const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
                  const behind = childrenOf(t).length;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(t.id)}
                      className={clsx(
                        'group flex min-h-[44px] items-center gap-3 rounded-inner border p-3 text-left transition-all duration-150',
                        on
                          ? 'border-blue/60 bg-blue/10 text-ink shadow-[0_8px_20px_-14px_rgb(var(--blue))]'
                          : 'border-hairline bg-tile-2/60 text-muted hover:border-edge hover:text-ink',
                      )}
                    >
                      <HealthRing
                        interactive={false}
                        size={34}
                        thickness={4}
                        segments={[{ label: h.label, value: 1, hex: h.hex }]}
                        center={on ? <Check size={13} strokeWidth={3} /> : t.env.slice(0, 1).toUpperCase()}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-mono text-xs text-ink">{t.slug}</span>
                          <EnvBadge env={t.env} />
                        </span>
                        <span className="mt-1 block">
                          {behind > 0 ? (
                            <span className="text-[11px] text-muted">{behind} machine{behind === 1 ? '' : 's'} behind it</span>
                          ) : (
                            <HealthBadge state={t.healthState} />
                          )}
                        </span>
                      </span>
                    </button>
                  );
                })}
                {!!selected.length && (
                  <button
                    type="button"
                    onClick={() => setSelected([])}
                    className="rounded-lg px-3 py-2 text-xs text-muted hover:text-ink"
                  >
                    Clear
                  </button>
                )}
              </div>
            </Field>
            )}

            <Field
              label="What is wrong?"
              hint={
                advisory
                  ? 'Give it what you know: the symptom, error messages, log lines, versions, and what changed recently. Screenshots help too.'
                  : 'Be specific about the symptom. Paste or drop a screenshot (a dashboard, an error) and the agent will read it.'
              }
            >
              <div {...att.dropProps} className={clsx('space-y-2 rounded-inner', att.dragging && 'ring-2 ring-blue/60 ring-offset-2 ring-offset-tile')}>
              <div className="relative">
              <textarea
                className="input min-h-32 resize-y pr-12"
                placeholder={
                  dictation.listening
                    ? 'Listening…'
                    : advisory
                      ? 'e.g. our checkout API returns 502s since this morning\'s deploy. nginx error log says "upstream timed out"'
                      : chosenTargets.length === 1
                    ? `e.g. disk is filling up on ${chosenTargets[0]!.slug}, or just: check disk usage`
                    : 'e.g. checkout is returning 500s since about 14:20'
                }
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onPaste={att.onPaste}
                autoFocus
              />
              <span className="absolute bottom-2 right-2"><MicButton dictation={dictation} /></span>
              </div>
              {dictation.error && <p className="text-[11px] text-amber">{dictation.error}</p>}
              <AttachmentStrip att={att} />
              <div className="flex items-center gap-2 text-[11px] text-muted">
                <AttachButton att={att} />
                <span>{att.dragging ? 'Drop to attach' : 'Attach, paste (Ctrl+V) or drop screenshots'}</span>
              </div>
              </div>
            </Field>

            {!!runbooks.data?.length && (
              <Field label="Follow a runbook (optional)" hint="Its full steps are given to the agent at the start of the run.">
                <select className="input" value={runbookId} onChange={(e) => setRunbookId(e.target.value)}>
                  <option value="">No runbook</option>
                  {runbooks.data.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
              </Field>
            )}

            <Field label="Agent">
              <select className="input" value={chosenAgent} onChange={(e) => setAgentId(e.target.value)}>
                {agents.data?.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {a.role}
                  </option>
                ))}
              </select>
            </Field>

            {error && (
              <p className="rounded-lg border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
                {error}
              </p>
            )}

            <div className="flex items-center justify-between gap-4">
              <p className="text-xs text-muted">
                {stackMode
                  ? 'Read-only: the monitoring stack is checked through its own APIs.'
                  : advisory
                  ? networkChecks
                    ? 'Nothing runs on your systems. You get likely causes, checks and a fix, with every command rated by the risk engine.'
                    : 'Nothing runs. You get likely causes, checks and a fix, and every command is rated by the risk engine before you run it.'
                  : scoped
                  ? 'Targets outside this selection are not just discouraged — they are absent from the tools the agent is given.'
                  : 'Read-only checks run immediately. Anything riskier will pause for your approval.'}
              </p>
              <button
                className="btn-primary shrink-0"
                onClick={start}
                disabled={busy || att.busy || (!hasInput && !stackMode) || !chosenAgent || !targets.data || (!advisory && !stackMode && !targets.data.length)}
              >
                {busy ? <Spinner /> : <Send size={15} />} Start
              </button>
            </div>
          </div>
        </Panel>

        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((e) => (
            <button
              key={e}
              onClick={() => setTask(e)}
              className="rounded-full border border-hairline bg-tile px-3 py-1.5 text-xs text-muted hover:border-blue/50 hover:text-ink"
            >
              {e}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
