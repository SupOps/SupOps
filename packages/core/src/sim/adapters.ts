import type { Observation } from './types.ts';
import { lexShell } from '../risk/shell-lex.ts';

/**
 * Native dry-run adapters. Each one recognises a command shape, gives back a
 * READ-ONLY preview command to run in its place, and turns that preview's output into
 * observations. All of this is pure (no I/O), so it is tested with recorded fixtures;
 * the orchestrator runs the preview command against the real target.
 */

export interface DryRunAdapter {
  id: string;
  /** Where the preview runs: an ssh shell command, or kubectl argv on a cluster target. */
  kind: 'ssh' | 'kubectl';
  /** The read-only preview to run instead, or null when this adapter does not apply. */
  plan(name: string, argv: string[], raw: string): string | null;
  /** Observations (and honest blind spots) from the preview's output and exit code. */
  interpret(stdout: string, exitCode: number): { observations: Observation[]; blindSpots?: string[] };
}

/** Packages whose removal breaks the way in, the init system, or the C library. */
export const ESSENTIAL_PACKAGES = new Set([
  'openssh-server', 'openssh-sftp-server', 'ssh', 'sudo', 'systemd', 'systemd-sysv', 'init',
  'libc6', 'libc-bin', 'glibc', 'bash', 'coreutils', 'util-linux', 'dpkg', 'apt', 'login',
  'passwd', 'kernel', 'linux-image-amd64', 'linux-image-generic', 'grub-common', 'grub2-common',
  'network-manager', 'networkd-dispatcher', 'dbus',
]);
const isEssential = (pkg: string) => ESSENTIAL_PACKAGES.has(pkg) || /^(linux-image|linux-generic)/.test(pkg);

const APT_VERBS = new Set(['install', 'remove', 'purge', 'autoremove', 'upgrade', 'dist-upgrade', 'full-upgrade']);
const DNF_VERBS = new Set(['install', 'remove', 'erase', 'upgrade', 'update', 'autoremove', 'downgrade', 'reinstall']);
/** systemctl verbs that stop or detach a unit, so its reverse-dependencies matter. */
const SYSTEMCTL_DISRUPTIVE = new Set(['stop', 'restart', 'disable', 'mask', 'kill']);

const firstVerb = (argv: string[], verbs: Set<string>) => argv.find((a) => !a.startsWith('-') && verbs.has(a));
const operands = (argv: string[]) => argv.filter((a) => !a.startsWith('-'));

export const aptAdapter: DryRunAdapter = {
  id: 'apt-simulate',
  kind: 'ssh',
  plan(name, argv) {
    if (name !== 'apt' && name !== 'apt-get') return null;
    const verb = firstVerb(argv, APT_VERBS);
    if (!verb) return null;
    const pkgs = operands(argv).filter((a) => a !== verb && a !== 'apt' && a !== 'apt-get');
    // -s simulates without touching the system; the quiet options keep the output stable.
    return `apt-get -s -o Debug::NoLocking=true ${verb} ${pkgs.join(' ')}`.trim();
  },
  interpret(stdout) {
    const remove = new Set<string>();
    const install = new Set<string>();
    // The "will be REMOVED:" block lists packages on the following indented lines.
    const block = (label: string, into: Set<string>) => {
      const m = stdout.match(new RegExp(`will be ${label}:\\n((?:\\s+\\S.*\\n)+)`));
      if (m) for (const p of m[1]!.trim().split(/\s+/)) into.add(p);
    };
    block('REMOVED', remove);
    block('installed', install);
    // The terse form: "Remv pkg [ver]" / "Inst pkg (ver ...)".
    for (const m of stdout.matchAll(/^Remv (\S+)/gm)) remove.add(m[1]!);
    for (const m of stdout.matchAll(/^Inst (\S+)/gm)) install.add(m[1]!);
    return pkgObservations([...remove], [...install]);
  },
};

export const dnfAdapter: DryRunAdapter = {
  id: 'dnf-simulate',
  kind: 'ssh',
  plan(name, argv) {
    if (name !== 'dnf' && name !== 'yum' && name !== 'microdnf') return null;
    const verb = firstVerb(argv, DNF_VERBS);
    if (!verb) return null;
    const pkgs = operands(argv).filter((a) => a !== verb && a !== name);
    return `${name} --assumeno ${verb} ${pkgs.join(' ')}`.trim();
  },
  interpret(stdout) {
    const remove = new Set<string>();
    const install = new Set<string>();
    // dnf prints "Removing:" / "Installing:" sections; each row starts with the name.
    let section: Set<string> | null = null;
    for (const line of stdout.split('\n')) {
      if (/^(Removing|Removing dependent packages|Removing unused dependencies):/.test(line)) section = remove;
      else if (/^(Installing|Installing dependencies|Upgrading):/.test(line)) section = install;
      else if (/^(Transaction Summary|Operation aborted|Error)/.test(line)) section = null;
      else if (section && /^\s+\S/.test(line)) {
        const name = line.trim().split(/\s+/)[0];
        if (name) section.add(name);
      }
    }
    return pkgObservations([...remove], [...install]);
  },
};

function pkgObservations(remove: string[], install: string[]): { observations: Observation[]; blindSpots?: string[] } {
  const observations: Observation[] = [];
  if (remove.length) {
    const essential = remove.filter(isEssential);
    observations.push({
      kind: 'pkg.remove',
      detail: `would remove ${remove.length} package${remove.length === 1 ? '' : 's'}: ${remove.slice(0, 12).join(', ')}${remove.length > 12 ? ` and ${remove.length - 12} more` : ''}${essential.length ? ` -- including ${essential.join(', ')}` : ''}`,
      // Removing sshd, systemd or libc is a lockout the text "apt-get remove X" never showed.
      ...(essential.length
        ? { raise: { tier: 'high' as const, category: 'lockout' as const, reason: `removing ${essential.join(', ')} would cut off access or break the system -- the command text did not name ${essential.length === 1 ? 'it' : 'them'}` } }
        : remove.length >= 25
          ? { raise: { tier: 'high' as const, category: 'availability' as const, reason: `the removal cascades to ${remove.length} packages, far more than the command named` } }
          : {}),
    });
  }
  if (install.length) observations.push({ kind: 'pkg.install', detail: `would install ${install.length} package${install.length === 1 ? '' : 's'}: ${install.slice(0, 12).join(', ')}${install.length > 12 ? ` and ${install.length - 12} more` : ''}` });
  if (!observations.length) return { observations: [], blindSpots: ['the package manager reported no change (already satisfied, or the preview could not resolve it)'] };
  return { observations };
}

export const systemctlAdapter: DryRunAdapter = {
  id: 'systemd-deps',
  kind: 'ssh',
  plan(name, argv) {
    if (name !== 'systemctl') return null;
    const verb = firstVerb(argv, SYSTEMCTL_DISRUPTIVE);
    if (!verb) return null;
    const unit = operands(argv).find((a) => a !== verb && a !== 'systemctl');
    if (!unit) return null;
    // Read-only: what else depends on this unit and would be disrupted.
    return `systemctl list-dependencies --reverse --no-pager --plain ${unit}`;
  },
  interpret(stdout, exitCode) {
    const lines = stdout.split('\n').map((l) => l.replace(/[│├└─\s]+/g, ' ').trim()).filter(Boolean);
    if (exitCode !== 0 || lines.length <= 1) {
      return { observations: [{ kind: 'deps.reverse', detail: 'no other unit depends on it (or systemd could not be queried)' }], blindSpots: ['systemd itself is not observed; the restart/stop is not actually simulated'] };
    }
    const dependents = lines.slice(1).filter((u) => u.endsWith('.service') || u.endsWith('.target') || u.endsWith('.socket'));
    return {
      observations: [{ kind: 'deps.reverse', detail: dependents.length ? `${dependents.length} unit${dependents.length === 1 ? '' : 's'} depend on it and would be disrupted: ${dependents.slice(0, 10).join(', ')}${dependents.length > 10 ? '…' : ''}` : 'nothing else depends on it' }],
      blindSpots: ['systemd itself is not observed; this shows the blast radius, not whether the service comes back healthy'],
    };
  },
};

export const SSH_ADAPTERS: DryRunAdapter[] = [aptAdapter, dnfAdapter, systemctlAdapter];

/** The adapter and preview command for a single-command ssh line, or null. */
export function planSshDryRun(command: string): { adapter: DryRunAdapter; preview: string } | null {
  const lexed = lexShell(command);
  // One plain command only. Pipes, && and scripts are the shadow's job (later phases).
  if (!lexed.ok || lexed.commands.length !== 1) return null;
  const cmd = lexed.commands[0]!;
  const name = cmd.name.split('/').pop() ?? cmd.name;
  for (const adapter of SSH_ADAPTERS) {
    const preview = adapter.plan(name, cmd.args, command);
    if (preview) return { adapter, preview };
  }
  return null;
}

// --- Kubernetes (cluster targets) -------------------------------------------

const KUBECTL_MUTATING = new Set(['apply', 'create', 'delete', 'patch', 'replace', 'scale', 'annotate', 'label', 'set', 'rollout', 'edit', 'cordon', 'drain', 'taint', 'uncordon', 'expose', 'autoscale']);

/** For a mutating kubectl argv, the argv to run as a server-side dry run, or null. */
export function planKubectlDryRun(argv: string[]): string[] | null {
  const verb = argv.find((a) => !a.startsWith('-'));
  if (!verb || !KUBECTL_MUTATING.has(verb)) return null;
  // rollout only mutates for `undo`/`restart`/`pause`/`resume`; a dry run is only
  // meaningful for the forms the apiserver supports, so keep it simple and let the
  // apiserver reject what it cannot dry-run.
  if (argv.some((a) => a === '--dry-run=server' || a === '--dry-run' || a.startsWith('--dry-run='))) return null;
  return [...argv, '--dry-run=server'];
}

export const kubectlAdapter = {
  id: 'kubectl-dry-run',
  interpret(stdout: string, exitCode: number): { observations: Observation[]; blindSpots?: string[] } {
    const text = stdout.trim();
    if (exitCode !== 0) {
      // An admission webhook or validation rejected it: it would fail, not harm.
      const first = text.split('\n').find((l) => /error|denied|forbidden|invalid/i.test(l)) ?? text.split('\n')[0] ?? 'rejected';
      return { observations: [{ kind: 'k8s.reject', detail: `the cluster would reject it: ${first.slice(0, 200)}` }] };
    }
    const changed = [...text.matchAll(/^([a-z.]+\/\S+)\s+(configured|created|deleted|patched|scaled|unchanged|replaced)/gm)].map((m) => `${m[1]} ${m[2]}`);
    const acting = changed.filter((c) => !c.endsWith('unchanged'));
    return {
      observations: acting.length
        ? [{ kind: 'k8s.apply', detail: `server dry-run: ${acting.slice(0, 10).join(', ')}${acting.length > 10 ? '…' : ''}` }]
        : [{ kind: 'k8s.apply', detail: 'server dry-run reports no change (already in the desired state)' }],
      blindSpots: ['a server dry-run validates and runs admission, but does not run the workload, so runtime effects are not observed'],
    };
  },
};
