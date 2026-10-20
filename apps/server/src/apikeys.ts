import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { apiKeys, users, type ApiKeyScope } from '@supops/db';
import type { NextFunction, Request, Response } from 'express';
import { db } from './context.ts';

/**
 * API keys for machines. A key is `sok_` and 40 random characters, kept only as a hash.
 * It acts as a member (never an admin), and the gate below lets it reach only what its
 * scopes name.
 */

export const API_KEY_SCOPES: ApiKeyScope[] = ['read', 'investigate', 'changes', 'metrics', 'mcp'];

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export function newApiKey(): { token: string; hash: string; prefix: string } {
  const token = `sok_${randomBytes(30).toString('base64url')}`;
  return { token, hash: hash(token), prefix: token.slice(0, 10) };
}

/** The key behind a presented token, if it is live (not revoked, not expired). Records its use. */
export function verifyApiKey(token: string, now = Date.now()) {
  if (!token.startsWith('sok_')) return null;
  const row = db.select().from(apiKeys).where(and(eq(apiKeys.tokenHash, hash(token)), isNull(apiKeys.revokedAt))).get();
  if (!row || !row.createdBy || (row.expiresAt && row.expiresAt.getTime() <= now)) return null;
  // A key acts in its maker's name: when the maker is removed or disabled, the key stops working.
  const maker = db.select({ name: users.name, disabledAt: users.disabledAt }).from(users).where(eq(users.id, row.createdBy)).get();
  if (!maker || maker.disabledAt) return null;
  // Once a minute is plenty for "last used".
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > 60_000) db.update(apiKeys).set({ lastUsedAt: new Date(now) }).where(eq(apiKeys.id, row.id)).run();
  return {
    user: { id: row.createdBy, email: '', name: `API key "${row.name}" (made by ${maker.name})`, globalRole: 'member' },
    key: { id: row.id, name: row.name, scopes: row.scopes },
  };
}

/** What each scope allows, as method and path patterns under /api. */
const ALLOW: Record<ApiKeyScope, Array<[string, RegExp]>> = {
  read: [['GET', /^\/(projects|runs|observability|alerts|changes|slos|synthetics|errors|service-health|dashboard|targets|knowledge|workflows)(\/|$)/]],
  investigate: [['POST', /^\/runs\/?$/], ['POST', /^\/observability\/incidents\/[^/]+\/investigate$/], ['GET', /^\/runs(\/|$)/]],
  changes: [['POST', /^\/changes\/?$/]],
  metrics: [['GET', /^\/metrics\/?$/]],
  mcp: [['POST', /^\/mcp\/?$/], ['GET', /^\/mcp\/?$/], ['DELETE', /^\/mcp\/?$/]],
};

export const keyAllows = (scopes: ApiKeyScope[], method: string, path: string) =>
  scopes.some((s) => (ALLOW[s] ?? []).some(([m, re]) => m === method && re.test(path)));

/** After requireAuth: a request made with an API key goes only where its scopes allow. */
export function apiKeyGate(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKey) return next();
  if (keyAllows(req.apiKey.scopes, req.method, req.path)) return next();
  res.status(403).json({ error: `This API key may not do that (its scopes: ${req.apiKey.scopes.join(', ')}).` });
}
