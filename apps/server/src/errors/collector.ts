import { and, desc, eq, gte, lt, lte, sql } from 'drizzle-orm';
import { changes, errorGroups, projects } from '@supops/db';
import { exceptionsFromOtlp, groupErrors, obsRequest, parseErrorText, parseSpanError, type ErrorSample, type ResolvedTarget } from '@supops/core';
import { db } from '../context.ts';
import { projectConnections } from '../observe/connections.ts';

/**
 * Every few minutes: errors from logs (Loki) and traces (Tempo) since the last look,
 * grouped and counted. A group seen for the first time is checked against the changes
 * to its service in the hour before.
 */

const EVERY_MS = 5 * 60_000;
const KEEP_MS = 30 * 86_400_000;
const SERVICE_LABELS = ['service_name', 'service', 'app', 'app_kubernetes_io_name', 'job', 'container'];
const ERRORISH = '(?i)(exception|error|panic|traceback|fatal)';

async function fromLoki(conn: ResolvedTarget, start: number, end: number): Promise<ErrorSample[]> {
  const r = await obsRequest(conn, '/loki/api/v1/query_range', {
    query: { query: `{job=~".+"} |~ "${ERRORISH}"`, start: `${start}000000`, end: `${end}000000`, limit: 1000, direction: 'backward' },
    timeoutMs: 30_000,
  });
  if ('error' in r) return [];
  const streams = ((r.json as { data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } }).data?.result ?? []);
  const out: ErrorSample[] = [];
  for (const s of streams) {
    const service = SERVICE_LABELS.map((k) => s.stream[k]).find(Boolean) ?? 'unknown';
    for (const [ts, line] of s.values) {
      const e = parseErrorText(line);
      if (e) out.push({ service, error: e, at: Number(ts.slice(0, 13)), example: line, source: 'logs' });
    }
  }
  return out;
}

async function fromTempo(conn: ResolvedTarget, start: number, end: number): Promise<ErrorSample[]> {
  const r = await obsRequest(conn, '/api/search', { query: { q: '{ status = error }', limit: 20, start: Math.floor(start / 1000), end: Math.ceil(end / 1000) }, timeoutMs: 30_000 });
  if ('error' in r) return [];
  const ids = ((r.json as { traces?: Array<{ traceID: string }> }).traces ?? []).map((t) => t.traceID).slice(0, 10);
  const out: ErrorSample[] = [];
  for (const id of ids) {
    const t = await obsRequest(conn, `/api/traces/${id}`, { timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 });
    if ('error' in t) continue;
    for (const ex of exceptionsFromOtlp(t.json)) {
      const e = parseSpanError(ex);
      if (e) out.push({ service: ex.service, error: e, at: ex.at, example: ex.stacktrace ?? `${ex.type ?? 'error'}: ${ex.message ?? ''}`, source: 'traces', traceId: id });
    }
  }
  return out;
}

/** One project, one window: collect, group, store, and mark new groups that follow a change. */
export async function collectErrors(projectId: string, start: number, end: number): Promise<{ groups: number; created: number }> {
  const samples: ErrorSample[] = [];
  for (const conn of projectConnections(projectId, ['loki'])) samples.push(...(await fromLoki(conn, start, end)));
  for (const conn of projectConnections(projectId, ['tempo'])) samples.push(...(await fromTempo(conn, start, end)));
  const groups = groupErrors(samples);
  let created = 0;
  for (const g of groups) {
    const have = db.select().from(errorGroups).where(and(eq(errorGroups.projectId, projectId), eq(errorGroups.fingerprint, g.fingerprint))).get();
    if (have) {
      db.update(errorGroups)
        .set({ count: sql`${errorGroups.count} + ${g.count}`, lastCount: g.count, lastSeen: new Date(Math.max(have.lastSeen.getTime(), g.last)), ...(g.traceId && !have.traceId ? { traceId: g.traceId } : {}) })
        .where(eq(errorGroups.id, have.id))
        .run();
      continue;
    }
    // New: was its service changed in the hour before it first appeared?
    const before = db
      .select()
      .from(changes)
      .where(and(eq(changes.projectId, projectId), gte(changes.startedAt, new Date(g.first - 3_600_000)), lte(changes.startedAt, new Date(g.first)), sql`lower(${changes.service}) = ${g.service.toLowerCase()}`))
      .orderBy(desc(changes.startedAt))
      .get();
    db.insert(errorGroups)
      .values({
        projectId, fingerprint: g.fingerprint, service: g.service, type: g.error.type, message: g.error.message, frame: g.error.frame, source: g.source,
        example: g.example, traceId: g.traceId ?? null, count: g.count, lastCount: g.count, firstSeen: new Date(g.first), lastSeen: new Date(g.last),
        newAfterChange: before ? { changeId: before.id, title: before.title, startedAt: before.startedAt.getTime() } : null,
      })
      .run();
    created++;
  }
  return { groups: groups.length, created };
}

/** For an incident: error groups that appeared around when it began, on its services. */
export function newErrorsBlock(projectId: string, services: string[], startedAt: Date): string | null {
  const t = startedAt.getTime();
  const rows = db
    .select()
    .from(errorGroups)
    .where(and(eq(errorGroups.projectId, projectId), gte(errorGroups.firstSeen, new Date(t - 3_600_000)), lte(errorGroups.firstSeen, new Date(t + 15 * 60_000))))
    .all()
    .filter((g) => !services.length || services.some((s) => s.toLowerCase() === g.service.toLowerCase()))
    .slice(0, 8);
  if (!rows.length) return null;
  return [
    'NEW ERRORS (kinds of error first seen in the hour before this incident, from logs and traces):',
    ...rows.map((g) => `- ${g.service}: ${g.type}${g.message ? `: ${g.message}` : ''}${g.frame ? ` (at ${g.frame})` : ''}, ${g.count}x since ${g.firstSeen.toISOString().slice(11, 16)}${g.newAfterChange ? `; first seen after the change "${g.newAfterChange.title}"` : ''}`),
  ].join('\n');
}

class ErrorCollector {
  private timer: NodeJS.Timeout | null = null;
  private last = new Map<string, number>();
  private busy = false;

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const p of db.select({ id: projects.id }).from(projects).all()) {
        if (!projectConnections(p.id, ['loki', 'tempo']).length) continue;
        const start = this.last.get(p.id) ?? now - EVERY_MS;
        try {
          await collectErrors(p.id, start, now);
          this.last.set(p.id, now);
        } catch (err) {
          console.error(`error grouping for ${p.id} failed:`, err);
        }
      }
      db.delete(errorGroups).where(lt(errorGroups.lastSeen, new Date(now - KEEP_MS))).run();
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    setTimeout(() => void this.tick(), 45_000);
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const errorCollector = new ErrorCollector();
