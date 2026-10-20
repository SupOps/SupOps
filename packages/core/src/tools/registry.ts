import { assertSchemaProfile } from '@supops/shared';
import type { JsonSchemaProfile, ToolSpec } from '@supops/shared';
import type { ResolvedTarget, ResolvedTool, ToolDef } from './types.ts';

/**
 * Bind a tool to a project's targets.
 *
 * This is where "project-agnostic" stops being a slogan. There is one `ssh_exec`
 * tool, never `ssh_exec__prod_web_1`: the target is an enum generated from what
 * this project has registered. A host in someone else's project is not merely
 * denied, it is unrepresentable in the tool schema -- which is the cheapest
 * enforcement available and costs nothing at runtime.
 *
 * The enum is a nudge, not a boundary. `validateArgs` re-checks the slug server-side,
 * because small models cheerfully invent enum values.
 */
export function bindTool(
  def: ToolDef<never>,
  targets: ResolvedTarget[],
): ResolvedTool | null {
  const eligible = def.fixedTarget ? [def.fixedTarget] : targets.filter((t) => def.targetKinds.includes(t.kind));
  // A tool with no target to act on is noise in the prompt, and every extra tool
  // measurably degrades tool-call accuracy on smaller models. Drop it.
  if (eligible.length === 0) return null;

  const properties: Record<string, JsonSchemaProfile> = {
    target: {
      type: 'string',
      enum: eligible.map((t) => t.slug),
      description:
        'Which registered target to act on. Available:\n' +
        eligible
          .map((t) => `- ${t.slug} (${t.kind}, env=${t.env})${t.description ? `: ${t.description}` : ''}`)
          .join('\n'),
    },
    ...def.parameters,
  };

  const parameters: JsonSchemaProfile = {
    type: 'object',
    properties,
    required: ['target', ...def.required],
  };

  // Fail at bind time, not at request time: a dropped constraint fails open.
  assertSchemaProfile(parameters, `${def.key}.parameters`);

  const spec: ToolSpec = {
    type: 'function',
    function: { name: def.key, description: def.description, parameters },
  };

  return {
    def,
    spec,
    targetsBySlug: new Map(eligible.map((t) => [t.slug, t])),
  };
}

/** Deterministic ordering keeps the serialised tool list stable across runs. */
export function bindTools(
  defs: ToolDef<never>[],
  targets: ResolvedTarget[],
): ResolvedTool[] {
  return defs
    .map((d) => bindTool(d, targets))
    .filter((t): t is ResolvedTool => t !== null)
    .sort((a, b) => a.def.key.localeCompare(b.def.key));
}

/**
 * The tool keys an agent actually gets. Agents saved before a tool existed receive it
 * through implication rather than a data migration: anything that may run commands
 * on machines (ssh_exec) may also run kubectl on clusters. One definition, used both
 * when a run starts and when it is resumed, so the two can never disagree.
 */
const IMPLIED_TOOLS: Record<string, string[]> = { ssh_exec: ['run_script', 'docker', 'k8s_kubectl', 'query_metrics', 'query_logs', 'query_traces', 'alerts', 'scm'], query_logs: ['query_traces'] };

export function effectiveToolKeys(keys: string[] | null): string[] | null {
  if (keys === null) return null;
  const out = [...keys];
  for (const k of keys) for (const extra of IMPLIED_TOOLS[k] ?? []) if (!out.includes(extra)) out.push(extra);
  return out;
}

export class ToolRegistry {
  private byKey = new Map<string, ToolDef<never>>();
  /**
   * Tools that come and go at runtime, in named groups (an MCP server's tools). Found
   * by `get` -- so a run started with one can resume -- but never part of `resolve` or
   * `keys`: an agent allowed "every tool" must not pick up another project's server.
   */
  private dynamic = new Map<string, ToolDef<never>>();
  private groups = new Map<string, string[]>();

  register(def: ToolDef<never>): this {
    if (this.byKey.has(def.key)) throw new Error(`Duplicate tool key "${def.key}"`);
    // Every tool that touches a system must have its arguments judged. The risk engine
    // falls back to the bare baseline when a tool has neither `classifyArgs` nor a
    // shell `command`, and that silently made a file read of a private key read_only.
    // Refuse such a tool at registration rather than let one ship.
    const shellCommand = def.kind === 'ssh_exec' && 'command' in def.parameters;
    if (def.kind !== 'internal' && !def.classifyArgs && !shellCommand) {
      throw new Error(`Tool "${def.key}" touches a system but has no argument classifier (classifyArgs)`);
    }
    this.byKey.set(def.key, def);
    return this;
  }

  get(key: string): ToolDef<never> | undefined {
    return this.byKey.get(key) ?? this.dynamic.get(key);
  }

  /** Replace a group of runtime tools (empty removes it). A key clash with a built-in is skipped. */
  setGroup(group: string, defs: ToolDef<never>[]): void {
    for (const k of this.groups.get(group) ?? []) this.dynamic.delete(k);
    const keys: string[] = [];
    for (const d of defs) {
      if (this.byKey.has(d.key) || this.dynamic.has(d.key)) continue;
      if (d.kind !== 'internal' && !d.classifyArgs) throw new Error(`Tool "${d.key}" touches a system but has no argument classifier (classifyArgs)`);
      this.dynamic.set(d.key, d);
      keys.push(d.key);
    }
    if (keys.length) this.groups.set(group, keys);
    else this.groups.delete(group);
  }

  group(group: string): ToolDef<never>[] {
    return (this.groups.get(group) ?? []).map((k) => this.dynamic.get(k)!).filter(Boolean);
  }

  /**
   * Resolve the effective allowlist. Deny by default: a tool the agent did not
   * explicitly list is not available, and an unknown key is an error rather than a
   * silent omission, because silently shipping fewer tools than intended is very
   * hard to notice from the outside.
   */
  resolve(allowedKeys: string[] | null): ToolDef<never>[] {
    const base =
      allowedKeys === null
        ? [...this.byKey.values()]
        : allowedKeys.map((k) => {
            const def = this.byKey.get(k);
            if (!def) throw new Error(`Agent references unknown tool "${k}"`);
            return def;
          });
    // Always-available tools an agent gets regardless of its allowlist. `confirm_target`
    // is a safety affordance (confirm which machine before acting), so agents created
    // before it existed still get it without editing their stored tool list.
    for (const key of ToolRegistry.MANDATORY) {
      const def = this.byKey.get(key);
      if (def && !base.some((d) => d.key === key)) base.push(def);
    }
    return base;
  }

  private static readonly MANDATORY = ['confirm_target'];

  keys(): string[] {
    return [...this.byKey.keys()];
  }
}
