import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { LLMClient } from '@supops/core';
import { CASES, selectCases } from './cases/index.ts';
import { runCase } from './harness.ts';
import { markdownReport, type Result } from './report.ts';
import { score } from './score.ts';

/**
 * npm run eval -- --models <a,b> [--cases <ids or tag:x>] [--runs N] [--judge <model>] [--out dir]
 *
 * The provider is any OpenAI-compatible endpoint, from EVAL_BASE_URL / EVAL_API_KEY (or
 * LLM_BASE_URL / LLM_API_KEY). Nothing touches real infrastructure: every tool answer is a
 * recording from the case.
 */
const { values } = parseArgs({
  options: {
    models: { type: 'string' },
    cases: { type: 'string' },
    runs: { type: 'string', default: '1' },
    judge: { type: 'string' },
    out: { type: 'string', default: 'eval-results' },
    list: { type: 'boolean', default: false },
    'base-url': { type: 'string' },
  },
});

if (values.list) {
  for (const c of CASES) console.log(`${c.id.padEnd(38)} ${c.tags.join(',').padEnd(30)} ${c.title}`);
  process.exit(0);
}

const baseUrl = values['base-url'] ?? process.env.EVAL_BASE_URL ?? process.env.LLM_BASE_URL;
const apiKey = process.env.EVAL_API_KEY ?? process.env.LLM_API_KEY ?? '';
const models = (values.models ?? process.env.EVAL_MODELS ?? process.env.LLM_MODEL ?? '').split(',').map((m) => m.trim()).filter(Boolean);
if (!baseUrl || !models.length) {
  console.error('Set the provider and models: EVAL_BASE_URL (or LLM_BASE_URL), EVAL_API_KEY, and --models a,b (or EVAL_MODELS).');
  process.exit(2);
}
const cases = selectCases(values.cases);
if (!cases.length) {
  console.error(`No case matches "${values.cases}". See --list.`);
  process.exit(2);
}
const runs = Math.max(1, Number(values.runs) || 1);
const judge = values.judge ? { client: new LLMClient({ baseUrl, apiKey, model: values.judge }), model: values.judge } : undefined;

const results: Result[] = [];
for (const model of models) {
  const llm = new LLMClient({ baseUrl, apiKey, model });
  for (const c of cases) {
    for (let i = 0; i < runs; i++) {
      const run = await runCase(c, llm);
      const verdict = await score(c, run, judge);
      results.push({ case: c, run, verdict });
      console.log(`${verdict.pass ? 'PASS' : 'FAIL'} ${model} ${c.id}${runs > 1 ? ` #${i + 1}` : ''} · ${run.steps} steps · ${(run.ms / 1000).toFixed(1)}s${verdict.pass ? '' : ` · ${verdict.reasons.filter((r) => !r.startsWith('note:')).join('; ')}`}`);
    }
  }
}

const at = new Date();
const report = markdownReport(results, { judge: values.judge ?? null, runsPerCase: runs, at });
mkdirSync(values.out!, { recursive: true });
const stamp = at.toISOString().replace(/[:.]/g, '-');
writeFileSync(join(values.out!, `eval-${stamp}.md`), report);
writeFileSync(join(values.out!, `eval-${stamp}.json`), JSON.stringify(results.map((r) => ({ case: r.case.id, model: r.run.model, pass: r.verdict.pass, reasons: r.verdict.reasons, elements: r.verdict.elements, steps: r.run.steps, tokens: r.run.promptTokens + r.run.completionTokens, ms: r.run.ms, calls: r.run.calls, answer: r.run.answer })), null, 2));
console.log(`\n${report}\n\nWritten to ${values.out}/eval-${stamp}.md and .json`);
