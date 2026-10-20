import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { changes, ciItems, ciLinks, suspectFeedback, targets } from '@supops/db';
import type { ChangeSource } from '@supops/db';
import { rankChanges, trainSuspectModel, type ChangeInput, type RankedChange, type SuspectExample, type SuspectModel } from '@supops/core';
import { db } from '../context.ts';

export type ChangeRow = typeof changes.$inferSelect;

/**
 * Store changes. One the sender already sent (same id) is updated in place (a deploy
 * reported as started and then as finished is one change). A change naming a service
 * that is also a machine's name is tied to that machine.
 */
export function recordChanges(
  projectId: string,
  source: ChangeSource,
  inputs: ChangeInput[],
  extra: { integrationId?: string; targetId?: string; runId?: string } = {},
): ChangeRow[] {
  const bySlug = new Map(db.select({ id: targets.id, slug: targets.slug }).from(targets).where(eq(targets.projectId, projectId)).all().map((t) => [t.slug.toLowerCase(), t.id]));
  const out: ChangeRow[] = [];
  for (const c of inputs) {
    const values = {
      projectId,
      source,
      kind: c.kind,
      title: c.title.slice(0, 300),
      service: c.service ?? null,
      environment: c.environment ?? null,
      version: c.version ?? null,
      previousVersion: c.previousVersion ?? null,
      author: c.author ?? null,
      url: c.url ?? null,
      status: c.status ?? null,
      targetId: extra.targetId ?? (c.service ? bySlug.get(c.service.toLowerCase()) ?? null : null),
      integrationId: extra.integrationId ?? null,
      runId: extra.runId ?? null,
      externalId: c.externalId ?? null,
      labels: c.labels ?? null,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt ?? null,
    };
    const row = c.externalId
      ? db
          .insert(changes)
          .values(values)
          .onConflictDoUpdate({
            target: [changes.projectId, changes.source, changes.externalId],
            set: { title: values.title, status: values.status, finishedAt: values.finishedAt, url: values.url, version: values.version },
          })
          .returning()
          .get()
      : db.insert(changes).values(values).returning().get();
    out.push(row);
  }
  return out;
}

/**
 * What the given services depend on, from the approved service map: one hop, by name,
 * key or alias. Each dependency is returned under all its names, so a change that
 * calls it by any of them is recognised.
 */
export function upstreamOf(projectId: string, services: string[]): string[] {
  if (!services.length) return [];
  const items = db.select({ id: ciItems.id, key: ciItems.key, name: ciItems.name, aliases: ciItems.aliases, status: ciItems.status }).from(ciItems).where(eq(ciItems.projectId, projectId)).all().filter((i) => i.status === 'approved');
  const want = new Set(services.map((s) => s.toLowerCase()));
  const names = (i: (typeof items)[number]) => [i.name, i.key, ...(i.aliases ?? [])];
  const from = new Set(items.filter((i) => names(i).some((n) => want.has(n.toLowerCase()))).map((i) => i.id));
  if (!from.size) return [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Set<string>();
  for (const l of db.select().from(ciLinks).where(eq(ciLinks.projectId, projectId)).all()) {
    if (l.status !== 'approved' || !from.has(l.fromId)) continue;
    const to = byId.get(l.toId);
    if (to) for (const n of names(to)) out.add(n);
  }
  return [...out];
}

const models = new Map<string, SuspectModel | null>();

/** The project's learned suspect ranking, retrained from every mark when one changes. */
export function suspectModel(projectId: string): SuspectModel | null {
  if (models.has(projectId)) return models.get(projectId)!;
  const examples: SuspectExample[] = [];
  for (const f of db.select().from(suspectFeedback).where(eq(suspectFeedback.projectId, projectId)).all()) {
    examples.push({ x: f.features, y: f.verdict === 'cause' ? 1 : 0, w: 1 });
    // The other suspects on screen when someone picked the cause: a weak "not these".
    if (f.verdict === 'cause') for (const o of f.others) examples.push({ x: o, y: 0, w: 0.3 });
  }
  const m = trainSuspectModel(examples);
  models.set(projectId, m);
  return m;
}
export const forgetSuspectModel = (projectId: string) => models.delete(projectId);

/** The changes that may have caused an incident, likeliest first. */
export function suspectsFor(
  projectId: string,
  incident: { startedAt: Date; services: string[]; targetIds: string[] },
  limit = 8,
): Array<RankedChange<ChangeRow>> {
  const t0 = incident.startedAt.getTime();
  const rows = db
    .select()
    .from(changes)
    .where(and(eq(changes.projectId, projectId), gte(changes.startedAt, new Date(t0 - 24 * 3_600_000)), lte(changes.startedAt, new Date(t0 + 2 * 60_000))))
    .orderBy(desc(changes.startedAt))
    .limit(500)
    .all();
  return rankChanges({ ...incident, upstream: upstreamOf(projectId, incident.services) }, rows, { limit, model: suspectModel(projectId) });
}

export function listChanges(projectId: string, opts: { since?: Date; service?: string; limit?: number } = {}): ChangeRow[] {
  return db
    .select()
    .from(changes)
    .where(and(eq(changes.projectId, projectId), ...(opts.since ? [gte(changes.startedAt, opts.since)] : []), ...(opts.service ? [sql`lower(${changes.service}) = ${opts.service.toLowerCase()}`] : [])))
    .orderBy(desc(changes.startedAt))
    .limit(opts.limit ?? 200)
    .all();
}
