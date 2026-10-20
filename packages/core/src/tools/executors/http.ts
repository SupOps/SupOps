import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

/**
 * A deliberately narrow HTTP client for reading observability APIs.
 *
 * - Requests never leave the connection's configured origin, and redirects are not
 *   followed: a backend cannot bounce the agent somewhere else.
 * - The address is checked at connect time, inside the DNS lookup the socket actually
 *   uses, so a name that resolves to something else on a second lookup cannot slip
 *   past. Cloud metadata endpoints are always refused; private and loopback addresses
 *   only when the connection allows them.
 * - GET only, with a time limit and a cap on how much of the body is read.
 */
export interface SafeGetOptions {
  baseUrl: string;
  path: string;
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  allowPrivateNetwork: boolean;
  insecureSkipVerify?: boolean;
  timeoutMs: number;
  maxBytes: number;
  signal?: AbortSignal;
  /** POST a JSON body instead of GET (Elasticsearch _search). Still read-only for the backend. */
  jsonBody?: unknown;
  /** Override the method (e.g. DELETE for ending an Alertmanager silence). */
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
}

export interface SafeGetResult {
  status: number;
  body: string;
  truncated: boolean;
  /** The Location header of a redirect, which is never followed automatically. */
  location?: string;
}

export class BlockedAddressError extends Error {}

/** Addresses no connection may reach, whatever its settings: cloud instance metadata and unspecified. */
function alwaysBlocked(ip: string): boolean {
  if (ip === '169.254.169.254' || ip.startsWith('169.254.')) return true; // link-local incl. AWS/GCP/Azure metadata
  if (ip === '100.100.100.200') return true; // Alibaba metadata
  if (ip === '0.0.0.0' || ip === '::' ) return true;
  const v6 = ip.toLowerCase();
  if (v6.startsWith('fe80:') || v6 === 'fd00:ec2::254') return true;
  return false;
}

function isPrivate(ip: string): boolean {
  if (ip.startsWith('::ffff:')) return isPrivate(ip.slice(7));
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd');
}

/** Why this address may not be contacted, or null if it may. */
export function addressProblem(ip: string, allowPrivateNetwork: boolean): string | null {
  const bare = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (alwaysBlocked(bare)) return `${ip} is a link-local or cloud-metadata address and is never reachable`;
  if (!allowPrivateNetwork && isPrivate(bare)) return `${ip} is a private or loopback address; enable "private network" on this connection to allow it`;
  return null;
}

/**
 * A socket `lookup` that refuses addresses `refuse` objects to. It answers in the shape
 * the caller asked for: Node's connection racing (autoSelectFamily, on by default since
 * Node 20) asks for every address at once (`all: true`) and fails with "Invalid IP
 * address: undefined" if handed a single one. Every address is checked, so a name with
 * one public and one internal record cannot slip the internal one through.
 */
export function guardLookup(refuse: (ip: string, hostname: string) => Error | null): LookupFunction {
  return (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (err, addresses) => {
      const cb = callback as (e: Error | null, a: unknown, f?: number) => void;
      if (err) return cb(err, options.all ? [] : '', 0);
      const list = addresses as Array<{ address: string; family: number }>;
      for (const a of list) {
        const problem = refuse(a.address, hostname);
        if (problem) return cb(problem, options.all ? [] : '', 0);
      }
      if (options.all) return cb(null, list);
      const first = list[0];
      if (!first) return cb(Object.assign(new Error(`${hostname} has no addresses`), { code: 'ENOTFOUND' }), '', 0);
      cb(null, first.address, first.family);
    });
  };
}

function guardedLookup(allowPrivateNetwork: boolean): LookupFunction {
  return guardLookup((ip) => {
    const problem = addressProblem(ip, allowPrivateNetwork);
    return problem ? new BlockedAddressError(problem) : null;
  });
}

export function buildUrl(baseUrl: string, path: string, query?: SafeGetOptions['query']): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('only http and https connections are supported');
  if (!path.startsWith('/') || path.includes('..') || /^\/\//.test(path)) throw new Error('invalid API path');
  const url = new URL(base.pathname.replace(/\/$/, '') + path, base.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  if (url.origin !== base.origin) throw new Error('request would leave the connection origin');
  return url;
}

export function safeGet(o: SafeGetOptions): Promise<SafeGetResult> {
  const url = buildUrl(o.baseUrl, o.path, o.query);
  // A literal IP in the URL never goes through lookup, so check it here.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    const problem = addressProblem(host, o.allowPrivateNetwork);
    if (problem) return Promise.reject(new BlockedAddressError(problem));
  }
  const body = o.jsonBody === undefined ? undefined : JSON.stringify(o.jsonBody);
  const method = o.method ?? (body ? 'POST' : 'GET');
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : {}),
          ...o.headers,
        },
        lookup: guardedLookup(o.allowPrivateNetwork),
        timeout: o.timeoutMs,
        ...(url.protocol === 'https:' && o.insecureSkipVerify ? { rejectUnauthorized: false } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          if (size >= o.maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
          size += c.length;
        });
        const done = () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).subarray(0, o.maxBytes).toString('utf8'),
            truncated: truncated || size > o.maxBytes,
            ...(typeof res.headers.location === 'string' ? { location: res.headers.location } : {}),
          });
        res.on('end', done);
        res.on('close', done);
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no response within ${Math.round(o.timeoutMs / 1000)}s`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Follow one redirect, but only to an allowlisted host (e.g. the storage a CI log is
 * served from), over https, without the original credentials, and never to a private
 * or metadata address.
 */
export async function followAllowedRedirect(
  first: SafeGetResult,
  allowedHosts: RegExp[],
  o: Pick<SafeGetOptions, 'timeoutMs' | 'maxBytes' | 'signal'>,
): Promise<SafeGetResult> {
  if (first.status < 300 || first.status >= 400 || !first.location) return first;
  let next: URL;
  try {
    next = new URL(first.location);
  } catch {
    return first;
  }
  if (next.protocol !== 'https:' || !allowedHosts.some((re) => re.test(next.hostname))) return first;
  return safeGet({
    baseUrl: next.origin,
    path: next.pathname,
    query: Object.fromEntries(next.searchParams),
    headers: { accept: '*/*' },
    allowPrivateNetwork: false,
    timeoutMs: o.timeoutMs,
    maxBytes: o.maxBytes,
    ...(o.signal ? { signal: o.signal } : {}),
  });
}
