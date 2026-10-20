import type { RiskTier } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import type { SimpleCommand } from './shell-lex.ts';
import { lexShell } from './shell-lex.ts';
import { hasGlob, isDevicePath, isProtectedPath, isScratchPath, isWritablePath } from './paths.ts';

import type { RuleHit } from './rule-kit.ts';
import { hit, RANK, registerCommandClassifier } from './rule-kit.ts';
import * as files from './rules-files.ts';
import * as net from './rules-net.ts';
import * as sys from './rules-system.ts';
import { classifyShellInvocation, SHELLS } from './rules-line.ts';
import { DATA_COMMANDS } from './rules-data.ts';
import { CLOUD_COMMANDS } from './rules-cloud.ts';

/*
 * Which rule set the dispatcher uses. `v2` is the current one; `legacy` keeps the
 * rules as they were before the upgrade, so a bad rule can be switched off on a
 * running install with SUPOPS_RISK_RULES=legacy and a restart, no code change.
 * The parity test compares the two over a corpus: v2 may only ever be stricter,
 * except where a lowering is listed on purpose.
 */
export type RiskRulesMode = 'v2' | 'legacy';

let forcedMode: RiskRulesMode | null = null;

export function riskRulesMode(): RiskRulesMode {
  if (forcedMode) return forcedMode;
  return process.env.SUPOPS_RISK_RULES === 'legacy' ? 'legacy' : 'v2';
}

/** Run `fn` with a given rule set (used by tests and the parity check). Synchronous only. */
export function withRiskRulesMode<T>(mode: RiskRulesMode, fn: () => T): T {
  const prev = forcedMode;
  forcedMode = mode;
  try {
    return fn();
  } finally {
    forcedMode = prev;
  }
}

type Classifier = (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit;

/** v2 classifiers. A name here overrides the legacy CLASSIFIERS / FLAT entry. */
const V2: Record<string, Classifier> = {
  // files
  rm: files.classifyRm, rmdir: files.classifyRm, unlink: files.classifyRm,
  find: files.classifyFind,
  mv: files.classifyMove,
  cp: files.classifyCopy, install: files.classifyCopy,
  ln: files.classifyLink,
  chmod: files.classifyChmod,
  chown: files.classifyChown, chgrp: files.classifyChown,
  chattr: files.classifyChattr,
  gzip: files.classifyCompress, gunzip: files.classifyCompress, zcat: files.classifyCompress,
  bzip2: files.classifyCompress, bunzip2: files.classifyCompress, bzcat: files.classifyCompress,
  xz: files.classifyCompress, unxz: files.classifyCompress, xzcat: files.classifyCompress,
  zstd: files.classifyCompress, unzstd: files.classifyCompress, zstdcat: files.classifyCompress,
  lz4: files.classifyCompress, lz4cat: files.classifyCompress, pigz: files.classifyCompress,
  compress: files.classifyCompress,
  shred: files.classifyShred,
  truncate: files.classifyTruncate,
  tee: files.classifyTee,
  dd: files.classifyDd,
  sed: sys.classifySed,
  // network
  curl: net.classifyCurl,
  wget: net.classifyWget,
  nc: net.classifyNetcat, ncat: net.classifyNetcat, netcat: net.classifyNetcat,
  'nc.openbsd': net.classifyNetcat, 'nc.traditional': net.classifyNetcat,
  socat: net.classifySocat,
  ssh: net.classifySsh,
  scp: net.classifyTransfer, rsync: net.classifyTransfer, sftp: net.classifyTransfer,
  ping: net.classifyPing, ping6: net.classifyPing,
  ip: sys.classifyIp,
  ifconfig: sys.classifyIfupdown, ifup: sys.classifyIfupdown, ifdown: sys.classifyIfupdown,
  nmcli: sys.classifyNmcli,
  // services and processes
  systemctl: sys.classifySystemctl,
  service: sys.classifyService,
  kill: sys.classifyKill,
  pkill: sys.classifyKillByName, killall: sys.classifyKillByName, killall5: sys.classifyKillByName,
  crontab: sys.classifyCrontab,
  // accounts
  passwd: sys.classifyAccount, chage: sys.classifyAccount, userdel: sys.classifyAccount,
  deluser: sys.classifyAccount, usermod: sys.classifyAccount, useradd: sys.classifyAccount,
  adduser: sys.classifyAccount, groupadd: sys.classifyAccount, addgroup: sys.classifyAccount,
  groupdel: sys.classifyAccount, delgroup: sys.classifyAccount, gpasswd: sys.classifyAccount,
  groupmod: sys.classifyAccount, chpasswd: sys.classifyAccount, newusers: sys.classifyAccount,
  visudo: sys.classifyAccount, chsh: sys.classifyAccount,
  // firewall
  iptables: sys.classifyIptables, ip6tables: sys.classifyIptables,
  'iptables-save': sys.classifyIptables, 'ip6tables-save': sys.classifyIptables,
  'iptables-restore': sys.classifyIptables, 'ip6tables-restore': sys.classifyIptables,
  nft: sys.classifyNft,
  ufw: sys.classifyUfw,
  'firewall-cmd': sys.classifyFirewallCmd,
  // host identity and clock
  date: sys.classifyDate,
  hostname: sys.classifyHostname,
  hostnamectl: sys.classifyCtl, timedatectl: sys.classifyCtl, localectl: sys.classifyCtl,
  // disks
  mkfs: sys.classifyDisk, mke2fs: sys.classifyDisk, mkswap: sys.classifyDisk, mkdosfs: sys.classifyDisk,
  mkntfs: sys.classifyDisk, wipefs: sys.classifyDisk, blkdiscard: sys.classifyDisk,
  fdisk: sys.classifyDisk, sfdisk: sys.classifyDisk, gdisk: sys.classifyDisk, sgdisk: sys.classifyDisk,
  cfdisk: sys.classifyDisk, parted: sys.classifyDisk, lvremove: sys.classifyDisk, vgremove: sys.classifyDisk,
  pvremove: sys.classifyDisk, lvreduce: sys.classifyDisk, cryptsetup: sys.classifyDisk,
  zpool: sys.classifyDisk, zfs: sys.classifyDisk, mount: sys.classifyDisk, umount: sys.classifyDisk,
  swapoff: sys.classifyDisk, swapon: sys.classifyDisk,
  lvs: sys.classifyDisk, vgs: sys.classifyDisk, pvs: sys.classifyDisk, lvdisplay: sys.classifyDisk,
  vgdisplay: sys.classifyDisk, pvdisplay: sys.classifyDisk, lvscan: sys.classifyDisk,
  vgscan: sys.classifyDisk, pvscan: sys.classifyDisk,
  // packages
  apt: sys.classifyPackage, 'apt-get': sys.classifyPackage, 'apt-cache': sys.classifyPackage,
  aptitude: sys.classifyPackage, dnf: sys.classifyPackage, yum: sys.classifyPackage,
  microdnf: sys.classifyPackage, zypper: sys.classifyPackage, apk: sys.classifyPackage,
  pip: sys.classifyPackage, pip3: sys.classifyPackage, pipx: sys.classifyPackage,
  npm: sys.classifyPackage, pnpm: sys.classifyPackage, yarn: sys.classifyPackage,
  snap: sys.classifyPackage, brew: sys.classifyPackage, gem: sys.classifyPackage,
  dpkg: sys.classifyDpkgRpm, 'dpkg-query': sys.classifyDpkgRpm, rpm: sys.classifyDpkgRpm,
  // kernel, power, security controls
  sysctl: sys.classifySysctl,
  modprobe: sys.classifyModules, rmmod: sys.classifyModules, insmod: sys.classifyModules, modinfo: sys.classifyModules,
  shutdown: sys.classifyPower, reboot: sys.classifyPower, halt: sys.classifyPower,
  poweroff: sys.classifyPower, init: sys.classifyPower, telinit: sys.classifyPower,
  getenforce: sys.classifySecurityControl, sestatus: sys.classifySecurityControl,
  setenforce: sys.classifySecurityControl, auditctl: sys.classifySecurityControl,
  'aa-status': sys.classifySecurityControl, apparmor_status: sys.classifySecurityControl,
  'aa-disable': sys.classifySecurityControl, 'aa-complain': sys.classifySecurityControl,
  'aa-teardown': sys.classifySecurityControl,
  // wrappers and deferred execution
  env: sys.classifyEnv,
  xargs: sys.classifyXargs,
  watch: sys.classifyWatch,
  at: sys.classifyDeferred, batch: sys.classifyDeferred, atq: sys.classifyDeferred, atrm: sys.classifyDeferred,
  setsid: sys.classifyDeferred, disown: sys.classifyDeferred, 'systemd-run': sys.classifyDeferred,
  chroot: sys.classifyIsolation, nsenter: sys.classifyIsolation, unshare: sys.classifyIsolation,
  runuser: sys.classifyIsolation, setpriv: sys.classifyIsolation, capsh: sys.classifyIsolation,
  // databases and cloud control planes (rules-data.ts / rules-cloud.ts)
  ...DATA_COMMANDS,
  ...CLOUD_COMMANDS,
};

/** Redirect classifier for the active rule set. */
export function classifyRedirectsActive(cmd: SimpleCommand, target: ResolvedTarget): RuleHit | null {
  return riskRulesMode() === 'v2' ? files.classifyRedirects(cmd, target) : classifyRedirects(cmd, target);
}

export type { RuleHit } from './rule-kit.ts';

/** Commands whose tier does not depend on their arguments. */
const FLAT: Record<string, RiskTier> = {
  // --- read_only ---
  cat: 'read_only', less: 'read_only', more: 'read_only', head: 'read_only',
  tail: 'read_only', grep: 'read_only', egrep: 'read_only', fgrep: 'read_only',
  zgrep: 'read_only', ls: 'read_only', stat: 'read_only', file: 'read_only',
  wc: 'read_only', sort: 'read_only', uniq: 'read_only', cut: 'read_only',
  tr: 'read_only', df: 'read_only', du: 'read_only', free: 'read_only',
  ps: 'read_only', top: 'read_only', htop: 'read_only', vmstat: 'read_only',
  iostat: 'read_only', sar: 'read_only', uptime: 'read_only', who: 'read_only',
  whoami: 'read_only', id: 'read_only',
  // env / date / hostname are deliberately absent: `env <cmd>` runs a command, and
  // `date -s` / `hostname <name>` change the host. They fall through to `unknown`.
  printenv: 'read_only', pwd: 'read_only', echo: 'read_only',
  which: 'read_only', whereis: 'read_only', sleep: 'read_only', true: 'read_only',
  false: 'read_only', test: 'read_only', printf: 'read_only', getent: 'read_only',
  lsmod: 'read_only', last: 'read_only', groups: 'read_only', strings: 'read_only',
  cd: 'read_only',
  dmesg: 'read_only', lsof: 'read_only', ss: 'read_only', netstat: 'read_only',
  dig: 'read_only', nslookup: 'read_only', host: 'read_only', traceroute: 'read_only',
  lsblk: 'read_only', lscpu: 'read_only', blkid: 'read_only', mount_list: 'read_only',
  jq: 'read_only', yq: 'read_only', md5sum: 'read_only', sha256sum: 'read_only',
  diff: 'read_only', realpath: 'read_only', readlink: 'read_only', basename: 'read_only',
  dirname: 'read_only', nproc: 'read_only', arch: 'read_only', uname: 'read_only',

  // --- low ---
  mkdir: 'low', touch: 'low', sync: 'low', logrotate: 'low',

  // --- medium ---
  crontab: 'medium', apt: 'medium', 'apt-get': 'medium', yum: 'medium',
  dnf: 'medium', apk: 'medium', pip: 'medium', pip3: 'medium', npm: 'medium',

  // --- high ---
  mkfs: 'high', fdisk: 'high', parted: 'high', mount: 'high', umount: 'high',
  swapoff: 'high', swapon: 'high', lvremove: 'high', vgremove: 'high',
  pvremove: 'high', userdel: 'high', usermod: 'high', useradd: 'high',
  passwd: 'high', chpasswd: 'high', visudo: 'high', shutdown: 'high',
  reboot: 'high', halt: 'high', poweroff: 'high', init: 'high', telinit: 'high',
  insmod: 'high', rmmod: 'high', modprobe: 'high', sysctl: 'high',

  // --- forbidden ---
  eval: 'forbidden', exec: 'forbidden', source: 'forbidden',
};

/** Argument-sensitive commands get a dedicated classifier. */
const CLASSIFIERS: Record<
  string,
  (cmd: SimpleCommand, target: ResolvedTarget) => RuleHit
> = {
  rm: classifyRm,
  find: classifyFind,
  sed: classifySed,
  awk: classifyAwk,
  dd: classifyDd,
  systemctl: classifySystemctl,
  service: classifyService,
  kill: classifyKill,
  pkill: (c) => hit('shell.pkill', 'medium', `pkill ${c.args.join(' ')} terminates processes by name`),
  killall: (c) => hit('shell.killall', 'medium', `killall ${c.args.join(' ')} terminates processes by name`),
  chmod: classifyChmod,
  chown: classifyChown,
  chgrp: classifyChown,
  cp: classifyCopyMove,
  mv: classifyCopyMove,
  ln: classifyCopyMove,
  truncate: classifyTruncate,
  curl: classifyHttpClient,
  wget: classifyHttpClient,
  journalctl: classifyJournalctl,
  git: classifyGit,
  iptables: classifyIptables,
  ip6tables: classifyIptables,
  ufw: classifyIptables,
  'firewall-cmd': classifyIptables,
  tee: classifyTee,
  nginx: (c) => (c.args.includes('-t') ? hit('shell.nginx.test', 'read_only', 'nginx config test') : hit('shell.nginx.reload', 'medium', 'nginx control command')),
  apachectl: (c) => (c.args.includes('configtest') ? hit('shell.apachectl.test', 'read_only', 'apache config test') : hit('shell.apachectl', 'medium', 'apache control command')),
  mysql: classifySqlClient,
  psql: classifySqlClient,
  'ssh-keygen': (c) => hit('shell.sshkeygen', 'high', `ssh-keygen ${c.args.join(' ')} touches key material`),
  kubectl: classifyKubectl,
  oc: classifyKubectl, // OpenShift CLI: same verbs/risk shape as kubectl
  k3s: classifyK3s,
  docker: classifyDocker,
  podman: classifyDocker,
  helm: classifyHelm,
};

// The list of credential paths lives in rules-files.ts. A second copy here drifted
// behind it (it missed ~/.docker/config.json, .npmrc, .vault-token, tfstate...), so a
// plain `cat` of those was a free read while the same path elsewhere was gated.
const isSensitiveReadPath = files.isSensitiveReadPath;

export function classifySimpleCommand(
  cmd: SimpleCommand,
  target: ResolvedTarget,
): RuleHit {
  const name = cmd.name.split('/').pop() ?? cmd.name;

  // `su - user -c "<cmd>"` is a wrapper like sudo: what matters is the command it
  // runs, not the identity switch. Without this, every command an agent wraps this
  // way lands on `su` -- which is not in the ruleset, so it fails closed to `high`
  // and demands approval for `df -h`. That is how approval fatigue starts, and an
  // approver who stops reading is worse than no gate at all.
  if (name === 'su') {
    const cIdx = cmd.args.indexOf('-c');
    if (cIdx >= 0 && cmd.args[cIdx + 1]) {
      const inner = cmd.args[cIdx + 1]!;
      const innerLex = lexInner(inner);
      if (!innerLex) {
        return hit('shell.su.unreadable', 'high', `su -c "${inner}" could not be read safely`);
      }
      const worst = innerLex
        .map((c) => classifySimpleCommand(c, target))
        .reduce((a, b) => (RANK[a.tier] >= RANK[b.tier] ? a : b));
      return { ...worst, reason: `su -c: ${worst.reason}` };
    }
    // An interactive `su` opens a shell we cannot see into.
    return hit('shell.su.interactive', 'high', 'su without -c opens an unreviewable shell');
  }

  // sudo/env/nice/timeout wrap a real command; classify what they actually run.
  if (['sudo', 'doas', 'nice', 'ionice', 'timeout', 'nohup', 'stdbuf'].includes(name)) {
    const inner = stripWrapperFlags(name, cmd.args);
    if (!inner.length) {
      return hit('shell.wrapper.empty', 'high', `${name} with no command to inspect`);
    }
    const innerHit = classifySimpleCommand(
      { ...cmd, name: inner[0]!, args: inner.slice(1) },
      target,
    );
    // sudo does not itself raise the tier -- the inner command's own rule already
    // accounts for privilege. Raising here would make every read-only check on a
    // sudo-only host require approval, which is how approval fatigue starts.
    return { ...innerHit, reason: `${name}: ${innerHit.reason}` };
  }

  if (riskRulesMode() === 'v2') {
    // Shells are judged on what they run: `-c` strings are re-read, and piped
    // input or heredocs by the whole-line checks in rules-line.ts.
    if (SHELLS.has(name)) return classifyShellInvocation(cmd, target);
    if (name === 'base64' || name === 'base32') {
      const secret = files.readsSensitive(cmd, target);
      return secret
        ? hit('shell.read.secret', 'medium', `encoding a credential/secret path (${secret}) requires approval`, { category: 'secrets' })
        : hit(`shell.${name}`, 'read_only', `${name} encodes or decodes text (what receives it is judged separately)`);
    }
  }

  // Piping anything into a shell is remote code execution with extra steps.
  if (['sh', 'bash', 'zsh', 'ksh', 'dash'].includes(name)) {
    if (cmd.pipedInto || cmd.args.some((a) => a === '-c' || a === '-s')) {
      return hit(
        'shell.pipe-to-shell',
        'forbidden',
        `piping or evaluating arbitrary input through ${name} executes unreviewable code`,
      );
    }
  }
  if (name === 'base64' && cmd.pipedInto) {
    return hit('shell.base64-pipe', 'forbidden', 'base64-decoded input piped to another command');
  }

  const v2 = riskRulesMode() === 'v2' ? V2[name] ?? (/^mkfs\./.test(name) ? sys.classifyDisk : undefined) : undefined;
  if (v2) return v2(cmd, target);

  const classifier = CLASSIFIERS[name];
  if (classifier) return classifier(cmd, target);

  const flat = FLAT[name];
  if (flat) {
    // Reading login/credential material is never a free read. Even a plain `cat` of
    // a private key or ~/.aws/credentials must pause for a human -- this is the
    // "worst case: it reads a file to log in" the operator asked to gate.
    if (flat === 'read_only') {
      const secretPath = cmd.args.find(isSensitiveReadPath);
      if (secretPath) {
        return hit(
          'shell.read.secret',
          'medium',
          `reading a credential/secret path (${secretPath}) requires approval`,
        );
      }
    }
    return hit(`shell.flat.${name}`, flat, `${name} is classified ${flat}`);
  }

  // Fail closed. An unrecognised binary could be anything, including a wrapper
  // script that does far more than its name suggests.
  return hit(
    'shell.unknown',
    'high',
    `"${name}" is not in the ruleset; unrecognised commands are treated as high risk`,
  );
}

// sudo/doas flags that take a following value. Without consuming the value too,
// `sudo -u appuser <cmd>` would leave `appuser` as the "inner command" and
// `sudo -S -p '' <cmd>` would stop stripping at the empty `-p` argument -- both
// misclassifying the real command (usually to `high`). The executor's elevation
// wrapper emits exactly these flags, so this keeps classified === executed.
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-p', '-C', '-h', '-R', '-r', '-t', '-U', '-D']);

function stripWrapperFlags(name: string, args: string[]): string[] {
  const out = [...args];
  const takesValue = name === 'sudo' || name === 'doas';
  while (out.length) {
    const a = out[0]!;
    if (name === 'timeout' && /^[0-9]+[smhd]?$/.test(a)) { out.shift(); continue; }
    if (takesValue && SUDO_VALUE_FLAGS.has(a)) { out.shift(); out.shift(); continue; }
    if (a.startsWith('-') || a.includes('=')) { out.shift(); continue; }
    break;
  }
  return out;
}

// --------------------------------------------------------------------------
// Individual classifiers
// --------------------------------------------------------------------------

function classifyRm(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const flags = cmd.args.filter((a) => a.startsWith('-')).join('');
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  const recursive = /r/i.test(flags);
  const force = /f/.test(flags);

  for (const p of paths) {
    const norm = p.replace(/\/+$/, '') || '/';
    if (norm === '/' || /^\/\*+$/.test(p)) {
      return hit('shell.rm.root', 'forbidden', `rm targeting ${p} destroys the host`);
    }
    if (recursive && isProtectedPath(p, target)) {
      return hit('shell.rm.protected', 'forbidden', `recursive rm of protected path ${p}`);
    }
  }
  if (recursive) {
    return hit(
      'shell.rm.recursive',
      'high',
      `recursive rm (${flags}) of ${paths.join(', ') || '(no path)'} has unbounded blast radius`,
    );
  }
  if (paths.some(hasGlob)) {
    return hit('shell.rm.glob', 'high', `rm with a glob (${paths.join(' ')}) matches an unknown set of files`);
  }
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.rm.protected-file', 'high', `rm of a protected path (${paths.join(' ')})`);
  }
  if (paths.length && paths.every((p) => isScratchPath(p, target))) {
    return hit('shell.rm.scratch', 'medium', `rm of specific files under a scratch path (${paths.join(' ')})`);
  }
  return hit('shell.rm.file', 'high', `rm of ${paths.join(' ') || '(no path)'}${force ? ' with -f' : ''}`);
}

function classifyFind(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  if (cmd.args.includes('-delete')) {
    return hit('shell.find.delete', 'high', 'find -delete removes every match');
  }
  const execIdx = cmd.args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok');
  if (execIdx >= 0) {
    const inner = cmd.args.slice(execIdx + 1).filter((a) => a !== ';' && a !== '\;' && a !== '+');
    if (!inner.length) return hit('shell.find.exec', 'high', 'find -exec with an opaque command');
    const innerHit = classifySimpleCommand(
      { name: inner[0]!, args: inner.slice(1), redirects: [], raw: inner.join(' '), pipedInto: false },
      target,
    );
    // -exec runs the inner command once per match, so its blast radius is at least
    // as large as the inner command's and usually much larger.
    return {
      ruleId: 'shell.find.exec',
      tier: innerHit.tier === 'read_only' ? 'read_only' : 'high',
      reason: `find -exec runs "${inner.join(' ')}" for every match: ${innerHit.reason}`,
    };
  }
  return hit('shell.find.read', 'read_only', 'find without -delete or -exec only lists files');
}

function classifySed(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const inPlace = cmd.args.some((a) => a === '-i' || a.startsWith('-i.') || (a.startsWith('-') && !a.startsWith('--') && a.includes('i')));
  if (!inPlace) return hit('shell.sed.read', 'read_only', 'sed without -i only writes to stdout');
  const files = cmd.args.filter((a) => !a.startsWith('-') && !a.includes('s/') && !a.startsWith('/'));
  const targets = cmd.args.filter((a) => a.startsWith('/'));
  if (targets.some((p) => isProtectedPath(p, target))) {
    return hit('shell.sed.protected', 'high', `sed -i edits a protected file (${targets.join(' ')})`);
  }
  return hit('shell.sed.inplace', 'medium', `sed -i rewrites ${[...files, ...targets].join(' ') || 'a file'} in place`);
}

function classifyAwk(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a.startsWith('-i') || a.includes('system('))) {
    return hit('shell.awk.system', 'high', 'awk invoking system() or editing in place');
  }
  return hit('shell.awk.read', 'read_only', 'awk reading and formatting text');
}

function classifyDd(cmd: SimpleCommand): RuleHit {
  const of = cmd.args.find((a) => a.startsWith('of='))?.slice(3);
  if (of && isDevicePath(of)) {
    return hit('shell.dd.device', 'forbidden', `dd writing directly to block device ${of}`);
  }
  return hit('shell.dd', 'high', 'dd performs raw block writes');
}

const SYSTEMCTL_READ = new Set(['status', 'show', 'list-units', 'list-unit-files', 'is-active', 'is-enabled', 'is-failed', 'cat', 'list-timers', 'list-sockets']);
const SYSTEMCTL_HIGH = new Set(['disable', 'mask', 'unmask', 'isolate', 'set-default', 'daemon-reexec']);

function classifySystemctl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const verb = cmd.args.find((a) => !a.startsWith('-'));
  if (!verb) return hit('shell.systemctl.list', 'read_only', 'systemctl with no verb lists units');
  if (SYSTEMCTL_READ.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'read_only', `systemctl ${verb} only reads unit state`);
  }
  if (SYSTEMCTL_HIGH.has(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} changes boot-time behaviour`);
  }
  if (['poweroff', 'reboot', 'halt', 'kexec', 'suspend'].includes(verb)) {
    return hit(`shell.systemctl.${verb}`, 'high', `systemctl ${verb} takes the host down`);
  }

  const unit = cmd.args.find((a) => a !== verb && !a.startsWith('-'));
  const allowed = target.unitAllowlist;
  const unitAllowed = !!unit && !!allowed && allowed.includes(unit);

  if (verb === 'reload' || verb === 'reload-or-restart') {
    return unitAllowed
      ? hit('shell.systemctl.reload.allowlisted', 'low', `reload of allowlisted unit ${unit}`)
      : hit('shell.systemctl.reload', 'medium', `systemctl reload ${unit ?? ''} re-reads config`);
  }
  if (['restart', 'start', 'stop', 'try-restart', 'enable'].includes(verb)) {
    return hit(
      `shell.systemctl.${verb}`,
      'medium',
      `systemctl ${verb} ${unit ?? ''} interrupts or changes a running service`,
    );
  }
  return hit('shell.systemctl.other', 'high', `unrecognised systemctl verb "${verb}"`);
}

function classifyService(cmd: SimpleCommand): RuleHit {
  const verb = cmd.args[1];
  if (verb === 'status') return hit('shell.service.status', 'read_only', 'service status only reads');
  return hit('shell.service', 'medium', `service ${cmd.args.join(' ')} changes a running service`);
}

function classifyKill(cmd: SimpleCommand): RuleHit {
  const sig = cmd.args.find((a) => a.startsWith('-'));
  if (!sig || /^-(15|TERM|SIGTERM|1|HUP|SIGHUP)$/i.test(sig)) {
    return hit('shell.kill.term', 'low', `kill ${sig ?? '-TERM'} asks a process to stop gracefully`);
  }
  if (/^-(9|KILL|SIGKILL)$/i.test(sig)) {
    return hit('shell.kill.force', 'medium', 'kill -9 terminates without cleanup, risking data loss');
  }
  return hit('shell.kill', 'medium', `kill ${sig} signals a process`);
}

function classifyChmod(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const recursive = cmd.args.some((a) => a === '-R' || a === '--recursive');
  const mode = cmd.args.find((a) => /^[0-7]{3,4}$/.test(a) || /^[ugoa]*[+-=]/.test(a));
  const paths = cmd.args.filter((a) => !a.startsWith('-') && a !== mode);

  if (mode === '777' || mode === '0777') {
    return hit('shell.chmod.777', 'high', 'chmod 777 makes a path world-writable');
  }
  if (mode === '000' || mode === '0000') {
    return hit('shell.chmod.000', 'high', 'chmod 000 removes all access');
  }
  if (recursive && paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chmod.recursive-protected', 'forbidden', `recursive chmod of ${paths.join(' ')}`);
  }
  if (recursive) return hit('shell.chmod.recursive', 'high', `recursive chmod of ${paths.join(' ')}`);
  if (paths.length && paths.every((p) => isWritablePath(p, target))) {
    return hit('shell.chmod.writable', 'low', `chmod within the target's writable paths (${paths.join(' ')})`);
  }
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chmod.protected', 'high', `chmod of a protected path (${paths.join(' ')})`);
  }
  return hit('shell.chmod', 'medium', `chmod ${cmd.args.join(' ')}`);
}

function classifyChown(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const recursive = cmd.args.some((a) => a === '-R' || a === '--recursive');
  const paths = cmd.args.filter((a) => !a.startsWith('-')).slice(1);
  if (recursive && paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.chown.recursive-protected', 'forbidden', `recursive chown of ${paths.join(' ')}`);
  }
  if (recursive) return hit('shell.chown.recursive', 'high', `recursive chown of ${paths.join(' ')}`);
  if (paths.length && paths.every((p) => isWritablePath(p, target))) {
    return hit('shell.chown.writable', 'low', `chown within writable paths (${paths.join(' ')})`);
  }
  return hit('shell.chown', 'medium', `chown ${cmd.args.join(' ')}`);
}

function classifyCopyMove(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  const dest = paths[paths.length - 1];
  if (dest && isProtectedPath(dest, target)) {
    return hit(`shell.${cmd.name}.protected`, 'high', `${cmd.name} writing into protected path ${dest}`);
  }
  if (dest && isWritablePath(dest, target)) {
    return hit(`shell.${cmd.name}.writable`, 'low', `${cmd.name} into a writable path (${dest})`);
  }
  return hit(`shell.${cmd.name}`, 'medium', `${cmd.name} ${cmd.args.join(' ')} modifies the filesystem`);
}

function classifyTruncate(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const zero = cmd.args.some((a) => a === '-s' || a.startsWith('--size')) &&
    cmd.args.some((a) => a === '0' || a === '-s0');
  const paths = cmd.args.filter((a) => !a.startsWith('-') && a !== '0');
  if (zero && paths.every((p) => p.endsWith('.log') || isScratchPath(p, target))) {
    return hit('shell.truncate.log', 'low', `truncating log file(s) ${paths.join(' ')}`);
  }
  return hit('shell.truncate', 'high', `truncate ${cmd.args.join(' ')} discards file contents`);
}

function classifyHttpClient(cmd: SimpleCommand): RuleHit {
  if (cmd.pipedInto) {
    return hit(
      'shell.curl.pipe',
      'forbidden',
      `${cmd.name} piped into another command downloads and runs unreviewed code`,
    );
  }
  const method = cmd.args.find((a, i) => (a === '-X' || a === '--request') && cmd.args[i + 1])
    ? cmd.args[cmd.args.findIndex((a) => a === '-X' || a === '--request') + 1]
    : null;
  if (cmd.args.some((a) => a === '-I' || a === '--head')) {
    return hit('shell.curl.head', 'read_only', `${cmd.name} HEAD request`);
  }
  if (!method || method.toUpperCase() === 'GET') {
    return hit('shell.curl.get', 'read_only', `${cmd.name} GET request`);
  }
  if (method.toUpperCase() === 'DELETE') {
    return hit('shell.curl.delete', 'high', `${cmd.name} -X DELETE`);
  }
  return hit('shell.curl.write', 'medium', `${cmd.name} -X ${method} sends a mutating request`);
}

function classifyJournalctl(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a.startsWith('--vacuum') || a === '--rotate' || a === '--flush')) {
    return hit('shell.journalctl.vacuum', 'medium', 'journalctl vacuum/rotate discards logs');
  }
  return hit('shell.journalctl.read', 'read_only', 'journalctl reads the journal');
}

const GIT_READ = new Set(['status', 'log', 'diff', 'show', 'branch', 'remote', 'describe', 'blame', 'rev-parse', 'ls-files']);

function classifyGit(cmd: SimpleCommand): RuleHit {
  // Skip global options that take a value (`git -C /path push`, `git -c k=v …`) so the
  // subcommand isn't read as a path or config value.
  const verb = files.operands(cmd.args, ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix']).ops[0];
  if (!verb) return hit('shell.git', 'read_only', 'git with no subcommand');
  if (GIT_READ.has(verb)) return hit(`shell.git.${verb}`, 'read_only', `git ${verb} only reads`);
  if (verb === 'push' && cmd.args.some((a) => a === '--force' || a === '-f')) {
    return hit('shell.git.force-push', 'high', 'git push --force can destroy remote history');
  }
  if (verb === 'reset' && cmd.args.includes('--hard')) {
    return hit('shell.git.reset-hard', 'high', 'git reset --hard discards uncommitted work');
  }
  if (verb === 'clean' && cmd.args.some((a) => a.includes('f'))) {
    return hit('shell.git.clean', 'high', 'git clean -f deletes untracked files');
  }
  return hit(`shell.git.${verb}`, 'medium', `git ${verb} modifies the working tree`);
}

function classifyIptables(cmd: SimpleCommand): RuleHit {
  if (cmd.args.some((a) => a === '-L' || a === '--list' || a === '-S' || a === 'status')) {
    return hit('shell.firewall.list', 'read_only', 'listing firewall rules');
  }
  if (cmd.args.some((a) => ['-F', '-X', '-P', '--flush', 'disable', 'stop'].includes(a))) {
    return hit(
      'shell.firewall.flush',
      'high',
      'flushing or disabling firewall rules can expose the host and lock you out',
    );
  }
  return hit('shell.firewall.modify', 'high', `${cmd.name} ${cmd.args.join(' ')} changes firewall rules`);
}

function classifyTee(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const paths = cmd.args.filter((a) => !a.startsWith('-'));
  if (paths.some((p) => isProtectedPath(p, target))) {
    return hit('shell.tee.protected', 'high', `tee writing into a protected path (${paths.join(' ')})`);
  }
  return hit('shell.tee', 'medium', `tee writes to ${paths.join(' ') || 'a file'}`);
}

function classifySqlClient(cmd: SimpleCommand): RuleHit {
  const sql = cmd.args.join(' ');
  if (/\b(DROP|TRUNCATE|ALTER)\b/i.test(sql)) {
    return hit('shell.sql.ddl', 'high', 'SQL containing DROP/TRUNCATE/ALTER');
  }
  if (/\b(DELETE|UPDATE)\b/i.test(sql) && !/\bWHERE\b/i.test(sql)) {
    return hit('shell.sql.unqualified', 'high', 'DELETE/UPDATE without a WHERE clause affects every row');
  }
  if (/\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
    return hit('shell.sql.dml', 'medium', 'SQL that modifies rows');
  }
  return hit('shell.sql.read', 'read_only', 'read-only SQL');
}

/** Redirections write files regardless of what the command itself does. */
export function classifyRedirects(cmd: SimpleCommand, target: ResolvedTarget): RuleHit | null {
  for (const r of cmd.redirects) {
    if (r.op === '<') continue;
    if (isDevicePath(r.path)) {
      return hit('shell.redirect.device', 'forbidden', `redirecting output to device ${r.path}`);
    }
    if (isProtectedPath(r.path, target)) {
      return hit('shell.redirect.protected', 'high', `redirecting output into protected path ${r.path}`);
    }
    if (!isWritablePath(r.path, target)) {
      return hit('shell.redirect', 'medium', `redirecting output to ${r.path} writes a file`);
    }
  }
  return null;
}

/** Whole-line patterns that no per-command rule would catch. */
export function classifyWholeLine(command: string): RuleHit | null {
  if (/:\s*\(\s*\)\s*\{.*\|.*&.*\}\s*;?\s*:/.test(command)) {
    return hit('shell.forkbomb', 'forbidden', 'fork bomb');
  }
  if (/\bhistory\s+-c\b/.test(command)) {
    return hit('shell.history-clear', 'forbidden', 'clearing shell history destroys audit evidence');
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(command)) {
    return hit('shell.embedded-key', 'high', 'command contains an embedded private key');
  }
  if (/\bAKIA[0-9A-Z]{16}\b/.test(command)) {
    return hit('shell.embedded-credential', 'high', 'command contains what looks like an AWS access key');
  }
  return null;
}

/** Read a nested command string, returning null when it cannot be read safely. */
function lexInner(inner: string): SimpleCommand[] | null {
  const lexed = lexShell(inner);
  return lexed.ok ? lexed.commands : null;
}

// --------------------------------------------------------------------------
// Container and cluster tooling
//
// Absent from the ruleset until now, which meant every `kubectl` and `docker`
// invocation fell through to `shell.unknown` and failed closed at `high`. On a
// Kubernetes host that made `kubectl get pods` indistinguishable from
// `kubectl delete namespace` -- both red, both approval-gated -- which is precisely
// the approval fatigue the risk model exists to avoid.
// --------------------------------------------------------------------------

/** Verbs that only read cluster state. */
const KUBECTL_READ = new Set([
  'get', 'describe', 'logs', 'top', 'events', 'explain', 'version', 'api-resources',
  'api-versions', 'cluster-info', 'config', 'auth', 'diff', 'wait',
]);

/** Deleting these takes out far more than the object named. */
const K8S_FORBIDDEN_RESOURCES = new Set([
  'namespace', 'namespaces', 'ns',
  'crd', 'crds', 'customresourcedefinition', 'customresourcedefinitions',
  'clusterrole', 'clusterroles', 'clusterrolebinding', 'clusterrolebindings',
  'node', 'nodes', 'storageclass', 'storageclasses', 'pv', 'persistentvolume',
]);

const K8S_POD_RESOURCES = new Set(['pod', 'pods', 'po']);

/** kubectl flags that take a following value, so `-n prod delete` isn't read as verb `prod`. */
const KUBECTL_VALUE_FLAGS = [
  '-n', '--namespace', '--context', '--cluster', '--user', '--kubeconfig', '-o', '--output',
  '--as', '--as-group', '-l', '--selector', '--field-selector', '-s', '--server', '--token',
  '--certificate-authority', '--client-certificate', '--client-key', '--request-timeout',
  '--cache-dir', '--chunk-size', '--field-manager', '-f', '--filename', '-c', '--container',
];

function classifyKubectl(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const args = files.operands(cmd.args, KUBECTL_VALUE_FLAGS).ops;
  const verb = args[0];
  if (!verb) return hit('shell.kubectl', 'read_only', 'kubectl with no subcommand prints help');

  // `kubectl exec pod -- <cmd>` runs an arbitrary command inside a container. Without
  // recursion this is a universal bypass, so the inner command decides the tier.
  if (verb === 'exec' || verb === 'run') {
    const sep = cmd.args.indexOf('--');
    const inner = sep >= 0 ? cmd.args.slice(sep + 1) : [];
    if (verb === 'run' && sep < 0) {
      return hit('shell.kubectl.run', 'medium', 'kubectl run creates a new workload');
    }
    if (inner.length === 0) {
      return hit('shell.kubectl.exec', 'high', 'kubectl exec opens an unreviewable shell in a container');
    }
    const worst = classifyNested(inner, target);
    if (!worst) {
      return hit('shell.kubectl.exec', 'high', `kubectl exec -- "${inner.join(' ')}" could not be read safely`);
    }
    return { ...worst, reason: `kubectl exec: ${worst.reason}` };
  }

  // Reading Secret objects prints live credentials (base64 is not encryption), so it
  // pauses for a human like reading a key file over SSH does. `describe` shows only
  // key names and sizes, so it stays read-only.
  if (verb === 'get') {
    const kinds = (args[1] ?? '').toLowerCase().split(',').map((k) => k.split('/')[0]!.split('.')[0]!);
    const rawPath = cmd.args.find((a) => /\/secrets(\/|$|\?)/.test(a));
    if (kinds.some((k) => k === 'secret' || k === 'secrets') || rawPath) {
      return hit('shell.kubectl.get.secret', 'medium', 'reading Kubernetes Secrets exposes credentials; requires approval');
    }
  }

  if (KUBECTL_READ.has(verb)) {
    return hit(`shell.kubectl.${verb}`, 'read_only', `kubectl ${verb} only reads cluster state`);
  }

  if (verb === 'rollout') {
    const sub = args[1];
    if (sub === 'status' || sub === 'history') {
      return hit('shell.kubectl.rollout.read', 'read_only', `kubectl rollout ${sub} only reads`);
    }
    return hit('shell.kubectl.rollout', 'medium', `kubectl rollout ${sub ?? ''} restarts workloads`);
  }

  if (verb === 'scale') {
    const zero = cmd.args.some((a) => a === '--replicas=0' || a === '0');
    return zero
      ? hit('shell.kubectl.scale.zero', 'high', 'scaling to zero replicas takes the workload offline')
      : hit('shell.kubectl.scale', 'medium', 'kubectl scale changes replica count');
  }

  if (verb === 'delete') {
    const resource = args[1]?.split('/')[0]?.toLowerCase();
    if (resource && K8S_FORBIDDEN_RESOURCES.has(resource)) {
      return hit(
        'shell.kubectl.delete.cluster',
        'forbidden',
        `deleting a ${resource} destroys everything inside it`,
      );
    }
    // A sweep across every namespace has an unknowable blast radius.
    if (cmd.args.some((a) => a === '--all-namespaces' || a === '-A' || a === '--all')) {
      return hit('shell.kubectl.delete.all', 'high', 'kubectl delete across all namespaces or all objects');
    }
    if (resource && K8S_POD_RESOURCES.has(resource)) {
      return hit('shell.kubectl.delete.pod', 'medium', 'deleting a pod; the controller should recreate it');
    }
    return hit('shell.kubectl.delete', 'high', `kubectl delete ${resource ?? ''} removes a cluster object`);
  }

  if (['drain', 'taint', 'apply', 'patch', 'replace', 'edit'].includes(verb)) {
    return hit(`shell.kubectl.${verb}`, 'high', `kubectl ${verb} changes cluster state directly`);
  }
  if (['cordon', 'uncordon', 'annotate', 'label', 'set', 'expose', 'autoscale'].includes(verb)) {
    return hit(`shell.kubectl.${verb}`, 'medium', `kubectl ${verb} modifies an object`);
  }
  if (verb === 'port-forward' || verb === 'proxy' || verb === 'cp') {
    return hit(`shell.kubectl.${verb}`, 'medium', `kubectl ${verb} opens a channel into the cluster`);
  }

  return hit('shell.kubectl.other', 'high', `unrecognised kubectl verb "${verb}"`);
}

/** k3s wraps kubectl; classify what follows. */
function classifyK3s(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  if (cmd.args[0] === 'kubectl') {
    return classifyKubectl({ ...cmd, name: 'kubectl', args: cmd.args.slice(1) }, target);
  }
  return hit('shell.k3s', 'high', `k3s ${cmd.args.join(' ')} manages the cluster itself`);
}

const DOCKER_READ = new Set([
  'ps', 'logs', 'inspect', 'stats', 'images', 'version', 'info', 'top', 'port',
  'diff', 'history', 'events', 'search',
]);

/** Management nouns in `docker <noun> <subcommand>` (the modern form of the verbs above). */
const DOCKER_NOUNS = new Set(['image', 'container', 'volume', 'network', 'system', 'node', 'service', 'context', 'builder', 'buildx', 'plugin', 'manifest', 'trust', 'config', 'secret', 'swarm', 'stack', 'checkpoint']);
/** Nouns whose changes hit shared infrastructure, so a change there is high, not medium. */
const DOCKER_INFRA_NOUNS = new Set(['volume', 'network', 'system', 'node', 'service', 'swarm', 'secret', 'config']);
/** Subcommands that only read, under any management noun. */
const DOCKER_READ_SUB = new Set(['ls', 'list', 'inspect', 'ps', 'logs', 'stats', 'top', 'history', 'df', 'info', 'events', 'version', 'port', 'diff']);

/** docker global flags that take a value, so `docker -H tcp://x ps` reads as verb `ps`. */
const DOCKER_VALUE_FLAGS = ['-H', '--host', '--context', '--config', '--log-level', '-l'];

function classifyDocker(cmd: SimpleCommand, target: ResolvedTarget): RuleHit {
  const args = files.operands(cmd.args, DOCKER_VALUE_FLAGS).ops;
  const verb = args[0];
  if (!verb) return hit('shell.docker', 'read_only', 'docker with no subcommand prints help');

  // Flags that hand the container the host. These are not recoverable mistakes, so
  // they are checked before the verb -- `docker run --privileged` is forbidden
  // regardless of how benign the rest of the line looks.
  if (hasHostEscape(cmd.args)) {
    return hit(
      'shell.docker.escape',
      'forbidden',
      'this container would have host-level access (privileged, a host namespace, the docker socket, or / mounted in)',
    );
  }

  if (DOCKER_READ.has(verb)) {
    return hit(`shell.docker.${verb}`, 'read_only', `docker ${verb} only reads`);
  }

  if (verb === 'exec') {
    // Same bypass as kubectl exec: the inner command is what matters.
    const rest = cmd.args.filter((a) => !a.startsWith('-'));
    const inner = rest.slice(2);
    if (inner.length === 0) {
      return hit('shell.docker.exec', 'high', 'docker exec opens an unreviewable shell in a container');
    }
    const worst = classifyNested(inner, target);
    if (!worst) {
      return hit('shell.docker.exec', 'high', `docker exec "${inner.join(' ')}" could not be read safely`);
    }
    return { ...worst, reason: `docker exec: ${worst.reason}` };
  }

  if (verb === 'prune' || cmd.args.includes('prune')) {
    return hit('shell.docker.prune', 'high', 'docker prune deletes unused objects in bulk');
  }
  if (['rm', 'rmi', 'kill'].includes(verb)) {
    return hit(`shell.docker.${verb}`, 'high', `docker ${verb} destroys a container or image`);
  }
  // Modern management form: `docker <noun> <subcommand>`, e.g. `docker image ls`,
  // `docker container inspect`, `docker volume rm`. Read-only subcommands only read;
  // destructive ones delete in bulk; exec opens a shell; the rest change something.
  if (DOCKER_NOUNS.has(verb)) {
    const sub = args[1];
    if (sub && DOCKER_READ_SUB.has(sub)) return hit(`shell.docker.${verb}.read`, 'read_only', `docker ${verb} ${sub} only reads`);
    if (sub && ['rm', 'rmi', 'remove', 'prune', 'kill'].includes(sub)) return hit(`shell.docker.${verb}.${sub}`, 'high', `docker ${verb} ${sub} destroys ${verb}s`);
    if (sub === 'exec') return hit(`shell.docker.${verb}.exec`, 'high', `docker ${verb} exec opens an unreviewable shell in a container`);
    const infra = DOCKER_INFRA_NOUNS.has(verb);
    return hit(`shell.docker.${verb}`, infra ? 'high' : 'medium', `docker ${verb} ${sub ?? ''} changes ${infra ? 'shared infrastructure' : 'what is running'}`);
  }
  if (['start', 'restart', 'stop', 'pause', 'unpause', 'cp', 'update', 'rename', 'run', 'create'].includes(verb)) {
    return hit(`shell.docker.${verb}`, 'medium', `docker ${verb} changes what is running`);
  }
  if (verb === 'compose' || verb === 'stack') {
    const sub = args[1];
    if (sub === 'ps' || sub === 'logs' || sub === 'config') {
      return hit('shell.docker.compose.read', 'read_only', `docker ${verb} ${sub} only reads`);
    }
    if (sub === 'down') {
      return hit('shell.docker.compose.down', 'high', 'docker compose down stops and removes the stack');
    }
    return hit('shell.docker.compose', 'medium', `docker ${verb} ${sub ?? ''} changes the stack`);
  }

  return hit('shell.docker.other', 'high', `unrecognised docker verb "${verb}"`);
}

/** Capabilities that, added to a container, amount to root on the host. */
const DANGEROUS_CAPS = /^(ALL|SYS_ADMIN|SYS_MODULE|SYS_RAWIO|SYS_PTRACE|SYS_BOOT|DAC_READ_SEARCH|DAC_OVERRIDE|BPF|MKNOD)$/i;

/** Does a bind-mount source hand the container a security-critical part of the host? */
function mountEscapes(source: string | undefined): boolean {
  if (!source) return false;
  const s = source.replace(/^['"]|['"]$/g, '');
  if (/docker\.sock/.test(s)) return true; // the docker socket is a root shell by another name
  return /^\/(:|$)/.test(s) // host root
    || /^\/(etc|root|boot|proc|sys|dev|var\/run|run)(\/|:|$)/.test(s);
}

/** Container-escape flags, checked as whole tokens rather than substrings. */
function hasHostEscape(args: string[]): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === '--privileged') return true;
    // `--pid host` and `--pid=host` (and net/ipc/uts/userns) share a host namespace.
    if (/^--(pid|net|network|ipc|uts|userns)=host$/.test(a)) return true;
    if (/^--(pid|net|network|ipc|uts|userns)$/.test(a) && args[i + 1] === 'host') return true;
    // Turning off the sandbox that would otherwise contain a breakout.
    const secopt = a === '--security-opt' ? args[i + 1] : /^--security-opt=/.test(a) ? a.slice(15) : null;
    if (secopt && /(seccomp|apparmor)=unconfined|label=disable|systempaths=unconfined/.test(secopt)) return true;
    if (/^--cap-add(=|$)/.test(a)) {
      const cap = a.includes('=') ? a.split('=')[1] : args[i + 1];
      if (cap && DANGEROUS_CAPS.test(cap)) return true;
    }
    // The docker socket, or a host device, given straight to the container.
    if (/docker\.sock/.test(a)) return true;
    if ((a === '--device' && /^\/dev\//.test(args[i + 1] ?? '')) || /^--device=\/dev\//.test(a)) return true;

    // Host paths bind-mounted in: `-v /:/host`, `--volume=/etc:/h`.
    if ((a === '-v' || a === '--volume') && mountEscapes(args[i + 1])) return true;
    if (/^--volume=/.test(a) && mountEscapes(a.slice(9))) return true;
    // `--mount type=bind,source=/,target=/h`, in either `--mount spec` or `--mount=spec` form.
    if (a === '--mount' || /^--mount=/.test(a)) {
      const spec = a.startsWith('--mount=') ? a.slice(8) : args[i + 1] ?? '';
      if (mountEscapes(/(?:^|,)(?:src|source)=([^,]+)/.exec(spec)?.[1])) return true;
    }
  }
  return false;
}

const HELM_READ = new Set(['list', 'ls', 'status', 'get', 'history', 'show', 'version', 'search', 'template', 'lint']);

const HELM_VALUE_FLAGS = [
  '-n', '--namespace', '--kube-context', '--kubeconfig', '-o', '--output', '-f', '--values',
  '--set', '--set-string', '--set-file', '--version', '--repo', '--kube-apiserver', '--kube-token',
];

function classifyHelm(cmd: SimpleCommand): RuleHit {
  const args = files.operands(cmd.args, HELM_VALUE_FLAGS).ops;
  const verb = args[0];
  if (!verb) return hit('shell.helm', 'read_only', 'helm with no subcommand prints help');
  if (verb === 'repo') {
    const sub = args[1];
    return sub === 'list'
      ? hit('shell.helm.repo.list', 'read_only', 'helm repo list only reads')
      : hit('shell.helm.repo', 'low', `helm repo ${sub ?? ''} changes local repo config`);
  }
  if (HELM_READ.has(verb)) return hit(`shell.helm.${verb}`, 'read_only', `helm ${verb} only reads`);
  if (['uninstall', 'delete', 'rollback'].includes(verb)) {
    return hit(`shell.helm.${verb}`, 'high', `helm ${verb} tears down or reverts a release`);
  }
  if (['install', 'upgrade'].includes(verb)) {
    return hit(`shell.helm.${verb}`, 'medium', `helm ${verb} deploys a release`);
  }
  return hit('shell.helm.other', 'high', `unrecognised helm verb "${verb}"`);
}

/**
 * Classify a nested argv (the tail of `kubectl exec -- …` or `docker exec …`),
 * returning the worst tier found, or null when it cannot be read safely.
 */
function classifyNested(inner: string[], target: ResolvedTarget): RuleHit | null {
  const joined = inner.join(' ');
  const lexed = lexInner(joined);
  if (!lexed || lexed.length === 0) return null;
  return lexed
    .map((c) => classifySimpleCommand(c, target))
    .reduce((a, b) => (RANK[a.tier] >= RANK[b.tier] ? a : b));
}

registerCommandClassifier(classifySimpleCommand);
