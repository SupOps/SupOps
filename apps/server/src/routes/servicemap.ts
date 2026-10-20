import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { CI_LINK_KINDS, CI_TYPES, ciEvidence, ciItems, ciLinks, ciProposals, incidents, knowledgeDocs, targets } from '@supops/db';
import { dependenciesOf, impactOf } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { applyChange, enqueueDocForMap, mapDiagram } from '../servicemap/docs.ts';
import { DIAGRAM_PREFIX } from '@supops/shared';
import { clearDiscovery, lastDiscovery, runDiscovery } from '../servicemap/discover.ts';
import { mapWithConfidence, projectItems, projectLinks } from '../servicemap/store.ts';

/**
 * The service map. Anyone signed in reads it; edits follow the same rule as
 * knowledge documents: an admin's change applies at once, anyone else's waits as a
 * suggestion for an admin. Suggestions from documents wait the same way.
 */
export const serviceMapRoutes = Router();

const projectOf = (req: { query: Record<string, unknown> }) => (typeof req.query.projectId === 'string' ? req.query.projectId : '');

serviceMapRoutes.get('/', (req, res) => {
  const projectId = projectOf(req);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const map = mapWithConfidence(projectId);
  const ts = db.select({ id: targets.id, slug: targets.slug, healthState: targets.healthState }).from(targets).where(eq(targets.projectId, projectId)).all();
  const open = db.select({ id: incidents.id, title: incidents.title, severity: incidents.severity, targetIds: incidents.targetIds }).from(incidents).where(and(eq(incidents.projectId, projectId), eq(incidents.status, 'open'))).all();
  const docs = new Map(db.select({ id: knowledgeDocs.id, title: knowledgeDocs.title, slug: knowledgeDocs.slug }).from(knowledgeDocs).where(eq(knowledgeDocs.projectId, projectId)).all().map((d) => [d.id, d]));
  const tById = new Map(ts.map((t) => [t.id, t]));
  const pending = db.select({ id: ciProposals.id }).from(ciProposals).where(and(eq(ciProposals.projectId, projectId), eq(ciProposals.status, 'pending'))).all().length;
  // Evidence references in words: which document, which machine.
  const refName = (source: string, ref: string) => {
    if (source === 'doc') return ref.startsWith(DIAGRAM_PREFIX) ? ref.slice(DIAGRAM_PREFIX.length) : docs.get(ref)?.title ?? 'a removed document';
    if (source === 'target') return tById.get(ref)?.slug ?? 'a target';
    const tid = ref.replace(/^scan:/, '').split(':')[0]!;
    return tById.get(tid)?.slug ?? null;
  };
  res.json({
    items: map.items.map((i) => {
      const t = i.targetId ? tById.get(i.targetId) : undefined;
      const incs = i.targetId ? open.filter((o) => (o.targetIds ?? []).includes(i.targetId!)) : [];
      return {
        ...i,
        target: t ? { id: t.id, slug: t.slug, healthState: t.healthState } : null,
        incidents: incs.map((o) => ({ id: o.id, title: o.title, severity: o.severity })),
        evidence: i.evidence.map((e) => ({ ...e, refName: refName(e.source, e.ref), docSlug: e.source === 'doc' ? docs.get(e.ref)?.slug ?? null : null })),
      };
    }),
    links: map.links.map((l) => ({ ...l, evidence: l.evidence.map((e) => ({ ...e, refName: refName(e.source, e.ref), docSlug: e.source === 'doc' ? docs.get(e.ref)?.slug ?? null : null })) })),
    pending,
    discovery: lastDiscovery(projectId),
  });
});

/**
 * Delete the whole map: every component, connection, piece of evidence and
 * suggestion. Admins only. Documents and diagrams are untouched, so the map can be
 * built again from them.
 */
serviceMapRoutes.delete('/', (req, res) => {
  const projectId = projectOf(req);
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only an admin can delete the service map.' });
    return;
  }
  const removed = db.transaction((tx) => {
    const items = tx.select({ id: ciItems.id }).from(ciItems).where(eq(ciItems.projectId, projectId)).all().length;
    const links = tx.select({ id: ciLinks.id }).from(ciLinks).where(eq(ciLinks.projectId, projectId)).all().length;
    tx.delete(ciEvidence).where(eq(ciEvidence.projectId, projectId)).run();
    tx.delete(ciProposals).where(eq(ciProposals.projectId, projectId)).run();
    tx.delete(ciLinks).where(eq(ciLinks.projectId, projectId)).run();
    tx.delete(ciItems).where(eq(ciItems.projectId, projectId)).run();
    return { items, links };
  });
  clearDiscovery(projectId);
  audit(req.user, { projectId, entity: 'service-map', action: 'delete-map', after: removed });
  res.json(removed);
});

/** What a failure of this component reaches, and what it relies on. */
serviceMapRoutes.get('/items/:id/impact', (req, res) => {
  const item = db.select().from(ciItems).where(eq(ciItems.id, req.params.id)).get();
  if (!item) {
    res.status(404).json({ error: 'Component not found' });
    return;
  }
  const links = projectLinks(item.projectId).map((l) => ({ id: l.id, fromId: l.fromId, toId: l.toId, kind: l.kind }));
  res.json({ impact: impactOf(item.id, links), dependencies: dependenciesOf(item.id, links) });
});

// ---- editing (admins directly, others as suggestions) --------------------------------

const itemBody = z.object({
  projectId: z.string(),
  name: z.string().min(1).max(120),
  key: z.string().max(80).optional(),
  type: z.enum(CI_TYPES),
  env: z.string().max(30).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  aliases: z.array(z.string().min(1).max(120)).max(40).optional(),
  targetId: z.string().nullable().optional(),
  /** Details, including the catalogue fields alerts pick up: owner, team, runbook, repo, tier. */
  attrs: z.record(z.string().max(500)).refine((a) => Object.keys(a).length <= 30, 'At most 30 details').optional(),
});
const linkBody = z.object({
  projectId: z.string(),
  fromId: z.string(),
  toId: z.string(),
  kind: z.enum(CI_LINK_KINDS),
  detail: z.string().max(200).nullable().optional(),
});

type Change = Parameters<typeof applyChange>[1];

function submit(req: import('express').Request, res: import('express').Response, projectId: string, change: Omit<Change, 'origin' | 'sourceRef' | 'quote'>, label: string) {
  const full: Change = { ...change, origin: 'manual', sourceRef: null, quote: null };
  if (isAdmin(req.user)) {
    const r = applyChange(projectId, full, req.user?.id ?? null);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    audit(req.user, { projectId, entity: 'service-map', entityId: r.id ?? null, action: change.op, after: change.payload });
    res.json({ applied: true, id: r.id });
    return;
  }
  const p = db
    .insert(ciProposals)
    .values({ projectId, origin: 'manual', sourceRef: req.user?.id ?? null, sourceTitle: `${req.user?.name ?? 'Someone'}: ${label}`, op: change.op, payload: change.payload, createdBy: req.user?.id ?? null })
    .returning()
    .get();
  res.status(202).json({ applied: false, proposalId: p.id, message: 'Saved as a suggestion: an admin approves map changes, as for documents.' });
}

serviceMapRoutes.post('/items', (req, res) => {
  const b = itemBody.safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.issues[0]?.message ?? 'Invalid component' });
    return;
  }
  const { projectId, ...item } = b.data;
  submit(req, res, projectId, { op: 'add_item', payload: item }, `add ${item.name}`);
});

serviceMapRoutes.patch('/items/:id', (req, res) => {
  const item = db.select().from(ciItems).where(eq(ciItems.id, req.params.id)).get();
  const b = itemBody.omit({ projectId: true }).partial().safeParse(req.body);
  if (!item || !b.success) {
    res.status(item ? 400 : 404).json({ error: item ? b.error!.issues[0]?.message ?? 'Invalid change' : 'Component not found' });
    return;
  }
  submit(req, res, item.projectId, { op: 'update_item', payload: { id: item.id, name: item.name, changes: b.data } }, `edit ${item.name}`);
});

serviceMapRoutes.delete('/items/:id', (req, res) => {
  const item = db.select().from(ciItems).where(eq(ciItems.id, req.params.id)).get();
  if (!item) {
    res.status(404).json({ error: 'Component not found' });
    return;
  }
  submit(req, res, item.projectId, { op: 'remove_item', payload: { id: item.id, name: item.name } }, `remove ${item.name}`);
});

serviceMapRoutes.post('/links', (req, res) => {
  const b = linkBody.safeParse(req.body);
  if (!b.success || b.data.fromId === b.data.toId) {
    res.status(400).json({ error: b.success ? 'A component cannot depend on itself.' : b.error.issues[0]?.message ?? 'Invalid link' });
    return;
  }
  const items = new Map(projectItems(b.data.projectId).map((i) => [i.id, i]));
  const from = items.get(b.data.fromId);
  const to = items.get(b.data.toId);
  if (!from || !to) {
    res.status(400).json({ error: 'Both components must be in this project.' });
    return;
  }
  submit(req, res, b.data.projectId, { op: 'add_link', payload: { from: from.key, to: to.key, kind: b.data.kind, detail: b.data.detail ?? null } }, `${from.name} ${b.data.kind.replace('_', ' ')} ${to.name}`);
});

serviceMapRoutes.patch('/links/:id', (req, res) => {
  const link = db.select().from(ciLinks).where(eq(ciLinks.id, req.params.id)).get();
  const b = linkBody.omit({ projectId: true }).partial().safeParse(req.body);
  if (!link || !b.success) {
    res.status(link ? 400 : 404).json({ error: link ? b.error!.issues[0]?.message ?? 'Invalid change' : 'Link not found' });
    return;
  }
  submit(req, res, link.projectId, { op: 'update_link', payload: { id: link.id, changes: b.data } }, 'edit a link');
});

serviceMapRoutes.delete('/links/:id', (req, res) => {
  const link = db.select().from(ciLinks).where(eq(ciLinks.id, req.params.id)).get();
  if (!link) {
    res.status(404).json({ error: 'Link not found' });
    return;
  }
  const items = new Map(projectItems(link.projectId, { all: true }).map((i) => [i.id, i.name]));
  submit(req, res, link.projectId, { op: 'remove_link', payload: { id: link.id, from: items.get(link.fromId), to: items.get(link.toId), kind: link.kind } }, `remove ${items.get(link.fromId)} -> ${items.get(link.toId)}`);
});

/** Two entries that are one thing: links, names and evidence move to `into`. Admins only. */
serviceMapRoutes.post('/items/:id/merge', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can merge components.' });
    return;
  }
  const from = db.select().from(ciItems).where(eq(ciItems.id, req.params.id)).get();
  const into = db.select().from(ciItems).where(eq(ciItems.id, String(req.body?.into ?? ''))).get();
  if (!from || !into || from.projectId !== into.projectId || from.id === into.id) {
    res.status(400).json({ error: 'Choose another component in the same project.' });
    return;
  }
  db.transaction((tx) => {
    for (const l of tx.select().from(ciLinks).where(and(eq(ciLinks.projectId, from.projectId), inArray(ciLinks.fromId, [from.id]))).all()) {
      const dup = tx.select().from(ciLinks).where(and(eq(ciLinks.projectId, from.projectId), eq(ciLinks.fromId, into.id), eq(ciLinks.toId, l.toId), eq(ciLinks.kind, l.kind))).get();
      if (dup || l.toId === into.id) {
        if (dup) tx.update(ciEvidence).set({ linkId: dup.id }).where(eq(ciEvidence.linkId, l.id)).run();
        else tx.delete(ciEvidence).where(eq(ciEvidence.linkId, l.id)).run();
        tx.delete(ciLinks).where(eq(ciLinks.id, l.id)).run();
      } else tx.update(ciLinks).set({ fromId: into.id }).where(eq(ciLinks.id, l.id)).run();
    }
    for (const l of tx.select().from(ciLinks).where(and(eq(ciLinks.projectId, from.projectId), inArray(ciLinks.toId, [from.id]))).all()) {
      const dup = tx.select().from(ciLinks).where(and(eq(ciLinks.projectId, from.projectId), eq(ciLinks.fromId, l.fromId), eq(ciLinks.toId, into.id), eq(ciLinks.kind, l.kind))).get();
      if (dup || l.fromId === into.id) {
        if (dup) tx.update(ciEvidence).set({ linkId: dup.id }).where(eq(ciEvidence.linkId, l.id)).run();
        else tx.delete(ciEvidence).where(eq(ciEvidence.linkId, l.id)).run();
        tx.delete(ciLinks).where(eq(ciLinks.id, l.id)).run();
      } else tx.update(ciLinks).set({ toId: into.id }).where(eq(ciLinks.id, l.id)).run();
    }
    tx.update(ciEvidence).set({ itemId: into.id }).where(eq(ciEvidence.itemId, from.id)).run();
    const aliases = [...new Set([...into.aliases, from.name, ...from.aliases])].filter((a) => a !== into.name).slice(0, 40);
    tx.update(ciItems).set({ aliases, locked: true, targetId: into.targetId ?? from.targetId, updatedAt: new Date(), updatedBy: req.user?.id ?? null }).where(eq(ciItems.id, into.id)).run();
    tx.delete(ciItems).where(eq(ciItems.id, from.id)).run();
  });
  audit(req.user, { projectId: from.projectId, entity: 'service-map', entityId: into.id, action: 'merge', after: { merged: from.name, into: into.name } });
  res.json({ ok: true });
});

// ---- suggestions -----------------------------------------------------------------------

serviceMapRoutes.get('/proposals', (req, res) => {
  const projectId = projectOf(req);
  res.json(
    db.select().from(ciProposals).where(and(eq(ciProposals.projectId, projectId), eq(ciProposals.status, 'pending'))).orderBy(desc(ciProposals.createdAt)).all(),
  );
});

function decide(accept: boolean) {
  return (req: import('express').Request<{ id: string }>, res: import('express').Response) => {
    if (!isAdmin(req.user)) {
      res.status(403).json({ error: 'Only owners and admins can approve map changes.' });
      return;
    }
    const p = db.select().from(ciProposals).where(eq(ciProposals.id, req.params.id)).get();
    if (!p || p.status !== 'pending') {
      res.status(404).json({ error: 'No such pending suggestion.' });
      return;
    }
    if (accept) {
      const r = applyChange(p.projectId, p, req.user?.id ?? null);
      if (!r.ok) {
        db.update(ciProposals).set({ status: 'rejected', decidedBy: req.user?.id ?? null, decidedAt: new Date() }).where(eq(ciProposals.id, p.id)).run();
        res.status(409).json({ error: `${r.error} The suggestion was set aside.` });
        return;
      }
    }
    db.update(ciProposals).set({ status: accept ? 'accepted' : 'rejected', decidedBy: req.user?.id ?? null, decidedAt: new Date() }).where(eq(ciProposals.id, p.id)).run();
    audit(req.user, { projectId: p.projectId, entity: 'service-map', entityId: p.id, action: accept ? 'accept' : 'reject', after: { op: p.op, payload: p.payload } });
    res.json({ ok: true });
  };
}
serviceMapRoutes.post('/proposals/:id/accept', decide(true));
serviceMapRoutes.post('/proposals/:id/reject', decide(false));

/** Accept every pending suggestion (optionally from one document). Admins only. */
serviceMapRoutes.post('/proposals/accept-all', (req, res) => {
  if (!isAdmin(req.user)) {
    res.status(403).json({ error: 'Only owners and admins can approve map changes.' });
    return;
  }
  const projectId = String(req.body?.projectId ?? '');
  const sourceRef = typeof req.body?.sourceRef === 'string' ? req.body.sourceRef : null;
  const pending = db
    .select()
    .from(ciProposals)
    .where(and(eq(ciProposals.projectId, projectId), eq(ciProposals.status, 'pending'), ...(sourceRef ? [eq(ciProposals.sourceRef, sourceRef)] : [])))
    .all();
  // Renames first (so an addition of the same name meets it), then components, then links.
  const order = { update_item: 0, add_item: 1, add_link: 2, update_link: 3, remove_link: 4, remove_item: 5 } as const;
  let applied = 0;
  for (const p of pending.sort((a, b) => order[a.op] - order[b.op])) {
    const r = applyChange(projectId, p, req.user?.id ?? null);
    db.update(ciProposals).set({ status: r.ok ? 'accepted' : 'rejected', decidedBy: req.user?.id ?? null, decidedAt: new Date() }).where(eq(ciProposals.id, p.id)).run();
    if (r.ok) applied++;
  }
  audit(req.user, { projectId, entity: 'service-map', action: 'accept-all', after: { applied, of: pending.length } });
  res.json({ applied, of: pending.length });
});

// ---- building ----------------------------------------------------------------------------

/**
 * An architecture diagram: a picture (read by the model), a draw.io file (read
 * exactly), or Mermaid / PlantUML / Graphviz text. Its changes become suggestions.
 */
const diagramInput = z.object({
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  text: z.string().max(4_000_000).optional(),
  image: z.string().regex(/^data:image\/(png|jpeg|webp|gif);base64,/, 'A PNG, JPEG, WebP or GIF picture').max(11_000_000).optional(),
}).refine((v) => !!v.text !== !!v.image, 'Send either the diagram text or a picture of it.');

serviceMapRoutes.post('/from-diagram', async (req, res) => {
  const body = diagramInput.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.issues[0]?.message ?? 'Invalid diagram' });
    return;
  }
  const r = await mapDiagram(body.data.projectId, body.data);
  if ('error' in r) {
    res.status(422).json({ error: r.error });
    return;
  }
  audit(req.user, { projectId: body.data.projectId, entity: 'service-map', action: 'from-diagram', after: { name: body.data.name, proposals: r.proposals } });
  res.json(r);
});

/** Check the map against everything live now (targets, machines, clusters, metrics). Adds nothing. */
serviceMapRoutes.post('/discover', async (req, res) => {
  const projectId = String(req.body?.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const r = await runDiscovery(projectId);
  if ('busy' in r) {
    res.status(409).json({ error: 'Discovery is already running for this project.' });
    return;
  }
  res.json(r);
});

/** Read every approved document for the map again (suggestions to review). */
serviceMapRoutes.post('/from-documents', (req, res) => {
  const projectId = String(req.body?.projectId ?? '');
  const docs = db.select({ id: knowledgeDocs.id }).from(knowledgeDocs).where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'approved'))).all();
  for (const d of docs) enqueueDocForMap(d.id);
  res.json({ queued: docs.length });
});
