import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * The container glue for the detonation sandbox. This process owns the Docker/gVisor
 * socket; the SupOps server (which holds every target credential) never does. The
 * runner is deliberately DUMB: it runs the script in a locked-down throwaway container,
 * collects the RAW outputs (`docker diff`, the DNS and TCP sink logs, which canaries
 * were opened), and returns them. All parsing and judging happens in `@supops/core`,
 * where it is unit-tested; nothing here needs to be trusted to interpret a payload.
 *
 * NOTE: the `docker` invocations below require Docker (ideally with the gVisor
 * `runsc` runtime) and the sink network from `docker-compose.yml`. They are not
 * exercised in environments without Docker; `buildRunArgs` and `validate` are pure and
 * are unit-tested.
 */

export type Interpreter = 'bash' | 'sh' | 'python3';
export const INTERPRETERS: Interpreter[] = ['bash', 'sh', 'python3'];
export const MAX_SCRIPT_BYTES = 64 * 1024;

export interface DetonateRequest {
  interpreter: Interpreter;
  script: string;
  timeoutSec: number;
}

/** A clean request, or the reason it was rejected. Pure; unit-tested. */
export function validate(body: unknown): { ok: true; req: DetonateRequest } | { ok: false; error: string } {
  const b = body as Partial<DetonateRequest> | null;
  if (!b || typeof b !== 'object') return { ok: false, error: 'a JSON body is required' };
  if (!INTERPRETERS.includes(b.interpreter as Interpreter)) return { ok: false, error: `interpreter must be one of ${INTERPRETERS.join(', ')}` };
  if (typeof b.script !== 'string' || !b.script) return { ok: false, error: 'script is required' };
  if (Buffer.byteLength(b.script) > MAX_SCRIPT_BYTES) return { ok: false, error: `script is larger than ${MAX_SCRIPT_BYTES / 1024} KB` };
  const timeoutSec = Math.min(120, Math.max(5, Math.round(Number(b.timeoutSec) || 20)));
  return { ok: true, req: { interpreter: b.interpreter as Interpreter, script: b.script, timeoutSec } };
}

export interface SandboxSpec {
  image: string;
  runsc: boolean;
  network: string;
  scriptPath: string;
  interpreter: Interpreter;
  memoryMb: number;
  pidsLimit: number;
  timeoutSec: number;
  name: string;
}

/** The `docker run` arguments for one detonation. Pure; unit-tested for its hardening. */
export function buildRunArgs(s: SandboxSpec): string[] {
  return [
    'run', '--name', s.name,
    ...(s.runsc ? ['--runtime', 'runsc'] : []),
    '--network', s.network,
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(s.pidsLimit),
    '--memory', `${s.memoryMb}m`, '--memory-swap', `${s.memoryMb}m`,
    '--cpus', '1',
    '-v', `${s.scriptPath}:/script:ro`,
    s.image,
    'timeout', '-k', '5', String(s.timeoutSec), s.interpreter, '/script',
  ];
}

/** The unique markers planted in the sandbox image's canary files (see Dockerfile.sandbox). */
export const CANARY_TOKENS = (process.env.SUPOPS_CANARY_TOKENS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const CANARY_FILES = ['/root/.ssh/id_rsa', '/root/.aws/credentials', '/etc/shadow'];

const run = (cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });

export interface Config {
  image: string;
  network: string;
  runsc: boolean;
  dockerBin: string;
  /** Reads the DNS/TCP sink logs for a given run tag; provided by the compose setup. */
  readSinkLogs: (tag: string) => Promise<{ dnsLog: string; tcpLog: string }>;
}

/**
 * Run one script in the sandbox and return the RAW outputs. Requires Docker.
 * Returns `{ error }` when it cannot run, so the caller (core) fails closed.
 */
export async function detonateWithDocker(req: DetonateRequest, cfg: Config): Promise<{ raw: Record<string, unknown> } | { error: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'detonate-'));
  const scriptPath = join(dir, 'script');
  const name = `detonate-${randomBytes(6).toString('hex')}`;
  const started = Date.now();
  try {
    await writeFile(scriptPath, req.script, { mode: 0o444 });
    const spec: SandboxSpec = { image: cfg.image, runsc: cfg.runsc, network: cfg.network, scriptPath, interpreter: req.interpreter, memoryMb: 512, pidsLimit: 256, timeoutSec: req.timeoutSec, name };
    const runResult = await run(cfg.dockerBin, buildRunArgs(spec), (req.timeoutSec + 15) * 1000);
    // The container is kept (no --rm) so its writable layer can be diffed, then removed.
    const diff = await run(cfg.dockerBin, ['diff', name], 15_000);
    const opened = await run(cfg.dockerBin, ['logs', name], 10_000); // the open-logger writes canary opens to stderr with a prefix
    const sinks = await cfg.readSinkLogs(name).catch(() => ({ dnsLog: '', tcpLog: '' }));
    await run(cfg.dockerBin, ['rm', '-f', name], 10_000);
    const canaryOpened = opened.out.split('\n').filter((l) => l.startsWith('CANARY-OPEN ')).map((l) => l.slice('CANARY-OPEN '.length).trim());
    return {
      raw: {
        engine: cfg.runsc ? 'gvisor' : 'runc',
        exitCode: runResult.code,
        durationMs: Date.now() - started,
        stdout: runResult.out.slice(0, 20_000),
        dockerDiff: diff.out,
        dnsLog: sinks.dnsLog,
        tcpLog: sinks.tcpLog,
        canaryOpened,
        canaryTokens: CANARY_TOKENS,
      },
    };
  } catch (err) {
    return { error: `the sandbox could not run the script: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Whether the gVisor runtime is available, so the server can prefer it. */
export async function hasRunsc(dockerBin: string): Promise<boolean> {
  const r = await run(dockerBin, ['info', '--format', '{{json .Runtimes}}'], 10_000);
  return /runsc/.test(r.out);
}

