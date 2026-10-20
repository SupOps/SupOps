import type { ReplayRule } from '../types.ts';

/**
 * Ordinary answers for the checks any investigation starts with, so a case only has
 * to record what is unusual about it. Case rules come first and win.
 */
export function basics(o: { host: string; load?: string; mem?: string; disk?: string } = { host: 'web-1' }): ReplayRule[] {
  return [
    { tool: 'ssh_exec', match: '^uptime', output: ` 10:42:07 up 41 days,  3:12,  1 user,  load average: ${o.load ?? '0.38, 0.41, 0.44'}` },
    {
      tool: 'ssh_exec',
      match: '^free\\b',
      output: o.mem ?? '               total        used        free      shared  buff/cache   available\nMem:            7.7Gi       2.9Gi       1.1Gi        12Mi       3.8Gi       4.6Gi\nSwap:              0B          0B          0B',
    },
    {
      tool: 'ssh_exec',
      match: '^df\\b(?!.*-i)',
      output:
        o.disk ??
        'Filesystem      Size  Used Avail Use% Mounted on\n/dev/nvme0n1p1   40G   14G   25G  36% /\ntmpfs           3.9G     0  3.9G   0% /dev/shm\n/dev/nvme0n1p15 105M  6.1M   99M   6% /boot/efi',
    },
    { tool: 'ssh_exec', match: '^(hostname|uname)', output: o.host },
    { tool: 'ssh_exec', match: '^(whoami|id)\\b', output: 'ops' },
    { tool: 'ssh_exec', match: '^date\\b', output: 'Sat Oct 18 10:42:07 UTC 2026' },
  ];
}

/** `top -bn1` style output with these processes first. */
export function top(load: string, cpus: number, procs: Array<[pid: number, user: string, cpu: number, mem: number, cmd: string]>): string {
  return [
    `top - 10:42:07 up 41 days,  3:12,  1 user,  load average: ${load}`,
    `Tasks: 212 total,   ${Math.min(procs.length, 9)} running, 203 sleeping,   0 stopped,   0 zombie`,
    `%Cpu(s): ${Math.min(99, procs.reduce((a, p) => a + p[2], 0) / cpus).toFixed(1)} us,  2.1 sy,  0.0 ni, ${Math.max(0, 100 - procs.reduce((a, p) => a + p[2], 0) / cpus).toFixed(1)} id,  0.3 wa`,
    'MiB Mem :   7856.4 total,   1120.2 free,   2961.0 used,   3775.2 buff/cache',
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ...procs.map(([pid, user, cpu, mem, cmd]) => `${String(pid).padStart(7)} ${user.padEnd(9)} 20   0  812344 ${String(Math.round(mem * 80)).padStart(6)}  10240 R ${cpu.toFixed(1).padStart(5)} ${mem.toFixed(1).padStart(5)}  12:01.33 ${cmd}`),
  ].join('\n');
}
