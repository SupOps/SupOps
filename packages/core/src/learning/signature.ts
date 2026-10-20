import { createHash } from 'node:crypto';
import { lexShell } from '../risk/shell-lex.ts';
import { scriptForClassification } from '../tools/script.ts';
import { stripLeadingElevation } from '../tools/become.ts';

/**
 * A stable identity for "the same action", so the engine can recognise that a
 * command was denied before even when the flags come in a different order or a
 * number changed. Deterministic and versioned: if the normalisation changes, the
 * version prefix changes, and old rules simply stop matching rather than matching
 * the wrong thing.
 */
export const SIGNATURE_VERSION = 'v1';

const SUBCOMMAND_DEPTH: Record<string, number> = {
  kubectl: 2, docker: 2, git: 1, systemctl: 1, helm: 1, apt: 1, 'apt-get': 1, dnf: 1, yum: 1,
  aws: 2, gcloud: 3, az: 2, terraform: 1, tofu: 1, ip: 2, service: 2,
};

function generalise(v: string): string {
  if (/^\d+$/.test(v)) return 'N';
  if (/^\d+(\.\d+)?[a-z]+$/i.test(v)) return 'N';
  if (/^[0-9a-f]{12,}$/i.test(v)) return 'HEX';
  return v;
}

function signCommand(name: string, args: string[]): string {
  const program = name.split('/').pop() ?? name;
  const depth = SUBCOMMAND_DEPTH[program] ?? 0;
  const sub: string[] = [];
  const flags: string[] = [];
  const operands: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      const [flag, value] = a.split('=', 2) as [string, string | undefined];
      if (/^-[a-zA-Z]{2,}$/.test(flag)) {
        for (const c of flag.slice(1)) flags.push(`-${c}`);
        continue;
      }
      // `-n 50` / `--since 1h`: a lone flag followed by a value carries that value,
      // so the pair stays together however the flags are ordered.
      const next = args[i + 1];
      if (value === undefined && next !== undefined && !next.startsWith('-') && (sub.length >= depth || depth === 0)) {
        flags.push(`${flag}=${generalise(next)}`);
        i += 1;
        continue;
      }
      flags.push(value === undefined ? flag : `${flag}=${generalise(value)}`);
    } else if (sub.length < depth && operands.length === 0 && /^[a-z][a-z0-9-]*$/.test(a)) {
      sub.push(a);
    } else {
      operands.push(generalise(a));
    }
  }
  return [program, ...sub, ...[...new Set(flags)].sort(), ...operands].join(' ');
}

/** The signature of a tool call, or null when it cannot be signed (unparseable or internal). */
export function signatureOf(toolKey: string, args: Record<string, unknown>): string | null {
  let line: string | null = null;
  if (toolKey === 'ssh_exec' && typeof args.command === 'string') line = stripLeadingElevation(args.command);
  else if (toolKey === 'k8s_kubectl' && typeof args.args === 'string') line = `kubectl ${args.args.replace(/^kubectl\s+/, '')}`;
  else if ((toolKey === 'ssh_write_file' || toolKey === 'ssh_read_file') && typeof args.path === 'string') {
    return `${SIGNATURE_VERSION}|${toolKey}|${args.path}`;
  } else if (toolKey === 'run_script' && typeof args.script === 'string') {
    // A shell script is signed by the lines that do something; Python, which cannot
    // be read that way, by its exact text.
    if (args.interpreter === 'python3') return `${SIGNATURE_VERSION}|run_script|python3|${createHash('sha256').update(args.script.trim()).digest('hex').slice(0, 16)}`;
    line = scriptForClassification(args.script);
  }
  if (!line) return null;
  const lex = lexShell(line);
  if (!lex.ok || lex.commands.length === 0) return null;
  return `${SIGNATURE_VERSION}|${toolKey}|${lex.commands.map((c) => signCommand(c.name, c.args)).join(' ; ')}`;
}
