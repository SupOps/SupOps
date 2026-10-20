import { THREAT_LABEL, diagramKey, extractMermaidBlocks, repairMermaid, stripAnsi } from '@supops/shared';
import type { ChatMessage } from '@supops/shared';
import type { ReportInput, ReportToolCall } from './report.ts';
import { recordedFindings } from './report.ts';

/**
 * The report as structured data, not prose.
 *
 * The writer model fills this in from a factual digest of the run; the PDF and the
 * Markdown are both laid out from it. Structure is what makes a document scannable
 * -- a verdict you can see, metrics in tiles, a numbered chain from evidence to
 * conclusion -- where free-form Markdown rendered to PDF only ever looks like a
 * chat reply printed out.
 */

export const REPORT_TYPES = ['rca', 'health_check', 'verification', 'change', 'query', 'other'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_TYPE_LABEL: Record<ReportType, string> = {
  rca: 'Root cause analysis',
  health_check: 'Health check',
  verification: 'Verification',
  change: 'Change record',
  query: 'Investigation',
  other: 'Operations report',
};

export const OUTCOMES = [
  'resolved', 'mitigated', 'open', 'healthy', 'degraded', 'critical',
  'confirmed', 'not_confirmed', 'completed', 'failed', 'inconclusive',
] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export const OUTCOME_META: Record<Outcome, { label: string; tone: Tone }> = {
  resolved: { label: 'Resolved', tone: 'good' },
  mitigated: { label: 'Mitigated', tone: 'warn' },
  open: { label: 'Open', tone: 'bad' },
  healthy: { label: 'Healthy', tone: 'good' },
  degraded: { label: 'Degraded', tone: 'warn' },
  critical: { label: 'Critical', tone: 'bad' },
  confirmed: { label: 'Confirmed', tone: 'good' },
  not_confirmed: { label: 'Not confirmed', tone: 'bad' },
  completed: { label: 'Completed', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  inconclusive: { label: 'Inconclusive', tone: 'neutral' },
};

export type Status = 'ok' | 'warn' | 'crit' | 'info';

export interface ReportTable {
  title: string;
  columns: string[];
  rows: string[][];
  /** Where it came from, for the caption. */
  source: 'agent' | 'writer';
}

export interface ReportDoc {
  title: string;
  type: ReportType;
  outcome: Outcome;
  headline: string;
  summary: string[];
  metrics: Array<{ label: string; value: string; status: Status }>;
  rootCause: { statement: string; confidence: 'confirmed' | 'likely' | 'unconfirmed' } | null;
  /** What led to the conclusion: each step names the commands (#n) that established it. */
  chain: Array<{ finding: string; evidence: number[]; status: Status }>;
  actions: Array<{ action: string; result: string; evidence: number[] }>;
  targets: Array<{ target: string; status: 'ok' | 'warn' | 'crit' | 'unreachable'; note: string }>;
  tables: ReportTable[];
  recommendations: Array<{ priority: 'high' | 'medium' | 'low'; text: string }>;
  /** False when the model was unavailable and this was assembled mechanically. */
  written: boolean;
}

// --------------------------------------------------------------------------
// The writer prompt
// --------------------------------------------------------------------------

export const REPORT_DOC_PROMPT = `You are a senior SRE writing the definitive, share-ready report of an automated operations run. Your reader is an engineering lead who will not open anything else: they need the result, how it was established, and what to do next -- fast.

You receive a factual digest: the operator's request (it may contain typos), every command the agent ran (numbered #1, #2, ...) with its risk, outcome and output, recorded findings, tables the agent produced, human approvals, and the agent's closing note.

Return ONLY a JSON object (no prose, no code fences) with exactly these keys:
{
  "title": "Professional, specific title (max 90 chars). Rewrite the request: fix typos, name the system and the outcome, e.g. 'Disk pressure on logstore1 traced to unrotated nginx logs'. Not a question, no trailing period.",
  "type": "rca | health_check | verification | change | query | other",
  "outcome": "resolved | mitigated | open | healthy | degraded | critical | confirmed | not_confirmed | completed | failed | inconclusive",
  "headline": "One sentence: the single most important result, with the key number.",
  "summary": ["2-4 short bullets: what was checked, what was found, current state. Numbers over adjectives."],
  "metrics": [{"label": "Disk /data", "value": "92%", "status": "crit"}],
  "rootCause": {"statement": "The cause, in one or two sentences.", "confidence": "confirmed | likely | unconfirmed"},
  "chain": [{"finding": "What this step established, with its value.", "evidence": [3, 5], "status": "ok | warn | crit | info"}],
  "actions": [{"action": "What was changed", "result": "What happened / verified after", "evidence": [7]}],
  "targets": [{"target": "slug", "status": "ok | warn | crit | unreachable", "note": "One line with the key numbers."}],
  "tables": [{"title": "Short title", "columns": ["Col", "Col"], "rows": [["v", "v"]]}],
  "recommendations": [{"priority": "high | medium | low", "text": "Concrete next step."}]
}

How to choose "type":
- rca: something was wrong and the run looked for why.
- health_check: a sweep of the state of one or more targets.
- verification: confirming something is (or is not) as expected (a config, a version, a service, a fix).
- change: the run changed something (restart, deploy, edit, scale, cleanup).
- query: answering a question / gathering information.
- other: none of the above.
Pick "outcome" consistent with the type (rca: resolved/mitigated/open/inconclusive; health_check: healthy/degraded/critical; verification: confirmed/not_confirmed/inconclusive; change: completed/failed/mitigated; query: completed/inconclusive).

Rules:
- Use ONLY facts in the digest. Never invent hosts, numbers, pods, versions or outcomes. If the run failed or was inconclusive, say so plainly.
- Be brief. Results first. No filler, no restating the request, no generic advice.
- "chain" is the evidence trail from first observation to conclusion: 3-7 steps, each citing the command numbers (#n) whose output proves it. Skip dead ends and routine probing.
- "metrics": 3-6 of the values that matter most (usage %, counts, versions, latencies, restart counts). Omit if there are none.
- "rootCause": null unless type is rca (or a clear cause was found).
- "actions": only state-changing actions actually executed; [] if none.
- "targets": one entry per target examined for health checks or multi-target runs; [] otherwise.
- "tables": only add a table when it makes numbers scannable and is NOT already one of the agent's tables (those are included automatically).
- "recommendations": 0-4, concrete and specific to what was found; [] if nothing needs doing.`;

// --------------------------------------------------------------------------
// Parsing the writer's answer
// --------------------------------------------------------------------------

const clip = (s: unknown, n: number): string => {
  const v = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
  return v.length > n ? `${v.slice(0, n - 1).trimEnd()}…` : v;
};
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
  typeof v === 'string' && (allowed as readonly string[]).includes(v.trim().toLowerCase())
    ? (v.trim().toLowerCase() as T)
    : dflt;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const refs = (v: unknown, calls: ReportToolCall[]): number[] =>
  [...new Set(arr(v).map((n) => Number(String(n).replace(/^#/, ''))).filter((n) => Number.isInteger(n) && n >= 1 && n <= calls.length && isCommand(calls[n - 1])))].slice(0, 6);

/** Pull the first JSON object out of a model reply (tolerates fences and chatter). */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const text = fenced ?? raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Turn the writer's reply into a ReportDoc, field by field. Anything missing or
 * malformed falls back to what the execution record says, so a sloppy reply still
 * yields a correct (if plainer) document rather than an error.
 */
export function parseReportDoc(raw: string | null, input: ReportInput): ReportDoc {
  const base = fallbackReportDoc(input);
  const j = raw ? (extractJson(raw) as Record<string, unknown> | null) : null;
  if (!j || typeof j !== 'object') return base;
  const calls = input.toolCalls;

  const status = (v: unknown) => oneOf(v, ['ok', 'warn', 'crit', 'info'] as const, 'info');
  const title = clip(j.title, 100).replace(/[.?]+$/, '');
  const type = oneOf(j.type, REPORT_TYPES, base.type);
  const rc = j.rootCause as Record<string, unknown> | null | undefined;

  const doc: ReportDoc = {
    title: title.length >= 6 ? title : base.title,
    type,
    outcome: oneOf(j.outcome, OUTCOMES, base.outcome),
    headline: clip(j.headline, 260) || base.headline,
    summary: arr(j.summary).map((s) => clip(s, 320)).filter(Boolean).slice(0, 5),
    metrics: arr(j.metrics)
      .map((m) => m as Record<string, unknown>)
      .map((m) => ({ label: clip(m.label, 40), value: clip(m.value, 28), status: status(m.status) }))
      .filter((m) => m.label && m.value)
      .slice(0, 6),
    rootCause:
      rc && typeof rc === 'object' && clip(rc.statement, 10)
        ? { statement: clip(rc.statement, 500), confidence: oneOf(rc.confidence, ['confirmed', 'likely', 'unconfirmed'] as const, 'unconfirmed') }
        : null,
    chain: arr(j.chain)
      .map((c) => c as Record<string, unknown>)
      .map((c) => ({ finding: clip(c.finding, 360), evidence: refs(c.evidence, calls), status: status(c.status) }))
      .filter((c) => c.finding)
      .slice(0, 8),
    actions: arr(j.actions)
      .map((a) => a as Record<string, unknown>)
      .map((a) => ({ action: clip(a.action, 200), result: clip(a.result, 240), evidence: refs(a.evidence, calls) }))
      .filter((a) => a.action)
      .slice(0, 8),
    targets: arr(j.targets)
      .map((t) => t as Record<string, unknown>)
      .map((t) => ({
        target: clip(t.target, 60),
        status: oneOf(t.status, ['ok', 'warn', 'crit', 'unreachable'] as const, 'ok'),
        note: clip(t.note, 220),
      }))
      .filter((t) => t.target)
      .slice(0, 40),
    tables: arr(j.tables).map((t) => normaliseTable(t, 'writer')).filter((t): t is ReportTable => !!t).slice(0, 3),
    recommendations: arr(j.recommendations)
      .map((r) => r as Record<string, unknown>)
      .map((r) => ({ priority: oneOf(r.priority, ['high', 'medium', 'low'] as const, 'medium'), text: clip(r.text, 300) }))
      .filter((r) => r.text)
      // Most urgent first, whatever order the writer used.
      .sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.priority] - ({ high: 0, medium: 1, low: 2 })[b.priority])
      .slice(0, 5),
    written: true,
  };
  if (!doc.summary.length) doc.summary = base.summary;
  if (!doc.chain.length) doc.chain = base.chain;
  doc.tables = mergeTables(extractAgentTables(input.steps), doc.tables);
  return doc;
}

function normaliseTable(t: unknown, source: ReportTable['source']): ReportTable | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const columns = arr(o.columns).map((c) => clip(c, 40)).filter(Boolean).slice(0, 8);
  if (columns.length < 2) return null;
  const rows = arr(o.rows)
    .map((r) => arr(r).map((c) => clip(c, 80)).slice(0, columns.length))
    .filter((r) => r.some(Boolean))
    .map((r) => [...r, ...Array(Math.max(0, columns.length - r.length)).fill('')])
    .slice(0, 40);
  if (!rows.length) return null;
  return { title: clip(o.title, 80) || 'Table', columns, rows, source };
}

/** Agent tables first (they are primary evidence), then any the writer added; no duplicates. */
function mergeTables(agent: ReportTable[], writer: ReportTable[]): ReportTable[] {
  const seen = new Set<string>();
  const out: ReportTable[] = [];
  for (const t of [...agent, ...writer]) {
    const key = `${t.columns.join('|').toLowerCase()}::${(t.rows[0] ?? []).join('|').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.slice(0, 5);
}

// --------------------------------------------------------------------------
// Tables the agent wrote
// --------------------------------------------------------------------------

const splitRow = (line: string): string[] =>
  line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) =>
    c.replace(/\\\|/g, '|').replace(/\*\*|__|`/g, '').trim(),
  );

/**
 * Every GitHub-style Markdown table the agent put in its messages during the run --
 * a pod list, a disk summary -- so a table it produced is never lost from the report.
 * Later tables win on duplicates (the agent often refines one as it goes).
 */
export function extractAgentTables(steps: Array<{ messageJson: ChatMessage }>): ReportTable[] {
  const found: ReportTable[] = [];
  for (const s of steps) {
    const m = s.messageJson;
    if (m.role !== 'assistant' || typeof m.content !== 'string') continue;
    const lines = m.content.split('\n');
    for (let i = 0; i < lines.length - 1; i += 1) {
      const head = lines[i]!;
      const sep = lines[i + 1]!;
      if (!head.includes('|') || !/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(sep)) continue;
      const columns = splitRow(head).filter((c, idx, a) => c || idx < a.length - 1);
      if (columns.length < 2) continue;
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim()) {
        const r = splitRow(lines[j]!).slice(0, columns.length);
        rows.push([...r, ...Array(Math.max(0, columns.length - r.length)).fill('')]);
        j += 1;
      }
      if (rows.length) {
        // The nearest heading or bold line above the table titles it.
        let title = '';
        for (let k = i - 1; k >= Math.max(0, i - 4); k -= 1) {
          const t = lines[k]!.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/:$/, '');
          if (t && !t.includes('|')) { title = t; break; }
        }
        found.push({
          title: clip(title, 80) || 'Table from the investigation',
          columns: columns.map((c) => clip(c, 40)),
          rows: rows.slice(0, 40).map((r) => r.map((c) => clip(c, 80))),
          source: 'agent',
        });
      }
      i = j - 1;
    }
  }
  const byCols = new Map<string, ReportTable>();
  for (const t of found) byCols.set(t.columns.join('|').toLowerCase(), t);
  return [...byCols.values()].slice(-4);
}

/** A ```mermaid diagram the agent drew during the run. */
export interface ReportDiagram {
  title: string;
  /** Repaired source (see repairMermaid), as it renders in the UI. */
  source: string;
  key: string;
}

/**
 * Every diagram the agent drew, deduplicated (a redrawn diagram keeps its latest
 * version), capped so a chatty run cannot turn the report into a picture book.
 */
export function extractAgentDiagrams(steps: Array<{ messageJson: ChatMessage }>): ReportDiagram[] {
  const byKey = new Map<string, ReportDiagram>();
  for (const s of steps) {
    const m = s.messageJson;
    if (m.role !== 'assistant' || typeof m.content !== 'string' || !m.content.includes('```')) continue;
    for (const b of extractMermaidBlocks(m.content)) {
      const source = repairMermaid(b.source);
      const key = diagramKey(source);
      byKey.delete(key);
      byKey.set(key, { title: clip(b.title, 80) || 'Diagram', source, key });
    }
  }
  return [...byKey.values()].slice(-6);
}

// --------------------------------------------------------------------------
// Mechanical fallback (model unavailable)
// --------------------------------------------------------------------------

function finalNote(steps: ReportInput['steps']): string {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const m = steps[i]!.messageJson;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

/** Tidy a raw request into a title: first line, no trailing punctuation, capitalised. */
export function tidyTitle(raw: string): string {
  const first = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Operations run';
  const t = clip(first, 90).replace(/[.?!]+$/, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function fallbackReportDoc(input: ReportInput): ReportDoc {
  const { run, toolCalls } = input;
  const health = input.kind === 'health';
  const changed = toolCalls.filter((c) => (c.state === 'succeeded' || c.state === 'failed') && c.tier && c.tier !== 'read_only');
  const findings = recordedFindings(toolCalls);
  const worst = findings.some((f) => f.severity === 'critical') ? 'crit' : findings.some((f) => f.severity === 'warning') ? 'warn' : 'ok';

  const type: ReportType = health ? 'health_check' : changed.length ? 'change' : 'query';
  const outcome: Outcome =
    run.status === 'failed' || run.status === 'halted' ? 'failed'
      : health ? (worst === 'crit' ? 'critical' : worst === 'warn' ? 'degraded' : 'healthy')
        : run.status === 'succeeded' ? 'completed' : 'inconclusive';

  // The agent's closing note, reduced to its first few meaningful lines.
  const note = finalNote(input.steps);
  const summary = note
    .split('\n')
    .map((l) => l.replace(/^\s*[-*#>\d.]+\s*/, '').replace(/\*\*/g, '').trim())
    // Real sentences only: not table rows, not labels that introduce a list/table.
    .filter((l) => l.length > 20 && !l.includes('|') && !/:$/.test(l))
    .slice(0, 4)
    .map((l) => clip(l, 300));

  const indexOf = (c: ReportToolCall) => toolCalls.indexOf(c) + 1;
  const chain = findings.length
    ? findings.slice(0, 6).map((f) => ({
        finding: `${f.target !== '—' ? `${f.target}: ` : ''}${clip(f.finding, 320)}`,
        evidence: [] as number[],
        status: (f.severity === 'critical' ? 'crit' : f.severity === 'warning' ? 'warn' : 'info') as Status,
      }))
    : [];

  return {
    title: tidyTitle(run.title),
    type,
    outcome,
    // The most severe recorded finding is the best headline; else the agent's first sentence.
    headline: findings[0]
      ? clip(findings[0].finding, 240)
      : summary[0] ?? `${REPORT_TYPE_LABEL[type]} on ${run.targetsSnapshot.map((t) => t.slug).join(', ') || 'the project'}.`,
    summary: findings[0] ? summary : summary.slice(1),
    metrics: [],
    rootCause: null,
    chain,
    actions: changed.slice(0, 8).map((c) => ({
      // A raw command is shown as code, so `*` and `_` in it are never read as emphasis.
      action: typeof c.argsJson.intent === 'string' && c.argsJson.intent.trim()
        ? clip(c.argsJson.intent, 200)
        : `\`${clip((c.renderedCommand ?? c.toolKey).replace(/`/g, "'"), 180)}\``,
      result: c.state === 'succeeded' ? 'Succeeded' : 'Failed',
      evidence: [indexOf(c)],
    })),
    targets: [],
    tables: extractAgentTables(input.steps),
    recommendations: [],
    written: false,
  };
}

// --------------------------------------------------------------------------
// Approvals, for the footer and the record
// --------------------------------------------------------------------------

export interface ApprovalEntry {
  name: string;
  approved: number;
  rejected: number;
  /** When they last decided. */
  at: Date | null;
  /** The kinds of harm on the steps they decided (e.g. "Outage risk"), deduplicated. */
  risks: string[];
}

/** Who approved or rejected this run's gated steps: each person once, in order of first decision. */
export function approvalLedger(input: ReportInput): ApprovalEntry[] {
  const byUser = new Map<string, ApprovalEntry>();
  const decided = input.toolCalls
    .filter((c) => c.decidedBy)
    .sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0));
  for (const c of decided) {
    const id = c.decidedBy!;
    const e = byUser.get(id) ?? { name: input.approverNames[id] ?? 'Unknown user', approved: 0, rejected: 0, at: null, risks: [] };
    for (const r of c.riskJson?.contributions ?? []) {
      const label = r.category && r.tier === c.tier ? THREAT_LABEL[r.category] : null;
      if (label && !e.risks.includes(label)) e.risks.push(label);
    }
    if (c.state === 'denied' || c.state === 'expired') e.rejected += 1;
    else e.approved += 1;
    if (c.decidedAt && (!e.at || c.decidedAt > e.at)) e.at = c.decidedAt;
    byUser.set(id, e);
  }
  return [...byUser.values()];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "28 Sep 2026, 09:15 UTC" */
export const fmtUtc = (d: Date): string =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${d.toISOString().slice(11, 16)} UTC`;
/** "28 Sep 09:15 UTC" -- for tight spaces like the footer. */
export const fmtShort = (d: Date): string =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.toISOString().slice(11, 16)} UTC`;

/**
 * The command as a person would type it. The executed string carries SupOps's
 * machine-readable sudo prompt (`sudo -S -p '[[SUPOPS-SUDO:%p]]'`), which is plumbing,
 * not content: show it as plain `sudo`.
 */
export function displayCommand(c: ReportToolCall): string {
  const raw = c.renderedCommand ?? c.toolKey;
  return raw
    .replace(/sudo -S -p '\[\[SUPOPS-SUDO:[^\]]*\]\]'/g, 'sudo')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Only real commands can be cited as evidence (not findings or confirmations). */
export const isCommand = (c: ReportToolCall | undefined): boolean =>
  !!c && c.toolKey !== 'record_finding' && c.toolKey !== 'confirm_target' && c.toolKey !== 'update_plan';

/** What a tool call was, in words a reader recognises. */
export const TOOL_LABEL: Record<string, string> = {
  ssh_exec: 'Shell command',
  ssh_read_file: 'File read',
  ssh_write_file: 'File write',
  k8s_kubectl: 'kubectl',
  confirm_target: 'Target confirmation',
  record_finding: 'Finding',
};

/** "Approved by A (14:20 UTC), B (14:32 UTC) · Rejected by C (14:40 UTC)" */
export function approvalLine(ledger: ApprovalEntry[]): string {
  if (!ledger.length) return 'No approvals were needed: every action ran within policy.';
  const time = (e: ApprovalEntry) => (e.at ? ` (${fmtUtc(e.at)})` : '');
  const approved = ledger.filter((e) => e.approved).map((e) => `${e.name}${time(e)}`);
  const rejected = ledger.filter((e) => e.rejected).map((e) => `${e.name}${time(e)}`);
  return [
    approved.length ? `Approved by ${approved.join(', ')}` : '',
    rejected.length ? `Rejected by ${rejected.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
}

/** The commands the document shows as evidence: everything cited, plus every change. */
export function citedCalls(input: ReportInput, doc: ReportDoc): number[] {
  const cited = new Set<number>([
    ...doc.chain.flatMap((c) => c.evidence),
    ...doc.actions.flatMap((a) => a.evidence),
  ]);
  input.toolCalls.forEach((c, i) => {
    if ((c.state === 'succeeded' || c.state === 'failed') && c.tier && c.tier !== 'read_only') cited.add(i + 1);
    if (c.decidedBy) cited.add(i + 1);
  });
  // Nothing cited (e.g. mechanical fallback on a read-only run): show the first reads.
  if (!cited.size) {
    input.toolCalls.forEach((c, i) => {
      if (cited.size < 6 && c.toolKey !== 'record_finding' && c.toolKey !== 'update_plan' && c.resultJson) cited.add(i + 1);
    });
  }
  return [...cited].filter((n) => input.toolCalls[n - 1] && input.toolCalls[n - 1]!.toolKey !== 'record_finding').sort((a, b) => a - b).slice(0, 12);
}

// --------------------------------------------------------------------------
// Shared facts + the Markdown rendering
// --------------------------------------------------------------------------

export function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The headline numbers every report shows as tiles, straight from the execution record. */
export function runFacts(input: ReportInput) {
  const calls = input.toolCalls.filter((c) => c.toolKey !== 'record_finding' && c.toolKey !== 'confirm_target' && c.toolKey !== 'update_plan');
  const ran = calls.filter((c) => c.state === 'succeeded' || c.state === 'failed');
  const changes = ran.filter((c) => c.tier && c.tier !== 'read_only');
  const refused = calls.filter((c) => c.state === 'denied' || c.state === 'expired' || c.state === 'blocked');
  const tiers = { read_only: 0, low: 0, medium: 0, high: 0, forbidden: 0 };
  for (const c of calls) if (c.tier) tiers[c.tier] += 1;
  const touched = new Set(calls.map((c) => (typeof c.argsJson.target === 'string' ? c.argsJson.target : '')).filter(Boolean));
  const findings = recordedFindings(input.toolCalls);
  return {
    duration: input.run.endedAt ? humanDuration(input.run.endedAt.getTime() - input.run.startedAt.getTime()) : 'running',
    commands: ran.length,
    failed: ran.filter((c) => c.state === 'failed').length,
    changes: changes.length,
    refused: refused.length,
    approvals: input.toolCalls.filter((c) => c.decidedBy && c.state !== 'denied' && c.state !== 'expired').length,
    rejected: input.toolCalls.filter((c) => c.decidedBy && (c.state === 'denied' || c.state === 'expired')).length,
    targets: touched.size || input.run.targetsSnapshot.length,
    findings: findings.length,
    critical: findings.filter((f) => f.severity === 'critical').length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    tiers,
  };
}

const mdCell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const STATUS_WORD: Record<string, string> = { ok: 'OK', warn: 'Warning', crit: 'Critical', info: 'Info', unreachable: 'Unreachable' };

/** Share-ready Markdown (for tickets/wikis), with the same structure as the PDF. */
export function buildReportMarkdown(input: ReportInput, doc: ReportDoc): string {
  const f = runFacts(input);
  const out: string[] = [];
  const meta = OUTCOME_META[doc.outcome];
  out.push(`# ${doc.title}`, '');
  out.push(`**${REPORT_TYPE_LABEL[doc.type]}** · **${meta.label}** · ${input.projectName} · ${fmtUtc(input.run.startedAt)} · ${f.duration}`, '');
  out.push(`> ${doc.headline}`, '');
  out.push(`| Duration | Commands | Changes | Approvals | Targets | Findings |`, `|---|---|---|---|---|---|`);
  out.push(`| ${f.duration} | ${f.commands}${f.failed ? ` (${f.failed} failed)` : ''} | ${f.changes} | ${f.approvals} | ${f.targets} | ${f.findings}${f.critical ? ` (${f.critical} critical)` : ''} |`, '');

  if (doc.summary.length) {
    out.push('## Summary', '', ...doc.summary.map((s) => `- ${s}`), '');
  }
  if (doc.metrics.length) {
    out.push('## Key metrics', '', '| Metric | Value | Status |', '|---|---|---|');
    for (const m of doc.metrics) out.push(`| ${mdCell(m.label)} | **${mdCell(m.value)}** | ${STATUS_WORD[m.status]} |`);
    out.push('');
  }
  if (doc.rootCause) {
    out.push('## Root cause', '', `${doc.rootCause.statement}`, '', `_Confidence: ${doc.rootCause.confidence}_`, '');
  }
  const cmd = (n: number) => (input.toolCalls[n - 1] ? displayCommand(input.toolCalls[n - 1]!) : '');
  if (doc.chain.length) {
    out.push('## How it was established', '');
    doc.chain.forEach((c, i) => {
      out.push(`${i + 1}. ${c.finding}${c.evidence.length ? `  \n   ${c.evidence.map((n) => `\`#${n} ${mdCell(cmd(n)).slice(0, 90)}\``).join(' · ')}` : ''}`);
    });
    out.push('');
  }
  if (doc.actions.length) {
    out.push('## Changes made', '', '| Change | Result | Ref |', '|---|---|---|');
    for (const a of doc.actions) out.push(`| ${mdCell(a.action)} | ${mdCell(a.result)} | ${a.evidence.map((n) => `#${n}`).join(' ')} |`);
    out.push('');
  }
  if (doc.targets.length) {
    out.push('## Targets', '', '| Target | Status | Notes |', '|---|---|---|');
    for (const t of doc.targets) out.push(`| \`${t.target}\` | ${STATUS_WORD[t.status]} | ${mdCell(t.note)} |`);
    out.push('');
  }
  for (const t of doc.tables) {
    out.push(`## ${t.title}`, '', `| ${t.columns.map(mdCell).join(' | ')} |`, `|${t.columns.map(() => '---').join('|')}|`);
    for (const r of t.rows) out.push(`| ${r.map(mdCell).join(' | ')} |`);
    out.push('');
  }
  // Kept as ```mermaid fences: GitHub, GitLab, Notion and most wikis draw them.
  for (const d of extractAgentDiagrams(input.steps)) {
    out.push(`## ${d.title}`, '', '```mermaid', d.source, '```', '');
  }
  if (doc.recommendations.length) {
    out.push('## Recommendations', '', ...doc.recommendations.map((r) => `- **${r.priority}** — ${r.text}`), '');
  }
  const cited = citedCalls(input, doc);
  if (cited.length) {
    out.push('## Evidence', '');
    for (const n of cited) {
      const c = input.toolCalls[n - 1]!;
      const target = typeof c.argsJson.target === 'string' ? ` · ${c.argsJson.target}` : '';
      out.push(`**#${n}** ${TOOL_LABEL[c.toolKey] ?? c.toolKey}${target} · ${c.tier ?? '—'} · ${c.state}`, '', '```sh', displayCommand(c), '```');
      const body = trimOutput(c.resultJson?.text ?? '');
      if (body) out.push('```', body, '```');
      out.push('');
    }
  }
  out.push('---', '', `_${approvalLine(approvalLedger(input))}_  `,
    `_Generated by SupOps ${fmtUtc(new Date())} from the run's execution record${doc.written ? '; narrative by the report writer model' : ''}._`);
  return out.join('\n');
}

/** Keep evidence output short: the first lines that matter, never a transcript. */
export function trimOutput(text: string, maxLines = 16, maxChars = 1400): string {
  // stripAnsi: runs recorded before output was cleaned still carry terminal colour codes.
  const clean = stripAnsi(text).replace(/^\[exit \d+\]\n?/, '').replace(/\r/g, '').trimEnd();
  if (!clean) return '';
  const lines = clean.split('\n');
  let out = lines.slice(0, maxLines).join('\n');
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}…`;
  const hidden = lines.length - Math.min(lines.length, maxLines);
  return hidden > 0 ? `${out}\n… ${hidden} more line${hidden === 1 ? '' : 's'}` : out;
}
