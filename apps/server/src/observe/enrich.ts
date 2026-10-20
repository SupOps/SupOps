import { and, asc, eq, sql } from 'drizzle-orm';
import { ciItems, extractionRules } from '@supops/db';
import { alertMatchLabels } from '@supops/shared';
import { CATALOGUE_FIELDS, catalogueLabels, extractLabels } from '@supops/core';
import { db } from '../context.ts';

/**
 * Labels SupOps adds to arriving alerts: from extraction rules (the alert's own text)
 * and from the service catalogue (owner, team, runbook on service-map components).
 * The source's labels are never replaced. Each added label records where it came from.
 */

const enabledExtraction = (projectId: string) =>
  db.select().from(extractionRules).where(and(eq(extractionRules.projectId, projectId), eq(extractionRules.enabled, true))).orderBy(asc(extractionRules.priority), asc(extractionRules.createdAt)).all();

export function applyExtraction(
  projectId: string,
  a: { title: string; summary: string | null; severity: string; source: string; labels: Record<string, string> },
): { labels: Record<string, string>; origin: Record<string, string> } {
  const rules = enabledExtraction(projectId);
  if (!rules.length) return { labels: a.labels, origin: {} };
  const out = extractLabels(rules, a, alertMatchLabels(a));
  const origin: Record<string, string> = {};
  for (const r of out.byRule) {
    if (!r.seen) continue;
    const applied = Object.keys(r.added).length > 0;
    for (const k of Object.keys(r.added)) origin[k] = `rule:${r.id}`;
    db.update(extractionRules)
      .set({
        seen: sql`${extractionRules.seen} + 1`,
        ...(applied ? { applied: sql`${extractionRules.applied} + 1`, lastAppliedAt: new Date(), lastExample: r.added } : {}),
      })
      .where(eq(extractionRules.id, r.id))
      .run();
  }
  return { labels: out.labels, origin };
}

const norm = (s: string) => s.toLowerCase().replace(/:\d+$/, '').trim();

/**
 * The service-map component an alert is about, if it has catalogue fields: by the
 * service it names first (most specific), then its machine.
 */
export function catalogueComponent(projectId: string, labels: Record<string, string>, targetIds: string[]) {
  const items = db
    .select({ id: ciItems.id, name: ciItems.name, key: ciItems.key, aliases: ciItems.aliases, attrs: ciItems.attrs, targetId: ciItems.targetId })
    .from(ciItems)
    .where(and(eq(ciItems.projectId, projectId), eq(ciItems.status, 'approved')))
    .all()
    .filter((i) => Object.keys(CATALOGUE_FIELDS).some((f) => i.attrs[f]?.trim()));
  if (!items.length) return null;
  const names = (i: (typeof items)[number]) => [i.name, i.key, ...i.aliases].map(norm);
  const service = [labels.service, labels.app, labels.app_kubernetes_io_name, labels.deployment, labels.job].filter((v): v is string => !!v).map(norm);
  const host = [labels.instance, labels.host, labels.hostname, labels.node].filter((v): v is string => !!v).map(norm);
  return (
    items.find((i) => service.some((s) => names(i).includes(s))) ??
    items.find((i) => (i.targetId && targetIds.includes(i.targetId)) || host.some((h) => names(i).includes(h))) ??
    null
  );
}

/** Owner, team, runbook... from the catalogue, for a new alert. */
export function applyCatalogue(projectId: string, labels: Record<string, string>, targetIds: string[]): { labels: Record<string, string>; origin: Record<string, string> } {
  const c = catalogueComponent(projectId, labels, targetIds);
  if (!c) return { labels, origin: {} };
  const add = catalogueLabels(c.attrs, labels);
  return { labels: { ...labels, ...add }, origin: Object.fromEntries(Object.keys(add).map((k) => [k, `catalogue:${c.id}`])) };
}
