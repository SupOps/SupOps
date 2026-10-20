import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { users } from './identity.ts';

export type ApiKeyScope = 'read' | 'investigate' | 'changes' | 'metrics' | 'mcp';

/**
 * Keys for machines: scripts, CI, a Prometheus scraping /metrics, another agent using
 * SupOps as an MCP server. Stored as a hash, shown once. A key acts as a member, never
 * an admin, and only within its scopes.
 */
export const apiKeys = sqliteTable(
  'api_keys',
  {
    id: id(),
    name: text('name').notNull(),
    /** The first characters, to tell keys apart in lists and logs. */
    prefix: text('prefix').notNull(),
    tokenHash: text('token_hash').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<ApiKeyScope[]>().notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    lastUsedAt: ts('last_used_at'),
    expiresAt: ts('expires_at'),
    revokedAt: ts('revoked_at'),
  },
  (t) => [uniqueIndex('api_keys_hash').on(t.tokenHash), index('api_keys_created').on(t.createdAt)],
);
