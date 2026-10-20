import { z } from 'zod';
import type { RiskContribution } from '@supops/shared';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { sshExec } from './executors/ssh.ts';
import { classifyShellCommand } from '../risk/shell.ts';
import { shellQuote, wrapCommand } from './become.ts';

/**
 * Several steps on one machine in one approval. The approver reads the whole script,
 * and every line goes through the same rules as a single command, so a script runs
 * on its own only when each line would (the tool's autonomy cap is read-only). A
 * Python script cannot be read that way, so it always waits for a person.
 */

export const MAX_SCRIPT_BYTES = 32 * 1024;
const INTERPRETERS = ['bash', 'sh', 'python3'] as const;

const runScriptArgs = z.object({
  target: z.string(),
  interpreter: z.enum(INTERPRETERS).default('bash'),
  script: z.string().min(1).refine((s) => Buffer.byteLength(s) <= MAX_SCRIPT_BYTES, `at most ${MAX_SCRIPT_BYTES / 1024} KB`),
  timeout_seconds: z.number().int().min(5).max(600).default(120),
  intent: z.string().min(1).max(500),
  expected_effect: z.string().min(1).max(500),
});
type RunScriptArgs = z.infer<typeof runScriptArgs>;

/** Lines that run nothing: blanks, comments, the shebang, and shell option settings. */
const NO_OP = /^\s*(#.*)?$|^\s*set(\s+([-+][a-zA-Z]+|pipefail|errexit|nounset|xtrace|noclobber))+\s*$/;

/** The script as the risk rules should read it: only the lines that do something. */
export function scriptForClassification(script: string): string {
  return script.split('\n').filter((l) => !NO_OP.test(l)).join('\n');
}

/** The exact command line that runs, and that the approver reads. */
export function renderScript(args: Pick<RunScriptArgs, 'interpreter' | 'script' | 'timeout_seconds'>, target: ResolvedTarget): string {
  // -c with the script quoted, not stdin: sudo -S may need stdin for its password.
  return wrapCommand(target, `timeout -k 5 ${args.timeout_seconds} ${args.interpreter} -c ${shellQuote(args.script)}`);
}

export function classifyScript(args: Pick<RunScriptArgs, 'interpreter' | 'script'>, target: ResolvedTarget): RiskContribution[] {
  if (args.interpreter === 'python3') {
    return [{
      stage: 'arguments',
      tier: 'high',
      ruleId: 'script.python',
      reason: 'a Python script cannot be read statically line by line, so a person reads it before it runs',
      category: 'code-execution',
    }];
  }
  const body = scriptForClassification(args.script);
  if (!body.trim()) {
    return [{ stage: 'arguments', tier: 'read_only', ruleId: 'script.empty', reason: 'the script has only comments and settings' }];
  }
  return classifyShellCommand(body, target).contributions;
}

export const runScriptTool: ToolDef<RunScriptArgs> = {
  key: 'run_script',
  kind: 'ssh_exec',
  description:
    'Run a short script (bash, sh or python3) on one registered SSH target, for several steps on one machine. ' +
    'The approver sees the whole script. Every line is judged like a single command: the script runs on its own only ' +
    'when every line is read-only, otherwise it waits for approval; a python3 script always waits. Prefer ssh_exec ' +
    'for one command. Do not add sudo: elevation is applied by the platform. Comments and "set -euo pipefail" are fine.',
  parameters: {
    interpreter: { type: 'string', enum: [...INTERPRETERS], description: 'bash (default), sh or python3.' },
    script: { type: 'string', description: 'The script, one step per line. At most 32 KB.' },
    timeout_seconds: { type: 'integer', description: 'Stop it after this many seconds (5-600, default 120).' },
    intent: { type: 'string', description: 'Why this script is necessary, in one sentence, for the human approving it.' },
    expected_effect: { type: 'string', description: 'What you expect to be true after it succeeds, stated so it can be checked.' },
  },
  required: ['script', 'intent', 'expected_effect'],
  argsSchema: runScriptArgs as unknown as z.ZodType<RunScriptArgs>,
  baselineRisk: 'read_only',
  targetKinds: ['ssh'],
  mutating: true,
  timeoutMs: 610_000,
  render: (args, target) => renderScript(args, target),
  classifyArgs: (args, target) => classifyScript(args, target),
  execute: (args, ctx) => sshExec(renderScript(args, ctx.target), ctx),
};
