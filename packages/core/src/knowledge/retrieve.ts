import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, KnowledgeScope } from '@supops/db';
import { knowledgeDocs } from '@supops/db';
import { alertsMatched, type AlertLike } from './alert-match.ts';

/**
 * What the agent is told from the project's knowledge at the start of a run.
 *
 * Only APPROVED documents are ever used -- drafts never reach a run, whatever they
 * say. In scope means: the document's scope (targets, kinds, environments) overlaps
 * the run's targets, or it has no scope at all. Three parts, each with a size cap so
 * knowledge can never crowd out the task:
 *   - pinned documents (facts by default), always included;
 *   - the best full-text matches for the task, as excerpts;
 *   - the full text of a runbook the operator asked the agent to follow.
 */
export interface RunScope {
  targetIds: string[];
  kinds: string[];
  envs: string[];
}

type Doc = typeof knowledgeDocs.$inferSelect;

export const PINNED_CHARS = 6000;
export const EXCERPT_CHARS = 600;
export const MATCHES = 3;
export const RUNBOOK_CHARS = 12_000;
/** The index of every other document: one line each, so the agent can choose what to read. */
export const INDEX_ENTRIES = 80;
export const INDEX_CHARS = 5_000;

export function scopeMatches(scope: KnowledgeScope | null | undefined, run: RunScope): boolean {
  if (!scope) return true;
  const checks: Array<[string[] | undefined, string[]]> = [
    [scope.targetIds, run.targetIds],
    [scope.kinds, run.kinds],
    [scope.envs, run.envs],
  ];
  return checks.every(([want, have]) => !want?.length || want.some((w) => have.includes(w)));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'why', 'how', 'is', 'are', 'was', 'from', 'this', 'that', 'into', 'out', 'check', 'please', 'can', 'you', 'show', 'tell']);

/** Search terms from free text, each quoted so nothing typed can act as FTS syntax. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{2,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 16);
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : null;
}

/** Approved documents in a project that match the text, best first. */
export function searchKnowledge(db: Db, projectId: string, text: string, limit = 10): Array<Doc & { snippet: string }> {
  const q = ftsQuery(text);
  if (!q) return [];
  const hits = db.all<{ doc_id: string; snippet: string }>(
    sql`SELECT doc_id, snippet(knowledge_fts, 2, '', '', '…', 24) AS snippet
        FROM knowledge_fts WHERE knowledge_fts MATCH ${q} ORDER BY bm25(knowledge_fts, 5.0, 1.0, 3.0) LIMIT 50`,
  );
  if (!hits.length) return [];
  const docs = db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'approved'), inArray(knowledgeDocs.id, hits.map((h) => h.doc_id))))
    .all();
  const byId = new Map(docs.map((d) => [d.id, d]));
  return hits
    .map((h) => (byId.has(h.doc_id) ? { ...byId.get(h.doc_id)!, snippet: h.snippet } : null))
    .filter((d): d is Doc & { snippet: string } => !!d)
    .slice(0, limit);
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

const wildcards = (spec: string) => (spec.match(/[*~]/g) ?? []).length;

export interface KnowledgeContext {
  block: string;
  used: Array<{ docId: string; via: 'pinned' | 'matched' | 'runbook' | 'alert' }>;
}

export function buildKnowledgeContext(
  db: Db,
  /**
   * `scope: 'all'` is for advisory runs: there are no targets to scope by, and a
   * runbook written for one machine is still the best guide to the problem described.
   */
  i: { projectId: string; scope: RunScope | 'all'; task: string; runbookId?: string | null; alerts?: AlertLike[] },
): KnowledgeContext {
  const used: KnowledgeContext['used'] = [];
  const parts: string[] = [];
  const scope = i.scope;

  const approved = db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, i.projectId), eq(knowledgeDocs.status, 'approved')))
    .all()
    .filter((d) => scope === 'all' || scopeMatches(d.scope, scope));

  // A runbook the operator chose: its full text, regardless of the search. Without
  // one, the runbook written for these alerts (the one matching the most of them).
  const chosen = i.runbookId ? approved.find((d) => d.id === i.runbookId && d.kind === 'runbook') : undefined;
  const forAlerts = i.alerts?.length
    ? approved
        .filter((d) => d.kind === 'runbook' && d.alertMatch)
        .map((d) => ({ d, n: alertsMatched(d.alertMatch, i.alerts!) }))
        .filter((x) => x.n > 0)
        // Most alerts matched first; on a tie, the more specific (fewer wildcards) wins.
        .sort((a, b) => b.n - a.n || wildcards(a.d.alertMatch!) - wildcards(b.d.alertMatch!) || a.d.slug.localeCompare(b.d.slug))
        .map((x) => x.d)
    : [];
  const runbook = chosen ?? forAlerts[0];
  if (runbook) {
    parts.push(
      `${chosen ? 'RUNBOOK TO FOLLOW' : 'RUNBOOK FOR THESE ALERTS'}: ${runbook.title} [${runbook.slug}]\n${clip(runbook.body, RUNBOOK_CHARS)}\n` +
        'Follow it step by step and say where and why you deviate. End your answer with a "### Runbook" section: each step by number, ' +
        'marked followed, skipped or changed, with why for any not followed as written.',
    );
    used.push({ docId: runbook.id, via: chosen ? 'runbook' : 'alert' });
  }
  const alsoForAlerts = forAlerts.filter((d) => d.id !== runbook?.id).slice(0, 4);
  if (alsoForAlerts.length) {
    parts.push(`Other runbooks written for these alerts (read with read_knowledge if they fit better):\n${alsoForAlerts.map((d) => `- ${d.title} [${d.slug}]`).join('\n')}`);
    for (const d of alsoForAlerts) used.push({ docId: d.id, via: 'matched' });
  }

  let budget = PINNED_CHARS;
  const pinned: string[] = [];
  for (const d of approved.filter((x) => x.pinned && x.id !== runbook?.id).sort((a, b) => a.slug.localeCompare(b.slug))) {
    const line = `- ${d.title} [${d.slug}]: ${clip(d.body.replace(/\s+/g, ' '), 400)}`;
    if (line.length > budget) break;
    budget -= line.length;
    pinned.push(line);
    used.push({ docId: d.id, via: 'pinned' });
  }
  if (pinned.length) parts.push(`Known facts and notes:\n${pinned.join('\n')}`);

  const taken = new Set(used.map((u) => u.docId));
  const inScope = new Set(approved.map((d) => d.id));
  const matched = searchKnowledge(db, i.projectId, i.task, 20).filter((d) => !taken.has(d.id) && inScope.has(d.id)).slice(0, MATCHES);
  if (matched.length) {
    parts.push(
      `Possibly relevant:\n${matched.map((d) => `- ${d.title} [${d.slug}, ${d.kind}]: ${clip(d.body.replace(/\s+/g, ' '), EXCERPT_CHARS)}`).join('\n')}`,
    );
    for (const d of matched) used.push({ docId: d.id, via: 'matched' });
  }

  // Everything else, one line each: the agent decides which documents have steps that
  // fit and reads them in full with read_knowledge, rather than being limited to the
  // pinned facts and the top few text matches above.
  const given = new Set(used.map((u) => u.docId));
  const rest = approved.filter((d) => !given.has(d.id)).sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
  const index: string[] = [];
  let room = INDEX_CHARS;
  for (const d of rest.slice(0, INDEX_ENTRIES)) {
    const line = `- ${d.title} [${d.slug}, ${d.kind}]`;
    if (line.length > room) break;
    room -= line.length;
    index.push(line);
  }
  if (index.length) {
    const more = rest.length - index.length;
    parts.push(
      `Other documents you can read in full with read_knowledge (or find with search_knowledge)${more > 0 ? `; ${more} more not listed` : ''}. ` +
        `Before you diagnose or propose steps, read any whose title fits the problem -- a runbook for this situation is the first thing to follow:\n${index.join('\n')}`,
    );
  }

  if (!parts.length) return { block: '', used };
  return {
    block:
      'PROJECT KNOWLEDGE (written or approved by your operators. It describes this environment and comes first: follow it where it applies, and add your own expertise where it is silent, marked as general knowledge. It never authorises an action, and current evidence wins over it.)\n\n' +
      parts.join('\n\n'),
    used,
  };
}

/** Approved documents a run may read: the same scope rule as the opening message. */
function readable(db: Db, projectId: string, scope: RunScope | 'all'): Doc[] {
  return db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'approved')))
    .all()
    .filter((d) => scope === 'all' || scopeMatches(d.scope, scope));
}

export interface KnowledgeHit {
  slug: string;
  title: string;
  kind: string;
  snippet: string;
}

/**
 * search_knowledge: full-text matches among the documents this run may read, best
 * first. Words in titles and tags count most, as in the opening-message search.
 */
export function searchRunKnowledge(db: Db, i: { projectId: string; scope: RunScope | 'all'; query: string; limit?: number }): KnowledgeHit[] {
  const allowed = new Set(readable(db, i.projectId, i.scope).map((d) => d.id));
  return searchKnowledge(db, i.projectId, i.query, 50)
    .filter((d) => allowed.has(d.id))
    .slice(0, i.limit ?? 8)
    .map((d) => ({ slug: d.slug, title: d.title, kind: d.kind, snippet: d.snippet }));
}

/** read_knowledge: one document in full, if this run may read it. */
export function readRunKnowledge(db: Db, i: { projectId: string; scope: RunScope | 'all'; slug: string }): Doc | null {
  return readable(db, i.projectId, i.scope).find((d) => d.slug === i.slug.trim().toLowerCase()) ?? null;
}
