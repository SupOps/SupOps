import type { Db } from '@supops/db';
import type { ResolvedTarget, ResolvedTool } from '../tools/types.ts';
import { resolveBecomeSecrets, resolveSecret, pinnedHostKey, pinHostKey } from '../engine/targets.ts';
import { sshExec } from '../tools/executors/ssh.ts';
import { kubectlExec, planKubectl } from '../tools/executors/kubectl.ts';
import { kubectlAdapter, planKubectlDryRun, planSshDryRun } from './adapters.ts';
import { contributionsFrom } from './judge.ts';
import { detonate, detonationScript } from './detonate.ts';
import { buildShadowHelper, buildShadowProbe, judgeShadow, parseShadowProbe, parseShadowReport, type ShadowCapability } from './shadow.ts';
import type { SimulationResult } from './types.ts';
import { skipped, unavailable } from './types.ts';

/** Whether the target-side shadow is enabled (off unless explicitly turned on). */
const shadowEnabled = () => process.env.SUPOPS_TARGET_SHADOW === 'on';
/** What each target supports, probed once per process (capabilities rarely change). */
const shadowCap = new Map<string, ShadowCapability>();
/** The inline helper must fit comfortably under Linux's single-argument limit. */
const MAX_INLINE_BYTES = 100 * 1024;

/**
 * Run the native dry-run simulator for one classified call, before it is approved.
 *
 * It is pure until an adapter matches: if no dry-run applies, it returns `skipped`
 * with no I/O at all, so classifying an ordinary command costs nothing. When an
 * adapter does match, it resolves the target's credential exactly as the real
 * executor does, runs the READ-ONLY preview command, and reports what it saw. Every
 * contribution it returns only raises risk; a clean preview never lowers anything.
 */
export interface SimulateInput {
  db: Db;
  tool: ResolvedTool;
  target: ResolvedTarget;
  args: Record<string, unknown>;
  runId: string;
  toolCallId: string;
  signal: AbortSignal;
  /** Hard ceiling on how long a preview may take. */
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export async function simulate(input: SimulateInput): Promise<SimulationResult> {
  const { db, tool, target, args } = input;
  const started = Date.now();
  const timeoutMs = input.timeoutMs ?? 20_000;
  const maxOutputBytes = input.maxOutputBytes ?? 256 * 1024;

  // A script the agent wrote: detonate it in a throwaway sandbox on the SupOps side,
  // never on the target, and see what it actually tries to do.
  const toDetonate = detonationScript(tool.def.key, args);
  if (toDetonate) return detonate({ ...toDetonate, signal: input.signal, timeoutMs });

  // Decide what to run -- pure, no I/O. Nothing matched ⇒ skip instantly.
  let plan: { kind: 'ssh'; preview: string; simulator: string } | { kind: 'kubectl'; argvString: string; simulator: string } | { kind: 'shadow'; command: string } | null = null;
  if (tool.def.kind === 'ssh_exec' && target.config.kind === 'ssh' && typeof args.command === 'string') {
    const m = planSshDryRun(args.command);
    if (m) plan = { kind: 'ssh', preview: m.preview, simulator: m.adapter.id };
    // No native dry-run for this command: run the real thing in a copy-on-write shadow
    // on the target, if the shadow is turned on (it executes real code, so it is off by
    // default and gated on a security review of the isolation profile).
    else if (shadowEnabled()) plan = { kind: 'shadow', command: args.command };
    else return skipped('no native dry-run applies to this command yet');
  } else if (tool.def.key === 'k8s_kubectl' && target.config.kind === 'k8s' && typeof args.args === 'string') {
    const planned = planKubectl(args.args, target.config);
    if (!planned.ok) return skipped('the kubectl arguments could not be read for a dry run');
    const dry = planKubectlDryRun(planned.argv);
    if (!dry) return skipped('this kubectl command is not a server dry-run candidate');
    plan = { kind: 'kubectl', argvString: dry.join(' '), simulator: kubectlAdapter.id };
  } else {
    return skipped('no native dry-run applies to this action yet');
  }

  // Resolve the credential the same way executeToolCall does.
  const secret = resolveSecret(db, target);
  const becomeSecrets = resolveBecomeSecrets(db, target);
  let withSecret: ResolvedTarget = secret ? { ...target, secret: secret.value } : target;
  if (becomeSecrets.length) withSecret = { ...withSecret, becomeSecrets };
  if (withSecret.config.kind === 'ssh') {
    withSecret = { ...withSecret, config: { ...withSecret.config, hostKeyFingerprint: pinnedHostKey(db, target.id) } };
  }
  const ctx = {
    runId: input.runId,
    toolCallId: `${input.toolCallId}#sim`,
    target: withSecret,
    timeoutMs,
    maxOutputBytes,
    signal: input.signal,
    onNewHostKey: (fp: string) => pinHostKey(db, target.id, fp),
  };

  try {
    if (plan.kind === 'ssh') {
      const out = await sshExec(plan.preview, ctx);
      const adapter = planSshDryRun(args.command as string)!.adapter;
      const { observations, blindSpots } = adapter.interpret(out.text, out.exitCode ?? -1);
      return done(plan.simulator, observations, blindSpots, started, plan.preview);
    }
    if (plan.kind === 'shadow') {
      // Probe once what the target can do; no bubblewrap or overlayfs ⇒ no shadow.
      let cap = shadowCap.get(target.id);
      if (!cap) { cap = parseShadowProbe((await sshExec(buildShadowProbe(), ctx)).text); shadowCap.set(target.id, cap); }
      if (!cap.bwrap || !cap.overlay || !cap.strace) return unavailable('shadow', `this target cannot run the shadow sandbox (${!cap.bwrap ? 'no bubblewrap' : !cap.overlay ? 'no overlayfs' : 'no strace'})`);
      const helper = buildShadowHelper(plan.command);
      if (Buffer.byteLength(helper) > MAX_INLINE_BYTES) return unavailable('shadow', 'the command is too large to shadow inline');
      const report = parseShadowReport((await sshExec(helper, ctx)).text);
      const { observations, blindSpots } = judgeShadow(report);
      return { status: report.ran && observations.length ? 'observed' : 'unavailable', simulator: 'shadow', command: plan.command, ...(report.ran ? {} : { note: report.note ?? 'the shadow did not run' }), observations, blindSpots, contributions: contributionsFrom('shadow', observations), ms: Date.now() - started };
    }
    const out = await kubectlExec(plan.argvString, ctx);
    const { observations, blindSpots } = kubectlAdapter.interpret(out.text, out.exitCode ?? -1);
    return done(plan.simulator, observations, blindSpots, started, `kubectl ${plan.argvString}`);
  } catch (err) {
    const simulator = plan.kind === 'shadow' ? 'shadow' : plan.simulator;
    return { status: 'error', simulator, note: `the simulation could not complete: ${err instanceof Error ? err.message : String(err)}`, observations: [], contributions: [], ms: Date.now() - started };
  }
}

function done(simulator: string, observations: SimulationResult['observations'], blindSpots: string[] | undefined, started: number, command?: string): SimulationResult {
  return {
    status: observations.length ? 'observed' : 'unavailable',
    simulator,
    ...(command ? { command } : {}),
    observations,
    ...(blindSpots?.length ? { blindSpots } : {}),
    contributions: contributionsFrom(simulator, observations),
    ms: Date.now() - started,
  };
}
