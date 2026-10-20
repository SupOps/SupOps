import { and, eq, inArray } from 'drizzle-orm';
import { ciEvidence, ciItems, ciLinks, ciProposals, knowledgeDocs } from '@supops/db';
import type { CiLinkKind, CiType } from '@supops/db';
import { DIAGRAM_PROMPT, EXTRACT_PROMPT, diagramFormat, keyFor, parseDrawio, parseExtraction, planDocChanges } from '@supops/core';
import type { Extraction } from '@supops/core';
import { DIAGRAM_PREFIX, messageText } from '@supops/shared';
import type { ContentPart } from '@supops/shared';
import { db, llm } from '../context.ts';
import { addEvidence, dropEvidence, findItem, projectItems, projectLinks, upsertItem, upsertLink } from './store.ts';

/**
 * Documents into the map. When an approved document is added or changes, the model
 * reads it for components and dependencies; what the map already has gains this
 * document as evidence, and anything that would change the map becomes a suggestion
 * for a person to accept or reject -- never applied on its own.
 */

const MAX_TEXT = 24_000;
const queue: string[] = [];
let draining = false;

/** Read a document for the map, soon (calls the model; one document at a time). */
export function enqueueDocForMap(docId: string): void {
  if (!queue.includes(docId)) queue.push(docId);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await mapDocument(id);
      } catch (err) {
        console.warn(`service map: reading document ${id} failed:`, err instanceof Error ? err.message : err);
      }
    }
  } finally {
    draining = false;
  }
}

/** What this document supported before: (item ids, link ids) and which of those only it supports. */
function previousSupport(projectId: string, docId: string) {
  const mine = db.select({ itemId: ciEvidence.itemId, linkId: ciEvidence.linkId }).from(ciEvidence).where(and(eq(ciEvidence.projectId, projectId), eq(ciEvidence.source, 'doc'), eq(ciEvidence.ref, docId))).all();
  const itemIds = [...new Set(mine.map((e) => e.itemId).filter((x): x is string => !!x))];
  const linkIds = [...new Set(mine.map((e) => e.linkId).filter((x): x is string => !!x))];
  // An entry is doc-only when every piece of its evidence is this document.
  const onlyThis = (col: 'itemId' | 'linkId', ids: string[]) =>
    ids.filter((id) => db.select({ source: ciEvidence.source, ref: ciEvidence.ref }).from(ciEvidence).where(eq(ciEvidence[col], id)).all().every((e) => e.source === 'doc' && e.ref === docId));
  return { itemIds, linkIds, docOnlyItemIds: onlyThis('itemId', itemIds), docOnlyLinkIds: onlyThis('linkId', linkIds) };
}

export async function mapDocument(docId: string): Promise<{ proposals: number; supported: number } | { error: string }> {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, docId)).get();
  if (!doc) return { error: 'Document not found' };
  const projectId = doc.projectId;
  const active = doc.status === 'approved';

  let extraction = { items: [], links: [] } as ReturnType<typeof parseExtraction>;
  if (active) {
    try {
      const res = await llm.complete(
        [
          { role: 'system', content: EXTRACT_PROMPT },
          { role: 'user', content: `Document "${doc.title}" (${doc.kind}):\n\n${doc.body.slice(0, MAX_TEXT)}` },
        ],
        [],
        { maxTokens: 6000, temperature: 0 },
      );
      extraction = parseExtraction(messageText(res.message.content ?? ''));
    } catch (err) {
      return { error: `The model could not read the document: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  return applyReading(projectId, docId, doc.title, extraction);
}

/**
 * What a source (a document or a diagram) now says, against the map: the entries it
 * supports gain it as evidence, and every change becomes a suggestion, replacing the
 * suggestions this source made before.
 */
function applyReading(projectId: string, ref: string, title: string, extraction: Extraction): { proposals: number; supported: number } {
  const prev = previousSupport(projectId, ref);
  const items = projectItems(projectId).map((i) => ({ id: i.id, key: i.key, name: i.name, type: i.type, description: i.description, aliases: i.aliases, locked: i.locked }));
  const links = projectLinks(projectId).map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, kind: l.kind }));
  const plan = planDocChanges({ extraction, items, links, previousItemIds: prev.itemIds, previousLinkIds: prev.linkIds, docOnlyItemIds: prev.docOnlyItemIds, docOnlyLinkIds: prev.docOnlyLinkIds });

  db.transaction(() => {
    for (const s of plan.supportItems) addEvidence(projectId, { itemId: s.itemId }, { source: 'doc', ref, detail: s.quote ?? title });
    for (const s of plan.supportLinks) addEvidence(projectId, { linkId: s.linkId }, { source: 'doc', ref, detail: s.quote ?? title });
    dropEvidence(projectId, { itemIds: plan.dropItemEvidence, linkIds: plan.dropLinkEvidence }, 'doc', ref);
    db.delete(ciProposals).where(and(eq(ciProposals.projectId, projectId), eq(ciProposals.origin, 'doc'), eq(ciProposals.sourceRef, ref), eq(ciProposals.status, 'pending'))).run();
    for (const p of plan.proposals) {
      db.insert(ciProposals).values({ projectId, origin: 'doc', sourceRef: ref, sourceTitle: title, op: p.op, payload: p.payload, quote: p.quote ?? null }).run();
    }
  });
  return { proposals: plan.proposals.length, supported: plan.supportItems.length + plan.supportLinks.length };
}

// ---- diagrams ------------------------------------------------------------------------------

/** Evidence from a diagram is referenced by its name: importing it again replaces what it said. */
export const diagramRef = (name: string) => `${DIAGRAM_PREFIX}${name.trim().slice(0, 120)}`;

/**
 * An architecture diagram into suggestions. A draw.io file (or a draw.io SVG) is read
 * exactly; a picture is read by the model as an image; Mermaid, PlantUML or Graphviz
 * text by the model as text.
 */
export async function mapDiagram(
  projectId: string,
  input: { name: string; text?: string; image?: string },
): Promise<{ proposals: number; supported: number; components: number; connections: number; read: 'exactly' | 'by the model' } | { error: string }> {
  const name = input.name.trim() || 'Architecture diagram';
  let extraction: Extraction | null = input.text ? parseDrawio(input.text) : null;
  const exact = !!extraction;
  if (!extraction) {
    const user: ContentPart[] = input.image
      ? [{ type: 'text', text: `Diagram "${name}":` }, { type: 'image_url', image_url: { url: input.image } }]
      : [{ type: 'text', text: `Diagram "${name}" (${diagramFormat(input.text ?? '')}):\n\n${(input.text ?? '').slice(0, MAX_TEXT)}` }];
    try {
      const res = await llm.complete([{ role: 'system', content: DIAGRAM_PROMPT }, { role: 'user', content: user }], [], { maxTokens: 6000, temperature: 0 });
      extraction = parseExtraction(messageText(res.message.content ?? ''));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: input.image ? `The model could not read the picture (it needs a model that accepts images): ${msg}` : `The model could not read the diagram: ${msg}` };
    }
  }
  if (!extraction.items.length && !extraction.links.length) {
    return { error: exact ? 'No labelled boxes were found in this draw.io file.' : 'No components were found. Is it an architecture diagram with labelled boxes?' };
  }
  const r = applyReading(projectId, diagramRef(name), name, extraction);
  return { ...r, components: extraction.items.length, connections: extraction.links.length, read: exact ? 'exactly' : 'by the model' };
}

// ---- applying a change ------------------------------------------------------------------

type Proposal = typeof ciProposals.$inferSelect;

/**
 * Apply an accepted suggestion (or an admin's direct edit). Everything it touches is
 * marked as a person's -- locked against automatic changes -- and records where it
 * came from: the document's quote, or the person.
 */
export function applyChange(projectId: string, p: Pick<Proposal, 'op' | 'payload' | 'origin' | 'sourceRef' | 'quote'>, userId: string | null): { ok: true; id?: string } | { ok: false; error: string } {
  const pl = p.payload as Record<string, unknown>;
  const ev = p.origin === 'doc' && p.sourceRef
    ? { source: 'doc' as const, ref: p.sourceRef, detail: p.quote }
    : { source: 'manual' as const, ref: userId ?? 'someone', detail: 'added or edited by a person' };
  const now = new Date();
  switch (p.op) {
    case 'add_item': {
      const row = upsertItem(projectId, { key: String(pl.key ?? keyFor(String(pl.name))), name: String(pl.name), type: (pl.type as CiType) ?? 'service', env: (pl.env as string) ?? null, description: (pl.description as string) ?? null, aliases: (pl.aliases as string[]) ?? [], targetId: (pl.targetId as string) ?? null }, ev);
      // Details given with it (owner, team, runbook, repo, tier...) are kept, merged over any it had.
      const attrs = pl.attrs && typeof pl.attrs === 'object' ? { ...row.attrs, ...(pl.attrs as Record<string, string>) } : undefined;
      db.update(ciItems).set({ status: 'approved', locked: true, updatedBy: userId, updatedAt: now, ...(attrs ? { attrs } : {}) }).where(eq(ciItems.id, row.id)).run();
      return { ok: true, id: row.id };
    }
    case 'update_item': {
      const id = String(pl.id);
      const changes = (pl.changes ?? {}) as Partial<typeof ciItems.$inferInsert>;
      const allowed = ['name', 'type', 'env', 'description', 'aliases', 'attrs', 'targetId'] as const;
      const patch = Object.fromEntries(Object.entries(changes).filter(([k]) => (allowed as readonly string[]).includes(k)));
      const before = db.select().from(ciItems).where(and(eq(ciItems.id, id), eq(ciItems.projectId, projectId))).get();
      const row = db.update(ciItems).set({ ...patch, locked: true, status: 'approved', updatedBy: userId, updatedAt: now }).where(and(eq(ciItems.id, id), eq(ciItems.projectId, projectId))).returning().get();
      if (!row || !before) return { ok: false, error: 'That component no longer exists.' };
      // Services named after their machine ("postgresql on 10.0.5.12") follow its new name.
      if (typeof patch.name === 'string' && patch.name !== before.name) {
        for (const l of db.select().from(ciLinks).where(and(eq(ciLinks.projectId, projectId), eq(ciLinks.toId, id), eq(ciLinks.kind, 'runs_on'))).all()) {
          const svc = db.select().from(ciItems).where(eq(ciItems.id, l.fromId)).get();
          if (svc && !svc.locked && svc.name.endsWith(` on ${before.name}`)) {
            db.update(ciItems).set({ name: `${svc.name.slice(0, -before.name.length)}${patch.name}`, aliases: [...svc.aliases, svc.name], updatedAt: now }).where(eq(ciItems.id, svc.id)).run();
          }
        }
      }
      addEvidence(projectId, { itemId: id }, ev);
      return { ok: true, id };
    }
    case 'remove_item': {
      const row = db.update(ciItems).set({ status: 'archived', locked: true, updatedBy: userId, updatedAt: now }).where(and(eq(ciItems.id, String(pl.id)), eq(ciItems.projectId, projectId))).returning().get();
      if (!row) return { ok: false, error: 'That component no longer exists.' };
      db.update(ciLinks).set({ status: 'archived', updatedAt: now }).where(and(eq(ciLinks.projectId, projectId), inArray(ciLinks.fromId, [row.id]))).run();
      db.update(ciLinks).set({ status: 'archived', updatedAt: now }).where(and(eq(ciLinks.projectId, projectId), inArray(ciLinks.toId, [row.id]))).run();
      return { ok: true, id: row.id };
    }
    case 'add_link': {
      const end = (v: unknown) => {
        const name = String(v);
        return findItem(projectId, { key: name, name }) ?? upsertItem(projectId, { key: keyFor(name), name, type: 'service' }, ev);
      };
      const from = end(pl.from);
      const to = end(pl.to);
      const row = upsertLink(projectId, from.id, to.id, (pl.kind as CiLinkKind) ?? 'depends_on', ev, { detail: (pl.detail as string) ?? null });
      if (!row) return { ok: false, error: 'A component cannot depend on itself.' };
      db.update(ciLinks).set({ status: 'approved', locked: true, updatedBy: userId, updatedAt: now }).where(eq(ciLinks.id, row.id)).run();
      return { ok: true, id: row.id };
    }
    case 'update_link': {
      const changes = (pl.changes ?? {}) as Partial<typeof ciLinks.$inferInsert>;
      const patch = Object.fromEntries(Object.entries(changes).filter(([k]) => ['kind', 'detail', 'fromId', 'toId'].includes(k)));
      const row = db.update(ciLinks).set({ ...patch, locked: true, status: 'approved', updatedBy: userId, updatedAt: now }).where(and(eq(ciLinks.id, String(pl.id)), eq(ciLinks.projectId, projectId))).returning().get();
      if (!row) return { ok: false, error: 'That link no longer exists.' };
      addEvidence(projectId, { linkId: row.id }, ev);
      return { ok: true, id: row.id };
    }
    case 'remove_link': {
      const row = db.update(ciLinks).set({ status: 'archived', locked: true, updatedBy: userId, updatedAt: now }).where(and(eq(ciLinks.id, String(pl.id)), eq(ciLinks.projectId, projectId))).returning().get();
      return row ? { ok: true, id: row.id } : { ok: false, error: 'That link no longer exists.' };
    }
  }
}
