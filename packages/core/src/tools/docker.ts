import { z } from 'zod';
import type { ToolOutput } from '@supops/db';
import type { ExecContext, ResolvedTarget, ToolDef } from './types.ts';
import { errOutput, okOutput, truncateOutput } from './output.ts';
import { shellQuote, wrapCommand } from './become.ts';
import { sshExec } from './executors/ssh.ts';
import { classifyShellCommand } from '../risk/shell.ts';

/**
 * Containers on a machine, through fixed docker commands over SSH. The reads condense
 * docker's JSON into what an investigation needs (why did it restart, was it OOM-killed,
 * is it healthy, what happened lately) and `inspect` never brings back environment
 * values: docker's own template selects the fields on the host. Each command is
 * classified by the same shell rules as typing it into ssh_exec, so a restart waits
 * for approval like any other change.
 */

const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/;
const SINCE = /^(\d+[smhd]|\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2}))$/;
const OPS = ['ps', 'inspect', 'logs', 'stats', 'events', 'restart', 'start', 'stop'] as const;

const args = z
  .object({
    target: z.string(),
    operation: z.enum(OPS),
    container: z.string().regex(CONTAINER, 'a container name or id').optional(),
    tail: z.number().int().min(1).max(2000).optional(),
    since: z.string().regex(SINCE, 'like 30m, 2h, 1d or an RFC3339 time').optional(),
    intent: z.string().max(500).optional(),
    expected_effect: z.string().max(500).optional(),
  })
  .superRefine((a, ctx) => {
    if (['inspect', 'logs', 'restart', 'start', 'stop'].includes(a.operation) && !a.container) ctx.addIssue({ code: 'custom', path: ['container'], message: `${a.operation} needs a container` });
  });
type Args = z.infer<typeof args>;

/** Only the fields an investigation uses; Config.Env reduced to its names. */
const INSPECT_FORMAT =
  '{"Name":{{json .Name}},"Image":{{json .Config.Image}},"Created":{{json .Created}},"State":{{json .State}},"RestartCount":{{.RestartCount}},' +
  '"RestartPolicy":{{json .HostConfig.RestartPolicy}},"Memory":{{.HostConfig.Memory}},"NanoCpus":{{.HostConfig.NanoCpus}},"OomKillDisable":{{json .HostConfig.OomKillDisable}},' +
  '"Mounts":{{json .Mounts}},"Ports":{{json .NetworkSettings.Ports}},"Networks":{{json .NetworkSettings.Networks}},' +
  '"EnvNames":[{{range $i, $e := .Config.Env}}{{if $i}},{{end}}{{json (index (split $e "=") 0)}}{{end}}]}';

export function dockerCommand(a: Args): string {
  const c = a.container ? shellQuote(a.container) : '';
  switch (a.operation) {
    case 'ps':
      return `docker ps -a --no-trunc --format ${shellQuote('{{json .}}')}`;
    case 'inspect':
      return `docker inspect --type container --format ${shellQuote(INSPECT_FORMAT)} ${c}`;
    case 'logs':
      return `docker logs --timestamps --tail ${a.tail ?? 200}${a.since ? ` --since ${shellQuote(a.since)}` : ''} ${c}`;
    case 'stats':
      return `docker stats --no-stream --no-trunc --format ${shellQuote('{{json .}}')}${a.container ? ` ${c}` : ''}`;
    case 'events':
      return `docker events --since ${shellQuote(a.since ?? '1h')} --until 0s --filter type=container${a.container ? ` --filter ${shellQuote(`container=${a.container}`)}` : ''} --format ${shellQuote('{{json .}}')}`;
    default:
      return `docker ${a.operation} ${c}`;
  }
}

/** sshExec's text: "[exit N]", stdout, then "[stderr]" and stderr when there was any. */
export function splitOutput(text: string): { stdout: string; stderr: string } {
  const body = text.replace(/^\[exit -?\d+\]\n?/, '');
  const at = body.indexOf('\n[stderr]\n');
  return at < 0 ? { stdout: body, stderr: '' } : { stdout: body.slice(0, at), stderr: body.slice(at + 10) };
}

const jsonLines = (s: string): Array<Record<string, unknown>> =>
  s.split('\n').flatMap((l) => {
    try {
      const v = JSON.parse(l) as unknown;
      return v && typeof v === 'object' ? [v as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });

const bytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GiB` : `${Math.round(n / (1 << 20))} MiB`);
const ago = (iso: string, now: number) => {
  const t = Date.parse(iso);
  if (!t || t < 0 || iso.startsWith('0001')) return null;
  const m = Math.round((now - t) / 60_000);
  return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function summarisePs(stdout: string): string {
  const rows = jsonLines(stdout);
  if (!rows.length) return 'No containers.';
  const order = (s: string) => (/restarting|dead|exited \([1-9]/i.test(s) ? 0 : /unhealthy/i.test(s) ? 1 : /exited/i.test(s) ? 3 : 2);
  rows.sort((a, b) => order(String(a.Status)) - order(String(b.Status)));
  return [`${rows.length} containers (trouble first):`, ...rows.map((r) => `${r.Names} · ${r.Image} · ${r.Status}${r.Ports ? ` · ${r.Ports}` : ''}`)].join('\n');
}

export function summariseInspect(stdout: string, now = Date.now()): string {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'));
  if (!line) return stdout.trim() || 'docker inspect returned nothing.';
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return 'Could not read docker inspect output.';
  }
  const st = (d.State ?? {}) as { Status?: string; Running?: boolean; Restarting?: boolean; OOMKilled?: boolean; ExitCode?: number; Error?: string; StartedAt?: string; FinishedAt?: string; Health?: { Status?: string; FailingStreak?: number; Log?: Array<{ ExitCode?: number; Output?: string; End?: string }> } };
  const policy = (d.RestartPolicy ?? {}) as { Name?: string; MaximumRetryCount?: number };
  const out = [
    `${String(d.Name ?? '').replace(/^\//, '')} (${String(d.Image)})`,
    `State: ${st.Status}${st.Restarting ? ' (restarting)' : ''}; started ${ago(st.StartedAt ?? '', now) ?? 'never'}${st.FinishedAt && ago(st.FinishedAt, now) ? `; last stopped ${ago(st.FinishedAt, now)}` : ''}`,
    `Last exit: code ${st.ExitCode ?? '?'}${st.OOMKilled ? ' -- KILLED FOR RUNNING OUT OF MEMORY (OOM)' : st.ExitCode === 137 ? ' (killed: SIGKILL, e.g. docker kill or the kernel)' : st.ExitCode === 143 ? ' (stopped: SIGTERM)' : ''}${st.Error ? `; error: ${st.Error}` : ''}`,
    `Restarts: ${d.RestartCount ?? 0}; restart policy ${policy.Name || 'no'}${policy.MaximumRetryCount ? ` (max ${policy.MaximumRetryCount})` : ''}`,
    `Limits: memory ${Number(d.Memory) ? bytes(Number(d.Memory)) : 'none'}; CPU ${Number(d.NanoCpus) ? `${Number(d.NanoCpus) / 1e9} cores` : 'none'}`,
  ];
  if (st.Health) {
    const last = st.Health.Log?.at(-1);
    out.push(`Health: ${st.Health.Status}${st.Health.FailingStreak ? `, failing ${st.Health.FailingStreak} checks in a row` : ''}${last ? `; last check exit ${last.ExitCode}: ${String(last.Output ?? '').trim().slice(0, 300)}` : ''}`);
  }
  const ports = Object.entries((d.Ports ?? {}) as Record<string, Array<{ HostIp: string; HostPort: string }> | null>).map(([p, b]) => (b?.length ? `${b.map((x) => `${x.HostIp || '*'}:${x.HostPort}`).join(',')}->${p}` : p));
  if (ports.length) out.push(`Ports: ${ports.join(', ')}`);
  const mounts = ((d.Mounts ?? []) as Array<{ Source?: string; Destination?: string; RW?: boolean }>).map((m) => `${m.Source}:${m.Destination}${m.RW === false ? ':ro' : ''}`);
  if (mounts.length) out.push(`Mounts: ${mounts.join(', ')}`);
  const nets = Object.keys((d.Networks ?? {}) as object);
  if (nets.length) out.push(`Networks: ${nets.join(', ')}`);
  const env = (d.EnvNames ?? []) as string[];
  if (env.length) out.push(`Environment variables (names only): ${env.join(', ')}`);
  return out.join('\n');
}

export function summariseStats(stdout: string): string {
  const rows = jsonLines(stdout);
  if (!rows.length) return 'No running containers.';
  const pct = (v: unknown) => Number(String(v ?? '0').replace('%', '')) || 0;
  rows.sort((a, b) => pct(b.MemPerc) - pct(a.MemPerc));
  return [`${rows.length} running (by memory use):`, ...rows.map((r) => `${r.Name} · CPU ${r.CPUPerc} · memory ${r.MemUsage} (${r.MemPerc}) · net ${r.NetIO} · disk ${r.BlockIO} · pids ${r.PIDs}`)].join('\n');
}

const NOTABLE = new Set(['die', 'oom', 'kill', 'restart', 'start', 'stop', 'health_status', 'destroy', 'create', 'pause', 'unpause']);

export function summariseEvents(stdout: string): string {
  const rows = jsonLines(stdout).filter((e) => NOTABLE.has(String(e.Action ?? e.status ?? '').split(':')[0]!));
  if (!rows.length) return 'No container starts, stops, deaths, OOM kills or health changes in that time.';
  const counts = new Map<string, number>();
  for (const e of rows) {
    const k = String(e.Action ?? e.status).split(':')[0]!;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const lines = rows.slice(-80).map((e) => {
    const attrs = ((e.Actor as { Attributes?: Record<string, string> })?.Attributes ?? {}) as Record<string, string>;
    const t = new Date(Number(e.timeNano ? BigInt(String(e.timeNano)) / 1_000_000n : Number(e.time) * 1000)).toISOString();
    return `${t} ${attrs.name ?? String(e.id ?? '').slice(0, 12)} ${String(e.Action ?? e.status)}${attrs.exitCode ? ` (exit ${attrs.exitCode})` : ''}`;
  });
  return [`${rows.length} events: ${[...counts].map(([k, n]) => `${n} ${k}`).join(', ')}${rows.length > 80 ? ' (latest 80 shown)' : ''}`, ...lines].join('\n');
}

const SUMMARY: Partial<Record<Args['operation'], (s: string) => string>> = { ps: summarisePs, inspect: (s) => summariseInspect(s), stats: summariseStats, events: summariseEvents };

async function run(a: Args, ctx: ExecContext): Promise<ToolOutput> {
  const summarise = SUMMARY[a.operation];
  // Condensed reads are not streamed raw: the person watching sees the summary.
  const { onChunk: _live, ...quiet } = ctx;
  const raw = await sshExec(wrapCommand(ctx.target, dockerCommand(a)), summarise ? quiet : ctx);
  if (!summarise) return raw;
  const { stdout, stderr } = splitOutput(raw.text);
  if (!raw.ok) {
    const why = `${stderr || stdout}`.trim();
    return errOutput(
      /permission denied.*docker.sock|connect to the docker daemon/i.test(why)
        ? `docker refused: ${why.slice(0, 300)}\nThe login on this machine cannot use docker. Give it sudo for this target, or add it to the docker group.`
        : /command not found|not found/i.test(why)
          ? 'docker is not installed on this machine (or not on the PATH).'
          : `docker ${a.operation} failed (exit ${raw.exitCode}): ${why.slice(0, 500)}`,
      { ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}) },
    );
  }
  const t = truncateOutput(summarise(stdout), ctx.maxOutputBytes);
  return okOutput(t.text, { truncated: t.truncated, originalBytes: t.originalBytes, exitCode: 0 });
}

export const dockerTool: ToolDef<Args> = {
  key: 'docker',
  kind: 'ssh_exec',
  description:
    'Containers on a machine (docker over SSH). Read: ps (every container, trouble first), inspect (state, last exit and why, ' +
    'OOM kill, restarts, health, limits, ports, mounts; environment variable names only), logs (container, tail lines, since), ' +
    'stats (CPU and memory now), events (starts, deaths, OOM kills and health changes since, default 1h; optionally one container). ' +
    'Change, waits for approval: restart, start, stop (give intent and expected_effect). For anything else use ssh_exec.',
  parameters: {
    operation: { type: 'string', enum: [...OPS], description: 'What to do.' },
    container: { type: 'string', description: 'Container name or id (all but ps, stats and events).' },
    tail: { type: 'integer', description: 'logs: how many lines from the end (default 200, max 2000).' },
    since: { type: 'string', description: 'logs/events: how far back, e.g. 30m, 2h, 1d.' },
    intent: { type: 'string', description: 'For restart/start/stop: why, in one sentence, for the person approving.' },
    expected_effect: { type: 'string', description: 'For restart/start/stop: what will be true afterwards.' },
  },
  required: ['operation'],
  argsSchema: args as never,
  baselineRisk: 'read_only',
  targetKinds: ['ssh'],
  mutating: true,
  timeoutMs: 60_000,
  render: (a, target: ResolvedTarget) => wrapCommand(target, dockerCommand(a)),
  // The same rules as typing the command into ssh_exec: one classification for docker.
  classifyArgs: (a, target) => classifyShellCommand(dockerCommand(a), target).contributions,
  execute: run,
};

