import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { messageText, stripAnsi } from '@supops/shared';
import { Bot, Check, RotateCcw, Send, Server, ShieldCheck, User, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { useRunStream } from '../lib/useRunStream';
import { cleanTask, OUTCOME_LABEL, TIER_STYLE, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { Markdown } from '../components/Markdown';
import { TrustDialog, TrustedChip, canTrust } from '../components/TrustDialog';
import { Terminal, type TerminalLine } from '../components/Terminal';
import { CommandBlock, Empty, RiskBadge, Spinner, StatusPill } from '../components/ui';
import type { Agent, Run, RunDetail, Target, ToolCall } from '../lib/types';
import { AttachmentStrip, UserContent } from '../components/Attachments';
import { FeedbackBar } from '../components/FeedbackBar';
import { useImageAttachments } from '../lib/images';
import { useDictation } from '../lib/useDictation';
import { MicButton } from '../components/MicButton';
import { PLAN_TOOL, PlanLine } from '../components/RunPlan';

const SESSION_KEY = 'supops.consoleRun';
const BUSY = ['queued', 'running', 'awaiting_approval'];
/** A finished turn: the session is terminal but a follow-up revives it. */
const RESUMABLE = ['succeeded', 'awaiting_input'];
/** Over for good: the next message opens a fresh session instead of continuing. */
const ENDED = ['failed', 'cancelled', 'expired', 'halted'];

export function Console() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const [runId, setRunId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const [input, setInput] = useState('');
  /**
   * Targets are frozen into the run's snapshot when the session starts, which is
   * what makes the audit record mean anything -- so this only applies to the first
   * message, and the picker is replaced by a read-only scope line afterwards.
   */
  const [scope, setScope] = useState<string[]>([]);
  const [tab, setTab] = useState<'chat' | 'terminal'>('chat');
  const [error, setError] = useState<string | null>(null);

  /**
   * Live output, keyed by tool call. Kept in a ref rather than state: chunks arrive
   * many times a second and re-rendering the whole page per chunk would drop frames.
   * A counter nudges React once per batch instead.
   */
  const liveOutput = useRef(new Map<string, string>());
  const [, bump] = useState(0);

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

  // Machines reached via a jump are hidden from the picker (same as Investigate):
  // you pick the jump ("prod") and the session includes the machines behind it, so
  // the agent confirms which one to reach with confirm_target. Each VM is still its
  // own target for scope and audit.
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
  const primaries = allTargets.filter((t) => !isVia(t));
  const childrenOf = (t: Target) => childrenByHost.get(hostOf(t)) ?? [];

  const detail = useQuery({
    queryKey: ['run', runId],
    queryFn: () => api<RunDetail>(`/runs/${runId}`),
    enabled: !!runId,
  });

  const run = detail.data?.run;
  const busy = !!run && BUSY.includes(run.status);
  const seedSeq = detail.data?.events.at(-1)?.seq ?? -1;

  const { events } = useRunStream(runId ?? undefined, seedSeq, (c) => {
    liveOutput.current.set(c.toolCallId, (liveOutput.current.get(c.toolCallId) ?? '') + c.chunk);
    bump((n) => n + 1);
  });

  // Any semantic event means the durable state moved; refetch rather than mirroring
  // the engine's state machine in the browser.
  useEffect(() => {
    if (events.length) void qc.invalidateQueries({ queryKey: ['run', runId] });
  }, [events.length, runId, qc]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['run', runId] }), 2500);
    return () => clearInterval(t);
  }, [busy, runId, qc]);

  useEffect(() => {
    try {
      if (runId) localStorage.setItem(SESSION_KEY, runId);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }, [runId]);

  const consoleAgent = agents.data?.find((a) => a.slug === 'console') ?? agents.data?.[0];

  const att = useImageAttachments();
  const dictation = useDictation(input, setInput);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Grow with the text: reset to one line, then fit the content (capped by max-h).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);
  const send = useMutation({
    mutationFn: async (raw: string) => {
      const text = raw || 'Look at the attached screenshot(s).';
      const images = att.images.length ? { images: att.payload() } : {};
      // Only a parked session can be continued. A session that failed or was closed
      // is over, so the next message quietly starts a fresh one rather than 409ing.
      if (runId && run?.interactive && RESUMABLE.includes(run.status)) {
        await post(`/runs/${runId}/message`, { message: text, ...images });
        return runId;
      }
      // Expand each selected jump to include the machines behind it, so the agent
      // can reach whichever node the request points to via confirm_target.
      const ids = new Set(scope);
      for (const id of scope) {
        const t = allTargets.find((x) => x.id === id);
        if (t) for (const c of childrenOf(t)) ids.add(c.id);
      }
      const created = await post<Run>('/runs', {
        projectId,
        agentId: consoleAgent!.id,
        task: text,
        interactive: true,
        ...(ids.size ? { targetIds: [...ids] } : {}),
        ...images,
      });
      return created.id;
    },
    onSuccess: (id) => {
      if (id !== runId) liveOutput.current.clear();
      setRunId(id);
      setInput('');
      att.clear();
      setError(null);
      void qc.invalidateQueries({ queryKey: ['run', id] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not send that'),
  });

  // Completed output lives on the tool call; in-flight output comes off the socket.
  const terminalLines = useMemo<TerminalLine[]>(() => {
    const out: TerminalLine[] = [];
    for (const c of detail.data?.toolCalls ?? []) {
      if (c.toolKey === 'record_finding' || c.toolKey === PLAN_TOOL) continue;
      out.push({
        kind: 'command',
        text: c.renderedCommand ?? c.toolKey,
        target: typeof c.argsJson.target === 'string' ? c.argsJson.target : null,
      });
      const finished = c.resultJson?.text;
      const streaming = liveOutput.current.get(c.toolCallId);
      const body = stripAnsi(finished ?? streaming ?? '');
      if (body) for (const line of body.split('\n')) out.push({ kind: 'output', text: line });
      else if (c.state === 'awaiting_approval') out.push({ kind: 'note', text: 'waiting for approval…' });
      else if (c.state === 'executing') out.push({ kind: 'note', text: 'running…' });
    }
    return out;
  }, [detail.data, liveOutput.current.size, events.length]);

  function newSession() {
    liveOutput.current.clear();
    setRunId(null);
    setInput('');
    setError(null);
    setScope([]);
  }

  const noAgent = agents.data && !consoleAgent;

  return (
    /* The page owns the viewport: each pane scrolls on its own, so a long command
       dump in the terminal never drags the chat composer off-screen. */
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader
        title="Console"
        subtitle="Ask a question or get something done — you'll see every command run live on the right"
        action={
          runId && (
            <button className="btn-ghost" onClick={newSession}>
              <RotateCcw size={15} /> New session
            </button>
          )
        }
      />

      <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-6 lg:grid-cols-2 lg:grid-rows-1">
        {/* tabs on narrow screens; side by side from lg */}
        <div className="flex gap-2 lg:col-span-2 lg:hidden">
          {(['chat', 'terminal'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={clsx(
                'flex-1 rounded-inner px-3 py-2 text-sm capitalize transition-colors',
                tab === t ? 'bg-blue text-white' : 'border border-edge bg-tile-2 text-muted',
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {/* ---------------- chat ---------------- */}
        <section className={clsx('tile flex min-h-0 flex-col overflow-hidden', tab !== 'chat' && 'hidden lg:flex')}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {!runId && (
              <Empty
                title="Nothing running"
                hint={
                  noAgent
                    ? 'This project has no Console agent. Create the project again or add one under Agents.'
                    : 'Ask a question, request a check, or describe something to create. Read-only work runs immediately; anything riskier asks first.'
                }
              />
            )}

            {detail.data?.steps.map((step) => {
              const m = step.messageJson;
              if (m.role === 'system') return null;
              if (m.role === 'tool') return null;

              if (m.role === 'user') {
                return (
                  <Bubble key={step.id} icon={<User size={13} />} tint="text-cyan" label="You">
                    <UserContent runId={runId ?? ''} content={m.content} clean={cleanTask} />
                  </Bubble>
                );
              }

              return (
                <div key={step.id} className="space-y-2">
                  {m.content && (
                    <Bubble icon={<Bot size={13} />} tint="text-violet" label="Assistant" meta={<ModelTag model={step.model} main={run?.model} />}>
                      <Markdown rateCommands={!!run?.policySnapshot?.advisory}>{messageText(m.content)}</Markdown>
                      {!m.tool_calls?.length && runId && projectId && !busy && (
                        <FeedbackBar runId={runId} stepId={step.id} text={messageText(m.content)} projectId={projectId} />
                      )}
                    </Bubble>
                  )}
                  {m.tool_calls?.map((tc) => {
                    const call = detail.data?.toolCalls.find((c) => c.toolCallId === tc.id);
                    if (!call) return null;
                    return call.toolKey === PLAN_TOOL && call.state === 'succeeded' ? <PlanLine key={tc.id} call={call} /> : <ActionCard key={tc.id} call={call} />;
                  })}
                </div>
              );
            })}

            {busy && (
              <div className="flex items-center gap-2 px-1 text-sm text-muted">
                <Spinner className="text-blue" />
                {run?.status === 'awaiting_approval' ? 'Waiting for your decision…' : 'Working…'}
              </div>
            )}

            {run && RESUMABLE.includes(run.status) && (
              <p className="px-1 text-[11px] text-muted">
                Turn complete — ask a follow-up, or start a new session to change scope.
              </p>
            )}

            {run && ENDED.includes(run.status) && (
              <p className="rounded-inner border border-hairline bg-tile-2/50 px-3 py-2 text-[11px] text-muted">
                {run.status === 'failed'
                  ? `This session ended — ${run.statusReason ?? 'the turn failed'}`
                  : 'This session has ended.'}{' '}
                Your next message starts a new one.
              </p>
            )}
          </div>

          {error && <p className="px-4 pb-2 text-sm text-red">{error}</p>}

          <div className="border-t border-hairline p-3 pb-2">
            <ScopePicker
              targets={primaries}
              selected={scope}
              onChange={setScope}
              locked={!!runId}
              lockedTo={run?.targets ?? []}
              advisory={!!run?.policySnapshot?.advisory}
            />
            {/* The original Console input, unchanged in size. Screenshots attach by
                paste or drop; their thumbnails appear above it only once there are some. */}
            <div className="mb-2 empty:hidden"><AttachmentStrip att={att} /></div>
            <div {...att.dropProps} className={clsx('flex gap-2 rounded-inner', att.dragging && 'ring-2 ring-blue/60')}>
              {/* The mic sits inside the box, as in Investigate and run follow-ups. The box
                  grows with its text (up to max-h) rather than having a resize grip,
                  which the mic would otherwise cover. */}
              <div className="relative min-w-0 flex-1">
              <textarea
                ref={inputRef}
                className="input block max-h-40 min-h-[44px] resize-none py-2.5 pr-12"
                rows={1}
                placeholder={
                  att.dragging
                    ? 'Drop to attach'
                    : dictation.listening
                      ? 'Listening…'
                      : runId
                        ? 'Follow up…'
                        : targets.data?.length
                          ? 'e.g. how many pods are not Running on k3master?'
                          : 'e.g. nginx returns 502 after a deploy. What should I check?'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={att.onPaste}
                onKeyDown={(e) => {
                  // Enter sends; Shift+Enter is a newline. Standard for a chat box.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if ((input.trim() || att.images.length) && !busy && !att.busy) {
                      dictation.cancel();
                      send.mutate(input.trim());
                    }
                  }
                }}
                disabled={!consoleAgent}
              />
              <span className="absolute bottom-[3px] right-1"><MicButton dictation={dictation} disabled={!consoleAgent} className="!h-[38px] !w-[38px]" /></span>
              </div>
              <button
                className="btn-primary shrink-0 self-end"
                disabled={(!input.trim() && !att.images.length) || busy || send.isPending || att.busy || !consoleAgent}
                onClick={() => {
                  dictation.cancel();
                  send.mutate(input.trim());
                }}
              >
                {send.isPending ? <Spinner /> : <Send size={15} />}
              </button>
            </div>
            <input
              ref={att.inputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void att.addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {dictation.error && <p className="mt-1.5 px-1 text-[11px] text-amber">{dictation.error}</p>}
            <p className="mt-1.5 px-1 text-[11px] text-muted">
              {targets.data?.length ? (
                <>
                  Enter to send · Shift+Enter for a new line · paste, drop or{' '}
                  <button type="button" className="text-blue-text hover:underline" onClick={() => att.inputRef.current?.click()}>
                    attach
                  </button>{' '}
                  screenshots
                </>
              ) : (
                'Advisory: no systems are connected, so nothing runs. You get the checks and fixes to run yourself — paste the output back here.'
              )}
            </p>
          </div>
        </section>

        {/* ---------------- terminal ---------------- */}
        <section className={clsx('tile flex min-h-0 flex-col overflow-hidden', tab !== 'terminal' && 'hidden lg:flex')}>
          <header className="flex items-center gap-2 border-b border-hairline px-4 py-2.5">
            <span className="flex gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-green/70" />
            </span>
            <span className="ml-1 font-mono text-[11px] text-muted">
              {run?.targets?.join(', ') || 'terminal'}
            </span>
            {run && <span className="ml-auto"><StatusPill status={run.status} /></span>}
          </header>
          <Terminal lines={terminalLines} live={busy} className="flex-1" />
        </section>
      </div>
    </div>
  );
}

function Bubble({
  icon, tint, label, meta, children,
}: { icon: React.ReactNode; tint: string; label: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-inner border border-hairline bg-tile-2/50 p-3">
      <div className={clsx('mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider', tint)}>
        {icon} {label}
        {meta}
      </div>
      {children}
    </div>
  );
}

/** One action, with an inline approve/reject when it is gated. */
function ActionCard({ call }: { call: ToolCall }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState('');
  const [trusting, setTrusting] = useState<null | 'approve' | 'only'>(null);
  const waiting = call.state === 'awaiting_approval';

  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'deny') =>
      post(`/runs/tool-calls/${call.id}/decision`, { decision, comment: comment || undefined }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['run', call.runId] });
      void qc.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const args = call.argsJson as { intent?: string };

  return (
    <div className={clsx('rounded-inner border p-3', waiting ? 'border-amber/50 bg-amber/5' : 'border-hairline bg-tile-2/40')}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-mono text-[11px] text-muted">{call.toolKey}</span>
        <RiskBadge tier={call.tier} />
        <TrustedChip call={call} />
        <span className={clsx('ml-auto text-[11px]', call.isError ? 'text-red' : 'text-muted')}>
          {OUTCOME_LABEL[call.state] ?? call.state}
        </span>
      </div>

      <CommandBlock className="!text-[11px]">{call.renderedCommand ?? call.toolKey}</CommandBlock>
      {args.intent && <p className="mt-2 text-[11px] text-muted">{args.intent}</p>}

      {waiting && (
        <div className="mt-3 space-y-2">
          <input
            className="input !py-2 text-xs"
            placeholder="Optional note — the agent reads this if you reject"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
          />
          <div className="flex gap-2">
            <button className="btn-primary !min-h-[36px] !text-xs" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
              <Check size={14} /> Approve
            </button>
            <button className="btn-danger !min-h-[36px] !text-xs" disabled={decide.isPending} onClick={() => decide.mutate('deny')}>
              <X size={14} /> Reject
            </button>
            {canTrust(call) && (
              <button className="btn-ghost !min-h-[36px] !text-xs" disabled={decide.isPending} onClick={() => setTrusting('approve')} title="Approve now, and let this command run without asking next time">
                <ShieldCheck size={14} /> Approve &amp; trust…
              </button>
            )}
          </div>
          {decide.error && (
            <p role="alert" className="rounded-inner border border-red/30 bg-red/10 px-2.5 py-1.5 text-[11px] text-red">
              {(decide.error as Error).message}
            </p>
          )}
          <p className="text-[10px] text-muted">
            Also queued under Approvals — deciding in either place resolves it.
          </p>
        </div>
      )}

      {call.decisionComment && <p className="mt-2 text-[11px] text-muted">Note: “{call.decisionComment}”</p>}
      {!waiting && canTrust(call) && ['approved', 'executing', 'succeeded', 'failed'].includes(call.state) && (
        <button className="mt-2 inline-flex items-center gap-1 text-[11px] text-blue-text hover:underline" onClick={() => setTrusting('only')}>
          <ShieldCheck size={11} /> Trust this command…
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
    </div>
  );
}

/**
 * Target selection for a new session. Scope is part of the run's frozen snapshot,
 * so once the session has started this becomes a read-only statement of what the
 * agent can reach rather than a control that would lie about being changeable.
 */
function ScopePicker({
  targets, selected, onChange, locked, lockedTo, advisory,
}: {
  targets: Target[];
  selected: string[];
  onChange: (next: string[]) => void;
  locked: boolean;
  lockedTo: string[];
  /** An advisory session reaches nothing, so it has no scope to show. */
  advisory: boolean;
}) {
  if (locked && advisory) return null;
  if (locked) {
    return (
      <p className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-muted">
        <Server size={12} className="shrink-0" />
        <span className="truncate">
          Scope: {lockedTo.length ? lockedTo.join(', ') : 'all targets'} · fixed for this session
        </span>
      </p>
    );
  }
  if (!targets.length) return null;

  const all = selected.length === 0;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <span className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Scope
      </span>
      <button
        type="button"
        onClick={() => onChange([])}
        className={clsx(
          'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
          all ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
        )}
      >
        All targets
      </button>
      {targets.map((t) => {
        const on = selected.includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => toggle(t.id)}
            className={clsx(
              'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
              on ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
            )}
          >
            {t.slug}
          </button>
        );
      })}
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
