import { z } from 'zod';
import { TARGET_KINDS } from '@supops/shared';
import type { RiskContribution } from '@supops/shared';
import type { ToolDef } from './types.ts';
import { NETWORK_TARGET } from './net-check.ts';
import { errOutput, okOutput } from './output.ts';

/**
 * Read more of an earlier result in this run, by line range or by searching it,
 * instead of running the command again. A long output is shown to the model as its
 * head and tail; SupOps keeps the whole of it (up to FULL_OUTPUT_BYTES) for this.
 *
 * Read-only, and only this run's own calls: the engine supplies the accessor.
 */
export const FULL_OUTPUT_BYTES = 512 * 1024;
const MAX_LINES = 400;
const MAX_CHARS = 16_000;

const READ: RiskContribution[] = [{ stage: 'arguments', tier: 'read_only', ruleId: 'output.read', reason: "reads an earlier result of this run, which SupOps already holds" }];

const args = z.object({
  target: z.string(),
  call: z.string().min(1).max(100),
  grep: z.string().max(200).optional(),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(MAX_LINES).optional(),
});

export const readOutputTool: ToolDef<z.infer<typeof args>> = {
  key: 'read_output',
  kind: 'knowledge',
  description:
    'Read more of an earlier tool result in this run, whose output was too long to show in full. ' +
    'Give the call id from the "[Full output kept…]" note. Either search it (grep: text to find, case-insensitive, ' +
    'with line numbers) or read a range of lines (offset: first line, limit: how many, at most 400). ' +
    'Use this instead of running the command again. The target is always supops-server.',
  parameters: {
    call: { type: 'string', description: 'The tool call id named in the note.' },
    grep: { type: 'string', description: 'Text to find; returns the matching lines with their numbers.' },
    offset: { type: 'number', description: 'First line to return (1 = the start).' },
    limit: { type: 'number', description: 'How many lines, at most 400.' },
  },
  required: ['call'],
  argsSchema: args,
  baselineRisk: 'read_only',
  targetKinds: [...TARGET_KINDS],
  // About the run itself, not any machine: always the SupOps server, so the model never has to pick one.
  fixedTarget: NETWORK_TARGET,
  mutating: false,
  timeoutMs: 5_000,
  render: (a) => `read_output ${a.call}${a.grep ? ` grep "${a.grep}"` : ''}${a.offset ? ` from line ${a.offset}` : ''}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    if (!ctx.outputs) return errOutput('Earlier outputs are not available here.');
    const out = ctx.outputs.read(a.call);
    if (!out) return errOutput(`No result with the id "${a.call}" in this run. Use the id from the "[Full output kept…]" note.`);
    const lines = out.text.split('\n');
    let picked: string[];
    let head: string;
    if (a.grep) {
      const needle = a.grep.toLowerCase();
      const hits = lines.map((l, i) => [i + 1, l] as const).filter(([, l]) => l.toLowerCase().includes(needle));
      const limit = a.limit ?? 200;
      picked = hits.slice(0, limit).map(([n, l]) => `${n}: ${l}`);
      head = hits.length ? `${hits.length} line${hits.length === 1 ? '' : 's'} of ${lines.length} match "${a.grep}"${hits.length > limit ? `; the first ${limit}` : ''}:` : `No line of the ${lines.length} matches "${a.grep}".`;
    } else {
      const from = Math.min(a.offset ?? 1, lines.length);
      const limit = a.limit ?? 200;
      picked = lines.slice(from - 1, from - 1 + limit).map((l, i) => `${from + i}: ${l}`);
      head = `Lines ${from}-${from + picked.length - 1} of ${lines.length} from \`${out.rendered.slice(0, 120)}\`:`;
    }
    let body = picked.join('\n');
    if (body.length > MAX_CHARS) body = `${body.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS.toLocaleString()} characters: ask for fewer lines]`;
    return okOutput(`${head}\n${body}`);
  },
};
