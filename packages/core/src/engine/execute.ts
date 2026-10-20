import type { Db } from '@supops/db';
import type { ToolOutput } from '@supops/db';
import type { KnowledgeAccess, OutputAccess, ResolvedTarget, ResolvedTool } from '../tools/types.ts';
import { AnsiStripper, errOutput, redactSecrets, redactTokenPatterns, stripAnsi } from '../tools/output.ts';
import { pinHostKey, pinnedHostKey, resolveBecomeSecrets, resolveSecret } from './targets.ts';
import { hashArgs, targetFingerprint } from './canonical.ts';
import type { RunStore, ToolCallRow } from './store.ts';

export interface ExecuteDeps {
  db: Db;
  store: RunStore;
  killSwitchActive: (projectId: string) => boolean;
  maxOutputBytes: number;
  /** Live output for this call, if anyone is watching. */
  onChunk?: (chunk: string) => void;
}

export interface ExecuteParams {
  call: ToolCallRow;
  tool: ResolvedTool;
  target: ResolvedTarget;
  projectId: string;
  toolsSnapshotKeys: string[];
  signal: AbortSignal;
  /** For knowledge tools: the run's approved knowledge, scoped by the engine. */
  knowledge?: KnowledgeAccess;
  /** For read_output: this run's own earlier results. */
  outputs?: OutputAccess;
}

export class ToolExecutionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolExecutionRefused';
  }
}

/**
 * The single path to any executor.
 *
 * Individual executors are not exported from the package barrel, so this function
 * is the only way a command reaches a host. Every guarantee the product makes about
 * safety is re-checked here, immediately before dispatch, rather than being trusted
 * from whenever it was last established. In particular the `argsHash` check closes
 * the gap between "a human approved this" and "this ran": if anything altered the
 * arguments in between, we refuse rather than execute something nobody agreed to.
 */
export async function executeToolCall(
  deps: ExecuteDeps,
  params: ExecuteParams,
): Promise<ToolOutput> {
  const { call, tool, target, projectId, toolsSnapshotKeys, signal } = params;

  if (call.state !== 'auto_approved' && call.state !== 'approved') {
    throw new ToolExecutionRefused(
      `tool call ${call.toolCallId} is in state "${call.state}"; only auto_approved or approved may execute`,
    );
  }
  if (call.tier === 'forbidden') {
    throw new ToolExecutionRefused(
      `tool call ${call.toolCallId} is forbidden; no approval can authorise it`,
    );
  }
  if (hashArgs(call.argsJson) !== call.argsHash) {
    throw new ToolExecutionRefused(
      `arguments for ${call.toolCallId} changed after classification (hash mismatch); refusing to execute`,
    );
  }
  // Calls classified before fingerprints existed have none; everything newer must match.
  if (call.targetFingerprint && call.targetFingerprint !== targetFingerprint(target)) {
    throw new ToolExecutionRefused(
      `target "${target.slug}" was changed after ${call.toolCallId} was classified (config, credential or environment); refusing to execute`,
    );
  }
  if (!toolsSnapshotKeys.includes(call.toolKey)) {
    throw new ToolExecutionRefused(
      `tool "${call.toolKey}" is not in this run's frozen tool snapshot`,
    );
  }
  if (deps.killSwitchActive(projectId)) {
    throw new ToolExecutionRefused('the project kill switch is active');
  }
  if (signal.aborted) {
    throw new ToolExecutionRefused('the run was cancelled');
  }

  // Validate server-side. The model's schema is a lowest-common-denominator subset
  // that several backends only loosely honour, so this is where constraints are
  // actually enforced -- and a failure here is information for the agent, not a crash.
  const parsed = tool.def.argsSchema.safeParse(call.argsJson);
  if (!parsed.success) {
    return errOutput(
      `Invalid arguments for ${call.toolKey}: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}. Fix the arguments and try again.`,
    );
  }

  const secret = resolveSecret(deps.db, target);
  const becomeSecrets = resolveBecomeSecrets(deps.db, target);
  let withSecret: ResolvedTarget = secret ? { ...target, secret: secret.value } : target;
  if (becomeSecrets.length) withSecret = { ...withSecret, becomeSecrets };
  // Verify against the key pinned NOW, not the run's snapshot: an earlier call in
  // this very run may have pinned it on first contact.
  if (withSecret.config.kind === 'ssh') {
    const pinned = pinnedHostKey(deps.db, target.id);
    withSecret = { ...withSecret, config: { ...withSecret.config, hostKeyFingerprint: pinned } };
  }

  // started_at is written BEFORE dispatch so that a crash mid-command is detectable:
  // boot recovery sweeps `executing` to `unknown_outcome` rather than re-running it.
  deps.store.updateToolCall(call.id, { state: 'executing', startedAt: new Date() });

  // Terminal colour codes are removed from the live stream as well as the stored result.
  const ansi = new AnsiStripper();
  const onChunk = deps.onChunk;

  let output: ToolOutput;
  try {
    output = await tool.def.execute(parsed.data as never, {
      runId: call.runId,
      toolCallId: call.toolCallId,
      target: withSecret,
      timeoutMs: tool.def.timeoutFor ? tool.def.timeoutFor(parsed.data as never) : tool.def.timeoutMs,
      maxOutputBytes: deps.maxOutputBytes,
      signal,
      ...(params.knowledge ? { knowledge: params.knowledge } : {}),
      ...(params.outputs ? { outputs: params.outputs } : {}),
      ...(onChunk
        ? {
            onChunk: (chunk: string) => {
              const clean = ansi.push(chunk);
              if (clean) onChunk(clean);
            },
          }
        : {}),
      onNewHostKey: (fp) => pinHostKey(deps.db, target.id, fp),
    });
  } catch (err) {
    output = errOutput(
      `${call.toolKey} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Redact before the output is persisted or shown to the model. A single
  // `cat /etc/app/config.yml` would otherwise write a live credential into the run
  // transcript and ship it to a third-party API.
  const secrets = [
    ...(secret ? [secret] : []),
    ...becomeSecrets.map((b, i) => ({ id: `become-${i}`, value: b.value })),
  ];
  // Exact values first (the credentials SupOps holds), then well-known token shapes
  // for secrets the command happened to print.
  const text = stripAnsi(output.text);
  output = { ...output, text: redactTokenPatterns(secrets.length ? redactSecrets(text, secrets) : text) };
  return output;
}

