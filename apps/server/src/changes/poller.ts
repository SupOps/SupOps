import { and, eq, gte, inArray, isNotNull, ne } from 'drizzle-orm';
import { rolloutStates, runs, targets, toolCalls, users } from '@supops/db';
import { detectRollouts, kubectlExec, loadTargets, obsRequest, resolveSecret, type ChangeInput, type WorkloadState } from '@supops/core';
import { db } from '../context.ts';
import { publicUrl } from '../notify/notifier.ts';
import { recordChanges } from './store.ts';
import { computeDueVerdicts } from '../servicehealth/signals.ts';

/**
 * Where changes come from without anyone sending them: rollouts seen in a cluster,
 * deploy annotations in Grafana, and SupOps' own approved actions. Each source keeps
 * enough state (or dedups by id) that a restart neither misses nor repeats one.
 */

const EVERY_MS = 2 * 60_000;
const DEPLOY_TAGS = /^(deploy|deployment|release|rollout|rollback|change|config)/i;

/** One cluster: compare its workloads with the last poll. */
export async function pollCluster(targetId: string): Promise<{ ok: boolean; changes: number; error?: string }> {
  const row = db.select().from(targets).where(eq(targets.id, targetId)).get();
  if (!row || row.kind !== 'k8s' || !row.enabled) return { ok: false, changes: 0, error: 'not an enabled cluster' };
  const resolved = loadTargets(db, row.projectId).find((t) => t.id === targetId);
  if (!resolved) return { ok: false, changes: 0, error: 'cluster not found' };
  const secret = resolveSecret(db, resolved);
  if (!secret) return { ok: false, changes: 0, error: 'no credential' };
  const cfg = resolved.config as { allowedNamespaces?: string[] };
  const scopes = cfg.allowedNamespaces?.length ? cfg.allowedNamespaces.map((ns) => `-n ${ns}`) : ['-A'];
  const items: unknown[] = [];
  for (const scope of scopes) {
    const out = await kubectlExec(`get deployments,statefulsets,daemonsets ${scope} -o json`, {
      runId: 'change-poll',
      toolCallId: 'change-poll',
      target: { ...resolved, secret: secret.value },
      timeoutMs: 45_000,
      maxOutputBytes: 32 * 1024 * 1024,
      signal: AbortSignal.timeout(60_000),
    });
    if (!out.ok) return { ok: false, changes: 0, error: out.text.slice(0, 300) };
    try {
      items.push(...((JSON.parse(out.text.slice(out.text.indexOf('{'))) as { items?: unknown[] }).items ?? []));
    } catch {
      return { ok: false, changes: 0, error: 'kubectl did not return JSON' };
    }
  }
  const prev = new Map<string, WorkloadState>(db.select().from(rolloutStates).where(eq(rolloutStates.targetId, targetId)).all().map((s) => [s.key, { generation: s.generation, images: s.images }]));
  const { changes, next } = detectRollouts(prev, { items });
  if (changes.length) recordChanges(row.projectId, 'kubernetes', changes);
  db.transaction((tx) => {
    tx.delete(rolloutStates).where(eq(rolloutStates.targetId, targetId)).run();
    for (const [key, s] of next) tx.insert(rolloutStates).values({ targetId, key, generation: s.generation, images: s.images }).run();
  });
  return { ok: true, changes: changes.length };
}

/** Grafana annotations tagged deploy/release/rollout/change/config since the last look. */
export async function pollGrafana(targetId: string, sinceMs: number): Promise<number> {
  const row = db.select().from(targets).where(eq(targets.id, targetId)).get();
  if (!row || row.kind !== 'grafana' || !row.enabled) return 0;
  const resolved = loadTargets(db, row.projectId).find((t) => t.id === targetId);
  if (!resolved) return 0;
  const secret = resolveSecret(db, resolved);
  const r = await obsRequest(secret ? { ...resolved, secret: secret.value } : resolved, '/api/annotations', { direct: true, query: { from: sinceMs, to: Date.now(), type: 'annotation', limit: 200 } });
  if ('error' in r || !Array.isArray(r.json)) return 0;
  const found: ChangeInput[] = [];
  for (const a of r.json as Array<{ id: number; time: number; timeEnd?: number; text?: string; tags?: string[] }>) {
    const tag = (a.tags ?? []).find((t) => DEPLOY_TAGS.test(t));
    if (!tag) continue;
    const service = (a.tags ?? []).find((t) => /^(service|app)[:=]/i.test(t))?.split(/[:=]/)[1];
    found.push({
      externalId: `grafana:${row.id}:${a.id}`,
      kind: /rollback/i.test(tag) ? 'rollback' : /config/i.test(tag) ? 'config' : 'deploy',
      title: (a.text ?? tag).replace(/<[^>]+>/g, '').slice(0, 300) || tag,
      ...(service ? { service } : {}),
      startedAt: new Date(a.time),
      ...(a.timeEnd && a.timeEnd !== a.time ? { finishedAt: new Date(a.timeEnd) } : {}),
      labels: { tags: (a.tags ?? []).join(',') },
    });
  }
  if (found.length) recordChanges(row.projectId, 'grafana', found);
  return found.length;
}

/** SupOps' own actions that changed something (approved or trusted), as changes. */
export function harvestOwnActions(sinceMs: number): number {
  const rows = db
    .select({ call: toolCalls, projectId: runs.projectId, decidedByName: users.name, slug: targets.slug })
    .from(toolCalls)
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .leftJoin(users, eq(users.id, toolCalls.decidedBy))
    .leftJoin(targets, eq(targets.id, toolCalls.targetId))
    .where(and(eq(toolCalls.state, 'succeeded'), isNotNull(toolCalls.tier), ne(toolCalls.tier, 'read_only'), isNotNull(toolCalls.finishedAt), gte(toolCalls.finishedAt, new Date(sinceMs))))
    .all();
  // Plans and notes are bookkeeping, not changes.
  const BOOKKEEPING = new Set(['update_plan', 'record_finding', 'confirm_target', 'read_output']);
  const base = publicUrl();
  let n = 0;
  for (const r of rows) {
    if (BOOKKEEPING.has(r.call.toolKey)) continue;
    recordChanges(
      r.projectId,
      'supops',
      [
        {
          externalId: `supops:${r.call.toolCallId}`,
          kind: 'action',
          title: (r.call.renderedCommand ?? r.call.toolKey).slice(0, 300),
          ...(r.slug ? { service: r.slug } : {}),
          author: r.decidedByName ? `${r.decidedByName} (approved in SupOps)` : 'SupOps (allowed without approval)',
          ...(base ? { url: `${base.replace(/\/$/, '')}/runs/${r.call.runId}` } : {}),
          status: 'succeeded',
          startedAt: r.call.startedAt ?? r.call.finishedAt!,
          finishedAt: r.call.finishedAt!,
        },
      ],
      { runId: r.call.runId, ...(r.call.targetId ? { targetId: r.call.targetId } : {}) },
    );
    n++;
  }
  return n;
}

class ChangePoller {
  private timer: NodeJS.Timeout | null = null;
  private lastGrafana = new Map<string, number>();
  private busy = false;

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      harvestOwnActions(Date.now() - 2 * 3_600_000);
      // Deploys out for 35 minutes: compare the half hour before with the half hour after.
      await computeDueVerdicts().catch((err) => console.error('deploy verdicts failed:', err));
      const conns = db.select({ id: targets.id, kind: targets.kind }).from(targets).where(and(eq(targets.enabled, true), inArray(targets.kind, ['k8s', 'grafana']))).all();
      for (const c of conns) {
        try {
          if (c.kind === 'k8s') await pollCluster(c.id);
          else {
            const since = this.lastGrafana.get(c.id) ?? Date.now() - 3_600_000;
            const now = Date.now();
            await pollGrafana(c.id, since);
            this.lastGrafana.set(c.id, now - 60_000);
          }
        } catch (err) {
          console.error(`change poll of ${c.id} failed:`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    setTimeout(() => void this.tick(), 30_000);
    this.timer = setInterval(() => void this.tick(), EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const changePoller = new ChangePoller();
