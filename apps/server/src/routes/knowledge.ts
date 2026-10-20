import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { knowledgeDocs, runKnowledge, runs } from '@supops/db';
import { parseAlertSpec, searchKnowledge } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { getImportJob, startImport } from '../services/knowledge-import.ts';
import { MAX_FILE_BYTES } from '../services/doc-extract.ts';
import { enqueueDocForMap, mapDocument } from '../servicemap/docs.ts';

/**
 * Project knowledge: runbooks, notes and facts the agent is given at the start of a
 * run. Anyone signed in may read and write drafts; only an admin's document -- or a
 * draft an admin approved -- ever reaches a run, because knowledge is a trusted
 * instruction channel into every future run.
 */
export const knowledgeRoutes = Router();

const scope = z
  .object({
    targetIds: z.array(z.string()).max(200).optional(),
    kinds: z.array(z.string()).max(20).optional(),
    envs: z.array(z.enum(['dev', 'staging', 'prod'])).optional(),
  })
  .default({});

const docBody = z.object({
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, 'Use lowercase letters, numbers and hyphens'),
  kind: z.enum(['runbook', 'note', 'fact']),
  title: z.string().min(1).max(160),
  body: z.string().min(1).max(32_000),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  scope,
  pinned: z.boolean().optional(),
  /** Runbooks: the alerts it is for (names or Alertmanager matchers). Empty clears it. */
  alertMatch: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .superRefine((v, ctx) => {
      const p = v ? parseAlertSpec(v) : null;
      if (p && !p.ok) ctx.addIssue({ code: 'custom', message: `Alerts it is for: ${p.error}` });
    })
    .transform((v) => (v === undefined ? undefined : v || null)),
});

knowledgeRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (q) {
    // Search covers approved documents (what a run would see).
    res.json(searchKnowledge(db, projectId, q, 50));
    return;
  }
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  res.json(
    db
      .select()
      .from(knowledgeDocs)
      .where(and(eq(knowledgeDocs.projectId, projectId), ...(status ? [eq(knowledgeDocs.status, status as 'draft')] : [])))
      .orderBy(desc(knowledgeDocs.updatedAt), desc(knowledgeDocs.createdAt))
      .all(),
  );
});

// ---- Import: upload existing documents, review what the model split out, save ----

const importBody = z.object({
  projectId: z.string().min(1),
  files: z
    .array(z.object({ name: z.string().min(1).max(200), data: z.string().min(1) }))
    .min(1, 'Choose at least one file')
    .max(5, 'Import at most 5 files at a time'),
});

/** Start an import. The reply is a job id; the page polls GET /import/:id. */
knowledgeRoutes.post('/import', (req, res) => {
  const parsed = importBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid import' });
    return;
  }
  const files = parsed.data.files.map((f) => ({ name: f.name.replace(/[\\/]/g, '_'), data: Buffer.from(f.data.replace(/^data:[^,]*,/, ''), 'base64') }));
  const big = files.find((f) => f.data.length > MAX_FILE_BYTES);
  if (big) {
    res.status(413).json({ error: `${big.name} is larger than 10 MB.` });
    return;
  }
  const job = startImport({ projectId: parsed.data.projectId, userId: req.user?.id ?? null, files });
  res.status(202).json({ id: job.id });
});

knowledgeRoutes.get('/import/:id', (req, res) => {
  const job = getImportJob(req.params.id, req.user?.id ?? null);
  if (!job) {
    res.status(404).json({ error: 'This import has expired. Upload the file again.' });
    return;
  }
  res.json(job);
});

const saveBody = z.object({
  projectId: z.string().min(1),
  docs: z
    .array(
      docBody.extend({
        source: z.string().max(300).optional(),
        /** Update this existing document instead of creating a new one. */
        replaceId: z.string().optional(),
      }),
    )
    .min(1, 'Select at least one document')
    .max(200),
});

/**
 * Save reviewed proposals, all or nothing. The same rules as a typed document: an
 * admin's are approved, anyone else's are drafts, and only an admin may overwrite an
 * approved document.
 */
knowledgeRoutes.post('/import/save', (req, res) => {
  const parsed = saveBody.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({ error: issue ? `${issue.path.slice(0, 2).join(' ')}: ${issue.message}` : 'Invalid documents' });
    return;
  }
  const { projectId, docs } = parsed.data;
  const admin = isAdmin(req.user);
  const existing = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.projectId, projectId)).all();
  const byId = new Map(existing.map((d) => [d.id, d]));

  const replaced = new Set(docs.map((d) => d.replaceId).filter(Boolean));
  const takenSlugs = new Set(existing.filter((d) => !replaced.has(d.id)).map((d) => d.slug));
  for (const d of docs) {
    const target = d.replaceId ? byId.get(d.replaceId) : undefined;
    if (d.replaceId && !target) {
      res.status(404).json({ error: `"${d.title}" was to update a document that no longer exists.` });
      return;
    }
    if (target && !admin && target.status !== 'draft') {
      res.status(403).json({ error: `Only owners and admins can update the approved document "${target.title}". Save it as a new draft instead.` });
      return;
    }
    if (takenSlugs.has(d.slug)) {
      res.status(409).json({ error: `The slug "${d.slug}" is already used. Change it before saving.` });
      return;
    }
    takenSlugs.add(d.slug);
  }

  const now = new Date();
  const approval = admin ? { status: 'approved' as const, approvedBy: req.user!.id, approvedAt: now } : { status: 'draft' as const };
  const saved = db.transaction((tx) =>
    docs.map(({ replaceId, source, ...d }) => {
      const values = { ...d, pinned: d.pinned ?? d.kind === 'fact', source: source ?? null, updatedAt: now, ...approval };
      return replaceId
        ? tx.update(knowledgeDocs).set(values).where(eq(knowledgeDocs.id, replaceId)).returning().get()
        : tx.insert(knowledgeDocs).values({ ...values, projectId, createdBy: req.user?.id ?? null }).returning().get();
    }),
  );
  for (const [i, row] of saved.entries()) {
    audit(req.user, {
      projectId,
      entity: 'knowledge',
      entityId: row.id,
      action: docs[i]!.replaceId ? 'import-update' : admin ? 'import' : 'import-draft',
      after: { slug: row.slug, kind: row.kind, title: row.title, source: row.source },
    });
  }
  // Approved documents feed the service map (as suggestions to review).
  if (approval.status === 'approved') for (const row of saved) enqueueDocForMap(row.id);
  res.status(201).json({ saved: saved.length, status: approval.status });
});

knowledgeRoutes.get('/drafts/count', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const n = db
    .select({ n: sql<number>`count(*)` })
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'draft')))
    .get()?.n ?? 0;
  res.json({ drafts: n });
});

knowledgeRoutes.get('/:id', (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const usedIn = db
    .select({ runId: runKnowledge.runId, via: runKnowledge.via, at: runKnowledge.createdAt, title: runs.title })
    .from(runKnowledge)
    .innerJoin(runs, eq(runKnowledge.runId, runs.id))
    .where(eq(runKnowledge.docId, doc.id))
    .orderBy(desc(runKnowledge.createdAt))
    .limit(20)
    .all();
  res.json({ ...doc, usedIn });
});

knowledgeRoutes.post('/', (req, res) => {
  const parsed = docBody.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid document' });
    return;
  }
  const taken = db.select({ id: knowledgeDocs.id }).from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, parsed.data.projectId), eq(knowledgeDocs.slug, parsed.data.slug))).get();
  if (taken) {
    res.status(409).json({ error: `A document with the slug "${parsed.data.slug}" already exists.` });
    return;
  }
  const admin = isAdmin(req.user);
  const row = db
    .insert(knowledgeDocs)
    .values({
      ...parsed.data,
      pinned: parsed.data.pinned ?? parsed.data.kind === 'fact',
      status: admin ? 'approved' : 'draft',
      createdBy: req.user?.id ?? null,
      ...(admin ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'knowledge', entityId: row.id, action: admin ? 'create' : 'draft', after: { slug: row.slug, kind: row.kind, title: row.title } });
  if (row.status === 'approved') enqueueDocForMap(row.id);
  res.status(201).json(row);
});

knowledgeRoutes.patch('/:id', (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  const admin = isAdmin(req.user);
  // Members may edit drafts; an approved document is only changed by an admin, so
  // an edit can never slip unreviewed text into what runs see.
  if (!admin && doc.status !== 'draft') {
    res.status(403).json({ error: 'Only owners and admins can edit an approved document. Save a copy as a draft instead.' });
    return;
  }
  const parsed = docBody.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid document' });
    return;
  }
  const row = db.update(knowledgeDocs).set({ ...parsed.data, updatedAt: new Date() }).where(eq(knowledgeDocs.id, doc.id)).returning().get();
  audit(req.user, { projectId: doc.projectId, entity: 'knowledge', entityId: doc.id, action: 'update', before: { title: doc.title, body: doc.body }, after: { title: row.title, body: row.body } });
  if (row.status === 'approved' && (row.body !== doc.body || row.title !== doc.title)) enqueueDocForMap(row.id);
  res.json(row);
});

function setStatus(status: 'approved' | 'draft' | 'archived', action: string) {
  return (req: import('express').Request<{ id: string }>, res: import('express').Response) => {
    if (!isAdmin(req.user)) {
      res.status(403).json({ error: 'Only owners and admins can approve or archive knowledge.' });
      return;
    }
    const row = db
      .update(knowledgeDocs)
      .set({ status, updatedAt: new Date(), ...(status === 'approved' ? { approvedBy: req.user!.id, approvedAt: new Date() } : {}) })
      .where(eq(knowledgeDocs.id, req.params.id))
      .returning()
      .get();
    if (!row) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }
    audit(req.user, { projectId: row.projectId, entity: 'knowledge', entityId: row.id, action });
    // Approved: read for the map. Archived or back to draft: what only it said is suggested for removal.
    enqueueDocForMap(row.id);
    res.json(row);
  };
}
knowledgeRoutes.post('/:id/approve', setStatus('approved', 'approve'));
knowledgeRoutes.post('/:id/archive', setStatus('archived', 'archive'));
knowledgeRoutes.post('/:id/restore', setStatus('draft', 'restore'));

knowledgeRoutes.delete('/:id', async (req, res) => {
  const doc = db.select().from(knowledgeDocs).where(eq(knowledgeDocs.id, req.params.id)).get();
  if (!doc) {
    res.status(404).json({ error: 'Document not found' });
    return;
  }
  if (!isAdmin(req.user) && !(doc.status === 'draft' && doc.createdBy === req.user?.id)) {
    res.status(403).json({ error: 'Only owners and admins can delete knowledge (you can delete your own drafts).' });
    return;
  }
  if (doc.status === 'approved') {
    // What only this document said is suggested for removal before it goes.
    db.update(knowledgeDocs).set({ status: 'archived' }).where(eq(knowledgeDocs.id, doc.id)).run();
    await mapDocument(doc.id);
  }
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, doc.id)).run();
  audit(req.user, { projectId: doc.projectId, entity: 'knowledge', entityId: doc.id, action: 'delete', before: { slug: doc.slug, title: doc.title } });
  res.json({ ok: true });
});
