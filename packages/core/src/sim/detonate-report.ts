import type { DetonationReport } from './detonate.ts';

/**
 * Assemble a {@link DetonationReport} from the raw outputs the detonation runner
 * collects around a container run: `docker diff` (what the writable layer changed), the
 * DNS and TCP sink logs (what the script looked up and tried to connect to), and which
 * planted canary files it opened. This is the parsing the runner would otherwise do
 * inline; keeping it here, in `packages/core`, means the security-relevant step is
 * fixture-tested without needing Docker. The runner (`apps/detonator`) is then thin
 * glue that only runs the container and calls this.
 */

export interface RawDetonation {
  engine: 'gvisor' | 'runc';
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  /** `docker diff <container>` output: lines of `A|C|D <path>`. */
  dockerDiff: string;
  /** DNS sink lines, e.g. `A example.com` or `query AAAA pool.supportxmr.com`. */
  dnsLog: string;
  /** TCP sink lines, e.g. `203.0.113.5:443 <first-bytes>`. */
  tcpLog: string;
  /** Canary files the script opened (from an open() wrapper in the image). */
  canaryOpened?: string[];
  /** Unique markers planted inside the canary files; seeing one on the wire proves exfil. */
  canaryTokens?: string[];
}

/** Writable-layer churn that is the container's own noise, not the script's doing. */
const NOISE = [/^\/tmp\//, /^\/run\//, /^\/var\/run\//, /^\/proc\//, /^\/sys\//, /^\/dev\//, /^\/var\/cache\//, /^\/root\/\.cache\//, /^\/\.dockerenv$/, /^\/var\/lib\/(dpkg|apt|rpm)\//];
const noise = (p: string) => NOISE.some((re) => re.test(p));

/** `A|C|D /path` → created / modified / deleted, dropping container noise. */
export function parseDockerDiff(diff: string): Pick<DetonationReport, 'filesCreated' | 'filesModified' | 'filesDeleted'> {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const line of diff.split('\n')) {
    const m = /^([ACD])\s+(\/.+)$/.exec(line.trim());
    if (!m || noise(m[2]!)) continue;
    (m[1] === 'A' ? created : m[1] === 'D' ? deleted : modified).push(m[2]!);
  }
  return { filesCreated: created, filesModified: modified, filesDeleted: deleted };
}

/** DNS sink lines → the names looked up (deduped, de-trailing-dotted). */
export function parseDns(log: string): string[] {
  const names = new Set<string>();
  for (const line of log.split('\n')) {
    const m = /(?:^|\s)([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9-]+)+)\.?\s*$/.exec(line.trim());
    if (m) names.add(m[1]!.replace(/\.$/, ''));
  }
  return [...names];
}

/** TCP sink lines → attempted connections with a short preview of the first bytes. */
export function parseTcp(log: string): DetonationReport['connects'] {
  const out: DetonationReport['connects'] = [];
  for (const line of log.split('\n')) {
    const m = /^(\[?[0-9a-fA-F:.]+\]?):(\d{1,5})(?:\s+(.*))?$/.exec(line.trim());
    if (!m) continue;
    const host = m[1]!.replace(/^\[|\]$/g, '');
    out.push({ host, port: Number(m[2]), ...(m[3] ? { preview: m[3].slice(0, 120) } : {}) });
  }
  return out;
}

export function assembleReport(raw: RawDetonation): DetonationReport {
  const files = parseDockerDiff(raw.dockerDiff);
  const dnsQueries = parseDns(raw.dnsLog);
  const connects = parseTcp(raw.tcpLog);
  // A canary's secret marker seen in a DNS name or a connection payload is proof its
  // contents left the box -- the clearest exfiltration signal there is.
  const tokens = raw.canaryTokens ?? [];
  const wire = `${raw.tcpLog}\n${raw.dnsLog}`;
  const canaryExfil = tokens.length > 0 && tokens.some((t) => t.length >= 6 && wire.includes(t));
  return {
    ran: true,
    engine: raw.engine,
    exitCode: raw.exitCode,
    durationMs: raw.durationMs,
    stdout: raw.stdout,
    dnsQueries,
    connects,
    ...files,
    canaryReads: raw.canaryOpened ?? [],
    canaryExfil,
  };
}

/** The report for a run that never happened (image missing, over budget, engine down). */
export function notRun(note: string, engine: DetonationReport['engine'] = 'unavailable'): DetonationReport {
  return { ran: false, engine, exitCode: null, durationMs: 0, stdout: '', dnsQueries: [], connects: [], filesCreated: [], filesModified: [], filesDeleted: [], canaryReads: [], canaryExfil: false, note };
}
