import { promises as dnsp } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tcpConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { addressProblem } from '../tools/executors/http.ts';
import { guarded } from '../tools/net-check.ts';

/**
 * Scheduled checks from the SupOps server: is the URL up and returning what it should,
 * does the port answer, does the name resolve, how long until the certificate expires.
 * Structured results (not text for a model), so each one counts towards availability.
 * The same address rules as net_check: internal addresses only when the check allows
 * them, cloud metadata never.
 */

export type SyntheticKind = 'http' | 'tcp' | 'dns' | 'tls';

export interface SyntheticSpec {
  kind: SyntheticKind;
  /** http: the URL. tcp/tls/dns: the host name or address. */
  target: string;
  port?: number | null;
  method?: 'GET' | 'HEAD' | null;
  /** http: accepted status codes, e.g. "200-399" or "200,204". Default 200-399. */
  expectStatus?: string | null;
  /** http: the body must contain this text. dns: an answer must contain it. */
  contains?: string | null;
  /** Slower than this counts as degraded, not down. */
  maxLatencyMs?: number | null;
  /** Fewer certificate days than this counts as degraded. Default 14. */
  certDaysWarn?: number | null;
  allowPrivate?: boolean;
  timeoutMs?: number;
}

export interface SyntheticResult {
  ok: boolean;
  /** up, degraded (works, but slow or the certificate is near expiry) or down. */
  status: 'up' | 'degraded' | 'down';
  latencyMs: number | null;
  statusCode?: number;
  certDaysLeft?: number;
  /** Why it is not plainly up. */
  error?: string;
}

const bare = (h: string) => h.replace(/^\[|\]$/g, '');

function refused(host: string, allowPrivate: boolean): string | null {
  if (!isIP(host)) return null;
  if (addressProblem(host, true)) return `${host} is a link-local or cloud-metadata address and is never checked`;
  if (!allowPrivate && addressProblem(host, false)) return `${host} is an internal address; allow internal addresses on this check to reach it`;
  return null;
}

/** "200-399,418" -> a test. */
export function statusMatcher(spec: string | null | undefined): (code: number) => boolean {
  const parts = (spec?.trim() || '200-399').split(',').map((p) => p.trim()).filter(Boolean);
  return (code) =>
    parts.some((p) => {
      const m = /^(\d{3})(?:-(\d{3}))?$/.exec(p);
      if (!m) return false;
      const lo = Number(m[1]);
      const hi = m[2] ? Number(m[2]) : lo;
      return code >= lo && code <= hi;
    });
}

const certDays = (c: PeerCertificate | undefined) => (c?.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86_400_000) : undefined);

function grade(spec: SyntheticSpec, r: Omit<SyntheticResult, 'status' | 'ok'> & { failed?: string }): SyntheticResult {
  if (r.failed) return { ok: false, status: 'down', latencyMs: r.latencyMs, ...(r.statusCode !== undefined ? { statusCode: r.statusCode } : {}), ...(r.certDaysLeft !== undefined ? { certDaysLeft: r.certDaysLeft } : {}), error: r.failed };
  const warn = spec.certDaysWarn ?? 14;
  const notes: string[] = [];
  if (r.certDaysLeft !== undefined && r.certDaysLeft < 0) return { ok: false, status: 'down', latencyMs: r.latencyMs, certDaysLeft: r.certDaysLeft, ...(r.statusCode !== undefined ? { statusCode: r.statusCode } : {}), error: `the certificate expired ${-r.certDaysLeft} days ago` };
  if (r.certDaysLeft !== undefined && r.certDaysLeft < warn) notes.push(`the certificate expires in ${r.certDaysLeft} days`);
  if (spec.maxLatencyMs && r.latencyMs !== null && r.latencyMs > spec.maxLatencyMs) notes.push(`took ${r.latencyMs} ms (limit ${spec.maxLatencyMs} ms)`);
  return {
    ok: true,
    status: notes.length ? 'degraded' : 'up',
    latencyMs: r.latencyMs,
    ...(r.statusCode !== undefined ? { statusCode: r.statusCode } : {}),
    ...(r.certDaysLeft !== undefined ? { certDaysLeft: r.certDaysLeft } : {}),
    ...(notes.length ? { error: notes.join('; ') } : {}),
  };
}

function httpOnce(url: URL, spec: SyntheticSpec, timeoutMs: number): Promise<{ status: number; body: string; location?: string; cert?: PeerCertificate }> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, {
      method: spec.method ?? 'GET',
      headers: { 'user-agent': 'SupOps-synthetic/1.0', accept: '*/*' },
      lookup: guarded(!!spec.allowPrivate),
      timeout: timeoutMs,
      agent: false,
      ...(url.protocol === 'https:' ? { servername: isIP(bare(url.hostname)) ? undefined : url.hostname } : {}),
    }, (res) => {
      const sock = res.socket as TLSSocket | null;
      const cert = sock && 'getPeerCertificate' in sock ? sock.getPeerCertificate() : undefined;
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { if (body.length < 65_536) body += c; else res.destroy(); });
      const done = () => resolve({ status: res.statusCode ?? 0, body, ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}), ...(cert ? { cert } : {}) });
      res.on('end', done);
      res.on('close', done);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`no response within ${Math.round(timeoutMs / 1000)}s`)));
    req.on('error', reject);
    req.end();
  });
}

const reason = (err: unknown) => (err instanceof Error ? ((err as NodeJS.ErrnoException).code ? `${(err as NodeJS.ErrnoException).code}: ${err.message}` : err.message) : String(err));

export async function runSynthetic(spec: SyntheticSpec): Promise<SyntheticResult> {
  const timeoutMs = spec.timeoutMs ?? 15_000;
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  if (spec.kind === 'http') {
    let url: URL;
    try {
      url = new URL(spec.target);
    } catch {
      return grade(spec, { latencyMs: null, failed: `not a valid URL: ${spec.target}` });
    }
    let firstCert: PeerCertificate | undefined;
    for (let hop = 0; hop < 6; hop++) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return grade(spec, { latencyMs: null, failed: 'only http and https URLs are checked' });
      const no = refused(bare(url.hostname), !!spec.allowPrivate);
      if (no) return grade(spec, { latencyMs: null, failed: no });
      let r;
      try {
        r = await httpOnce(url, spec, timeoutMs);
      } catch (err) {
        return grade(spec, { latencyMs: elapsed(), failed: reason(err) });
      }
      firstCert ??= r.cert;
      // Redirects are followed, unless the check names that redirect status as what it expects.
      if (r.status >= 300 && r.status < 400 && r.location && !(spec.expectStatus && statusMatcher(spec.expectStatus)(r.status))) {
        url = new URL(r.location, url);
        continue;
      }
      const days = certDays(firstCert);
      const base = { latencyMs: elapsed(), statusCode: r.status, ...(days !== undefined ? { certDaysLeft: days } : {}) };
      if (!statusMatcher(spec.expectStatus)(r.status)) return grade(spec, { ...base, failed: `HTTP ${r.status} (expected ${spec.expectStatus || '200-399'})` });
      if (spec.contains && !r.body.includes(spec.contains)) return grade(spec, { ...base, failed: `the response does not contain "${spec.contains}"` });
      return grade(spec, base);
    }
    return grade(spec, { latencyMs: elapsed(), failed: 'too many redirects' });
  }

  const host = bare(spec.target);
  const no = refused(host, !!spec.allowPrivate);
  if (no) return grade(spec, { latencyMs: null, failed: no });

  if (spec.kind === 'dns') {
    try {
      const answers = await Promise.race([
        dnsp.lookup(host, { all: true }).then((xs) => xs.map((x) => x.address)),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)),
      ]);
      if (!answers.length) return grade(spec, { latencyMs: elapsed(), failed: 'no addresses' });
      if (spec.contains && !answers.some((a) => a.includes(spec.contains!))) return grade(spec, { latencyMs: elapsed(), failed: `resolves to ${answers.join(', ')}, not ${spec.contains}` });
      return grade(spec, { latencyMs: elapsed() });
    } catch (err) {
      return grade(spec, { latencyMs: elapsed(), failed: reason(err) });
    }
  }

  const port = spec.port ?? (spec.kind === 'tls' ? 443 : 0);
  if (!port) return grade(spec, { latencyMs: null, failed: 'a port is needed' });
  return new Promise((resolve) => {
    const lookup = guarded(!!spec.allowPrivate);
    const s: Socket = spec.kind === 'tls'
      ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, lookup, timeout: timeoutMs })
      : tcpConnect({ host, port, lookup, timeout: timeoutMs });
    const finish = (r: SyntheticResult) => { s.destroy(); resolve(r); };
    s.once(spec.kind === 'tls' ? 'secureConnect' : 'connect', () => {
      if (spec.kind === 'tls') {
        const t = s as TLSSocket;
        const days = certDays(t.getPeerCertificate());
        if (!t.authorized) return finish(grade(spec, { latencyMs: elapsed(), ...(days !== undefined ? { certDaysLeft: days } : {}), failed: `the certificate is not trusted (${t.authorizationError})` }));
        return finish(grade(spec, { latencyMs: elapsed(), ...(days !== undefined ? { certDaysLeft: days } : {}) }));
      }
      finish(grade(spec, { latencyMs: elapsed() }));
    });
    s.once('timeout', () => finish(grade(spec, { latencyMs: elapsed(), failed: `no answer within ${Math.round(timeoutMs / 1000)}s` })));
    s.once('error', (err) => finish(grade(spec, { latencyMs: elapsed(), failed: reason(err) })));
  });
}

/** The share of results that were up or degraded (working), 0..1, or null with none. */
export function availability(results: Array<{ ok: boolean }>): number | null {
  return results.length ? results.filter((r) => r.ok).length / results.length : null;
}
