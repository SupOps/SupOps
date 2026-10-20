import { Router } from 'express';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiKeys, users } from '@supops/db';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { API_KEY_SCOPES, newApiKey } from '../apikeys.ts';

/** API keys: admins make and revoke them; the token is shown once. */
export const apiKeyRoutes = Router();

apiKeyRoutes.use((req, res, next) => {
  if (!isAdmin(req.user) || req.apiKey) {
    res.status(403).json({ error: 'Only an admin can manage API keys.' });
    return;
  }
  next();
});

const view = ({ tokenHash: _h, ...k }: typeof apiKeys.$inferSelect & { createdByName?: string | null }) => k;

apiKeyRoutes.get('/', (_req, res) => {
  const names = new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));
  res.json(db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all().map((k) => ({ ...view(k), createdByName: k.createdBy ? names.get(k.createdBy) ?? null : null })));
});

apiKeyRoutes.post('/', (req, res) => {
  const p = z
    .object({
      name: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(API_KEY_SCOPES as [string, ...string[]])).min(1),
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
    })
    .safeParse(req.body);
  if (!p.success) {
    res.status(400).json({ error: p.error.issues[0]?.message ?? 'Invalid key' });
    return;
  }
  const t = newApiKey();
  const row = db
    .insert(apiKeys)
    .values({
      name: p.data.name,
      prefix: t.prefix,
      tokenHash: t.hash,
      scopes: [...new Set(p.data.scopes)] as never,
      createdBy: req.user?.id ?? null,
      expiresAt: p.data.expiresInDays ? new Date(Date.now() + p.data.expiresInDays * 86_400_000) : null,
    })
    .returning()
    .get();
  audit(req.user, { entity: 'api_key', entityId: row.id, action: 'create', after: { name: row.name, scopes: row.scopes, prefix: row.prefix } });
  res.status(201).json({ key: view(row), token: t.token });
});

apiKeyRoutes.post('/:id/revoke', (req, res) => {
  const row = db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, req.params.id)).returning().get();
  if (!row) {
    res.status(404).json({ error: 'Key not found' });
    return;
  }
  audit(req.user, { entity: 'api_key', entityId: row.id, action: 'revoke', after: { name: row.name } });
  res.json(view(row));
});
