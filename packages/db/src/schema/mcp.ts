import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';

/** A tool as the MCP server listed it at the last check (see McpToolInfo in core). */
export interface StoredMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

/**
 * An MCP server whose tools a project's runs may use. Its tools reach a run only
 * through the risk engine: each call waits for approval unless an admin marked that
 * tool read-only (`readOnly`, with who and when, also in the audit log).
 *
 * `secretEnc` holds what may not be shown -- HTTP headers (an Authorization token) or a
 * stdio server's environment -- encrypted with the master key, never returned by the API.
 */
export const mcpServers = sqliteTable(
  'mcp_servers',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Unique across SupOps: it names the tools (mcp_<name>_<tool>). */
    name: text('name').notNull(),
    transport: text('transport').$type<'http' | 'stdio'>().notNull(),
    url: text('url'),
    command: text('command'),
    args: text('args', { mode: 'json' }).$type<string[]>(),
    secretEnc: text('secret_enc'),
    allowPrivateNetwork: integer('allow_private_network', { mode: 'boolean' }).notNull().default(false),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** The tools at the last successful check. Runs are offered these, so a restart needs no connection. */
    tools: text('tools', { mode: 'json' }).$type<StoredMcpTool[]>().notNull().default([]),
    /** Tool name -> who marked it read-only, and when. Anything absent waits for approval. */
    readOnly: text('read_only', { mode: 'json' }).$type<Record<string, { by: string; at: number }>>().notNull().default({}),
    /** A read-only tool the health check calls to show which identity SupOps acts as. */
    identityTool: text('identity_tool'),
    identity: text('identity'),
    serverInfo: text('server_info', { mode: 'json' }).$type<{ name: string; version: string; protocolVersion: string }>(),
    lastCheckedAt: ts('last_checked_at'),
    lastError: text('last_error'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mcp_servers_name').on(t.name), index('mcp_servers_project').on(t.projectId)],
);
