import { and, eq } from 'drizzle-orm';
import { incidents, targets } from '@supops/db';
import type { CiLinkKind } from '@supops/db';
import { dependenciesOf, impactOf, likelyOrigins } from '@supops/core';
import { db } from '../context.ts';
import { mapWithConfidence } from './store.ts';

/**
 * The service map where decisions are made: the slice around a run's machines in its
 * opening message, the dependencies of an incident (and which of them are unhealthy)
 * in its evidence, what an incident affects on its page, and whether two alerts are
 * on connected parts. Always labelled by how sure it is; live evidence wins.
 */

const PHRASE: Record<CiLinkKind, string> = {
  depends_on: 'depends on',
  runs_on: 'runs on',
  routes_to: 'routes to',
  replicates_to: 'replicates to',
  reads_from: 'reads from',
  writes_to: 'writes to',
  backs_up_to: 'backs up to',
  monitors: 'monitors',
};

type MapView = ReturnType<typeof mapWithConfidence>;

/** Components that are these targets, plus what runs on them. */
function itemsForTargets(map: MapView, targetIds: string[]): Set<string> {
  const ids = new Set(map.items.filter((i) => i.targetId && targetIds.includes(i.targetId)).map((i) => i.id));
  for (const l of map.links) if (l.kind === 'runs_on' && ids.has(l.toId)) ids.add(l.fromId);
  return ids;
}

/** Map entries known by any of these names (name, key or alias, any case). */
function itemsForNames(map: MapView, names: string[]): Set<string> {
  const want = new Set(names.map((n) => n.toLowerCase()));
  return new Set(map.items.filter((i) => [i.name, i.key, ...(i.aliases ?? [])].some((n) => want.has(String(n).toLowerCase()))).map((i) => i.id));
}

const SURE: Record<string, string> = { confirmed: 'confirmed', manual: 'confirmed by a person', documented: 'documented only', observed: 'observed, not documented', stale: 'not seen lately' };

/** A few lines for a run's opening message: how the in-scope machines connect. */
export function serviceMapContext(projectId: string, targetIds: string[], max = 25): string | null {
  const map = mapWithConfidence(projectId);
  if (!map.links.length) return null;
  const name = new Map(map.items.map((i) => [i.id, i.name]));
  const focus = targetIds.length ? itemsForTargets(map, targetIds) : new Set(map.items.map((i) => i.id));
  const rows = map.links
    .filter((l) => l.kind !== 'monitors' && (focus.has(l.fromId) || focus.has(l.toId)))
    .sort((a, b) => b.confidence.score - a.confidence.score)
    .slice(0, max)
    .map((l) => `- ${name.get(l.fromId)} ${PHRASE[l.kind]} ${name.get(l.toId)}${l.detail ? ` (${l.detail})` : ''} [${SURE[l.confidence.certainty] ?? l.confidence.certainty}]`);
  if (!rows.length) return null;
  return [
    'SERVICE MAP (how these systems connect, from documents, live connections and metrics; certainty in brackets; what you observe wins over it):',
    ...rows,
  ].join('\n');
}

/**
 * For an incident on these targets: what they depend on (with any of those that are
 * unhealthy now -- the likely origin) and what depends on them (what else is hit).
 */
export function incidentMapView(projectId: string, targetIds: string[], ownIncidentId?: string, services: string[] = []) {
  const map = mapWithConfidence(projectId);
  const start = new Set([...itemsForTargets(map, targetIds), ...itemsForNames(map, services)]);
  if (!start.size) return { dependsOn: [], affected: [], origins: [] as string[], effects: [] as Array<{ name: string; dependsOn: string }> };
  const links = map.links.map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, kind: l.kind }));
  const byId = new Map(map.items.map((i) => [i.id, i]));
  const health = new Map(db.select({ id: targets.id, healthState: targets.healthState }).from(targets).where(eq(targets.projectId, projectId)).all().map((t) => [t.id, t.healthState]));
  const open = db.select({ id: incidents.id, title: incidents.title, targetIds: incidents.targetIds }).from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'))).all().filter((o) => o.id !== ownIncidentId);

  const describe = (id: string, depth: number) => {
    const it = byId.get(id)!;
    const t = it.targetId;
    const problems = [
      ...(t && health.get(t) && !['ok', 'unknown'].includes(health.get(t)!) ? [`health: ${health.get(t)}`] : []),
      ...open.filter((o) => t && (o.targetIds ?? []).includes(t)).map((o) => `open incident: ${o.title}`),
    ];
    return { id, name: it.name, type: it.type, depth, certainty: it.confidence.certainty, problems };
  };
  const collect = (fn: typeof impactOf) => {
    const out = new Map<string, ReturnType<typeof describe>>();
    for (const s of start) for (const r of fn(s, links, 3)) if (!start.has(r.id) && !out.has(r.id)) out.set(r.id, describe(r.id, r.depth));
    return [...out.values()].sort((a, b) => b.problems.length - a.problems.length || a.depth - b.depth);
  };
  const dependsOn = collect(dependenciesOf);
  const affected = collect(impactOf);
  // What is failing: the incident's own components, and anything near it with a problem.
  // The likeliest origin is the failing one that depends on nothing else failing.
  const abnormal = new Set([...start, ...[...dependsOn, ...affected].filter((x) => x.problems.length).map((x) => x.id)]);
  const lo = likelyOrigins(abnormal, links);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  return { dependsOn, affected, origins: lo.effects.length ? lo.origins.map(nameOf) : [], effects: lo.effects.map((e) => ({ name: nameOf(e.id), dependsOn: nameOf(e.dependsOn) })) };
}

/** Are these two services connected on the map? The reason in words, or null. */
export function serviceMapRelation(projectId: string, a: string, b: string): string | null {
  const map = mapWithConfidence(projectId);
  const A = itemsForNames(map, [a]);
  const B = itemsForNames(map, [b]);
  if (!A.size || !B.size) return null;
  const name = new Map(map.items.map((i) => [i.id, i.name]));
  const l = map.links.find((x) => x.kind !== 'monitors' && x.confidence.certainty !== 'stale' && ((A.has(x.fromId) && B.has(x.toId)) || (B.has(x.fromId) && A.has(x.toId))));
  return l ? `${name.get(l.fromId)} ${PHRASE[l.kind]} ${name.get(l.toId)} (service map)` : null;
}

/** Lines for an incident's evidence pack. */
export function incidentMapBlock(projectId: string, targetIds: string[], ownIncidentId?: string, services: string[] = []): string | null {
  const v = incidentMapView(projectId, targetIds, ownIncidentId, services);
  if (!v.dependsOn.length && !v.affected.length && !v.origins.length) return null;
  const line = (x: (typeof v.dependsOn)[number]) => `- ${x.name} (${x.type}${x.depth > 1 ? `, ${x.depth} steps away` : ''}; ${SURE[x.certainty] ?? x.certainty})${x.problems.length ? ` -- ${x.problems.join('; ')}` : ''}`;
  return [
    'SERVICE MAP:',
    ...(v.dependsOn.length ? ['Depends on (a problem here is a likely origin):', ...v.dependsOn.slice(0, 12).map(line)] : []),
    ...(v.affected.length ? ['Affected if this is down:', ...v.affected.slice(0, 12).map(line)] : []),
    ...(v.origins.length
      ? [
          `Likeliest origin (failing, and nothing it depends on is failing): ${v.origins.join(', ')}.`,
          `Probably effects, not causes: ${v.effects.map((e) => `${e.name} (depends on ${e.dependsOn})`).join('; ')}.`,
        ]
      : []),
  ].join('\n');
}

/**
 * Are these two sets of machines connected in the map (directly, or through what
 * runs on them)? The reason in words, or null. Used to group alerts into one incident.
 */
export function mapRelation(projectId: string, a: string[], b: string[]): string | null {
  if (!a.length || !b.length) return null;
  const map = mapWithConfidence(projectId);
  const A = itemsForTargets(map, a);
  const B = itemsForTargets(map, b);
  const name = new Map(map.items.map((i) => [i.id, i.name]));
  const l = map.links.find((x) => x.kind !== 'monitors' && x.confidence.certainty !== 'stale' && ((A.has(x.fromId) && B.has(x.toId)) || (B.has(x.fromId) && A.has(x.toId))));
  return l ? `${name.get(l.fromId)} ${PHRASE[l.kind]} ${name.get(l.toId)} (service map)` : null;
}
