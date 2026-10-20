import type { ChatMessage } from '@supops/shared';
import type { RiskAssessment, RiskTier, RunStatus } from '@supops/shared';
import type { TargetSummary, ToolOutput } from '@supops/db';

export interface ReportRun {
  id: string;
  title: string;
  status: RunStatus;
  statusReason: string | null;
  model: string;
  iteration: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: Date;
  endedAt: Date | null;
  targetsSnapshot: TargetSummary[];
}

export interface ReportToolCall {
  toolKey: string;
  callIndex: number;
  renderedCommand: string | null;
  argsJson: Record<string, unknown>;
  tier: RiskTier | null;
  riskJson: RiskAssessment | null;
  state: string;
  resultJson: ToolOutput | null;
  isError: boolean;
  decidedBy: string | null;
  decisionComment: string | null;
  decidedAt?: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface ReportInput {
  run: ReportRun;
  steps: Array<{ seq: number; messageJson: ChatMessage }>;
  toolCalls: ReportToolCall[];
  projectName: string;
  agentName: string;
  approverNames: Record<string, string>;
  /** `health` produces a thorough per-target report; `incident` a concise RCA. */
  kind?: 'health' | 'incident';
}

export interface RecordedFinding {
  severity: string;
  target: string;
  finding: string;
}

/** The agent's recorded conclusions, in severity order (critical first). */
export function recordedFindings(toolCalls: ReportToolCall[]): RecordedFinding[] {
  const rank: Record<string, number> = { critical: 0, warning: 1, notice: 2, info: 3 };
  return toolCalls
    .filter((c) => c.toolKey === 'record_finding')
    .map((c) => ({
      severity: typeof c.argsJson.severity === 'string' ? c.argsJson.severity : 'info',
      target: typeof c.argsJson.target === 'string' ? c.argsJson.target : '—',
      finding: typeof c.argsJson.finding === 'string' ? c.argsJson.finding.trim() : '',
    }))
    .filter((f) => f.finding)
    .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

/**
 * The commands whose output is worth reproducing verbatim -- the balance between the
 * old "dump everything" and the newer "AI summary only". For a health sweep that is
 * the essential read commands (capped); for an incident, the state-changing, errored
 * or human-decided actions, falling back to the executed reads if there were none.
 */
export function essentialEvidence(input: ReportInput): ReportToolCall[] {
  const executed = input.toolCalls.filter(
    (c) => c.toolKey !== 'record_finding' && c.toolKey !== 'update_plan' && c.resultJson && (c.state === 'succeeded' || c.state === 'failed'),
  );
  if (input.kind === 'health') return executed.slice(0, 16);
  const notable = executed.filter((c) => (c.tier && c.tier !== 'read_only') || c.isError || c.decidedBy);
  return (notable.length ? notable : executed).slice(0, 12);
}

/**
 * Build an incident document from a run.
 *
 * Assembled from the execution record -- the `tool_calls` rows -- rather than from
 * the agent's closing narrative. That ordering is deliberate: a model will describe
 * an action it proposed but never performed, or report success it did not observe,
 * and a document that launders that into a post-incident record is worse than no
 * document. The agent's summary is included, clearly labelled as its account, and
 * the table beneath it is what actually happened.
 */
export function buildRcaMarkdown(input: ReportInput): string {
  const { run, toolCalls, projectName, agentName } = input;
  const out: string[] = [];

  const executed = toolCalls.filter((c) => c.state === 'succeeded' || c.state === 'failed');
  const changed = executed.filter((c) => c.tier && c.tier !== 'read_only');
  const denied = toolCalls.filter((c) => c.state === 'denied' || c.state === 'expired');
  const blocked = toolCalls.filter((c) => c.state === 'blocked');
  const approved = toolCalls.filter((c) => c.decidedBy || c.decisionComment);

  out.push(`# Incident report: ${run.title}`, '');

  out.push('| | |', '|---|---|');
  out.push(`| **Status** | ${statusLabel(run.status)}${run.statusReason ? ` — ${run.statusReason}` : ''} |`);
  out.push(`| **Started** | ${run.startedAt.toISOString()} |`);
  if (run.endedAt) {
    out.push(`| **Ended** | ${run.endedAt.toISOString()} |`);
    out.push(`| **Duration** | ${humanDuration(run.endedAt.getTime() - run.startedAt.getTime())} |`);
  }
  out.push(`| **Project** | ${projectName} |`);
  out.push(`| **Agent** | ${agentName} (${run.model}) |`);
  out.push(`| **Targets in scope** | ${run.targetsSnapshot.map((t) => `\`${t.slug}\` (${t.kind}, ${t.env})`).join(', ') || 'none'} |`);
  out.push(`| **Actions executed** | ${executed.length} (${changed.length} state-changing) |`);
  if (denied.length) out.push(`| **Actions refused** | ${denied.length} |`);
  if (blocked.length) out.push(`| **Actions blocked by policy** | ${blocked.length} |`);
  out.push('');

  // --- the agent's own account -------------------------------------------
  const summary = finalAssistantMessage(input.steps);
  out.push('## Summary', '');
  if (summary) {
    out.push('> The agent\'s own account. Verify it against the execution record below.', '');
    out.push(summary.trim(), '');
  } else {
    out.push('_The agent did not produce a closing summary._', '');
  }

  // --- what actually happened --------------------------------------------
  out.push('## What was done', '');
  if (toolCalls.length === 0) {
    out.push('_No actions were attempted._', '');
  } else {
    out.push('| # | Action | Target | Risk | Outcome | Approved by |');
    out.push('|---|---|---|---|---|---|');
    toolCalls.forEach((c, i) => {
      const target = typeof c.argsJson.target === 'string' ? c.argsJson.target : '—';
      const approver = c.decidedBy ? (input.approverNames[c.decidedBy] ?? c.decidedBy) : autoLabel(c);
      out.push(
        `| ${i + 1} | \`${inlineCode(c.renderedCommand ?? c.toolKey, 90)}\` | \`${target}\` | ` +
          `${c.tier ?? '—'} | ${outcomeLabel(c)} | ${approver} |`,
      );
    });
    out.push('');
  }

  // --- evidence -----------------------------------------------------------
  out.push('## Evidence', '');
  if (toolCalls.length === 0) {
    out.push('_No commands were run._', '');
  }
  toolCalls.forEach((c, i) => {
    out.push(`### ${i + 1}. ${c.toolKey} — ${outcomeLabel(c)}`, '');
    out.push('```sh');
    out.push(c.renderedCommand ?? JSON.stringify(c.argsJson));
    out.push('```', '');

    const intent = typeof c.argsJson.intent === 'string' ? c.argsJson.intent : null;
    const effect = typeof c.argsJson.expected_effect === 'string' ? c.argsJson.expected_effect : null;
    if (intent) out.push(`**Intent (stated by the agent):** ${intent}`, '');
    if (effect) out.push(`**Expected effect:** ${effect}`, '');

    if (c.tier && c.tier !== 'read_only' && c.riskJson) {
      const reasons = c.riskJson.contributions.filter((x) => x.tier !== 'read_only');
      if (reasons.length) {
        out.push(`**Assessed ${c.tier} because:**`, '');
        for (const r of reasons) out.push(`- ${r.reason}${r.ruleId ? ` _(${r.ruleId})_` : ''}`);
        out.push('');
      }
    }

    if (c.decisionComment) out.push(`**Reviewer note:** ${c.decisionComment}`, '');
    if (c.startedAt && c.finishedAt) {
      out.push(`**Ran at:** ${c.startedAt.toISOString()} (${humanDuration(c.finishedAt.getTime() - c.startedAt.getTime())})`, '');
    }

    if (c.resultJson) {
      out.push('**Output:**', '');
      out.push('```');
      out.push(c.resultJson.text.trimEnd());
      out.push('```', '');
    }
  });

  // --- human decisions ----------------------------------------------------
  if (approved.length) {
    out.push('## Human decisions', '');
    for (const c of approved) {
      const who = c.decidedBy ? (input.approverNames[c.decidedBy] ?? c.decidedBy) : 'unknown';
      const verdict = c.state === 'denied' ? 'rejected' : 'approved';
      out.push(`- **${verdict}** by ${who}: \`${inlineCode(c.renderedCommand ?? c.toolKey)}\`${c.decisionComment ? ` — "${c.decisionComment}"` : ''}`);
    }
    out.push('');
  }

  // --- honest caveats -----------------------------------------------------
  out.push('## Caveats', '');
  if (changed.length === 0) {
    out.push('- This run made no state-changing actions; it was diagnostic only.');
  }
  if (denied.length) {
    out.push(`- ${denied.length} proposed action(s) were refused and did not run.`);
  }
  if (blocked.length) {
    out.push(`- ${blocked.length} proposed action(s) were blocked by policy and did not run.`);
  }
  if (toolCalls.some((c) => c.state === 'unknown_outcome')) {
    out.push(
      '- One or more commands have an **unknown outcome**: the worker stopped after dispatching ' +
        'them but before recording a result. They may or may not have taken effect.',
    );
  }
  out.push(
    '- Command results above are raw output captured at the time. Nothing in this document ' +
      're-verifies the system\'s current state.',
  );
  out.push('');

  out.push('---', '');
  out.push(
    `_Generated by SupOps from run \`${run.id}\` on ${new Date().toISOString()}. ` +
      'The "What was done" table is taken from the execution record, not from the agent\'s narrative._',
  );

  return out.join('\n');
}

/**
 * A compact, factual digest of a run for the report-writing model. Deliberately not
 * the full transcript: read-only probe output is truncated hard, because the model's
 * job is to select what matters, not to be handed everything.
 */
export function buildRunDigest(input: ReportInput): string {
  const { run, toolCalls, projectName, agentName } = input;
  const out: string[] = [];
  out.push(`OPERATOR REQUEST (verbatim; may contain typos): ${run.title}`);
  out.push(`Run kind: ${input.kind === 'health' ? 'health check' : 'investigation / console'}`);
  out.push(`Project: ${projectName}  Agent: ${agentName} (${run.model})`);
  out.push(`Status: ${statusLabel(run.status)}${run.statusReason ? ` — ${run.statusReason}` : ''}`);
  if (run.endedAt) out.push(`Duration: ${humanDuration(run.endedAt.getTime() - run.startedAt.getTime())}`);
  out.push(`Targets: ${run.targetsSnapshot.map((t) => `${t.slug} (${t.kind},${t.env})`).join(', ') || 'none'}`);
  out.push('');
  out.push('ACTIONS (in order, from the execution record):');
  if (!toolCalls.length) out.push('(none)');
  toolCalls.forEach((c, i) => {
    const target = typeof c.argsJson.target === 'string' ? c.argsJson.target : '-';
    const intent = typeof c.argsJson.intent === 'string' ? ` intent="${c.argsJson.intent}"` : '';
    const shown = (c.renderedCommand ?? c.toolKey).replace(/sudo -S -p '\[\[SUPOPS-SUDO:[^\]]*\]\]'/g, 'sudo');
    out.push(`#${i + 1} [${c.toolKey}] [${c.tier ?? '-'}/${outcomeLabel(c)}] on ${target}: ${shown}${intent}`);
    if (c.decisionComment) out.push(`   reviewer: "${c.decisionComment}"`);
    if (c.resultJson?.text) {
      const body = c.resultJson.text.trim().replace(/\n{2,}/g, '\n');
      // A health sweep is judged on its numbers, so give the writer more of each output.
      const cap = input.kind === 'health' ? 1500 : 900;
      out.push(`   output: ${body.length > cap ? `${body.slice(0, cap)}… [truncated]` : body}`.replace(/\n/g, '\n   '));
    }
  });
  const findings = recordedFindings(toolCalls);
  if (findings.length) {
    out.push('', 'RECORDED FINDINGS:');
    for (const f of findings) out.push(`- [${f.severity}] ${f.target}: ${f.finding.replace(/\s*\n+\s*/g, ' ')}`);
  }
  const approvals = toolCalls.filter((c) => c.decidedBy);
  if (approvals.length) {
    out.push('', 'HUMAN DECISIONS:');
    toolCalls.forEach((c, i) => {
      if (!c.decidedBy) return;
      const who = input.approverNames[c.decidedBy] ?? 'unknown';
      out.push(`- #${i + 1} ${c.state === 'denied' || c.state === 'expired' ? 'rejected' : 'approved'} by ${who}${c.decisionComment ? `: "${c.decisionComment}"` : ''}`);
    });
  }
  // Every assistant message, not just the last: tables and interim conclusions the
  // agent wrote along the way are part of the record.
  const notes = input.steps
    .map((s) => s.messageJson)
    .filter((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())
    .map((m) => (m.content as string).trim());
  if (notes.length) {
    const joined = notes.slice(-4).join('\n---\n');
    out.push('', "AGENT'S NOTES (its own words, last few; verify against the record above):",
      joined.length > 6000 ? `${joined.slice(-6000)}` : joined);
  }
  return out.join('\n');
}

const INCIDENT_REPORT_PROMPT = `You write a concise incident / RCA report from an automated ops run, for sharing with a team (an on-call lead, a manager). You are given a factual digest of what the agent actually did.

Write clean GitHub-flavoured Markdown with these sections, and ONLY what each needs:
- **Summary** — 2-4 sentences: what was investigated, what was found, and the current state.
- **What happened** — the meaningful steps only, in order. Skip routine probing and dead ends; collapse repetitive checks into one line. Keep the essential numbers that establish the finding (e.g. "disk 92% on /data", a failing unit's name).
- **Root cause** — the cause if the record establishes one; say plainly if it is unconfirmed.
- **Actions taken** — only the state-changing or decision-worthy actions (not every read).
- **Current status & risk** — is it resolved, mitigated, or still open? Anything a human must still watch.
- **Recommendations** — concrete next steps, if any.

Rules: use ONLY facts present in the digest — never invent hostnames, numbers, or outcomes. If the run was inconclusive or failed, say so directly. Prefer short paragraphs and tight bullet lists. A factual action table and command evidence are appended to the document separately, so do not paste the full raw log — but do keep the specific values that matter. No preamble, no sign-off — start at the first heading.`;

const HEALTH_REPORT_PROMPT = `You write a DETAILED health-check report from an automated, read-only sweep of one or more targets, for an ops team. You are given a factual digest of every command the agent ran and every finding it recorded. This is a health report: be thorough and concrete — more detailed than a normal incident summary, and lead with real numbers, not adjectives.

Write clean GitHub-flavoured Markdown:
- **Summary** — 2-4 sentences: how many targets were checked, how many are healthy vs degraded vs unreachable, and the headline concerns.
- **Per target** — a \`###\` subsection for EACH target checked. State reachability first, then the essentials with their observed values: disk (worst mount and %), memory, CPU / load average vs cores, failed services (name them), and — where kubectl was used — namespace count and pod health (name unhealthy pods and their status). Use a small Markdown table of metric → value where it makes the numbers scannable. Say explicitly what is healthy, and flag what is not.
- **Findings** — every recorded finding, grouped by severity: critical first, then warning, then info. Give the target and the evidence for each.
- **Recommendations** — concrete next steps for the degraded/critical items, or state clearly that nothing needs action.

Rules: use ONLY facts present in the digest — never invent numbers, hostnames, pods or services. Prefer exact values ("disk 92% on /data", "load 9.5 across 2 cores") over vague wording. A service being stopped or a unit "failed" is only a problem if the digest's findings treat it as one — do not escalate on your own. Keep it well-structured with headings and tables. No preamble, no sign-off — start at the first heading.`;

/** System prompt for the report writer. Detailed for health sweeps, concise for incidents. */
export function reportSystemPrompt(kind: 'health' | 'incident' = 'incident'): string {
  return kind === 'health' ? HEALTH_REPORT_PROMPT : INCIDENT_REPORT_PROMPT;
}

/** @deprecated use reportSystemPrompt(kind). Kept as the incident default. */
export const REPORT_SYSTEM_PROMPT = INCIDENT_REPORT_PROMPT;

/**
 * Assemble the share-ready document: a small metadata block, the model's written
 * report body, then a compact factual actions table (the execution record, so the
 * narrative can always be checked against what really ran). Falls back to the full
 * mechanical document when no model body is available.
 */
export function buildShareableMarkdown(input: ReportInput, aiBody: string | null): string {
  if (!aiBody || !aiBody.trim()) return buildRcaMarkdown(input);
  const { run, toolCalls, projectName, agentName } = input;
  const executed = toolCalls.filter((c) => c.state === 'succeeded' || c.state === 'failed');
  const changed = executed.filter((c) => c.tier && c.tier !== 'read_only');
  const out: string[] = [];

  out.push(`# ${run.title}`, '');
  out.push(
    `**${statusLabel(run.status)}**` +
      (run.endedAt ? ` · ${humanDuration(run.endedAt.getTime() - run.startedAt.getTime())}` : '') +
      ` · ${projectName} · ${agentName}` +
      ` · ${run.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
  );

  out.push(aiBody.trim(), '');

  // Findings: the agent's recorded conclusions, verbatim -- the heart of a health
  // report and useful provenance on any run.
  const findings = recordedFindings(toolCalls);
  if (findings.length) {
    out.push('---', '', '## Findings', '');
    for (const f of findings) {
      out.push(`- **${f.severity}** \`${f.target}\` — ${f.finding.replace(/\s*\n+\s*/g, ' ')}`);
    }
    out.push('');
  }

  // Provenance: the commands that ran. Prefer the notable (state-changing/errored/
  // decided) ones; if there were none (a read-only sweep), show what was executed so
  // the record is not empty.
  const notable = toolCalls.filter((c) => (c.tier && c.tier !== 'read_only') || c.isError || c.decidedBy);
  const ran = toolCalls.filter(
    (c) => c.toolKey !== 'record_finding' && c.toolKey !== 'update_plan' && (c.state === 'succeeded' || c.state === 'failed'),
  );
  const record = (notable.length ? notable : ran).slice(0, 30);
  if (record.length) {
    out.push('---', '', `## ${notable.length ? 'Action record' : 'Commands run'}`, '');
    out.push('| # | Command | Target | Risk | Outcome | Approved by |');
    out.push('|---|---|---|---|---|---|');
    record.forEach((c, i) => {
      const target = typeof c.argsJson.target === 'string' ? c.argsJson.target : '—';
      const approver = c.decidedBy ? (input.approverNames[c.decidedBy] ?? c.decidedBy) : autoLabel(c);
      out.push(`| ${i + 1} | \`${inlineCode(c.renderedCommand ?? c.toolKey, 80)}\` | \`${target}\` | ${c.tier ?? '—'} | ${outcomeLabel(c)} | ${approver} |`);
    });
    out.push('');
  }

  // Essential evidence: the actual output of the commands that matter, capped so the
  // document stays a report rather than a transcript dump.
  const evidence = essentialEvidence(input);
  if (evidence.length) {
    out.push('---', '', '## Evidence', '');
    evidence.forEach((c) => {
      const target = typeof c.argsJson.target === 'string' ? ` on \`${c.argsJson.target}\`` : '';
      out.push(`### ${c.toolKey} — ${outcomeLabel(c)}${target}`, '');
      out.push('```sh', c.renderedCommand ?? c.toolKey, '```', '');
      if (c.resultJson?.text) {
        const body = c.resultJson.text.trimEnd();
        out.push('```', body.length > 2000 ? `${body.slice(0, 2000)}\n… [truncated]` : body, '```', '');
      }
    });
  }

  out.push('---', '');
  out.push(
    `_Written by SupOps from run \`${run.id}\` on ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ` +
      `${executed.length} action(s) ran (${changed.length} state-changing). The narrative is generated from ` +
      `the run's execution record; the action table above is that record._`,
  );
  return out.join('\n');
}

function finalAssistantMessage(steps: ReportInput['steps']): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const m = steps[i]!.messageJson;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content;
    }
  }
  return null;
}

const STATUS_LABELS: Partial<Record<RunStatus, string>> = {
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled by an operator',
  awaiting_approval: 'Paused — awaiting approval',
  awaiting_input: 'Paused — awaiting input',
  suspended: 'Paused — provider backoff',
  halted: 'Halted by the kill switch',
  running: 'In progress',
  queued: 'Queued',
  expired: 'Expired',
};
const statusLabel = (s: RunStatus): string => STATUS_LABELS[s] ?? s;

function outcomeLabel(c: ReportToolCall): string {
  switch (c.state) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'denied': return 'rejected by a human';
    case 'expired': return 'approval expired';
    case 'blocked': return 'blocked by policy';
    case 'unknown_outcome': return '**outcome unknown**';
    case 'awaiting_approval': return 'still awaiting approval';
    default: return c.state;
  }
}

/** Distinguishes "a human said yes" from "policy allowed it without asking". */
function autoLabel(c: ReportToolCall): string {
  if (c.state === 'blocked') return 'n/a — blocked';
  return c.tier && c.tier !== 'read_only' && c.tier !== 'low' ? '—' : 'auto (within policy)';
}

/**
 * Make a command safe inside a Markdown table cell.
 *
 * Pipes would otherwise be read as column separators, backticks would close the code
 * span, and a long argument (a `record_finding` body, say) would make the table
 * unreadable. The untruncated command always appears in the Evidence section below.
 */
function inlineCode(s: string, maxLength?: number): string {
  const flat = s.replace(/\|/g, '\\|').replace(/`/g, "'").replace(/\s*\n+\s*/g, ' ').trim();
  if (!maxLength || flat.length <= maxLength) return flat;
  return `${flat.slice(0, maxLength - 1).trimEnd()}…`;
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Filesystem-safe name for the downloaded document. */
export function reportFilename(run: { title: string; startedAt: Date }): string {
  const slug = run.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'run';
  return `supops-${slug}-${run.startedAt.toISOString().slice(0, 10)}.md`;
}
