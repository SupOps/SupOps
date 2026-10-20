import { Router } from 'express';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { errorGroups } from '@supops/db';
import { db } from '../context.ts';

/** Error groups: new kinds first, then the most frequent. */
export const errorRoutes = Router();

errorRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const hours = Math.min(30 * 24, Math.max(1, Number(req.query.hours ?? 24)));
  const since = new Date(Date.now() - hours * 3_600_000);
  const service = typeof req.query.service === 'string' && req.query.service ? req.query.service : null;
  const rows = db
    .select()
    .from(errorGroups)
    .where(and(eq(errorGroups.projectId, projectId), gte(errorGroups.lastSeen, since), ...(service ? [sql`lower(${errorGroups.service}) = ${service.toLowerCase()}`] : [])))
    .orderBy(desc(errorGroups.lastSeen))
    .limit(300)
    .all();
  const isNew = (g: (typeof rows)[number]) => g.firstSeen >= since;
  res.json(rows.sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || Number(!!b.newAfterChange) - Number(!!a.newAfterChange) || b.count - a.count).map((g) => ({ ...g, isNew: isNew(g) })));
});
