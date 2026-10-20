import { and, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { changes } from '@supops/db';
import { deployVerdict, familiesIn, obsRequest, redQueries, resourceQueries, type RedQueries, type ResolvedTarget, type SignalComparison } from '@supops/core';
import { db } from '../context.ts';
import { projectConnections } from '../observe/connections.ts';

/**
 * A service's RED signals and resources, from whichever metrics connection has them.
 * What a connection offers (its metric names) and where a service lives in it are
 * looked up once and remembered for a while: these are a few cheap reads, not a scan.
 */

const NAMES_TTL = 30 * 60_000;
const FOUND_TTL = 10 * 60_000;
const names = new Map<string, { at: number; names: string[] }>();
const found = new Map<string, { at: number; hit: ServiceSource | null }>();

export interface ServiceSource {
  conn: ResolvedTarget;
  red: RedQueries;
}

async function metricNames(conn: ResolvedTarget): Promise<string[]> {
  const have = names.get(conn.id);
  if (have && Date.now() - have.at < NAMES_TTL) return have.names;
  const r = await obsRequest(conn, '/api/v1/label/__name__/values', { timeoutMs: 15_000 });
  const list = 'error' in r ? [] : (((r.json as { data?: string[] }).data ?? []) as string[]);
  names.set(conn.id, { at: Date.now(), names: list });
  return list;
}

/** Where this service's request metrics are: the connection, the convention and the label. */
export async function findService(projectId: string, service: string): Promise<ServiceSource | null> {
  const key = `${projectId}\u0000${service.toLowerCase()}`;
  const have = found.get(key);
  if (have && Date.now() - have.at < FOUND_TTL) return have.hit;
  let hit: ServiceSource | null = null;
  outer: for (const conn of projectConnections(projectId, ['prometheus', 'grafana'])) {
    for (const f of familiesIn(await metricNames(conn))) {
      for (const label of f.serviceLabels) {
        const r = await obsRequest(conn, `/api/v1/label/${label}/values`, { query: { 'match[]': `${f.metric}_bucket` }, timeoutMs: 15_000 });
        if ('error' in r) continue;
        const values = ((r.json as { data?: string[] }).data ?? []) as string[];
        const match = values.find((v) => v.toLowerCase() === service.toLowerCase());
        if (match) {
          hit = { conn, red: redQueries(f, label, match) };
          break outer;
        }
      }
    }
  }
  found.set(key, { at: Date.now(), hit });
  return hit;
}

export async function instant(conn: ResolvedTarget, expr: string, atMs?: number): Promise<number | null> {
  const r = await obsRequest(conn, '/api/v1/query', { query: { query: expr, ...(atMs ? { time: (atMs / 1000).toFixed(3) } : {}) }, timeoutMs: 20_000 });
  if ('error' in r) return null;
  const v = ((r.json as { data?: { result?: Array<{ value: [number, string] }> } }).data?.result ?? [])[0]?.value?.[1];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function range(conn: ResolvedTarget, expr: string, startMs: number, endMs: number, stepS: number): Promise<Array<[number, number]>> {
  const r = await obsRequest(conn, '/api/v1/query_range', { query: { query: expr, start: Math.floor(startMs / 1000), end: Math.ceil(endMs / 1000), step: stepS }, timeoutMs: 20_000 });
  if ('error' in r) return [];
  const values = ((r.json as { data?: { result?: Array<{ values: Array<[number, string]> }> } }).data?.result ?? [])[0]?.values ?? [];
  return values.map(([t, v]) => [t * 1000, Number(v)] as [number, number]).filter(([, v]) => Number.isFinite(v));
}

/** The first of these queries that has data, as a resource query to use. */
export async function firstWithData(conn: ResolvedTarget, exprs: string[]): Promise<string | null> {
  for (const e of exprs) if ((await instant(conn, e)) !== null) return e;
  return null;
}

// ---------------------------------------------------------------------------
// Deploy verdicts
// ---------------------------------------------------------------------------

const WINDOW_MS = 30 * 60_000;
/** The first minutes after a deploy are warm-up, not the release's behaviour. */
const SETTLE_MS = 5 * 60_000;

/** Averages over the half hour before and the half hour after (past the warm-up), compared. */
export async function computeVerdict(projectId: string, service: string, at: Date) {
  const src = await findService(projectId, service);
  if (!src) return { computedAt: Date.now(), overall: 'unknown' as const, signals: [] };
  const t = at.getTime();
  const avg = (expr: string, endMs: number) => instant(src.conn, `avg_over_time((${expr})[30m:1m])`, endMs);
  const res = resourceQueries(service);
  const cpu = await firstWithData(src.conn, res.cpu);
  const memory = await firstWithData(src.conn, res.memory);
  const plan: Array<[string, SignalComparison['kind'], string | null]> = [
    ['p95 latency', 'latency', src.red.p95],
    ['errors', 'errors', src.red.errorRatio],
    ['requests', 'rate', src.red.rate],
    ['CPU', 'cpu', cpu],
    ['memory', 'memory', memory],
  ];
  const signals: SignalComparison[] = [];
  for (const [name, kind, expr] of plan) {
    if (!expr) continue;
    signals.push({ name, kind, before: await avg(expr, t), after: await avg(expr, t + SETTLE_MS + WINDOW_MS) });
  }
  return { computedAt: Date.now(), ...deployVerdict(signals) };
}

/** Deploys that have been out long enough to judge and have no verdict yet. */
export async function computeDueVerdicts(now = Date.now()): Promise<number> {
  const due = db
    .select()
    .from(changes)
    .where(and(inArray(changes.kind, ['deploy', 'rollback']), isNull(changes.verdict), lte(changes.startedAt, new Date(now - SETTLE_MS - WINDOW_MS)), gte(changes.startedAt, new Date(now - 24 * 3_600_000))))
    .limit(20)
    .all();
  let n = 0;
  for (const c of due) {
    // Without a service there is nothing to compare; settle it so it is not retried.
    const verdict = c.service ? await computeVerdict(c.projectId, c.service, c.startedAt) : { computedAt: Date.now(), overall: 'unknown' as const, signals: [] };
    db.update(changes).set({ verdict }).where(eq(changes.id, c.id)).run();
    n++;
  }
  return n;
}

/** For tests: forget what was learned about connections. */
export function forgetDiscovery(): void {
  names.clear();
  found.clear();
}
