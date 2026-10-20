import { z } from 'zod';
import { readKnowledgeTool, searchKnowledgeTool } from './knowledge.ts';
import { readOutputTool } from './read-output.ts';
import { planTool } from './plan.ts';
import { queryTracesTool } from './traces.ts';
import { dockerTool } from './docker.ts';
import { runScriptTool } from './script.ts';
import { scmTool } from './scm.ts';
import { TARGET_KINDS } from '@supops/shared';
import { alertsTool, queryLogsTool, queryMetricsTool } from './observability.ts';
import type { RiskContribution } from '@supops/shared';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { isProtectedPath, isWritablePath } from '../risk/paths.ts';
import { ToolRegistry } from './registry.ts';
import { sshExec } from './executors/ssh.ts';
import { kubectlExec, planKubectl } from './executors/kubectl.ts';
import { classifyShellCommand } from '../risk/shell.ts';
import { shellQuote, wrapCommand, wrapScript } from './become.ts';
import { okOutput } from './output.ts';

/**
 * Arguments every mutating tool must supply.
 *
 * `intent` and `expected_effect` are what a human reads on the approval card, and
 * asking for them measurably improves the quality of the actions a model proposes --
 * it has to commit to a prediction before acting. They are never used to lower risk;
 * a confident `intent` on a destructive command is still a destructive command.
 */
const MUTATING_ARGS = {
  intent: {
    type: 'string' as const,
    description: 'Why this action is necessary, in one sentence, for the human approving it.',
  },
  expected_effect: {
    type: 'string' as const,
    description: 'What you expect to be true after this succeeds, stated so it can be checked.',
  },
};

const sshExecArgs = z.object({
  target: z.string(),
  command: z.string().min(1).max(4000),
  intent: z.string().min(1).max(500),
  expected_effect: z.string().min(1).max(500),
});

export const sshExecTool: ToolDef<z.infer<typeof sshExecArgs>> = {
  key: 'ssh_exec',
  kind: 'ssh_exec',
  description:
    'Run a single shell command on a registered SSH target and return its output. ' +
    'Run ONE command per call -- do not chain with && or ; and do not use pipes into ' +
    'a shell, command substitution $(...) or backticks: commands that cannot be read ' +
    'statically are treated as high risk and will require approval. Prefer the most ' +
    'specific read-only command that answers your question. ' +
    'Do NOT prefix commands with sudo or su yourself: privilege elevation for this ' +
    'target is applied automatically by the platform, so write the plain command ' +
    '(e.g. "crontab -l", not "sudo crontab -l") -- adding your own sudo double-elevates ' +
    'and triggers a second password prompt that cannot be answered.',
  parameters: {
    command: {
      type: 'string',
      description:
        'The exact command to run, e.g. "systemctl status nginx" or "tail -n 100 /var/log/app.log".',
    },
    ...MUTATING_ARGS,
  },
  required: ['command', 'intent', 'expected_effect'],
  argsSchema: sshExecArgs,
  baselineRisk: 'read_only',
  targetKinds: ['ssh'],
  mutating: true,
  timeoutMs: 60_000,
  render: (args, target) => wrapCommand(target, args.command),
  execute: (args, ctx) => sshExec(wrapCommand(ctx.target, args.command), ctx),
};

const sshReadFileArgs = z.object({
  target: z.string(),
  path: z.string().min(1).max(1000),
  max_lines: z.number().int().min(1).max(2000).optional(),
});

/**
 * A separate tool for file reads. Splitting this out of `ssh_exec` keeps the common
 * case (look at a config or a log) a fixed, quoted `tail` that can never become
 * another command. It is classified exactly like that `tail`, so the sensitive-path
 * rules apply: reading a private key, a cloud credentials file or /etc/shadow waits
 * for a human. (It used to be read_only unconditionally, which let a secret be read
 * without anyone seeing it.)
 */
export const sshReadFileTool: ToolDef<z.infer<typeof sshReadFileArgs>> = {
  key: 'ssh_read_file',
  kind: 'ssh_exec',
  description:
    'Read a text file from a registered SSH target. Ordinary files (configs, logs) are ' +
    'read immediately; files that hold secrets (keys, credentials, password files) wait ' +
    'for approval. Prefer this over ssh_exec + cat when you just want to see a file.',
  parameters: {
    path: { type: 'string', description: 'Absolute path to the file to read.' },
    max_lines: {
      type: 'integer',
      description: 'How many lines from the end of the file to return. Defaults to 200.',
    },
  },
  required: ['path'],
  argsSchema: sshReadFileArgs,
  baselineRisk: 'read_only',
  targetKinds: ['ssh'],
  mutating: false,
  timeoutMs: 30_000,
  render: (args, target) => wrapCommand(target, `tail -n ${args.max_lines ?? 200} ${shellQuote(args.path)}`),
  classifyArgs: (args, target): RiskContribution[] =>
    classifyShellCommand(`tail -n ${args.max_lines ?? 200} ${shellQuote(args.path)}`, target).contributions,
  execute: (args, ctx) =>
    // The path is quoted and the verb is fixed, so this cannot become another
    // command no matter what the model puts in `path`.
    sshExec(wrapCommand(ctx.target, `tail -n ${args.max_lines ?? 200} ${shellQuote(args.path)}`), ctx),
};

const recordFindingArgs = z.object({
  target: z.string(),
  finding: z.string().min(1).max(2000),
  severity: z.enum(['info', 'notice', 'warning', 'critical']),
  reachable: z.boolean().optional(),
});

/** A no-side-effect way for the agent to put a conclusion on the timeline. */
export const recordFindingTool: ToolDef<z.infer<typeof recordFindingArgs>> = {
  key: 'record_finding',
  kind: 'internal',
  description:
    'Record a diagnostic conclusion on the run timeline. Has no side effects. Use this ' +
    'to state what you have established before you propose any action.',
  parameters: {
    finding: { type: 'string', description: 'What you have concluded, and the evidence for it.' },
    severity: {
      type: 'string',
      enum: ['info', 'notice', 'warning', 'critical'],
      description:
        'How serious this finding is. notice = minor or hygiene, not affecting what the ' +
        'machine does; warning/critical = an essential problem.',
    },
    reachable: {
      type: 'boolean',
      description: 'Set false only if you could not connect to the target at all.',
    },
  },
  required: ['finding', 'severity'],
  argsSchema: recordFindingArgs,
  baselineRisk: 'read_only',
  targetKinds: [...TARGET_KINDS],
  mutating: false,
  timeoutMs: 1_000,
  render: (args) => `record_finding(${args.severity}): ${args.finding}`,
  execute: async (args) => okOutput(`Finding recorded (${args.severity}).`),
};

const confirmTargetArgs = z.object({
  target: z.string(),
  plan: z.string().min(1).max(500),
  // The short to-do list for this run, shown live in the plan panel the moment the
  // target is confirmed -- so a multi-part task has a visible plan from the start,
  // even before the agent calls update_plan. Optional and back-compatible.
  steps: z.array(z.string().min(1).max(200)).max(12).optional(),
});

/**
 * Ask the operator to confirm WHICH machine to act on, before running anything.
 *
 * Used when a task could concern one of several machines behind a jump: the agent
 * deduces the single machine, calls this with a one-line plan, and it pauses for an
 * Approve/Reject decision exactly like any gated action -- no side effects of its
 * own. Baseline `medium` so it always gates (never auto-runs). Approval is the
 * signal to proceed on that machine; rejection carries a note to pick again.
 */
export const confirmTargetTool: ToolDef<z.infer<typeof confirmTargetArgs>> = {
  key: 'confirm_target',
  kind: 'internal',
  description:
    'Confirm which machine to work on BEFORE running anything, when the task could ' +
    'concern one of several machines (e.g. behind a jump). Deduce the single machine, ' +
    'call this with it, a one-line plan, and `steps`: the short to-do list you will work ' +
    'through (one entry per part of the task -- e.g. ["Check pod health", "List deployments", ' +
    '"Find unused images"]). It pauses for the operator to Approve or Reject, and the steps ' +
    'show in the plan panel immediately. Run no command on the machine until this is approved. ' +
    'If rejected, read the note and choose again.',
  parameters: {
    plan: {
      type: 'string',
      description: 'One line: what you will do on this machine, and why it is the right one.',
    },
    steps: {
      type: 'array',
      items: { type: 'string' },
      description: 'The to-do list for this task, one short entry per step, in order (at most 12).',
    },
  },
  required: ['plan'],
  argsSchema: confirmTargetArgs,
  baselineRisk: 'medium',
  targetKinds: ['ssh', 'k8s'],
  mutating: false,
  timeoutMs: 1_000,
  render: (args) => `Confirm target ${args.target}: ${args.plan}`,
  execute: async (args) => okOutput(`Confirmed. Proceed on ${args.target}.`),
};


const sshWriteFileArgs = z.object({
  target: z.string(),
  path: z.string().min(1).max(1000).startsWith('/', 'Use an absolute path'),
  content: z.string().max(256_000),
  intent: z.string().min(1).max(500),
  expected_effect: z.string().min(1).max(500),
});

/** A delimiter the content cannot contain, so it can never close the heredoc early. */
function heredocTag(content: string): string {
  let tag = 'SUPOPS_EOF';
  let n = 0;
  while (content.includes(tag)) tag = `SUPOPS_EOF_${(n += 1)}`;
  return tag;
}

const renderWrite = (args: { path: string; content: string }): string => {
  const tag = heredocTag(args.content);
  // Quoted delimiter: no expansion, no substitution. The content is data, and
  // cannot break out into the command no matter what the model puts in it.
  return `cat > ${shellQuote(args.path)} <<'${tag}'\n${args.content}\n${tag}`;
};

export const sshWriteFileTool: ToolDef<z.infer<typeof sshWriteFileArgs>> = {
  key: 'ssh_write_file',
  kind: 'ssh_exec',
  description:
    'Create or overwrite a text file on a registered SSH target. Overwrites the whole ' +
    'file -- read it first if you mean to edit rather than replace. Requires an ' +
    'absolute path. Writing outside the target\'s writable paths needs approval.',
  parameters: {
    path: { type: 'string', description: 'Absolute path of the file to write.' },
    content: { type: 'string', description: 'The complete new contents of the file.' },
    ...MUTATING_ARGS,
  },
  required: ['path', 'content', 'intent', 'expected_effect'],
  argsSchema: sshWriteFileArgs,
  baselineRisk: 'low',
  targetKinds: ['ssh'],
  mutating: true,
  timeoutMs: 30_000,
  render: (args, target) => wrapScript(target, renderWrite(args)),

  /**
   * Classified by destination, not by shell parsing: the rendered command is a
   * heredoc, and the lexer would treat every line of file content as its own
   * unrecognised command and fail closed at `high` for a one-line config change.
   */
  classifyArgs: (args, target: ResolvedTarget): RiskContribution[] => {
    if (isProtectedPath(args.path, target)) {
      return [{
        stage: 'arguments',
        tier: 'high',
        ruleId: 'write.protected',
        reason: `writing to a protected path (${args.path})`,
      }];
    }
    if (isWritablePath(args.path, target)) {
      return [{
        stage: 'arguments',
        tier: 'low',
        ruleId: 'write.writable',
        reason: `writing inside the target's writable paths (${args.path})`,
      }];
    }
    return [{
      stage: 'arguments',
      tier: 'medium',
      ruleId: 'write.file',
      reason: `overwriting ${args.path}`,
    }];
  },

  execute: (args, ctx) => sshExec(wrapScript(ctx.target, renderWrite(args)), ctx),
};

const kubectlArgs = z.object({
  target: z.string(),
  args: z.string().min(1).max(2000),
  intent: z.string().min(1).max(500),
  expected_effect: z.string().min(1).max(500),
});

const k8sOf = (t: ResolvedTarget) =>
  t.config.kind === 'k8s' ? t.config : { allowedNamespaces: [] as string[], defaultNamespace: undefined };

/**
 * kubectl against a cluster target, straight to its API server -- no VM in between.
 * Classified by the same kubectl ruleset `ssh_exec` uses for `kubectl ...` on a host,
 * so `get`/`describe`/`logs` run freely and `delete`/`apply`/`patch` wait for a human.
 */
export const kubectlTool: ToolDef<z.infer<typeof kubectlArgs>> = {
  key: 'k8s_kubectl',
  kind: 'k8s',
  description:
    'Run ONE kubectl command against a registered Kubernetes cluster target and return its output. ' +
    'Pass only the arguments after "kubectl", e.g. "get pods -n yta -o wide" or ' +
    '"logs deploy/api -n yta --tail=200". No pipes, ;, && or redirects (there is no shell). ' +
    'Snapshots only: no -w/--watch, no logs -f, no exec -it. ' +
    'Local files are not available: no -f/--filename, -k or --from-file; change objects with ' +
    'patch, set image, scale or rollout restart instead. Do not pass --context/--kubeconfig/--as: ' +
    'the target\'s own credential is always used. Reads run immediately; changes need approval.',
  parameters: {
    args: {
      type: 'string',
      description: 'kubectl arguments without the leading "kubectl", e.g. "get pods -A".',
    },
    ...MUTATING_ARGS,
  },
  required: ['args', 'intent', 'expected_effect'],
  argsSchema: kubectlArgs,
  baselineRisk: 'read_only',
  targetKinds: ['k8s'],
  mutating: true,
  timeoutMs: 60_000,
  render: (args) => `kubectl ${args.args.trim().replace(/^kubectl\s+/, '')}`,
  classifyArgs: (args, target): RiskContribution[] => {
    const plan = planKubectl(args.args, k8sOf(target));
    if (!plan.ok) {
      return [{ stage: 'arguments', tier: 'forbidden', ruleId: 'k8s.refused', reason: plan.reason }];
    }
    return classifyShellCommand(`kubectl ${args.args.trim().replace(/^kubectl\s+/, '')}`, target).contributions;
  },
  execute: (args, ctx) => kubectlExec(args.args, ctx),
};

export function createDefaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(sshExecTool as unknown as ToolDef<never>)
    .register(sshReadFileTool as unknown as ToolDef<never>)
    .register(runScriptTool as unknown as ToolDef<never>)
    .register(sshWriteFileTool as unknown as ToolDef<never>)
    .register(recordFindingTool as unknown as ToolDef<never>)
    .register(confirmTargetTool as unknown as ToolDef<never>)
    .register(kubectlTool as unknown as ToolDef<never>)
    .register(queryMetricsTool as unknown as ToolDef<never>)
    .register(queryLogsTool as unknown as ToolDef<never>)
    .register(queryTracesTool as unknown as ToolDef<never>)
    .register(dockerTool as unknown as ToolDef<never>)
    .register(scmTool as unknown as ToolDef<never>)
    .register(alertsTool as unknown as ToolDef<never>)
    .register(searchKnowledgeTool as unknown as ToolDef<never>)
    .register(readKnowledgeTool as unknown as ToolDef<never>)
    .register(readOutputTool as unknown as ToolDef<never>)
    .register(planTool as unknown as ToolDef<never>);
}

/** SupOps' own tools about the run itself, given to every run whatever the agent's tool list. */
export const SESSION_TOOL_KEYS = ['read_output', 'update_plan'];

/** Given to every run whose project has approved knowledge, whatever the agent's tool list. */
export const KNOWLEDGE_TOOL_KEYS = ['search_knowledge', 'read_knowledge'];

/** Read-only API tools for observability and source-control connections; advisory runs get these too. */
export const OBSERVABILITY_TOOL_KEYS = ['query_metrics', 'query_logs', 'query_traces', 'alerts', 'scm'];

export const BUILTIN_TOOL_KEYS = ['ssh_exec', 'ssh_read_file', 'run_script', 'docker', 'k8s_kubectl', 'query_metrics', 'query_logs', 'query_traces', 'alerts', 'scm', 'record_finding', 'confirm_target'];

/** The Console agent can also create files. */
export const CONSOLE_TOOL_KEYS = [
  'ssh_exec',
  'ssh_read_file',
  'ssh_write_file',
  'run_script',
  'k8s_kubectl',
  'record_finding',
  'confirm_target',
  'query_metrics',
  'query_logs',
  'alerts',
];
