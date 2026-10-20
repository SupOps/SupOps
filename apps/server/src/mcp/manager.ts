import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret, mcpServers, packEnvelope, unpackEnvelope } from '@supops/db';
import { HttpTransport, McpClient, StdioTransport, mcpServerPrefix, mcpToolDef, type McpBinding, type McpCallResult } from '@supops/core';
import type { ToolDef } from '@supops/core';
import { db, registry } from '../context.ts';

/**
 * MCP servers as sources of tools. Their tool lists are stored at each check, so runs
 * are offered them without connecting first (and a restart needs no connection);
 * connections are made on the first call and reused while in use.
 */

type Row = typeof mcpServers.$inferSelect;

/**
 * A stdio server is a program SupOps starts on its own machine, so it is off unless the
 * operator of the SupOps server turns it on. HTTP servers need no such switch.
 */
export const stdioAllowed = () => process.env.SUPOPS_MCP_STDIO === '1';

export interface McpSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export const packMcpSecrets = (s: McpSecrets): string | null =>
  Object.keys(s.headers ?? {}).length || Object.keys(s.env ?? {}).length ? packEnvelope(encryptSecret(JSON.stringify(s))) : null;

export function unpackMcpSecrets(enc: string | null): McpSecrets {
  if (!enc) return {};
  try {
    return JSON.parse(decryptSecret(unpackEnvelope(enc))) as McpSecrets;
  } catch {
    return {};
  }
}

function transportFor(row: Row) {
  const secrets = unpackMcpSecrets(row.secretEnc);
  if (row.transport === 'stdio') {
    if (!stdioAllowed()) throw new Error('Local (stdio) MCP servers are switched off on this SupOps server (SUPOPS_MCP_STDIO).');
    return new StdioTransport({ command: row.command ?? '', args: row.args ?? [], ...(secrets.env ? { env: secrets.env } : {}) });
  }
  return new HttpTransport({ url: row.url ?? '', ...(secrets.headers ? { headers: secrets.headers } : {}), allowPrivateNetwork: row.allowPrivateNetwork });
}

const configKey = (r: Row) => createHash('sha256').update(JSON.stringify([r.transport, r.url, r.command, r.args, r.secretEnc, r.allowPrivateNetwork])).digest('hex');

const IDLE_MS = 5 * 60_000;
const pool = new Map<string, { key: string; client: Promise<McpClient>; used: number }>();

function drop(id: string) {
  const p = pool.get(id);
  pool.delete(id);
  void p?.client.then((c) => c.close()).catch(() => {});
}

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, p] of pool) if (now - p.used > IDLE_MS) drop(id);
}, 60_000);
sweeper.unref();

function clientFor(row: Row): Promise<McpClient> {
  const key = configKey(row);
  const have = pool.get(row.id);
  if (have && have.key === key) {
    have.used = Date.now();
    return have.client;
  }
  if (have) drop(row.id);
  const client = (async () => {
    const c = new McpClient(transportFor(row));
    await c.connect();
    return c;
  })();
  pool.set(row.id, { key, client, used: Date.now() });
  client.catch(() => pool.get(row.id)?.client === client && pool.delete(row.id));
  return client;
}

async function callTool(serverId: string, tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<McpCallResult> {
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).get();
  if (!row) throw new Error('This MCP server was removed.');
  if (!row.enabled) throw new Error('This MCP server is switched off.');
  try {
    return await (await clientFor(row)).callTool(tool, args, timeoutMs, signal);
  } catch (err) {
    if (signal.aborted) throw err;
    // A dropped connection or an expired session: one fresh connection, then give up.
    drop(row.id);
    return await (await clientFor(row)).callTool(tool, args, timeoutMs, signal);
  }
}

function bindingFor(row: Row): McpBinding {
  return {
    serverName: row.name,
    // Read at the moment a call is classified, so marking or unmarking applies at once.
    readOnly: (tool) => db.select({ ro: mcpServers.readOnly }).from(mcpServers).where(eq(mcpServers.id, row.id)).get()?.ro[tool] ?? null,
    call: (tool, args, timeoutMs, signal) => callTool(row.id, tool, args, timeoutMs, signal),
  };
}

/** Put a server's current tools in the registry (or take them out). Without an id, every server. */
export function syncMcpTools(serverId?: string): void {
  const rows = serverId ? db.select().from(mcpServers).where(eq(mcpServers.id, serverId)).all() : db.select().from(mcpServers).all();
  if (serverId && !rows.length) registry.setGroup(`mcp:${serverId}`, []);
  for (const row of rows) {
    registry.setGroup(`mcp:${row.id}`, row.enabled ? (row.tools.map((t) => mcpToolDef(bindingFor(row), t)) as unknown as ToolDef<never>[]) : []);
    if (!row.enabled) drop(row.id);
  }
}

export function forgetMcpServer(id: string): void {
  registry.setGroup(`mcp:${id}`, []);
  drop(id);
}

/** The allowlist entry that gives an agent every tool of a server. */
export const serverWildcard = (name: string) => `${mcpServerPrefix(name)}*`;

/**
 * The MCP tools a run in this project may use: an agent allowed every tool gets every
 * enabled server's tools; otherwise those it lists, by key or by `mcp_<server>_*`.
 */
export function mcpToolsForRun(projectId: string, agentKeys: string[] | null): ToolDef<never>[] {
  const out: ToolDef<never>[] = [];
  for (const row of db.select().from(mcpServers).where(eq(mcpServers.projectId, projectId)).all()) {
    if (!row.enabled) continue;
    const all = agentKeys === null || agentKeys.includes(serverWildcard(row.name));
    for (const def of registry.group(`mcp:${row.id}`)) if (all || agentKeys!.includes(def.key)) out.push(def);
  }
  return out;
}

const IDENTITY_NAMES = /^(whoami|who_am_i|get_me|me|get_current_user|current_user|auth_test|get_authenticated_user|get_user_info)$/i;

/** A likely identity tool among these, for the settings page to suggest. */
export const suggestIdentityTool = (tools: Array<{ name: string }>) => tools.find((t) => IDENTITY_NAMES.test(t.name))?.name ?? null;

/**
 * Connect afresh, list the tools, and ask who SupOps is acting as (when an identity tool
 * is set and marked read-only: the check never calls anything that might change state).
 */
export async function checkMcpServer(id: string): Promise<Row> {
  const row = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  if (!row) throw new Error('MCP server not found');
  let client: McpClient | null = null;
  try {
    client = new McpClient(transportFor(row));
    const info = await client.connect();
    const tools = await client.listTools();
    let identity: string | null = null;
    const idTool = row.identityTool;
    if (idTool && tools.some((t) => t.name === idTool)) {
      if (row.readOnly[idTool]) {
        const r = await client.callTool(idTool, {}, 20_000);
        identity = (r.ok ? r.text : `The identity check failed: ${r.text}`).slice(0, 500);
      } else identity = `Not checked: mark ${idTool} read-only to let the health check call it.`;
    }
    const updated = db
      .update(mcpServers)
      .set({ tools, serverInfo: { name: info.name, version: info.version, protocolVersion: info.protocolVersion }, identity, lastCheckedAt: new Date(), lastError: null })
      .where(eq(mcpServers.id, id))
      .returning()
      .get();
    syncMcpTools(id);
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return db.update(mcpServers).set({ lastCheckedAt: new Date(), lastError: message.slice(0, 500) }).where(eq(mcpServers.id, id)).returning().get();
  } finally {
    client?.close();
  }
}
