import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { alertIntegrations } from '@supops/db';
import { db } from '../context.ts';
import { overRate, presentedToken, receive, recordRejection, tokenMatches } from '../observe/hooks.ts';

/**
 * Where senders push alerts: `POST /api/hooks/<sender id>`, authenticated by that
 * sender's own token (see presentedToken), not by a user session. An unknown id and
 * a wrong token get the same answer, so the endpoint does not tell anyone which ids
 * exist.
 */
export const hookRoutes = Router();

hookRoutes.post('/:id', (req, res) => {
  const row = db.select().from(alertIntegrations).where(eq(alertIntegrations.id, req.params.id)).get();
  const token = presentedToken(req.headers);
  if (!row || !token || !tokenMatches(row, token)) {
    if (row) recordRejection(row.id, token ? 'Wrong token' : 'No token: send it as "Authorization: Bearer <token>"');
    res.status(401).json({ error: 'Unknown sender or wrong token.' });
    return;
  }
  if (!row.enabled) {
    recordRejection(row.id, 'Sent while turned off');
    res.status(403).json({ error: 'This sender is turned off in SupOps.' });
    return;
  }
  if (overRate(row.id)) {
    recordRejection(row.id, 'Too many requests (over 300 a minute)');
    res.setHeader('Retry-After', '30');
    res.status(429).json({ error: 'Too many requests. Slow down: at most 300 a minute.' });
    return;
  }
  const r = receive(row, req.body);
  if (!r.ok) {
    res.status(400).json({ error: r.error });
    return;
  }
  res.status(202).json(r.result);
});
