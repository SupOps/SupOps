import type { CaseRun, EvalCase, Verdict } from './types.ts';

export interface Result {
  case: EvalCase;
  run: CaseRun;
  verdict: Verdict;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** The report: pass rate, tokens and time per model; pass rate per tag; then every failure and why. */
export function markdownReport(results: Result[], meta: { judge: string | null; runsPerCase: number; at: Date }): string {
  const models = [...new Set(results.map((r) => r.run.model))];
  const tags = [...new Set(results.flatMap((r) => r.case.tags))].sort();
  const lines = [
    `# SupOps accuracy eval`,
    '',
    `${meta.at.toISOString()} · ${new Set(results.map((r) => r.case.id)).size} cases × ${meta.runsPerCase} run(s) · judge: ${meta.judge ?? 'none (patterns only)'}`,
    '',
    '| Model | Pass rate | Passed | Avg tokens | Avg time | Avg steps |',
    '|---|---|---|---|---|---|',
    ...models.map((m) => {
      const rs = results.filter((r) => r.run.model === m);
      const passed = rs.filter((r) => r.verdict.pass).length;
      return `| ${m} | ${pct(passed, rs.length)} | ${passed}/${rs.length} | ${Math.round(avg(rs.map((r) => r.run.promptTokens + r.run.completionTokens))).toLocaleString()} | ${(avg(rs.map((r) => r.run.ms)) / 1000).toFixed(1)}s | ${avg(rs.map((r) => r.run.steps)).toFixed(1)} |`;
    }),
    '',
    '## By tag',
    '',
    `| Tag | ${models.join(' | ')} |`,
    `|---|${models.map(() => '---').join('|')}|`,
    ...tags.map((t) => `| ${t} | ${models.map((m) => { const rs = results.filter((r) => r.run.model === m && r.case.tags.includes(t)); return `${pct(rs.filter((r) => r.verdict.pass).length, rs.length)} (${rs.length})`; }).join(' | ')} |`),
    '',
    '## Failures',
    '',
  ];
  const failed = results.filter((r) => !r.verdict.pass);
  if (!failed.length) lines.push('None.');
  for (const r of failed) {
    lines.push(`- **${r.case.id}** (${r.run.model}): ${r.verdict.reasons.filter((x) => !x.startsWith('note:')).join('; ')}`);
  }
  const notes = results.flatMap((r) => r.verdict.reasons.filter((x) => x.startsWith('note:')).map((x) => `- ${r.case.id}: ${x.slice(6)}`));
  if (notes.length) lines.push('', '## Missing recordings', '', 'Calls the cases have no output for (add them so the case stays fair):', '', ...[...new Set(notes)]);
  return lines.join('\n');
}
