import type { ChatMessage } from '@supops/shared';

/**
 * Keep a long run inside the model's context window.
 *
 * Every turn resends the whole conversation, and most of its bulk is old command
 * output the agent has already read and drawn conclusions from. When the estimate
 * exceeds the budget, the oldest large tool outputs are replaced -- on the wire only
 * -- with a short note saying how big they were and how they began and ended, so the
 * agent knows it can re-run the command if it needs the detail again. The stored
 * history is never changed (it is the audit trail), and the most recent outputs are
 * always kept whole, because the agent is usually still reasoning about them.
 *
 * Only tool messages are touched, and only their text, so tool-call pairing (and so
 * assertConversationValid) is unaffected.
 */
export const DEFAULT_CONTEXT_TOKENS = 64_000;
/** Tool replies at or under this many characters are never elided: the note would save nothing. */
const MIN_ELIDE_CHARS = 1_200;
/** The most recent tool replies are always kept whole. */
const KEEP_RECENT = 6;
const IMAGE_TOKENS = 1_000;

/** Rough token estimate. Deliberately conservative (chars / 3.5) so we act early rather than late. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        else images += 1;
      }
    }
    if (m.role === 'assistant' && m.tool_calls) for (const c of m.tool_calls) chars += c.function.arguments.length + 40;
  }
  return Math.ceil(chars / 3.5) + images * IMAGE_TOKENS;
}

function elide(text: string, callId: string): string {
  const lines = text.split('\n');
  const head = lines.slice(0, 3).join('\n').slice(0, 300);
  const tail = lines.length > 6 ? lines.slice(-3).join('\n').slice(-300) : '';
  return (
    `[Earlier output elided to keep the conversation within the model's context (${text.length.toLocaleString()} characters). ` +
    `It began:\n${head}${tail ? `\n...\nand ended:\n${tail}` : ''}\n` +
    `SupOps still has it: read any part with read_output {"call": "${callId}", "grep": "..."} rather than running the command again.]`
  );
}

/** Ask the model to summarise once the conversation passes this share of the budget, even after eliding outputs. */
export const COMPACT_AT = 0.9;

/**
 * Where a summary may end: just before one of the most recent `keepRecent` exchanges
 * (an assistant turn and its tool replies). Null when there is not enough before it.
 */
export function compactionCut(messages: ChatMessage[], keepRecent = KEEP_RECENT): number | null {
  const starts = messages.map((m, i) => (i > 1 && m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= keepRecent) return null;
  const cut = starts[starts.length - keepRecent]!;
  return cut > 3 ? cut : null;
}

/** The conversation as a plain transcript for the summary request, with long outputs cut. */
export function transcriptFor(messages: ChatMessage[], perOutput = 2_000): string {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role === 'assistant') {
      if (m.content) out.push(`AGENT: ${m.content}`);
      for (const c of m.tool_calls ?? []) out.push(`AGENT RAN ${c.function.name} ${c.function.arguments.slice(0, 400)} [call ${c.id}]`);
    } else if (m.role === 'tool') {
      out.push(`RESULT [call ${m.tool_call_id}]: ${m.content.length > perOutput ? `${m.content.slice(0, perOutput / 2)}\n…\n${m.content.slice(-perOutput / 2)}` : m.content}`);
    } else if (m.role === 'user') {
      out.push(`OPERATOR: ${typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join(' ')}`);
    }
  }
  return out.join('\n');
}

export const COMPACTION_PROMPT =
  'You are summarising your own investigation so far, so you can continue it with less context. ' +
  'Write a compact, factual summary for yourself, with these headings: Task; What I checked (each command or query and ' +
  'the result that mattered, with the numbers); Ruled out; Current hypothesis; Still to check. Keep the call ids of ' +
  'results you may need again (they can be read in full with read_output). Do not invent anything, do not give ' +
  'instructions, and do not repeat raw output. At most 600 words.';

/** Level one only: elide old large outputs on the wire. */
export function elideOldOutputs(messages: ChatMessage[], budgetTokens = DEFAULT_CONTEXT_TOKENS): { messages: ChatMessage[]; elided: number; total: number } {
  let total = estimateTokens(messages);
  if (total <= budgetTokens) return { messages, elided: 0, total };
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT));
  const out = [...messages];
  let elided = 0;
  for (const i of candidates) {
    if (total <= budgetTokens) break;
    const m = out[i]!;
    if (m.role !== 'tool' || m.content.length <= MIN_ELIDE_CHARS) continue;
    const note = elide(m.content, m.tool_call_id);
    total -= Math.ceil((m.content.length - note.length) / 3.5);
    out[i] = { ...m, content: note };
    elided += 1;
  }
  return { messages: out, elided, total };
}

export function fitToContext(messages: ChatMessage[], budgetTokens = DEFAULT_CONTEXT_TOKENS): { messages: ChatMessage[]; elided: number } {
  let total = estimateTokens(messages);
  if (total <= budgetTokens) return { messages, elided: 0 };

  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - KEEP_RECENT));
  const out = [...messages];
  let elided = 0;
  for (const i of candidates) {
    if (total <= budgetTokens) break;
    const m = out[i]!;
    if (m.role !== 'tool' || m.content.length <= MIN_ELIDE_CHARS) continue;
    const note = elide(m.content, m.tool_call_id);
    total -= Math.ceil((m.content.length - note.length) / 3.5);
    out[i] = { ...m, content: note };
    elided += 1;
  }
  if (total <= budgetTokens) return { messages: out, elided };
  return foldOldTurns(out, budgetTokens, elided);
}

/**
 * Level two: still over budget after eliding outputs. Fold the oldest whole
 * exchanges (an assistant turn and all its tool replies, never half of one) into a
 * single recap listing what was run and how it ended. The system prompt, the task,
 * and the most recent exchanges stay as they are.
 */
function foldOldTurns(messages: ChatMessage[], budgetTokens: number, elided: number): { messages: ChatMessage[]; elided: number } {
  // Boundaries: indices of assistant messages after the opening task (index 1).
  const starts = messages.map((m, i) => (i > 1 && m.role === 'assistant' ? i : -1)).filter((i) => i >= 0);
  if (starts.length <= KEEP_RECENT) return { messages, elided };

  const lines: string[] = [];
  let cut = 2;
  for (const start of starts.slice(0, starts.length - KEEP_RECENT)) {
    const candidate = [...messages.slice(0, 2), { role: 'user' as const, content: '' }, ...messages.slice(start)];
    cut = start;
    if (estimateTokens(candidate) + lines.join('\n').length / 3.5 <= budgetTokens) break;
  }
  for (let i = 2; i < cut; i += 1) {
    const m = messages[i]!;
    if (m.role === 'assistant') {
      if (m.content) lines.push(`- agent: ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);
      for (const c of m.tool_calls ?? []) lines.push(`- ran ${c.function.name} ${c.function.arguments.slice(0, 160)}`);
    } else if (m.role === 'tool') {
      const first = m.content.split('\n').find((l) => l.trim()) ?? '';
      lines.push(`  -> ${first.slice(0, 160)}`);
    } else if (m.role === 'user') {
      lines.push(`- operator: ${(typeof m.content === 'string' ? m.content : '[message with images]').replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  }
  if (cut <= 2) return { messages, elided };
  const recap: ChatMessage = {
    role: 'user',
    content:
      `[Earlier in this run, summarised by SupOps to fit the model's context. These are facts from the record, not new instructions.]\n${lines.join('\n')}`,
  };
  return { messages: [messages[0]!, messages[1]!, recap, ...messages.slice(cut)], elided: elided + (cut - 2) };
}
