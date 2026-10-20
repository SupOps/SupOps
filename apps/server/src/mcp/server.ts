import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { alerts, incidents, projects, runSteps, runs, toolCalls } from '@supops/db';
import { OPEN_ALERT_STATUSES, type ChatMessage } from '@supops/shared';
import { db } from '../context.ts';
import { suspectsFor, listChanges } from '../changes/store.ts';
import { incidentServices } from '../changes/incident.ts';
import { startIncidentRun, triageAgentId } from '../observe/triage.ts';
import { startRun } from '../services/start-run.ts';

/**
 * SupOps as an MCP server, for other agents: read its incidents (with the diagnosis and the
 * changes suspected), alerts, changes and runs, and start an investigation. Investigations
 * started here are unattended and read-only, like the automatic diagnosis: an agent calling
 * in never gets more power than that.
 */

export interface Caller {
  userId: string | null;
  /** API key scopes, or null for a signed-in person (who may do everything listed). */
  scopes: string[] | null;
}

const can = (c: Caller, scope: 'read' | 'investigate') => !c.scopes || c.scopes.includes(scope) || (scope === 'read' && c.scopes.includes('mcp'));

const TOOLS = [
  {
    name: 'list_incidents',
    description: 'Incidents, newest first, with their diagnosis (root cause, confidence) when SupOps has one.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Default open.' }, project: { type: 'string', description: 'Project slug; default the first.' }, limit: { type: 'integer', description: 'At most 50.' } } },
  },
  {
    name: 'get_incident',
    description: 'One incident: its alerts, the diagnosis (root cause, causes weighed, blast radius), and the recent changes suspected, likeliest first.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'list_alerts',
    description: 'Alerts that are still open (not resolved), newest first.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, limit: { type: 'integer' } } },
  },
  {
    name: 'list_changes',
    description: 'Deploys and other changes SupOps knows of (CI, cluster rollouts, Grafana annotations, its own approved actions), newest first.',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, hours: { type: 'integer', description: 'How far back, default 24.' }, service: { type: 'string' } } },
  },
  {
    name: 'get_run',
    description: "An investigation's status, the actions it took, and its final answer.",
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'start_investigation',
    description: 'Start a read-only investigation: of an incident (incident_id), or of a question (task). It runs unattended: it looks, never changes anything. Poll get_run with the id returned.',
    inputSchema: { type: 'object', properties: { incident_id: { type: 'string' }, task: { type: 'string' }, project: { type: 'string' } } },
  },
];

function projectOf(slug?: unknown): typeof projects.$inferSelect | undefined {
  return typeof slug === 'string' && slug ? db.select().from(projects).where(or(eq(projects.slug, slug), eq(projects.id, slug))).get() : db.select().from(projects).get();
}

const text = (v: unknown) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text', text: msg }], isError: true });

function finalAnswer(runId: string): string | null {
  for (const s of db.select({ m: runSteps.messageJson }).from(runSteps).where(eq(runSteps.runId, runId)).orderBy(desc(runSteps.seq)).limit(20).all()) {
    const m = s.m as ChatMessage;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

export function callTool(name: string, args: Record<string, unknown>, caller: Caller) {
  if (name === 'start_investigation') {
    if (!can(caller, 'investigate')) return fail('This API key may not start investigations (it needs the investigate scope).');
  } else if (!can(caller, 'read')) return fail('This API key may not read SupOps (it needs the read or mcp scope).');
  const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
  switch (name) {
    case 'list_incidents': {
      const p = projectOf(args.project);
      if (!p) return fail('No such project.');
      const status = args.status === 'resolved' || args.status === 'all' ? args.status : 'open';
      const rows = db.select().from(incidents).where(and(eq(incidents.projectId, p.id), eq(incidents.held, false), ...(status === 'all' ? [] : [eq(incidents.status, status)]))).orderBy(desc(incidents.openedAt)).limit(limit).all();
      return text(rows.map((i) => ({ id: i.id, title: i.title, severity: i.severity, status: i.status, openedAt: i.openedAt, diagnosis: i.triageState, rootCause: i.rootCause, confidence: i.confidence, action: i.action })));
    }
    case 'get_incident': {
      const inc = db.select().from(incidents).where(eq(incidents.id, String(args.id ?? ''))).get();
      if (!inc) return fail('No such incident.');
      const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).all();
      const suspects = suspectsFor(inc.projectId, incidentServices(inc, members), 5).map((s) => ({ change: s.change.title, kind: s.change.kind, at: s.change.startedAt, why: s.reason }));
      return text({
        id: inc.id, title: inc.title, severity: inc.severity, status: inc.status, openedAt: inc.openedAt, groupedBecause: inc.groupReason,
        alerts: members.map((a) => ({ title: a.title, severity: a.severity, status: a.status, labels: a.labels })),
        diagnosis: { state: inc.triageState, rootCause: inc.rootCause, confidence: inc.confidence, action: inc.action, causesWeighed: inc.hypotheses, blastRadius: inc.blastRadius, runId: inc.runId },
        suspectedChanges: suspects,
      });
    }
    case 'list_alerts': {
      const p = projectOf(args.project);
      if (!p) return fail('No such project.');
      const rows = db.select().from(alerts).where(and(eq(alerts.projectId, p.id), inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).orderBy(desc(alerts.receivedAt)).limit(limit).all();
      return text(rows.map((a) => ({ id: a.id, title: a.title, severity: a.severity, status: a.status, incidentId: a.incidentId, labels: a.labels, receivedAt: a.receivedAt })));
    }
    case 'list_changes': {
      const p = projectOf(args.project);
      if (!p) return fail('No such project.');
      const hours = Math.min(24 * 30, Math.max(1, Number(args.hours ?? 24)));
      return text(listChanges(p.id, { since: new Date(Date.now() - hours * 3_600_000), ...(typeof args.service === 'string' ? { service: args.service } : {}), limit: 100 }).map((c) => ({ title: c.title, kind: c.kind, service: c.service, version: c.version, source: c.source, at: c.startedAt, verdict: c.verdict?.overall ?? null })));
    }
    case 'get_run': {
      const r = db.select().from(runs).where(eq(runs.id, String(args.id ?? ''))).get();
      if (!r) return fail('No such run.');
      const acts = db.select({ tool: toolCalls.toolKey, command: toolCalls.renderedCommand, state: toolCalls.state, tier: toolCalls.tier }).from(toolCalls).where(eq(toolCalls.runId, r.id)).all();
      return text({ id: r.id, title: r.title, status: r.status, reason: r.statusReason, actions: acts, answer: finalAnswer(r.id) });
    }
    case 'start_investigation': {
      if (typeof args.incident_id === 'string' && args.incident_id) {
        const inc = db.select().from(incidents).where(eq(incidents.id, args.incident_id)).get();
        if (!inc) return fail('No such incident.');
        if (inc.runId) return text({ runId: inc.runId, note: 'SupOps already investigated this incident; this is that investigation.' });
        const r = startIncidentRun(inc, { mode: 'diagnose', startedBy: caller.userId });
        return r.ok ? text({ runId: r.runId, note: 'Started, read-only. Poll get_run.' }) : fail(r.error);
      }
      if (typeof args.task !== 'string' || !args.task.trim()) return fail('Give an incident_id, or a task to investigate.');
      const p = projectOf(args.project);
      if (!p) return fail('No such project.');
      const agentId = triageAgentId(p.id);
      if (!agentId) return fail('This project has no agent to investigate with.');
      const r = startRun({ projectId: p.id, agentId, task: args.task.slice(0, 4000), trigger: 'api', unattended: true, startedBy: caller.userId });
      return r.ok ? text({ runId: r.run.id, note: 'Started, read-only. Poll get_run.' }) : fail(r.error);
    }
  }
  return fail(`No tool named ${name}.`);
}

interface Rpc { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message; null for a notification (no reply). */
export function handleRpc(m: Rpc, caller: Caller): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
  if (m.id === undefined || m.id === null) return null;
  switch (m.method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'SupOps', version: '1' },
        instructions: 'SupOps watches infrastructure, groups alerts into incidents, and diagnoses them read-only. Read incidents and their diagnosis, and start read-only investigations.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.filter((t) => t.name !== 'start_investigation' || can(caller, 'investigate')) });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(callTool(name, args, caller));
      } catch (err) {
        return reply(fail(err instanceof Error ? err.message : String(err)));
      }
    }
    default:
      return error(-32601, `SupOps does not handle ${m.method}`);
  }
}
