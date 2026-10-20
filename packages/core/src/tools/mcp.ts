import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import type { JsonSchemaProfile, RiskContribution } from '@supops/shared';
import type { ToolDef } from './types.ts';
import { errOutput, okOutput } from './output.ts';
import { addressProblem, BlockedAddressError, guardLookup } from './executors/http.ts';
import { NETWORK_TARGET } from './net-check.ts';

/**
 * A small Model Context Protocol client, written for SupOps: streamable HTTP and stdio,
 * initialise, list tools, call a tool. Nothing else (no sampling, no roots, no resources):
 * SupOps uses an MCP server only as a source of tools, each of which goes through the
 * risk engine like any other.
 *
 * Every MCP tool waits for a person's approval unless an admin has marked that tool
 * read-only. What the server says about its own tools (readOnlyHint) is shown to the
 * admin as a hint and never trusted on its own.
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface RpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpError extends Error {}

export interface McpTransport {
  /** Send a request and resolve with its response message. */
  request(msg: RpcRequest, timeoutMs: number, signal?: AbortSignal): Promise<RpcMessage>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  /** After initialise: the version both sides agreed on (sent as a header over HTTP). */
  setProtocolVersion(v: string): void;
  close(): void;
}

// ---------------------------------------------------------------------------
// Streamable HTTP
// ---------------------------------------------------------------------------

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /** Like observability connections: private and loopback addresses only when allowed. Metadata addresses never. */
  allowPrivateNetwork: boolean;
}

/** Messages from a text/event-stream body, as each event completes. */
export function sseMessages(): { push(chunk: string): RpcMessage[] } {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk.replace(/\r\n?/g, '\n');
      const out: RpcMessage[] = [];
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as RpcMessage | RpcMessage[];
          out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
        } catch {
          // Not JSON-RPC: skip it rather than fail the call.
        }
      }
      return out;
    },
  };
}

export class HttpTransport implements McpTransport {
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private readonly url: URL;
  private readonly o: HttpTransportOptions;

  constructor(o: HttpTransportOptions) {
    this.o = o;
    this.url = new URL(o.url);
    if (this.url.protocol !== 'http:' && this.url.protocol !== 'https:') throw new McpError('An MCP server URL must be http or https.');
  }

  setProtocolVersion(v: string): void {
    this.protocolVersion = v;
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    await this.post({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }, null, 15_000);
  }

  async request(msg: RpcRequest, timeoutMs: number, signal?: AbortSignal): Promise<RpcMessage> {
    const r = await this.post(msg, msg.id, timeoutMs, signal);
    if (!r) throw new McpError(`The MCP server sent no reply to ${msg.method}.`);
    return r;
  }

  close(): void {
    // Ending the session is a courtesy; a server that ignores it times it out itself.
    if (this.sessionId) void this.delete().catch(() => {});
    this.sessionId = null;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...this.o.headers,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
      ...(this.protocolVersion ? { 'mcp-protocol-version': this.protocolVersion } : {}),
      ...extra,
    };
  }

  private open(method: 'POST' | 'DELETE', headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
    const host = this.url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      const problem = addressProblem(host, this.o.allowPrivateNetwork);
      if (problem) throw new BlockedAddressError(problem);
    }
    const send = this.url.protocol === 'https:' ? httpsRequest : httpRequest;
    return send(this.url, {
      method,
      headers,
      lookup: guardLookup((ip) => {
        const problem = addressProblem(ip, this.o.allowPrivateNetwork);
        return problem ? new BlockedAddressError(problem) : null;
      }),
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  private delete(): Promise<void> {
    return new Promise((resolve) => {
      const req = this.open('DELETE', this.headers({}), 5_000);
      req.on('response', (res) => { res.resume(); resolve(); });
      req.on('error', () => resolve());
      req.on('timeout', () => { req.destroy(); resolve(); });
      req.end();
    });
  }

  /** POST one message; with `waitFor`, resolve with the response carrying that id. */
  private post(body: object, waitFor: number | null, timeoutMs: number, signal?: AbortSignal): Promise<RpcMessage | null> {
    const text = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err: Error | null, value: RpcMessage | null = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };
      // The socket timeout is per inactivity; this caps the whole exchange.
      const timer = setTimeout(() => { req.destroy(); finish(new McpError(`The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
      let req: ReturnType<HttpTransport['open']>;
      try {
        req = this.open(
          'POST',
          this.headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': String(Buffer.byteLength(text)) }),
          timeoutMs,
          signal,
        );
      } catch (err) {
        finish(err as Error);
        return;
      }
      req.on('response', (res) => {
        const status = res.statusCode ?? 0;
        const sid = res.headers['mcp-session-id'];
        if (typeof sid === 'string' && sid) this.sessionId = sid;
        const type = String(res.headers['content-type'] ?? '');
        let size = 0;
        if (status === 202 || (waitFor === null && status < 300)) {
          res.resume();
          return finish(null, null);
        }
        if (status >= 300) {
          let errBody = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => { if (errBody.length < 2000) errBody += c; });
          res.on('end', () => {
            if (status === 404 && this.sessionId) this.sessionId = null;
            const hint = status === 401 || status === 403 ? ' Check the credentials (headers) for this MCP server.' : status >= 300 && status < 400 ? ' Redirects are not followed: use the final URL.' : '';
            finish(new McpError(`The MCP server answered HTTP ${status}${errBody ? `: ${errBody.replace(/\s+/g, ' ').slice(0, 300)}` : ''}.${hint}`));
          });
          return;
        }
        res.setEncoding('utf8');
        const tooBig = () => { res.destroy(); finish(new McpError('The MCP server sent more than 8 MB in one reply.')); };
        if (type.includes('text/event-stream')) {
          const sse = sseMessages();
          res.on('data', (c: string) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) return tooBig();
            for (const m of sse.push(c)) {
              if (m.id === waitFor && (m.result !== undefined || m.error)) {
                res.destroy();
                return finish(null, m);
              }
            }
          });
          res.on('end', () => finish(new McpError('The MCP server closed the stream without answering.')));
          res.on('close', () => finish(new McpError('The MCP server closed the stream without answering.')));
        } else {
          let all = '';
          res.on('data', (c: string) => {
            size += c.length;
            if (size > MAX_RESPONSE_BYTES) return tooBig();
            all += c;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(all) as RpcMessage | RpcMessage[];
              const list = Array.isArray(parsed) ? parsed : [parsed];
              finish(null, list.find((m) => m.id === waitFor) ?? null);
            } catch {
              finish(new McpError(`The MCP server sent something that is not JSON (${type || 'no content type'}).`));
            }
          });
        }
        res.on('error', (e) => finish(e));
      });
      req.on('timeout', () => { req.destroy(); finish(new McpError(`The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s.`)); });
      req.on('error', (e) => finish(e));
      req.end(text);
    });
  }
}

// ---------------------------------------------------------------------------
// stdio
// ---------------------------------------------------------------------------

export interface StdioTransportOptions {
  command: string;
  args: string[];
  /** Only these, plus PATH, HOME and LANG: the server never sees SupOps' own environment. */
  env?: Record<string, string>;
}

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, { resolve: (m: RpcMessage) => void; reject: (e: Error) => void }>();
  private stderr = '';
  private exited: string | null = null;

  constructor(o: StdioTransportOptions) {
    const base: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'LANG']) if (process.env[k]) base[k] = process.env[k]!;
    this.child = spawn(o.command, o.args, { env: { ...base, ...o.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let line = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c: string) => {
      line += c;
      let at: number;
      while ((at = line.indexOf('\n')) >= 0) {
        const one = line.slice(0, at).trim();
        line = line.slice(at + 1);
        if (one) this.receive(one);
      }
      if (line.length > MAX_RESPONSE_BYTES) {
        this.fail('The MCP server wrote more than 8 MB without a line break.');
        this.child.kill();
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (c: string) => { this.stderr = (this.stderr + c).slice(-2000); });
    this.child.on('error', (e) => this.fail(`Could not start the MCP server: ${e.message}`));
    this.child.on('exit', (code, sig) => this.fail(`The MCP server exited (${sig ?? `code ${code}`})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-400)}` : ''}`));
  }

  setProtocolVersion(): void {}

  private fail(why: string) {
    this.exited ??= why;
    for (const p of this.pending.values()) p.reject(new McpError(why));
    this.pending.clear();
  }

  private receive(text: string) {
    let m: RpcMessage;
    try {
      m = JSON.parse(text) as RpcMessage;
    } catch {
      return;
    }
    if (m.method && m.id !== undefined && m.id !== null) {
      // A request from the server. SupOps answers ping and declines everything else.
      this.write(m.method === 'ping' ? { jsonrpc: '2.0', id: m.id, result: {} } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'SupOps does not support this' } });
      return;
    }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (p) {
        this.pending.delete(m.id);
        p.resolve(m);
      }
    }
  }

  private write(o: object) {
    if (!this.exited) this.child.stdin.write(`${JSON.stringify(o)}\n`);
  }

  async notify(method: string, params?: Record<string, unknown>): Promise<void> {
    this.write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  request(msg: RpcRequest, timeoutMs: number, signal?: AbortSignal): Promise<RpcMessage> {
    if (this.exited) return Promise.reject(new McpError(this.exited));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(msg.id);
        reject(new McpError(`The MCP server did not answer within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const done = <T>(f: (v: T) => void) => (v: T) => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); f(v); };
      const onAbort = () => {
        this.pending.delete(msg.id);
        clearTimeout(timer);
        this.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: msg.id, reason: 'cancelled' } });
        reject(new McpError('cancelled'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(msg.id, { resolve: done(resolve), reject: done(reject) });
      this.write(msg);
    });
  }

  close(): void {
    this.fail('closed');
    this.child.stdin.end();
    this.child.kill();
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** What the server says about the tool. Hints for the admin, never trusted on their own. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
  instructions?: string;
}

export interface McpCallResult {
  ok: boolean;
  text: string;
}

export class McpClient {
  private id = 0;
  info: McpServerInfo | null = null;
  private readonly t: McpTransport;

  constructor(t: McpTransport) {
    this.t = t;
  }

  private async call(method: string, params: Record<string, unknown> | undefined, timeoutMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const r = await this.t.request({ jsonrpc: '2.0', id: ++this.id, method, ...(params ? { params } : {}) }, timeoutMs, signal);
    if (r.error) throw new McpError(`The MCP server refused ${method}: ${r.error.message}`);
    return (r.result ?? {}) as Record<string, unknown>;
  }

  async connect(timeoutMs = 20_000): Promise<McpServerInfo> {
    const r = await this.call('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'SupOps', version: '1' } }, timeoutMs);
    const server = (r.serverInfo ?? {}) as { name?: string; version?: string };
    const version = typeof r.protocolVersion === 'string' ? r.protocolVersion : MCP_PROTOCOL_VERSION;
    this.t.setProtocolVersion(version);
    await this.t.notify('notifications/initialized');
    this.info = {
      name: String(server.name ?? 'unknown'),
      version: String(server.version ?? ''),
      protocolVersion: version,
      ...(typeof r.instructions === 'string' ? { instructions: r.instructions.slice(0, 2000) } : {}),
    };
    return this.info;
  }

  async listTools(timeoutMs = 20_000): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.call('tools/list', cursor ? { cursor } : undefined, timeoutMs);
      for (const t of (r.tools ?? []) as McpToolInfo[]) if (t && typeof t.name === 'string') out.push(t);
      cursor = typeof r.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor || out.length >= 500) break;
    }
    return out.slice(0, 500);
  }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<McpCallResult> {
    const r = await this.call('tools/call', { name, arguments: args }, timeoutMs, signal);
    return resultText(r);
  }

  close(): void {
    this.t.close();
  }
}

/** A tool result as text for the model: text as is, anything else described, never dropped silently. */
export function resultText(r: Record<string, unknown>): McpCallResult {
  const parts: string[] = [];
  for (const c of (Array.isArray(r.content) ? r.content : []) as Array<Record<string, unknown>>) {
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'image' || c.type === 'audio') parts.push(`[${c.type} (${String(c.mimeType ?? 'unknown type')}) not shown]`);
    else if (c.type === 'resource') {
      const res = (c.resource ?? {}) as { uri?: string; text?: string };
      parts.push(res.text ? `[resource ${res.uri ?? ''}]\n${res.text}` : `[resource ${res.uri ?? ''}: binary, not shown]`);
    } else if (c.type === 'resource_link') parts.push(`[link: ${String(c.name ?? '')} ${String(c.uri ?? '')}]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return { ok: r.isError !== true, text: parts.join('\n') || '(the tool returned nothing)' };
}

// ---------------------------------------------------------------------------
// MCP tools as SupOps tools
// ---------------------------------------------------------------------------

const slugPart = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'x';

/** What every tool of this server's key starts with. */
export const mcpServerPrefix = (server: string) => `mcp_${slugPart(server)}_`;

/** `mcp_<server>_<tool>`: what the model calls it. At most 64 characters, as providers require. */
export function mcpToolKey(server: string, tool: string): string {
  return `${mcpServerPrefix(server)}${slugPart(tool)}`.slice(0, 64);
}

const PROFILE_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);

/**
 * An MCP input schema cut down to what every model backend accepts (see
 * assertSchemaProfile). Constraints that do not survive are the MCP server's to enforce.
 */
export function profileOf(schema: unknown, depth = 0): JsonSchemaProfile {
  const s = (schema && typeof schema === 'object' ? schema : {}) as Record<string, unknown>;
  const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t): t is string => typeof t === 'string' && PROFILE_TYPES.has(t));
  const type = (types[0] ?? (s.properties ? 'object' : s.items ? 'array' : 'string')) as JsonSchemaProfile['type'];
  const out: JsonSchemaProfile = { type };
  if (typeof s.description === 'string') out.description = s.description.slice(0, 1000);
  if (Array.isArray(s.enum) && type === 'string') out.enum = s.enum.map(String).slice(0, 100);
  if (type === 'object' && depth < 4 && s.properties && typeof s.properties === 'object') {
    out.properties = Object.fromEntries(Object.entries(s.properties as Record<string, unknown>).slice(0, 60).map(([k, v]) => [k, profileOf(v, depth + 1)]));
    if (Array.isArray(s.required)) out.required = s.required.filter((r): r is string => typeof r === 'string' && r in out.properties!);
  }
  if (type === 'array') out.items = depth < 4 ? profileOf(s.items, depth + 1) : { type: 'string' };
  return out;
}

/** How SupOps reaches one MCP server's tools; supplied by the server process. */
export interface McpBinding {
  serverName: string;
  /** The admin's marking for this tool, read at the moment a call is classified. */
  readOnly(tool: string): { by: string; at: number } | null;
  call(tool: string, args: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<McpCallResult>;
}

/** Ours, not the MCP tool's: what the approver reads. Stripped before the call. */
const APPROVAL_ARGS = {
  intent: { type: 'string' as const, description: 'Why this call is needed, in one sentence, for the person approving it.' },
  expected_effect: { type: 'string' as const, description: 'What this call changes or returns, stated so it can be checked.' },
};
/** A tool parameter that clashes with one SupOps adds is renamed for the model and renamed back. */
const CLASH: Record<string, string> = { target: 'mcp_target', intent: 'mcp_intent', expected_effect: 'mcp_expected_effect' };

export const MCP_TIMEOUT_MS = 60_000;

export function mcpToolDef(binding: McpBinding, tool: McpToolInfo): ToolDef<Record<string, unknown> & { target: string }> {
  const input = profileOf(tool.inputSchema ?? { type: 'object' });
  const own = input.type === 'object' ? (input.properties ?? {}) : {};
  const params: Record<string, JsonSchemaProfile> = {};
  for (const [k, v] of Object.entries(own)) params[CLASH[k] ?? k] = v;
  const required = (input.required ?? []).map((k) => CLASH[k] ?? k);
  const back = Object.fromEntries(Object.entries(CLASH).map(([orig, renamed]) => [renamed, orig]));
  const label = `${binding.serverName}/${tool.name}`;
  const hint = tool.annotations?.readOnlyHint ? ' The server describes it as read-only.' : tool.annotations?.destructiveHint ? ' The server describes it as destructive.' : '';

  const classify = (): RiskContribution[] => {
    const ro = binding.readOnly(tool.name);
    return ro
      ? [{ stage: 'arguments', tier: 'read_only', ruleId: 'mcp.read_only', reason: `${label} was marked read-only by ${ro.by} on ${new Date(ro.at).toISOString().slice(0, 10)}` }]
      : [{ stage: 'arguments', tier: 'high', ruleId: 'mcp.unreviewed', reason: `${label} is an MCP tool no admin has marked read-only, so SupOps cannot tell what it changes; a person approves each call` }];
  };

  return {
    key: mcpToolKey(binding.serverName, tool.name),
    kind: 'http',
    description: `${(tool.description ?? tool.title ?? tool.name).slice(0, 1500)}\n(MCP tool "${tool.name}" on the server "${binding.serverName}".${hint} Unless an admin has marked it read-only, each call waits for a person's approval: give intent and expected_effect. The target argument is always supops-server.)`,
    parameters: { ...params, ...APPROVAL_ARGS },
    required,
    argsSchema: z.object({ target: z.string(), intent: z.string().max(500).optional(), expected_effect: z.string().max(500).optional() }).passthrough() as never,
    baselineRisk: 'read_only',
    targetKinds: ['http'],
    fixedTarget: NETWORK_TARGET,
    mutating: true,
    timeoutMs: MCP_TIMEOUT_MS,
    render: (a) => {
      const shown = Object.fromEntries(Object.entries(a).filter(([k]) => !['target', 'intent', 'expected_effect'].includes(k)));
      const json = JSON.stringify(shown);
      return `mcp ${label} ${json.length > 400 ? `${json.slice(0, 400)}…` : json}`;
    },
    classifyArgs: classify,
    execute: async (a, ctx) => {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(a)) {
        if (k === 'target' || k === 'intent' || k === 'expected_effect') continue;
        args[back[k] ?? k] = v as Json;
      }
      try {
        const r = await binding.call(tool.name, args, ctx.timeoutMs, ctx.signal);
        const text = Buffer.byteLength(r.text) > ctx.maxOutputBytes ? `${Buffer.from(r.text).subarray(0, ctx.maxOutputBytes).toString('utf8')}\n[cut at ${ctx.maxOutputBytes} bytes]` : r.text;
        return r.ok ? okOutput(text) : errOutput(`The MCP tool reported an error: ${text}`);
      } catch (err) {
        return errOutput(`Calling ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
