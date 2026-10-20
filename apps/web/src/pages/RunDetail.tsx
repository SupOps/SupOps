import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { THREAT_LABEL, messageText, stripAnsi } from '@supops/shared';
import {
  AlertTriangle, ArrowLeft, Ban, BookOpen, Bot, Check, ChevronDown, ChevronRight, CircleSlash, Pin, PinOff,
  Anchor, Cpu, Eraser, FilePen, FileX, FlaskConical, Globe, Info, KeyRound, Network, Package, Radio, Server, ShieldAlert, ShieldCheck, Terminal, User, X,
} from 'lucide-react';
import { api, post } from '../lib/api';
import { useRunStream } from '../lib/useRunStream';
import { cleanTask, duration, splitOpening, timeAgo } from '../lib/format';
import { CallCommand, CommandBlock, Panel, RiskBadge, Spinner, StatusPill } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { TrustDialog, TrustedChip, canTrust } from '../components/TrustDialog';
import { RiskBar } from '../components/viz';
import { TIER_STYLE } from '../lib/format';
import { ReportActions } from '../components/ReportActions';
import { ScrollJump } from '../components/ScrollJump';
import { UserContent } from '../components/Attachments';
import { Composer } from '../components/Composer';
import { FeedbackBar } from '../components/FeedbackBar';
import { useImageAttachments } from '../lib/images';
import { PLAN_TOOL, PlanCard, PlanLine, runPlan } from '../components/RunPlan';
import type { RunDetail as RunDetailData, ToolCall } from '../lib/types';

export function RunDetail() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const detail = useQuery({
    queryKey: ['run', id],
    queryFn: () => api<RunDetailData>(`/runs/${id}`),
    enabled: !!id,
  });

  const seedSeq = detail.data?.events.at(-1)?.seq ?? -1;
  const { events, connected } = useRunStream(id, seedSeq);

  // Any live event means the durable state has already changed; refetch rather than
  // trying to mirror the engine's state machine in the browser.
  useEffect(() => {
    if (events.length) void qc.invalidateQueries({ queryKey: ['run', id] });
  }, [events.length, id, qc]);

  const run = detail.data?.run;
  const isLive = run && ['running', 'queued', 'awaiting_approval', 'suspended'].includes(run.status);
  const advisory = !!run?.policySnapshot?.advisory;
  const readOnly = !!run?.policySnapshot?.unattended;

  // Follow the output while the run is live -- but only while the reader is already
  // at the bottom. Scrolling up to read something releases the auto-scroll (the
  // sentinel leaves the viewport, so `pinned` goes false) and scrolling back down
  // re-arms it, so a long investigation never yanks the page away mid-read.
  const bottomRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => { pinned.current = !!e?.isIntersecting; }, {
      rootMargin: '0px 0px 120px 0px',
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  // Once a run has streamed live in this view, keep following it to the bottom --
  // including the concluding message and the status flip to succeeded, which arrive
  // together after `isLive` has already gone false. A run opened after it finished
  // (history) was never live here, so it opens at the top instead of jumping down.
  const wasLive = useRef(false);
  if (isLive) wasLive.current = true;
  const stepCount = detail.data?.steps.length ?? 0;
  useEffect(() => {
    if (wasLive.current && pinned.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [isLive, stepCount, events.length]);

  useEffect(() => {
    if (!isLive) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['run', id] }), 3000);
    return () => clearInterval(t);
  }, [isLive, id, qc]);

  const [followUpText, setFollowUpText] = useState('');
  // "agent" is the normal conversation timeline; "sandbox" re-frames the run as what the
  // sandbox observed (or why it couldn't) for each command -- the "what it would do" lens.
  const [view, setView] = useState<'agent' | 'sandbox'>('agent');
  const att = useImageAttachments();
  const followUp = useMutation({
    mutationFn: (text: string) =>
      post(`/runs/${id}/message`, {
        message: text || 'Look at the attached screenshot(s).',
        ...(att.images.length ? { images: att.payload() } : {}),
      }),
    onSuccess: () => {
      setFollowUpText('');
      att.clear();
      void qc.invalidateQueries({ queryKey: ['run', id] });
    },
  });

  // Follow-ups are accepted once a turn has finished; while the agent works the box
  // stays up (locked) so the conversation never loses its input.
  const canFollowUp = !!run && (run.status === 'succeeded' || run.status === 'awaiting_input' || isLive);

  if (detail.isLoading) {
    return <div className="grid h-full place-items-center text-muted"><Spinner /></div>;
  }
  if (!detail.data || !run) {
    return <div className="grid h-full place-items-center text-muted">Run not found</div>;
  }

  const callsById = new Map(detail.data.toolCalls.map((c) => [c.toolCallId, c]));
  const openingId = detail.data.steps.find((s) => s.messageJson.role === 'user')?.id;

  // The header shows only the entry point(s) and machines actually acted on -- not
  // the whole frozen scope, which for a jump can be dozens of machines and reads as
  // noise the operator never chose.
  const snapshot = (run.targetsSnapshot as Array<{ slug: string; description?: string | null }>) ?? [];
  const acted = new Set(
    detail.data.toolCalls
      .map((c) => (c.argsJson as { target?: string }).target)
      // SupOps itself (plans, MCP tools, network checks) is not one of the project's machines.
      .filter((t): t is string => !!t && t !== 'supops-server'),
  );
  const primary = snapshot.filter((t) => !/^Behind\s/.test(t.description ?? '')).map((t) => t.slug);
  const shownTargets = [...new Set([...primary, ...acted])];

  return (
    <>
      <header className="border-b border-hairline px-6 py-5">
        <Link to="/runs" className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
          <ArrowLeft size={13} /> All runs
        </Link>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold text-ink">{run.title}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted">
              <StatusPill status={run.status} />
              {advisory && (
                <span className="chip border-amber/30 bg-amber/10 text-amber" title="This run had no access to any system. Its commands are for you to run.">
                  Advisory · no system access
                </span>
              )}
              {!advisory && readOnly && (
                <span className="chip border-cyan/30 bg-cyan/10 text-cyan" title="Started automatically: it can look, never change anything.">
                  Read-only diagnosis
                </span>
              )}
              <span>{run.model}</span>
              {shownTargets.length > 0 && (
                <span className="inline-flex items-center gap-1">
                  <Server size={12} />
                  {shownTargets.join(', ')}
                </span>
              )}
              <span>{run.iteration} steps</span>
              <span>{run.promptTokens + run.completionTokens} tokens</span>
              <span>{timeAgo(run.startedAt)}</span>
              {run.startedByName && <span>started by {run.startedByName}</span>}
              {isLive && (
                <span className={clsx('inline-flex items-center gap-1', connected ? 'text-green' : 'text-muted')}>
                  <Radio size={12} /> {connected ? 'live' : 'reconnecting'}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-start gap-2">
            {/* Available on any run that has actually done something, not just on
                success -- a failed or rejected run is often the one worth writing up. */}
            {(detail.data.toolCalls.length > 0 || (advisory && !isLive)) && <ReportActions runId={run.id} />}
            <button
              className={clsx('btn-ghost !px-3', run.pinned && '!border-blue/50 !text-blue-text')}
              onClick={async () => {
                await post(`/runs/${run.id}/pin`, { pinned: !run.pinned });
                void qc.invalidateQueries({ queryKey: ['run', id] });
              }}
              title={run.pinned ? 'Pinned: history clean-up will keep this run. Click to unpin.' : 'Pin: keep this run when old history is cleaned up'}
              aria-pressed={!!run.pinned}
              aria-label={run.pinned ? 'Unpin run' : 'Pin run'}
            >
              {run.pinned ? <PinOff size={15} /> : <Pin size={15} />}
            </button>
            {isLive && (
              <button
                className="btn-ghost"
                onClick={async () => {
                  await post(`/runs/${run.id}/cancel`, {});
                  void qc.invalidateQueries({ queryKey: ['run', id] });
                }}
              >
                <CircleSlash size={15} /> Abort
              </button>
            )}
          </div>
        </div>
        {run.statusReason && (
          <p className="mt-3 rounded-inner border border-hairline bg-tile-2 px-3.5 py-2.5 text-sm text-muted">
            {run.statusReason}
          </p>
        )}

        {/* A compact summary only. The timeline below already lists every action with
            its tier, its command and its output -- drawing the same thing twice at the
            top is what made this header feel heavy. */}
        {detail.data.toolCalls.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-x-8 gap-y-3 rounded-tile border border-hairline bg-tile px-4 py-3">
            <div className="min-w-[180px] flex-1">
              <RiskBar
                counts={detail.data.toolCalls.reduce<Record<string, number>>((acc, c) => {
                  const t = c.tier ?? 'read_only';
                  acc[t] = (acc[t] ?? 0) + 1;
                  return acc;
                }, {})}
              />
            </div>
            <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[11px]">
              <Fact k="Actions" v={String(detail.data.toolCalls.length)} />
              <Fact
                k="Gated"
                v={String(
                  detail.data.toolCalls.filter(
                    (c) => c.tier && c.tier !== 'read_only' && c.tier !== 'low',
                  ).length,
                )}
              />
              <Fact k="Steps" v={String(run.iteration)} />
              <Fact k="Tokens" v={String(run.promptTokens + run.completionTokens)} />
            </dl>
          </div>
        )}
        {/* Calls in the order they were made (the list is per step), for the latest plan.
            Falls back to the steps the agent seeded via confirm_target when it has not yet
            called update_plan, so a multi-part task shows its plan from the start. */}
        {(() => {
          const plan = runPlan(detail.data.steps.flatMap((s) => (s.messageJson.role === 'assistant' ? (s.messageJson.tool_calls ?? []) : []).map((tc) => callsById.get(tc.id)).filter((c): c is ToolCall => !!c)));
          return <PlanCard steps={plan.steps} live={!!isLive} seeded={plan.seeded} />;
        })()}
      </header>
      {/* Why a run only told you what was wrong, and how to let it fix things. */}
      {(advisory || readOnly) && !isLive && (
        <div className="flex items-start gap-2.5 border-b border-hairline bg-amber/[0.05] px-6 py-3 text-[12.5px] leading-relaxed text-ink/85">
          <Info size={15} className="mt-0.5 shrink-0 text-amber" />
          <p>
            {advisory ? (
              <>
                <span className="font-medium text-ink">This run could only advise.</span> The project has no machine or cluster SupOps can reach, so it
                cannot run anything itself; the commands above are for you. To let it fix things (each change with your approval), add the machine as an SSH
                target or the cluster as a Kubernetes target on <Link to="/targets" className="text-blue-text hover:underline">Targets</Link>.
              </>
            ) : (
              <>
                <span className="font-medium text-ink">This was the automatic read-only diagnosis:</span> it looks, it never changes anything. To fix it,
                press <span className="font-medium text-ink">Investigate</span> on the incident (or on the signal): that run starts from this diagnosis and
                proposes the fix, and every change waits for your approval.
              </>
            )}
          </p>
        </div>
      )}

      <div className={clsx('mx-auto w-full max-w-4xl space-y-3 px-6 pt-6', canFollowUp ? 'pb-1' : 'pb-6')}>
        {detail.data.toolCalls.length > 0 && <ViewToggle view={view} onChange={setView} />}
        {view === 'sandbox' ? (
          <SandboxMode calls={detail.data.toolCalls} />
        ) : (
          <>
        {detail.data.steps.map((step) => {
          const m = step.messageJson;

          if (m.role === 'system') return <SystemStep key={step.id} content={messageText(m.content)} />;
          if (m.role === 'tool') return null; // rendered inside its tool-call card

          if (m.role === 'user') {
            return (
              <Bubble key={step.id} icon={<User size={15} />} tint="text-cyan" label={step.id === openingId ? 'Task' : 'You'}>
                <UserContent runId={run.id} content={m.content} clean={cleanTask} />
                {step.id === openingId && (
                  <RunContext
                    context={splitOpening(messageText(m.content)).context}
                    advisory={advisory}
                    networkChecks={!!run.policySnapshot?.networkChecks}
                    targets={primary}
                    knowledge={detail.data.knowledge ?? []}
                  />
                )}
              </Bubble>
            );
          }

          return (
            <div key={step.id} className="space-y-3">
              {m.content && (
                <Bubble icon={<Bot size={15} />} tint="text-violet" label="Agent" meta={<ModelTag model={step.model} main={run.model} />}>
                  <Markdown rateCommands={advisory}>{messageText(m.content)}</Markdown>
                  {!m.tool_calls?.length && !isLive && (
                    <FeedbackBar runId={run.id} stepId={step.id} text={messageText(m.content)} projectId={run.projectId} />
                  )}
                </Bubble>
              )}
              {m.tool_calls?.map((tc) => {
                const call = callsById.get(tc.id);
                if (!call) return null;
                return call.toolKey === PLAN_TOOL && call.state === 'succeeded' ? <PlanLine key={tc.id} call={call} /> : <ToolCallCard key={tc.id} call={call} />;
              })}
            </div>
          );
        })}

        {isLive && (
          <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted">
            <Spinner className="text-blue-text" />
            {run.status === 'awaiting_approval' ? 'Waiting for a decision…' : 'Working…'}
          </div>
        )}
          </>
        )}

        {/* Keep the conversation going after the agent's final answer. The whole
            transcript replays into the next turn, so a follow-up continues this
            investigation rather than starting a fresh one. The box floats at the foot
            of the view while you scroll, and stays visible (send disabled) while the
            agent works, so you can write the next message in the meantime. */}
        {canFollowUp && (
          <div className="sticky bottom-0 z-20 -mx-2 bg-gradient-to-t from-ground from-70% to-transparent px-2 py-1.5">
            <Composer
              value={followUpText}
              onChange={setFollowUpText}
              onSubmit={() => followUp.mutate(followUpText.trim())}
              att={att}
              sending={followUp.isPending}
              locked={isLive}
              lockedHint={run.status === 'awaiting_approval' ? 'Waiting for a decision — you can send once it finishes' : 'The agent is working — you can send once it finishes'}
              placeholder={
                advisory
                  ? 'Paste the output of the checks you ran, or ask a follow-up…'
                  : 'Ask a follow-up, or tell it what to do next… (paste or drop a screenshot to attach it)'
              }
              error={followUp.error ? (followUp.error instanceof Error ? followUp.error.message : 'Could not send that') : null}
            />
          </div>
        )}

        <div ref={bottomRef} aria-hidden className="h-px" />
        <ScrollJump />
      </div>
    </>
  );
}

/**
 * What the agent was given besides the task, in one line: the mode or targets, the
 * runbook it follows, and which knowledge documents it read. The full opening text
 * (every excerpt) stays one click away rather than filling the page.
 */
function RunContext({ context, advisory, networkChecks, targets, knowledge }: {
  context: string | null;
  advisory: boolean;
  networkChecks: boolean;
  targets: string[];
  knowledge: Array<{ docId: string; via: string; title: string; kind: string }>;
}) {
  const [open, setOpen] = useState(false);
  if (!context) return null;
  // 'alert': the runbook written for the incident's alerts, followed like a chosen one.
  const runbook = knowledge.find((k) => k.via === 'runbook' || k.via === 'alert');
  const docs = knowledge.filter((k) => k !== runbook);
  const shown = docs.slice(0, 5);
  return (
    <div className="mt-3 border-t border-hairline pt-2.5 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span>
          {advisory ? `Advisory${networkChecks ? ' · network checks on' : ' · no network checks'}` : targets.length ? `Targets: ${targets.join(', ')}` : 'All targets'}
        </span>
        {runbook && (
          <span className="inline-flex items-center gap-1 text-ink"><BookOpen size={11} className="text-cyan" /> Following {runbook.title}{runbook.via === 'alert' ? ' (written for these alerts)' : ''}</span>
        )}
        {!!docs.length && (
          <span className="inline-flex flex-wrap items-center gap-1">
            Knowledge:
            {shown.map((k) => (
              <Link key={k.docId} to="/knowledge" title={k.via === 'pinned' ? 'Always given (pinned)' : 'Matched the task'} className="chip border border-edge bg-tile-2 hover:text-ink">
                {k.title}
              </Link>
            ))}
            {docs.length > shown.length && <span>+{docs.length - shown.length} more</span>}
          </span>
        )}
        {!runbook && !docs.length && <span>No knowledge matched</span>}
        <button type="button" onClick={() => setOpen((v) => !v)} className="ml-auto inline-flex items-center gap-1 hover:text-ink" aria-expanded={open}>
          <ChevronDown size={12} className={clsx('transition-transform', open && 'rotate-180')} /> {open ? 'Hide' : 'Full context'}
        </button>
      </div>
      {open && (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-inner border border-hairline bg-ground/40 p-3 font-mono text-[11px] leading-relaxed text-muted">{context}</pre>
      )}
    </div>
  );
}

function Bubble({
  icon, tint, label, meta, children,
}: { icon: React.ReactNode; tint: string; label: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="tile min-w-0 overflow-hidden p-4">
      <div className={clsx('mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide', tint)}>
        {icon} {label}
        {meta}
      </div>
      {children}
    </div>
  );
}

/** The model that wrote a reply; amber when the fallback answered instead of the run's model. */
function ModelTag({ model, main }: { model?: string | null; main?: string }) {
  if (!model) return null;
  const fellBack = !!main && model !== main;
  return (
    <span
      className={clsx('ml-auto font-mono text-[10.5px] font-normal normal-case tracking-normal', fellBack ? 'text-amber' : 'text-dim')}
      title={fellBack ? `${main} failed, so the fallback model ${model} answered` : `Answered by ${model}`}
    >
      {model}
    </span>
  );
}

function SystemStep({ content }: { content: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tile">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs text-muted hover:text-ink"
      >
        <ChevronRight size={13} className={clsx('transition-transform', open && 'rotate-90')} />
        System prompt
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words border-t border-hairline px-4 py-3 font-mono text-[11px] leading-relaxed text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}

/**
 * One action, with everything a human needs to judge it: the exact command, why the
 * agent wants to run it, what it expects to happen, and which rules produced the
 * risk tier. The approve/reject controls are here rather than on a separate screen
 * so the decision is made in context.
 */
/** A friendly name for which sandbox ran, from the simulator id. */
function sandboxLabel(simulator: string | null): string {
  if (!simulator) return 'sandbox';
  if (simulator.startsWith('detonate/')) return `detonated in a sandbox${simulator.endsWith('gvisor') ? ' (gVisor)' : ''}`;
  if (simulator === 'shadow') return 'target shadow — the real command, writes thrown away';
  if (simulator === 'kubectl-dry-run') return 'server dry-run';
  return 'dry-run';
}

/** An icon per observation kind, so the sandbox report reads at a glance. */
const OBS_ICON: Record<string, typeof Info> = {
  'file.delete': FileX, 'file.write': FilePen, 'pkg.remove': Package, 'pkg.install': Package,
  persistence: Anchor, 'anti-forensics': Eraser, 'net.connect': Globe, exfil: Globe,
  privilege: KeyRound, miner: Cpu, 'deps.reverse': Network, 'k8s.apply': Server, 'k8s.reject': Server,
  clean: Check,
};

/** The "what it would actually do" sandbox view: the command that ran, and what it did. */
function SandboxView({ observed }: { observed: NonNullable<ToolCall['riskJson']>['observed'] }) {
  if (!observed || observed.status === 'skipped') return null;
  const raised = new Set(['file.delete', 'persistence', 'anti-forensics', 'net.connect', 'exfil', 'privilege', 'miner']);
  return (
    <div className="overflow-hidden rounded-lg border border-cyan/25 bg-cyan/[0.04]">
      <div className="flex items-center gap-1.5 border-b border-cyan/15 bg-cyan/[0.06] px-3 py-1.5 text-xs font-medium text-ink/90">
        <FlaskConical size={13} className="text-cyan" /> What it would actually do
        <span className="text-[11px] font-normal text-muted">· {sandboxLabel(observed.simulator)}</span>
      </div>
      <div className="space-y-2.5 p-3">
        {observed.command && (
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted">Ran in the sandbox</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-inner border border-hairline bg-ground/70 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-ink/90">{observed.command}</pre>
          </div>
        )}
        {observed.items.length > 0 ? (
          <ul className="space-y-1.5">
            {observed.items.map((o, i) => {
              const Icon = OBS_ICON[o.kind] ?? Info;
              const danger = raised.has(o.kind);
              return (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <Icon size={14} className={clsx('mt-0.5 shrink-0', danger ? 'text-amber' : 'text-muted')} />
                  <span className={clsx(danger ? 'text-ink' : 'text-ink/80')}>{o.detail}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-xs text-muted">{observed.note ?? 'The sandbox could not run this action, so it was not observed.'}</p>
        )}
        {observed.blindSpots?.length ? (
          <p className="flex items-start gap-1.5 border-t border-cyan/15 pt-2 text-[11px] text-muted">
            <Info size={12} className="mt-0.5 shrink-0" /> Not observed: {observed.blindSpots.join('; ')}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** The segmented Agent | Sandbox switch for the run view. */
function ViewToggle({ view, onChange }: { view: 'agent' | 'sandbox'; onChange: (v: 'agent' | 'sandbox') => void }) {
  const opt = (v: 'agent' | 'sandbox', label: string, Icon: typeof Bot) => (
    <button
      type="button"
      onClick={() => onChange(v)}
      aria-pressed={view === v}
      className={clsx(
        'flex items-center gap-1.5 rounded-inner px-3 py-1 text-xs font-medium transition-colors',
        view === v ? 'bg-tile text-ink shadow-sm' : 'text-muted hover:text-ink',
      )}
    >
      <Icon size={13} /> {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
      <div className="inline-flex items-center gap-0.5 rounded-tile border border-hairline bg-ground/60 p-0.5">
        {opt('agent', 'Agent', Bot)}
        {opt('sandbox', 'Sandbox', FlaskConical)}
      </div>
      {view === 'sandbox' && <span className="text-[11px] text-muted">What each command would actually do, before it runs</span>}
    </div>
  );
}

/** Calls that are real commands a sandbox could observe (not SupOps' own bookkeeping). */
const BOOKKEEPING_KEYS = new Set(['update_plan', 'record_finding', 'confirm_target', 'read_output', 'search_knowledge', 'read_knowledge']);

/** Why a command was not observed in the sandbox -- stated plainly, never implying "safe". */
function NotSimulated({ call }: { call: ToolCall }) {
  const reason =
    call.tier === 'read_only'
      ? 'Read-only — not run in a sandbox because it only reads; there is nothing to observe.'
      : call.state === 'failed' || call.state === 'blocked'
        ? 'Not run in a sandbox — the command did not execute.'
        : 'Not observed — no built-in dry-run matched this command and no sandbox backend is configured. Turn on the detonator or target-shadow to observe commands like this.';
  return (
    <p className="flex items-start gap-1.5 rounded-lg border border-hairline bg-ground/40 px-3 py-2 text-xs text-muted">
      <FlaskConical size={13} className="mt-0.5 shrink-0 text-muted/70" /> {reason}
    </p>
  );
}

/**
 * The run seen through the sandbox: every command the agent ran, with what the sandbox
 * observed -- or, when it was not simulated, an honest line saying why. The "see inside
 * the sandbox" lens; the Agent view is the normal conversation timeline.
 */
function SandboxMode({ calls }: { calls: ToolCall[] }) {
  const commands = calls.filter((c) => !BOOKKEEPING_KEYS.has(c.toolKey) && c.renderedCommand);
  if (!commands.length) return <p className="px-1 py-6 text-sm text-muted">This run had no commands to run in a sandbox.</p>;
  return (
    <div className="space-y-3">
      {commands.map((call) => {
        const observed = call.riskJson?.observed;
        const simulated = observed && observed.status !== 'skipped';
        return (
          <div key={call.toolCallId} className="space-y-2 rounded-tile border border-hairline bg-tile px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <RiskBadge tier={call.tier} />
              <CallCommand call={call} className="min-w-0" />
            </div>
            {simulated ? <SandboxView observed={observed} /> : <NotSimulated call={call} />}
          </div>
        );
      })}
    </div>
  );
}

function ToolCallCard({ call }: { call: ToolCall }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  /** Trusting from the approval card also approves this one; from a finished action it only trusts. */
  const [trusting, setTrusting] = useState<null | 'approve' | 'only'>(null);

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      post(`/runs/tool-calls/${call.id}/decision`, { decision, comment: comment || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run', call.runId] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const waiting = call.state === 'awaiting_approval';
  const blocked = call.state === 'blocked';
  const denied = call.state === 'denied';
  const failed = call.isError && !blocked && !denied;

  const args = call.argsJson as { intent?: string; expected_effect?: string; target?: string };

  return (
    <div
      className={clsx(
        'tile relative overflow-hidden',
        waiting && 'border-amber/50 ring-1 ring-amber/20',
        blocked && 'border-red/50',
      )}
    >
      {/* Tier as a rail: readable down a long transcript without reading labels. */}
      <span className={clsx('rail', call.tier ? TIER_STYLE[call.tier].bg : 'bg-muted')} aria-hidden />
      <div className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 pl-5">
        <Terminal size={14} className="shrink-0 text-muted" />
        <span className="font-mono text-xs text-muted">{call.toolKey}</span>
        {args.target && (
          <span className="rounded bg-tile-2 px-1.5 py-0.5 font-mono text-[11px] text-cyan">
            {args.target}
          </span>
        )}
        <div className="flex-1" />
        <TrustedChip call={call} />
        <RiskBadge tier={call.tier} />
        <StateChip call={call} />
      </div>

      <div className="space-y-3 p-4">
        <CallCommand call={call} />

        {(args.intent || args.expected_effect) && (
          <dl className="grid gap-2 text-xs sm:grid-cols-2">
            {args.intent && (
              <div>
                <dt className="mb-0.5 font-medium uppercase tracking-wide text-muted">Why</dt>
                <dd className="text-ink">{args.intent}</dd>
              </div>
            )}
            {args.expected_effect && (
              <div>
                <dt className="mb-0.5 font-medium uppercase tracking-wide text-muted">Expected effect</dt>
                <dd className="text-ink">{args.expected_effect}</dd>
              </div>
            )}
          </dl>
        )}

        {/* The risk explanation is the difference between a decision and a rubber stamp. */}
        {call.riskJson && call.tier !== 'read_only' && (
          <div className="rounded-lg border border-hairline bg-tile-2 p-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted">
              <ShieldAlert size={13} /> Why this is {call.tier}
            </div>
            <ul className="space-y-1 text-xs text-muted">
              {call.riskJson.contributions
                .filter((c) => c.tier !== 'read_only')
                .map((c, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-muted/50">·</span>
                    <span>
                      {(c.category || c.irreversible) && (
                        <span className="mr-1.5 inline-flex gap-1 align-middle">
                          {c.category && (
                            <span className={clsx('rounded border px-1.5 py-px text-[10px] font-medium', TIER_STYLE[c.tier].chip)}>
                              {THREAT_LABEL[c.category]}
                            </span>
                          )}
                          {c.irreversible && (
                            <span className={clsx('rounded border px-1.5 py-px text-[10px] font-medium', TIER_STYLE.forbidden.chip)}>
                              Irreversible
                            </span>
                          )}
                        </span>
                      )}
                      {c.reason}
                      {c.ruleId && <span className="ml-1.5 font-mono text-[10px] text-muted/60">{c.ruleId}</span>}
                    </span>
                  </li>
                ))}
            </ul>
          </div>
        )}

        {/* What a shadow/dry-run/detonation simulation actually observed before approval. */}
        <SandboxView observed={call.riskJson?.observed} />

        {waiting && (
          <div className="space-y-2 rounded-lg border border-amber/30 bg-amber/5 p-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber">
              <AlertTriangle size={13} /> This action needs your approval before it runs
            </div>
            {call.riskJson?.preflight && <p className="text-xs text-amber">{call.riskJson.preflight} Consider asking the agent to look first.</p>}
            <input
              className="input"
              placeholder="Optional note — the agent reads this if you reject"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <div className="flex gap-2">
              <button className="btn-primary" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
                <Check size={15} /> Approve &amp; run
              </button>
              <button className="btn-danger" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
                <X size={15} /> Reject
              </button>
              {canTrust(call) && (
                <button className="btn-ghost" disabled={decide.isPending} onClick={() => setTrusting('approve')} title="Approve now, and let this command run without asking next time">
                  <ShieldCheck size={15} /> Approve &amp; trust…
                </button>
              )}
            </div>
            {decide.error && (
              <p role="alert" className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
                {(decide.error as Error).message}
              </p>
            )}
          </div>
        )}

        {call.decidedByName && (
          <p className="text-xs text-muted">
            {denied ? 'Rejected' : 'Approved'} by{' '}
            <span className="font-medium text-ink">{call.decidedByName}</span>
            {call.decidedAt ? ` · ${timeAgo(call.decidedAt)}` : ''}
          </p>
        )}
        {call.decisionComment && (
          <p className="text-xs text-muted">Reviewer note: “{call.decisionComment}”</p>
        )}
        {!waiting && canTrust(call) && ['approved', 'executing', 'succeeded', 'failed'].includes(call.state) && (
          <button className="inline-flex items-center gap-1 text-xs text-blue-text hover:underline" onClick={() => setTrusting('only')}>
            <ShieldCheck size={12} /> Trust this command…
          </button>
        )}
        {trusting && (
          <TrustDialog
            call={call}
            onClose={() => setTrusting(null)}
            onTrusted={(rule) => {
              const also = trusting === 'approve' && rule.status === 'active';
              setTrusting(null);
              if (also) decide.mutate('approve');
            }}
          />
        )}

        {call.resultJson && (
          <CommandBlock
            className={clsx(
              'max-h-80 overflow-y-auto',
              (failed || blocked || denied) && 'border-red/30 text-red-200',
            )}
          >
            {stripAnsi(call.resultJson.text)}
          </CommandBlock>
        )}
      </div>
    </div>
  );
}

function StateChip({ call }: { call: ToolCall }) {
  const map: Partial<Record<ToolCall['state'], { label: string; className: string; icon: React.ReactNode }>> = {
    awaiting_approval: { label: 'needs approval', className: 'text-amber', icon: <AlertTriangle size={12} /> },
    executing: { label: 'running', className: 'text-blue-text', icon: <Spinner className="!h-3 !w-3" /> },
    succeeded: { label: 'done', className: 'text-green', icon: <Check size={12} /> },
    failed: { label: 'failed', className: 'text-red', icon: <X size={12} /> },
    blocked: { label: 'blocked', className: 'text-red', icon: <Ban size={12} /> },
    denied: { label: 'rejected', className: 'text-red', icon: <X size={12} /> },
    unknown_outcome: { label: 'outcome unknown', className: 'text-amber', icon: <AlertTriangle size={12} /> },
  };
  const s = map[call.state];
  if (!s) return <span className="text-[11px] text-muted">{call.state}</span>;
  return (
    <span className={clsx('inline-flex items-center gap-1 text-[11px] font-medium', s.className)}>
      {s.icon} {s.label}
    </span>
  );
}

const Fact = ({ k, v }: { k: string; v: string }) => (
  <div>
    <dt className="text-muted">{k}</dt>
    <dd className="tabular mt-0.5 font-medium text-ink">{v}</dd>
  </div>
);
