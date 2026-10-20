import type { Observation } from './types.ts';
import type { ThreatCategory } from '@supops/shared';

/**
 * Target-side shadow execution: run the real command on the real machine, but inside a
 * copy-on-write sandbox whose writes are thrown away and whose network goes nowhere, so
 * we see what it would ACTUALLY do -- against the real files and services -- without
 * changing anything. Built on bubblewrap's `--overlay-src / --tmp-overlay /` (an
 * overlay of `/` with an EPHEMERAL tmpfs upper: the command reads the real filesystem
 * but every write lands in a throwaway tmpfs the kernel discards) plus `--unshare-all`
 * (no network, private PID/IPC/UTS), and `strace` to record what it touched -- files,
 * connections, processes, privilege. Because the upper is ephemeral, observation comes
 * from strace, so strace must be present; without it the shadow is unavailable.
 *
 * SECURITY: this runs real, possibly hostile code on the target, so the isolation
 * profile (the exact bwrap flags, seccomp filter and masked paths) MUST pass a written
 * security review before it is enabled in production. It uses bubblewrap's standard,
 * audited flags rather than hand-rolling isolation, keeps the shadow as defence in
 * depth (the risk engine's gates still apply), is strictly raise-only, and fails
 * closed: if the sandbox or strace cannot run, nothing is observed and nothing is
 * added. It is OFF unless SUPOPS_TARGET_SHADOW=on.
 */

export const SHADOW_BEGIN = '__SUPOPS_SHADOW_BEGIN__';
export const SHADOW_END = '__SUPOPS_SHADOW_END__';

export interface ShadowCapability {
  bwrap: boolean;
  overlay: boolean;
  strace: boolean;
}

export interface ShadowReport {
  ran: boolean;
  exit: number | null;
  filesWritten: string[];
  filesDeleted: string[];
  connects: Array<{ host: string; port: number }>;
  dnsPorts: number;
  execs: string[];
  privilege: string[];
  note?: string;
}

// --- capability probe --------------------------------------------------------

/** A read-only probe of what the target can do, so the shadow only runs where it works. */
export function buildShadowProbe(): string {
  return [
    'command -v bwrap >/dev/null 2>&1 && echo bwrap=1 || echo bwrap=0',
    'command -v strace >/dev/null 2>&1 && echo strace=1 || echo strace=0',
    'grep -qw overlay /proc/filesystems 2>/dev/null && echo overlay=1 || echo overlay=0',
  ].join('; ');
}

export function parseShadowProbe(out: string): ShadowCapability {
  const flag = (k: string) => new RegExp(`${k}=1`).test(out);
  return { bwrap: flag('bwrap'), overlay: flag('overlay'), strace: flag('strace') };
}

// --- the inline helper -------------------------------------------------------

/**
 * The stateless helper, sent inline (base64) and left with no trace on the target. The
 * command runs under strace inside an ephemeral overlay of `/`; strace's output (which
 * the helper writes to a bound host dir, so it survives the sandbox) is returned
 * base64-encoded for core to parse.
 */
export function buildShadowHelper(command: string): string {
  const cmdB64 = Buffer.from(command, 'utf8').toString('base64');
  const strace = 'strace -f -qq -y -e trace=%file,%network,execve,setuid,setgid,setreuid,setresuid,setresgid,capset -o /out/strace';
  const helper = String.raw`
set +e
T=$(mktemp -d "${'${TMPDIR:-/tmp}'}/supops-shadow.XXXXXX") || { printf '%s{"ran":false,"note":"no tmp dir"}%s\n' '${SHADOW_BEGIN}' '${SHADOW_END}'; exit 0; }
OUT="$T/out"; mkdir -p "$OUT"
printf %s '${cmdB64}' | base64 -d > "$T/cmd.sh" 2>/dev/null
bwrap --unshare-all --die-with-parent --new-session \
  --overlay-src / --tmp-overlay / \
  --bind "$OUT" /out --ro-bind "$T/cmd.sh" /cmd.sh \
  --proc /proc --dev /dev --tmpfs /tmp --chdir / \
  -- ${strace} /bin/sh /cmd.sh >/dev/null 2>"$OUT/stderr"
RC=$?
STRACE_B64=""
[ -f "$OUT/strace" ] && STRACE_B64=$(base64 -w0 "$OUT/strace" 2>/dev/null || base64 "$OUT/strace" 2>/dev/null | tr -d '\n')
if [ -z "$STRACE_B64" ] && [ ! -f "$OUT/strace" ]; then
  printf '%s{"ran":false,"note":"the sandbox or strace did not start (see RC %s)"}%s\n' '${SHADOW_BEGIN}' "$RC" '${SHADOW_END}'
else
  printf '%s{"ran":true,"exit":%s,"strace":"%s"}%s\n' '${SHADOW_BEGIN}' "$RC" "$STRACE_B64" '${SHADOW_END}'
fi
rm -rf "$T" 2>/dev/null
`;
  const b64 = Buffer.from(helper, 'utf8').toString('base64');
  // Sent as base64 -d | sh, so no quoting of the command survives to a shell.
  return `printf %s '${b64}' | base64 -d | /bin/sh`;
}

// --- parsing strace ----------------------------------------------------------

const ok = (line: string) => !/=\s*-1\b/.test(line); // ignore failed syscalls
const WRITE_FLAGS = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND/;

/** strace output → what the command wrote, deleted, connected to, ran, and escalated. */
export function parseStrace(text: string): Omit<ShadowReport, 'ran' | 'exit' | 'note'> {
  const written = new Set<string>();
  const deleted = new Set<string>();
  const connects: ShadowReport['connects'] = [];
  const execs = new Set<string>();
  const privilege = new Set<string>();
  let dnsPorts = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\d+\s+/, ''); // strace -f prefixes the pid
    if (!ok(line)) continue;
    let m: RegExpExecArray | null;
    if ((m = /\b(?:open|openat)(?:2)?\((?:[^,]+,\s*)?"([^"]+)"(?:<[^>]*>)?,\s*([A-Z_|]+)/.exec(line))) {
      if (WRITE_FLAGS.test(m[2]!)) written.add(m[1]!);
    } else if ((m = /\bcreat\("([^"]+)"/.exec(line))) {
      written.add(m[1]!);
    } else if ((m = /\b(?:mkdir|mkdirat)\((?:[^,]+,\s*)?"([^"]+)"/.exec(line))) {
      written.add(m[1]!);
    } else if ((m = /\b(?:rename|renameat2?)\((?:[^,]+,\s*)?"([^"]+)"(?:<[^>]*>)?,\s*(?:[^,]+,\s*)?"([^"]+)"/.exec(line))) {
      deleted.add(m[1]!); written.add(m[2]!);
    } else if ((m = /\b(?:unlink|unlinkat)\((?:[^,]+,\s*)?"([^"]+)"/.exec(line))) {
      deleted.add(m[1]!);
    } else if ((m = /\b(?:connect|sendto)\(.*sin_port=htons\((\d+)\).*inet_addr\("([0-9.]+)"\)/.exec(line))) {
      const port = Number(m[1]); if (port === 53) dnsPorts += 1; else connects.push({ host: m[2]!, port });
    } else if ((m = /\b(?:connect|sendto)\(.*sin6_port=htons\((\d+)\).*inet_pton\([^,]+,\s*"([0-9a-fA-F:]+)"/.exec(line))) {
      const port = Number(m[1]); if (port === 53) dnsPorts += 1; else connects.push({ host: m[2]!, port });
    } else if ((m = /\bexecve\("([^"]+)"/.exec(line))) {
      execs.add(m[1]!);
    } else if ((m = /\b(setuid|setgid|setreuid|setresuid|setresgid|capset)\(/.exec(line))) {
      privilege.add(m[1]!);
    }
  }
  return { filesWritten: [...written], filesDeleted: [...deleted], connects, dnsPorts, execs: [...execs], privilege: [...privilege] };
}

/** The helper's stdout (possibly PTY-merged) → a ShadowReport. */
export function parseShadowReport(stdout: string): ShadowReport {
  const begin = stdout.indexOf(SHADOW_BEGIN);
  const end = stdout.indexOf(SHADOW_END);
  if (begin < 0 || end <= begin) return notRunShadow('the shadow produced no report (the sandbox could not start)');
  let raw: { ran?: boolean; exit?: number | null; strace?: string; note?: string };
  try { raw = JSON.parse(stdout.slice(begin + SHADOW_BEGIN.length, end)); } catch { return notRunShadow('the shadow report was not valid'); }
  if (!raw.ran) return notRunShadow(raw.note ?? 'the shadow did not run');
  if (!raw.strace) return notRunShadow('the shadow ran but produced no trace to read');
  return { ran: true, exit: raw.exit ?? null, ...parseStrace(Buffer.from(raw.strace, 'base64').toString('utf8')) };
}

export function notRunShadow(note: string): ShadowReport {
  return { ran: false, exit: null, filesWritten: [], filesDeleted: [], connects: [], dnsPorts: 0, execs: [], privilege: [], note };
}

// --- the judge ---------------------------------------------------------------

const PERSISTENCE = [/authorized_keys$/, /\/\.ssh\//, /\/etc\/cron/, /\/var\/spool\/cron/, /\/etc\/systemd\/system\//, /\/etc\/ld\.so\.(preload|conf)/, /\/etc\/rc\.local$/, /\/etc\/profile\.d\//, /\/\.(bashrc|bash_profile|profile|zshrc)$/, /\/etc\/sudoers/, /\/etc\/passwd$/, /\/etc\/shadow$/];
const ANTI_FORENSICS = [/\/var\/log\//, /\/\.bash_history$/, /\/var\/log\/(auth|secure|wtmp|btmp)/];
/** Deleting under these is data loss, not just a stopped service. */
const DATA = [/\/var\/lib\//, /\/var\/www\//, /\/srv\//, /\/data\//, /\/opt\//, /\/home\//, /\/etc\//];
/** Transient paths a command touches as a matter of course; not worth reporting. */
const IGNORABLE = [/^\/tmp\//, /^\/dev\//, /^\/proc\//, /^\/run\//, /^\/sys\//, /^\/out\//, /^\/cmd\.sh$/, /^\/var\/tmp\//];
const ignore = (p: string) => IGNORABLE.some((re) => re.test(p));
const matchAny = (paths: string[], res: RegExp[]) => paths.filter((p) => res.some((re) => re.test(p)));
const cap = (xs: string[], n = 8) => `${xs.slice(0, n).join(', ')}${xs.length > n ? ` and ${xs.length - n} more` : ''}`;
const raise = (tier: 'high' | 'forbidden', category: ThreatCategory, reason: string) => ({ tier, category, reason });

/**
 * A shadow report → raise-only observations. The command ran against the real machine's
 * actual state (inside a discarded overlay), so what it touched is high-fidelity; only
 * writes/deletes/connections that the command's text did not make obvious are raised.
 */
export function judgeShadow(report: ShadowReport): { observations: Observation[]; blindSpots: string[] } {
  if (!report.ran) return { observations: [], blindSpots: [report.note ?? 'the shadow did not run'] };
  const observations: Observation[] = [];
  const written = report.filesWritten.filter((p) => !ignore(p));
  const deleted = report.filesDeleted.filter((p) => !ignore(p));

  const dataDeletes = matchAny(deleted, DATA);
  const forensicDeletes = matchAny(deleted, ANTI_FORENSICS);
  const persistence = [...new Set(matchAny(written, PERSISTENCE))];

  if (dataDeletes.length) observations.push({ kind: 'file.delete', detail: `it deletes ${deleted.length} file${deleted.length === 1 ? '' : 's'}, including under data or config paths: ${cap(dataDeletes)}`, raise: raise('high', 'destruction', `the command deletes data (${cap(dataDeletes, 3)}), which its text did not make obvious`) });
  else if (deleted.length) observations.push({ kind: 'file.delete', detail: `it deletes ${cap(deleted)}` });
  if (forensicDeletes.length) observations.push({ kind: 'anti-forensics', detail: `it deletes logs or history: ${cap(forensicDeletes)}`, raise: raise('high', 'anti-forensics', 'the command erases logs or shell history') });
  if (persistence.length) observations.push({ kind: 'persistence', detail: `it writes a persistence location: ${cap(persistence)}`, raise: raise('high', 'persistence', `the command writes ${cap(persistence, 3)}`) });
  if (report.connects.length) {
    const where = report.connects.slice(0, 5).map((c) => `${c.host}:${c.port}`).join(', ');
    observations.push({ kind: 'net.connect', detail: `it connects out to ${where}${report.connects.length > 5 ? '…' : ''}`, raise: raise('high', 'exfiltration', `the command reaches the network (${where}), which its text did not show`) });
  }
  if (report.privilege.length) observations.push({ kind: 'privilege', detail: `it changes privilege: ${cap(report.privilege)}`, raise: raise('high', 'privilege', `the command escalates privilege (${cap(report.privilege, 3)})`) });

  const ordinary = written.filter((p) => !PERSISTENCE.some((re) => re.test(p)));
  if (ordinary.length && !observations.some((o) => o.raise)) observations.push({ kind: 'file.write', detail: `it changes ${ordinary.length} file${ordinary.length === 1 ? '' : 's'}: ${cap(ordinary)}` });
  if (!observations.length) observations.push({ kind: 'clean', detail: `ran to exit ${report.exit}; no file changes, network, persistence or privilege change observed` });

  return {
    observations,
    blindSpots: ['a copy-on-write shadow does not run services reached over a socket (systemd, databases), so their effects are not observed; and a sandbox-aware payload can behave differently when watched'],
  };
}
