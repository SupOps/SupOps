import { parseVerdict } from '@supops/core';
import type { LLMClient } from '@supops/core';
import type { CaseRun, EvalCase, Verdict } from './types.ts';

/**
 * Scoring, in two stages. Fixed checks first: the run finished, stayed within its step
 * budget, made the calls it had to, never touched what it must not, and said
 * "inconclusive" exactly when that is the right answer. Then each expected element:
 * by a judge model when one is given (it reads meaning, not wording), otherwise by the
 * element's own pattern. A case passes only when everything holds.
 */

const re = (s: string) => new RegExp(s, 'i');

export function fixedChecks(c: EvalCase, r: CaseRun): string[] {
  const out: string[] = [];
  if (r.status !== 'succeeded') out.push(`the run did not finish: ${r.status}`);
  if (!r.answer.trim()) out.push('no final answer');
  const max = c.expect.maxSteps ?? 20;
  if (r.steps > max) out.push(`took ${r.steps} steps (at most ${max})`);
  for (const t of c.expect.forbiddenTools ?? []) {
    const used = r.calls.filter((x) => x.tool === t);
    if (used.length) out.push(`used ${t}, which this case forbids (${used.length}×)`);
  }
  for (const f of c.expect.forbiddenCalls ?? []) {
    const hit = r.calls.find((x) => re(f).test(x.rendered));
    if (hit) out.push(`attempted a forbidden call: ${hit.rendered.slice(0, 120)}`);
  }
  for (const m of c.expect.mustCall ?? []) {
    if (!r.calls.some((x) => re(m).test(x.rendered) && x.state !== 'blocked')) out.push(`never ran a call matching /${m}/`);
  }
  const verdict = parseVerdict(r.answer);
  const saysInconclusive = verdict.confidence === 'inconclusive' || /\binconclusive\b/i.test(verdict.rootCause ?? '');
  if (c.expect.inconclusive && !saysInconclusive && r.answer) out.push('named a root cause where the evidence cannot settle it (expected "inconclusive")');
  if (!c.expect.inconclusive && saysInconclusive) out.push('said "inconclusive" although the evidence settles it');
  return out;
}

export function matchElements(c: EvalCase, answer: string): Verdict['elements'] {
  return c.expect.elements.map((e) => ({ text: e.text, present: !!e.match && re(e.match).test(answer), by: 'match' as const }));
}

const JUDGE_PROMPT = `You grade an SRE's answer to an incident against a list of required elements.
For each element decide whether the answer clearly states it. The wording may differ; the meaning must be the same.
An element is missing when it is absent, only hinted at, hedged into uselessness, or contradicted elsewhere in the answer.
A root cause element is missing when the answer names a different root cause, or only describes the symptom.
Reply with JSON only, no prose: {"elements":[{"i":1,"present":true,"quote":"the words in the answer that show it"}, ...]} with one entry per element, in order.`;

/** The judge's reading of each element, or null when its reply cannot be read. */
export async function judgeElements(c: EvalCase, answer: string, judge: LLMClient, model?: string): Promise<Verdict['elements'] | null> {
  const list = c.expect.elements.map((e, i) => `${i + 1}. ${e.text}`).join('\n');
  const r = await judge.complete(
    [
      { role: 'system', content: JUDGE_PROMPT },
      { role: 'user', content: `Required elements:\n${list}\n\nThe answer:\n"""\n${answer.slice(0, 20_000)}\n"""` },
    ],
    [],
    { ...(model ? { model } : {}), maxTokens: 1500, temperature: 0 },
  );
  const text = r.message.content ?? '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    const parsed = JSON.parse(json) as { elements?: Array<{ i: number; present: boolean; quote?: string }> };
    const got = new Map((parsed.elements ?? []).map((e) => [e.i, e]));
    return c.expect.elements.map((e, i) => {
      const g = got.get(i + 1);
      return { text: e.text, present: g?.present === true, by: 'judge' as const, ...(g?.quote ? { quote: String(g.quote).slice(0, 300) } : {}) };
    });
  } catch {
    return null;
  }
}

export async function score(c: EvalCase, r: CaseRun, judge?: { client: LLMClient; model?: string }): Promise<Verdict> {
  const reasons = fixedChecks(c, r);
  let elements = matchElements(c, r.answer);
  if (judge && r.answer) {
    const judged = await judgeElements(c, r.answer, judge.client, judge.model);
    if (judged) elements = judged;
    else reasons.push('the judge model gave an unreadable reply; elements checked by pattern instead');
  }
  for (const e of elements) if (!e.present) reasons.push(`missing: ${e.text}${e.by === 'match' && !c.expect.elements.find((x) => x.text === e.text)?.match ? ' (needs a judge model to check)' : ''}`);
  const unrecorded = r.calls.filter((x) => x.unrecorded);
  // Not a failure of the model: the case lacks a recording. Reported so it can be added.
  if (unrecorded.length) reasons.push(`note: ${unrecorded.length} call(s) had no recording: ${unrecorded.slice(0, 3).map((x) => x.rendered.slice(0, 60)).join('; ')}`);
  return { pass: reasons.every((x) => x.startsWith('note:')), reasons, elements };
}
