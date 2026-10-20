import type { Observation, SimulationResult } from './types.ts';
import { unavailable } from './types.ts';
import { contributionsFrom } from './judge.ts';
import { assembleReport, notRun, type RawDetonation } from './detonate-report.ts';
import { redactTokenPatterns } from '../tools/output.ts';

/**
 * Detonation: run a SCRIPT the agent proposes (run_script, or a fetched `curl|sh`
 * payload) inside a throwaway sandbox on the SupOps side -- never on the target -- and
 * watch what it tries to do: what it reads, what it writes, where it connects, whether
 * it touches a planted credential canary. A script can read as "install a tool" and
 * actually open a reverse shell; static parsing can't see that, a detonation can.
 *
 * The sandbox and its container engine live in a SEPARATE process (`apps/detonator`)
 * that owns the Docker/gVisor socket -- the SupOps server, which holds every target
 * credential, must never get that socket. This module is only the client and the
 * judge; both are pure enough to test without Docker. Like the rest of shadow
 * execution it is raise-only and fails closed: no detonator, no sandbox, no risk
 * reduction.
 */

export interface DetonationReport {
  /** Whether the sandbox actually executed the script. */
  ran: boolean;
  engine: 'gvisor' | 'runc' | 'unavailable';
  exitCode: number | null;
  durationMs: number;
  /** The script's own output, already truncated by the runner. */
  stdout: string;
  /** DNS names the script looked up (from the loopback DNS sink). */
  dnsQueries: string[];
  /** Connections the script attempted (from the TCP sink); preview = first bytes seen. */
  connects: Array<{ host: string; port: number; preview?: string }>;
  filesCreated: string[];
  filesModified: string[];
  filesDeleted: string[];
  /** Canary credential files the script opened. */
  canaryReads: string[];
  /** A canary's contents were seen leaving on the wire: definitive exfiltration. */
  canaryExfil: boolean;
  /** Set when the sandbox could not run it (image missing, over budget...). */
  note?: string;
}

// --- The judge: a detonation report → raise-only observations -----------------

/** Writes here outlive the script: a backdoor, an autostart, a preloaded library. */
const PERSISTENCE = [
  /authorized_keys$/, /\/\.ssh\//, /\/etc\/cron/, /\/var\/spool\/cron/, /\/etc\/systemd\/system\//,
  /\/etc\/init\.d\//, /\/etc\/ld\.so\.(preload|conf)/, /\/etc\/rc\.local$/, /\/etc\/profile\.d\//,
  /\/\.(bashrc|bash_profile|profile|bash_login|zshrc)$/, /\/etc\/sudoers/, /\/etc\/passwd$/, /\/etc\/shadow$/,
];
/** Deleting these hides what happened. */
const ANTI_FORENSICS = [/\/var\/log\//, /\/\.bash_history$/, /\/var\/run\/utmp$/, /\/var\/log\/(auth|secure|wtmp|btmp)/];
/** Strings that give away a coin miner in the output or a looked-up name. */
const MINER = /\b(xmrig|minerd|stratum\+tcp|nanopool|supportxmr|minexmr|cryptonight|\.pool\.)\b/i;

const match = (paths: string[], res: RegExp[]) => paths.filter((p) => res.some((re) => re.test(p)));
const cap = (xs: string[], n = 8) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;

/**
 * Turn what the sandbox saw into observations. The dangerous combinations become
 * raise-only risk; a connection to the planted-credential canary leaving the box is
 * the clearest signal there is, so it is forbidden outright.
 */
export function judgeDetonation(report: DetonationReport): { observations: Observation[]; blindSpots: string[] } {
  const observations: Observation[] = [];
  if (!report.ran) return { observations: [], blindSpots: [report.note ?? 'the script was not detonated'] };

  const persistence = [...new Set([...match(report.filesCreated, PERSISTENCE), ...match(report.filesModified, PERSISTENCE)])];
  const antiForensics = match(report.filesDeleted, ANTI_FORENSICS);
  const minerHit = MINER.test(report.stdout) || report.dnsQueries.some((d) => MINER.test(d));

  // Exfiltration: a credential canary's contents left the box, or it read a canary and
  // then reached the network. Nothing legitimate does this; it is never approvable.
  if (report.canaryExfil || (report.canaryReads.length && report.connects.length)) {
    observations.push({
      kind: 'exfil',
      detail: `it read a credential file (${cap(report.canaryReads.length ? report.canaryReads : ['a planted canary'])}) and sent data to the network`,
      raise: { tier: 'forbidden', category: 'exfiltration', reason: 'the script reads a credential and sends it out -- data exfiltration' },
    });
  }
  // Any outbound attempt from a script run in a no-network sandbox: it would reach out
  // if it could. A reverse shell and a silent downloader both look like this.
  if (report.connects.length) {
    const where = report.connects.slice(0, 5).map((c) => `${c.host}:${c.port}`).join(', ');
    const hasExfil = observations.some((o) => o.kind === 'exfil');
    observations.push({
      kind: 'net.connect',
      detail: `it tries to reach the network: ${where}${report.connects.length > 5 ? '…' : ''}`,
      ...(hasExfil ? {} : { raise: { tier: 'high' as const, category: 'code-execution' as const, reason: `the script reaches out to ${where}, which its text did not make obvious` } }),
    });
  }
  if (persistence.length) {
    observations.push({
      kind: 'persistence',
      detail: `it installs something that outlives the run: ${cap(persistence)}`,
      raise: { tier: 'high', category: 'persistence', reason: `the script writes a persistence location (${cap(persistence, 3)})` },
    });
  }
  if (antiForensics.length) {
    observations.push({
      kind: 'anti-forensics',
      detail: `it deletes logs or history: ${cap(antiForensics)}`,
      raise: { tier: 'high', category: 'anti-forensics', reason: 'the script erases logs or shell history, hiding what it did' },
    });
  }
  if (minerHit) {
    observations.push({ kind: 'miner', detail: 'it shows the marks of a coin miner (mining pool or miner binary)', raise: { tier: 'high', category: 'resource', reason: 'the script looks like a coin miner' } });
  }
  // Informational: ordinary writes, so the panel is never empty on a clean-but-busy run.
  const otherWrites = [...report.filesCreated, ...report.filesModified].filter((p) => !PERSISTENCE.some((re) => re.test(p)));
  if (otherWrites.length && !observations.length) observations.push({ kind: 'file.write', detail: `it writes ${otherWrites.length} file${otherWrites.length === 1 ? '' : 's'}: ${cap(otherWrites)}` });
  if (!observations.length) observations.push({ kind: 'clean', detail: `ran to exit ${report.exitCode}; no network, no persistence, no credential access observed` });

  return {
    observations,
    blindSpots: [
      'the sandbox is a copy of a generic host, not this target, so paths and services may differ',
      'a payload can detect a sandbox and lie low; a clean detonation is not proof of safety',
    ],
  };
}

// --- The client: talk to the detonator, then judge ----------------------------

/** Tools whose argument is a script body worth detonating. */
export function detonationScript(toolKey: string, args: Record<string, unknown>): { interpreter: string; script: string } | null {
  if (toolKey === 'run_script' && typeof args.script === 'string') {
    return { interpreter: typeof args.interpreter === 'string' ? args.interpreter : 'bash', script: args.script };
  }
  return null;
}

const DETONATOR_URL = () => process.env.SUPOPS_DETONATOR_URL?.trim() || null;

/**
 * Detonate one script and return a raise-only simulation result. The detonator URL is
 * a loopback service SupOps operates; when it is not set, detonation is unavailable and
 * nothing is added (fail closed).
 */
export async function detonate(input: { interpreter: string; script: string; signal: AbortSignal; timeoutMs?: number }): Promise<SimulationResult> {
  const url = DETONATOR_URL();
  if (!url) return unavailable('detonator', 'no detonation sandbox is configured (SUPOPS_DETONATOR_URL)');
  const started = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/detonate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interpreter: input.interpreter, script: input.script, timeoutSec: Math.round((input.timeoutMs ?? 20_000) / 1000) }),
      signal: input.signal,
    });
    if (!res.ok) return { status: 'error', simulator: 'detonate', note: `the detonator answered ${res.status}`, observations: [], contributions: [], ms: Date.now() - started };
    // The detonator is dumb: on success it returns the raw container outputs under
    // `raw`, which core assembles and judges; on failure it returns `{ error }`. All
    // the security-relevant parsing and judging stays here, where it is tested.
    const body = (await res.json()) as { raw?: RawDetonation; error?: string };
    const report = body.raw ? assembleReport(body.raw) : notRun(body.error ?? 'the sandbox did not run the script');
    const { observations, blindSpots } = judgeDetonation(report);
    // The script's output can carry secrets; mask well-known token shapes before it is stored/shown.
    const safe = observations.map((o) => ({ ...o, detail: redactTokenPatterns(o.detail) }));
    return {
      status: report.ran ? 'observed' : 'unavailable',
      simulator: `detonate/${report.engine}`,
      command: `${input.interpreter} script (${input.script.split('\n').length} lines):\n${input.script.slice(0, 4000)}`,
      ...(report.note && !report.ran ? { note: report.note } : {}),
      observations: safe,
      blindSpots,
      contributions: contributionsFrom(`detonate/${report.engine}`, safe),
      ms: Date.now() - started,
    };
  } catch (err) {
    return { status: 'error', simulator: 'detonate', note: `the detonator could not be reached: ${err instanceof Error ? err.message : String(err)}`, observations: [], contributions: [], ms: Date.now() - started };
  }
}
