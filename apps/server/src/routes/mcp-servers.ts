import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { mcpServers } from '@supops/db';
import { mcpServerPrefix, mcpToolKey } from '@supops/core';
import { isAdmin } from '../auth.ts';
import { db } from '../context.ts';
import { audit } from '../services/audit.ts';
import { checkMcpServer, forgetMcpServer, packMcpSecrets, serverWildcard, stdioAllowed, suggestIdentityTool, syncMcpTools, unpackMcpSecrets } from '../mcp/manager.ts';

/**
 * MCP servers: a project's extra tools. Admins add, check and remove them, and mark
 * individual tools read-only; everyone can see them, never their headers' or
 * environment's values.
 */
export const mcpServerRoutes = Router();

/** Express 4 does not catch a rejected handler: answer with the error instead of hanging. */
const safe =
  (fn: (req: import('express').Request<{ id: string }>, res: import('express').Response) => Promise<void>) =>
  (req: import('express').Request<{ id: string }>, res: import('express').Response) =>
    fn(req, res).catch((err: unknown) => {
      if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : 'Something went wrong' });
    });

type Row = typeof mcpServers.$inferSelect;
const view = ({ secretEnc, ...r }: Row) => {
  const s = unpackMcpSecrets(secretEnc);
  return {
    ...r,
    // Names only: which headers and variables are set, never their values.
    headerNames: Object.keys(s.headers ?? {}),
    envNames: Object.keys(s.env ?? {}),
    prefix: mcpServerPrefix(r.name),
    wildcard: serverWildcard(r.name),
    tools: r.tools.map((t) => ({ ...t, key: mcpToolKey(r.name, t.name) })),
    suggestedIdentityTool: r.identityTool ? null : suggestIdentityTool(r.tools),
  };
};

function adminOnly(req: { user?: Parameters<typeof isAdmin>[0] }, res: { status: (n: number) => { json: (b: unknown) => void } }): boolean {
  if (isAdmin(req.user)) return true;
  res.status(403).json({ error: 'Only an admin can change MCP servers.' });
  return false;
}

const name = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, 'Name: up to 24 lowercase letters, numbers and hyphens');
const pairs = z.record(z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, numbers, _ . and - in names'), z.string().max(4000)).refine((r) => Object.keys(r).length <= 20, 'At most 20');
const body = z.object({
  name,
  transport: z.enum(['http', 'stdio']),
  url: z.string().trim().url().max(2000).refine((u) => /^https?:\/\//.test(u), 'The URL must be http or https').optional(),
  command: z.string().trim().min(1).max(500).optional(),
  args: z.array(z.string().max(1000)).max(40).optional(),
  /** Replaces all headers (or environment variables) when given; {} clears them. */
  headers: pairs.optional(),
  env: pairs.optional(),
  allowPrivateNetwork: z.boolean().optional(),
  enabled: z.boolean().optional(),
  identityTool: z.string().trim().max(200).nullable().optional(),
});

function shapeError(b: { transport: 'http' | 'stdio'; url?: string | null; command?: string | null }): string | null {
  if (b.transport === 'http' && !b.url) return 'An HTTP MCP server needs its URL.';
  if (b.transport === 'stdio') {
    if (!stdioAllowed()) return 'Local (stdio) MCP servers are switched off on this SupOps server. Its operator can allow them with SUPOPS_MCP_STDIO=1.';
    if (!b.command) return 'A local MCP server needs the command that starts it.';
  }
  return null;
}

mcpServerRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  res.json({ stdioAllowed: stdioAllowed(), servers: db.select().from(mcpServers).where(eq(mcpServers.projectId, projectId)).all().map(view) });
});

mcpServerRoutes.post('/', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const parsed = body.extend({ projectId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP server' });
    return;
  }
  const b = parsed.data;
  const bad = shapeError(b);
  if (bad) {
    res.status(400).json({ error: bad });
    return;
  }
  if (db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.name, b.name)).get()) {
    res.status(409).json({ error: `An MCP server named "${b.name}" already exists (names are unique across SupOps: they name the tools).` });
    return;
  }
  const row = db
    .insert(mcpServers)
    .values({
      projectId: b.projectId,
      name: b.name,
      transport: b.transport,
      url: b.transport === 'http' ? b.url! : null,
      command: b.transport === 'stdio' ? b.command! : null,
      args: b.transport === 'stdio' ? (b.args ?? []) : null,
      secretEnc: packMcpSecrets({ headers: b.headers ?? {}, env: b.env ?? {} }),
      allowPrivateNetwork: b.allowPrivateNetwork ?? false,
      enabled: b.enabled ?? true,
      identityTool: b.identityTool || null,
      createdBy: req.user?.id ?? null,
    })
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'mcp_server', entityId: row.id, action: 'create', after: { name: row.name, transport: row.transport, url: row.url, command: row.command } });
  res.status(201).json(view(await checkMcpServer(row.id)));
}));

mcpServerRoutes.patch('/:id', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  const parsed = body.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid MCP server' });
    return;
  }
  const b = parsed.data;
  const transport = b.transport ?? row.transport;
  const bad = shapeError({ transport, url: b.url ?? row.url, command: b.command ?? row.command });
  if (bad) {
    res.status(400).json({ error: bad });
    return;
  }
  if (b.name && b.name !== row.name) {
    res.status(400).json({ error: 'The name cannot be changed: it names the tools agents and runs refer to. Add the server again under the new name.' });
    return;
  }
  const before = unpackMcpSecrets(row.secretEnc);
  const secretEnc = b.headers || b.env ? packMcpSecrets({ headers: b.headers ?? before.headers ?? {}, env: b.env ?? before.env ?? {} }) : row.secretEnc;
  const updated = db
    .update(mcpServers)
    .set({
      transport,
      ...(b.url !== undefined ? { url: b.url } : {}),
      ...(b.command !== undefined ? { command: b.command } : {}),
      ...(b.args !== undefined ? { args: b.args } : {}),
      secretEnc,
      ...(b.allowPrivateNetwork !== undefined ? { allowPrivateNetwork: b.allowPrivateNetwork } : {}),
      ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
      ...(b.identityTool !== undefined ? { identityTool: b.identityTool || null } : {}),
    })
    .where(eq(mcpServers.id, row.id))
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'mcp_server', entityId: row.id, action: 'update', before: { url: row.url, command: row.command, enabled: row.enabled }, after: { url: updated.url, command: updated.command, enabled: updated.enabled, secretsChanged: secretEnc !== row.secretEnc } });
  // A changed address or credentials is checked straight away; switching on or off only re-registers.
  const reconnect = ['url', 'command', 'args', 'headers', 'env', 'allowPrivateNetwork', 'transport'].some((k) => k in b);
  if (reconnect && updated.enabled) {
    res.json(view(await checkMcpServer(row.id)));
    return;
  }
  syncMcpTools(row.id);
  res.json(view(updated));
}));

mcpServerRoutes.post('/:id/check', safe(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select({ id: mcpServers.id }).from(mcpServers).where(eq(mcpServers.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  res.json(view(await checkMcpServer(row.id)));
}));

/** Mark one tool read-only (it then runs without approval like any read-only check), or take that back. */
mcpServerRoutes.put('/:id/tools/:tool/read-only', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  const parsed = z.object({ readOnly: z.boolean() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'readOnly must be true or false' });
    return;
  }
  const tool = req.params.tool;
  if (!row.tools.some((t) => t.name === tool)) {
    res.status(404).json({ error: `The server does not list a tool named "${tool}". Check it again if the tool is new.` });
    return;
  }
  const next = { ...row.readOnly };
  if (parsed.data.readOnly) next[tool] = { by: req.user?.name ?? 'an admin', at: Date.now() };
  else delete next[tool];
  const updated = db.update(mcpServers).set({ readOnly: next }).where(eq(mcpServers.id, row.id)).returning().get();
  audit(req.user, {
    projectId: row.projectId,
    entity: 'mcp_server',
    entityId: row.id,
    action: parsed.data.readOnly ? 'mark_tool_read_only' : 'unmark_tool_read_only',
    after: { server: row.name, tool, key: mcpToolKey(row.name, tool) },
  });
  res.json(view(updated));
});

mcpServerRoutes.delete('/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, req.params.id)).get();
  if (!row) {
    res.status(404).json({ error: 'MCP server not found' });
    return;
  }
  db.delete(mcpServers).where(eq(mcpServers.id, row.id)).run();
  forgetMcpServer(row.id);
  audit(req.user, { projectId: row.projectId, entity: 'mcp_server', entityId: row.id, action: 'delete', before: { name: row.name } });
  res.status(204).end();
});
