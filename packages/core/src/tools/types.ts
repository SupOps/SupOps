import type { z } from 'zod';
import type {
  JsonSchemaProfile,
  RiskContribution,
  RiskTier,
  TargetKind,
  ToolSpec,
} from '@supops/shared';
import type { TargetConfig, ToolOutput } from '@supops/db';

/** A registered connection, resolved for execution. */
export interface ResolvedTarget {
  id: string;
  slug: string;
  kind: TargetKind;
  env: string;
  sensitivity: number;
  description: string | null;
  config: TargetConfig;
  credentialId: string | null;
  protectedPaths: string[] | null;
  writablePaths: string[] | null;
  unitAllowlist: string[] | null;
  /** Decrypted at the last moment, held only for this call frame. */
  secret?: string;
  /**
   * Elevation passwords keyed by the sudo/su account each is for, decrypted for
   * this call frame only. `user: ''` is the wildcard/default. The executor reads
   * sudo's prompt and picks the matching one at runtime.
   */
  becomeSecrets?: Array<{ user: string; value: string }>;
}

/** Read-only access to a run's approved knowledge, supplied by the engine (see tools/knowledge.ts). */
export interface KnowledgeAccess {
  search(query: string): Array<{ slug: string; title: string; kind: string; snippet: string }>;
  read(slug: string): { slug: string; title: string; kind: string; body: string; source: string | null } | null;
}

/** A run's own earlier tool results, in full (see tools/read-output.ts). */
export interface OutputAccess {
  read(toolCallId: string): { toolKey: string; rendered: string; text: string } | null;
}

export interface ExecContext {
  /** Only for knowledge tools; absent elsewhere. */
  knowledge?: KnowledgeAccess;
  /** Only for read_output; absent elsewhere. */
  outputs?: OutputAccess;
  runId: string;
  toolCallId: string;
  target: ResolvedTarget;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
  /**
   * Live output, as it arrives. Best-effort and never persisted -- a 200MB
   * `journalctl` must not become 200MB of database rows. Already redacted.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Called with the server's host key fingerprint on the first connection to a
   * target that has none pinned (trust on first use), so the caller can store it.
   * Later connections must match `config.hostKeyFingerprint` or are refused.
   */
  onNewHostKey?: (fingerprint: string) => void;
}

/**
 * A tool the model can call.
 *
 * The split between `parameters` (what the model is shown) and `argsSchema` (what
 * the server enforces) is deliberate and load-bearing. Gemini accepts only a
 * subset of JSON Schema and local models honour even less, so `parameters` is the
 * lowest common denominator and every real constraint is re-checked in zod. A
 * constraint that exists only in `parameters` is a constraint that fails open.
 */
export interface ToolDef<TArgs = Record<string, unknown>> {
  key: string;
  kind: 'ssh_exec' | 'docker' | 'k8s' | 'http' | 'knowledge' | 'internal';
  description: string;
  /** Excludes `target` -- the registry injects that as a project-scoped enum. */
  parameters: Record<string, JsonSchemaProfile>;
  required: string[];
  argsSchema: z.ZodType<TArgs>;
  /** Floor, never a ceiling. Argument rules and target sensitivity can only raise it. */
  baselineRisk: RiskTier;
  targetKinds: TargetKind[];
  /**
   * Acts only on this one target, never on the project's (MCP tools: the call is made
   * from the SupOps server). Overrides targetKinds when binding.
   */
  fixedTarget?: ResolvedTarget;
  /** Mutating tools must declare intent/expected_effect and get a verification probe. */
  mutating: boolean;
  timeoutMs: number;
  /** Per-call time limit when it depends on the arguments (a long terraform apply vs a quick read). */
  timeoutFor?: (args: TArgs) => number;
  /**
   * The exact thing that will run, shell-quoted, secrets masked. Feeds both the
   * risk classifier and the approval card -- so what gets classified and what a
   * human reads are guaranteed to be the same string.
   */
  render: (args: TArgs, target: ResolvedTarget) => string;
  /**
   * Tool-specific risk, for tools whose arguments are not a shell command.
   * `ssh_write_file` renders a heredoc, and feeding that to the shell lexer would
   * classify every line of file content as its own unknown command. Raise-only,
   * like every other stage.
   */
  classifyArgs?: (args: TArgs, target: ResolvedTarget) => RiskContribution[];
  execute: (args: TArgs, ctx: ExecContext) => Promise<ToolOutput>;
}

/** A ToolDef bound to one project's targets: what actually goes on the wire. */
export interface ResolvedTool {
  def: ToolDef<never>;
  spec: ToolSpec;
  targetsBySlug: Map<string, ResolvedTarget>;
}
