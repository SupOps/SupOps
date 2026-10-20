import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { alerts, incidents, runs, slos, syntheticChecks, toolCalls, watches } from '@supops/db';
import type { LLMClient } from '@supops/core';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from './context.ts';
import { pollStatus } from './observe/alert-poller.ts';
import { backupScheduler, listBackups } from './backup.ts';

/**
 * SupOps' own health in the Prometheus text format, for whoever watches SupOps: runs and
 * the queue, approvals waiting, open incidents and alerts, model latency, tokens and
 * errors, alert reads and metric queries that fail, synthetic checks, SLO budgets and the
 * last backup. Read from the database and memory at scrape time; nothing is stored.
 */

const LATENCY_BUCKETS = [0.5, 1, 2, 5, 10, 20, 30, 60, 120];
const llmStats = {
  requests: new Map<string, number>(),
  errors: new Map<string, number>(),
  promptTokens: 0,
  completionTokens: 0,
  buckets: LATENCY_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
};

/** Count every model call: how long it took, the tokens it used, and why it failed. */
export function instrumentLLM(llm: LLMClient): void {
  const original = llm.complete.bind(llm);
  llm.complete = (async (...args: Parameters<LLMClient['complete']>) => {
    const started = performance.now();
    try {
      const r = await original(...args);
      const s = (performance.now() - started) / 1000;
      llmStats.requests.set(r.model, (llmStats.requests.get(r.model) ?? 0) + 1);
      llmStats.promptTokens += r.promptTokens;
      llmStats.completionTokens += r.completionTokens;
      llmStats.sum += s;
      llmStats.count++;
      LATENCY_BUCKETS.forEach((b, i) => { if (s <= b) llmStats.buckets[i]!++; });
      return r;
    } catch (err) {
      const kind = err instanceof Error ? err.name : 'Error';
      llmStats.errors.set(kind, (llmStats.errors.get(kind) ?? 0) + 1);
      throw err;
    }
  }) as LLMClient['complete'];
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labels = (l: Record<string, string>) => {
  const e = Object.entries(l);
  return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};

export function renderMetrics(): string {
  const out: string[] = [];
  const metric = (name: string, type: 'gauge' | 'counter' | 'histogram', help: string, rows: Array<[Record<string, string>, number]>) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [l, v] of rows) out.push(`${name}${labels(l)} ${Number.isFinite(v) ? v : 0}`);
  };

  metric('supops_up', 'gauge', 'SupOps is answering.', [[{}, 1]]);
  const byStatus = db.select({ status: runs.status, n: sql<number>`count(*)` }).from(runs).groupBy(runs.status).all();
  metric('supops_runs', 'gauge', 'Runs by status.', byStatus.map((r) => [{ status: r.status }, r.n]));
  metric('supops_runs_queued', 'gauge', 'Runs waiting for a worker.', [[{}, byStatus.find((r) => r.status === 'queued')?.n ?? 0]]);
  const calls = db.select({ state: toolCalls.state, n: sql<number>`count(*)` }).from(toolCalls).groupBy(toolCalls.state).all();
  const pending = calls.find((c) => c.state === 'awaiting_approval')?.n ?? 0;
  metric('supops_tool_calls', 'gauge', 'Tool calls kept, by state.', calls.map((c) => [{ state: c.state }, c.n]));
  metric('supops_approvals_pending', 'gauge', 'Actions waiting for a person.', [[{}, pending]]);

  const open = db.select({ severity: incidents.severity, n: sql<number>`count(*)` }).from(incidents).where(eq(incidents.status, 'open')).groupBy(incidents.severity).all();
  metric('supops_incidents_open', 'gauge', 'Open incidents by severity.', open.map((o) => [{ severity: o.severity }, o.n]));
  const openAlerts = db.select({ n: sql<number>`count(*)` }).from(alerts).where(inArray(alerts.status, [...OPEN_ALERT_STATUSES])).get()?.n ?? 0;
  metric('supops_alerts_open', 'gauge', 'Alerts not yet resolved.', [[{}, openAlerts]]);

  metric('supops_llm_requests_total', 'counter', 'Model calls that answered, by model.', [...llmStats.requests].map(([m, n]) => [{ model: m }, n]));
  metric('supops_llm_errors_total', 'counter', 'Model calls that failed, by kind.', [...llmStats.errors].map(([k, n]) => [{ kind: k }, n]));
  metric('supops_llm_tokens_total', 'counter', 'Tokens used.', [[{ type: 'prompt' }, llmStats.promptTokens], [{ type: 'completion' }, llmStats.completionTokens]]);
  out.push('# HELP supops_llm_request_seconds How long model calls took.', '# TYPE supops_llm_request_seconds histogram');
  LATENCY_BUCKETS.forEach((b, i) => out.push(`supops_llm_request_seconds_bucket{le="${b}"} ${llmStats.buckets[i]}`));
  out.push(`supops_llm_request_seconds_bucket{le="+Inf"} ${llmStats.count}`, `supops_llm_request_seconds_sum ${llmStats.sum.toFixed(3)}`, `supops_llm_request_seconds_count ${llmStats.count}`);

  metric('supops_alert_read_ok', 'gauge', 'Whether the last alert read from each connection worked.', [...pollStatus].map(([id, s]) => [{ connection: id }, s.ok ? 1 : 0]));
  const failing = db.select({ n: sql<number>`count(*)` }).from(watches).where(and(eq(watches.enabled, true), isNotNull(watches.lastError), sql`${watches.lastError} not like '%more series%'`)).get()?.n ?? 0;
  metric('supops_watch_errors', 'gauge', 'Watched signals whose query is failing.', [[{}, failing]]);

  const checks = db.select({ name: syntheticChecks.name, status: syntheticChecks.lastStatus }).from(syntheticChecks).where(eq(syntheticChecks.enabled, true)).all();
  metric('supops_synthetic_up', 'gauge', 'Synthetic checks: 1 when the last run worked.', checks.filter((c) => c.status).map((c) => [{ check: c.name }, c.status === 'down' ? 0 : 1]));
  const objectives = db.select({ name: slos.name, status: slos.status }).from(slos).where(eq(slos.enabled, true)).all();
  metric('supops_slo_budget_remaining', 'gauge', 'Share of each SLO error budget left (negative when overspent).', objectives.filter((s) => s.status?.budgetRemaining != null).map((s) => [{ slo: s.name }, s.status!.budgetRemaining!]));
  metric('supops_slo_burning', 'gauge', 'Burn-rate rules firing per SLO.', objectives.map((s) => [{ slo: s.name }, s.status?.firing.length ?? 0]));

  const newest = listBackups()[0];
  metric('supops_backup_last_timestamp_seconds', 'gauge', 'When the newest database backup was made.', newest ? [[{}, Math.round(newest.at / 1000)]] : []);
  metric('supops_backup_last_failed', 'gauge', '1 when the last scheduled backup failed.', [[{}, backupScheduler.last && !backupScheduler.last.ok ? 1 : 0]]);

  const mem = process.memoryUsage();
  metric('process_resident_memory_bytes', 'gauge', 'Resident memory.', [[{}, mem.rss]]);
  metric('nodejs_heap_used_bytes', 'gauge', 'V8 heap in use.', [[{}, mem.heapUsed]]);
  metric('process_uptime_seconds', 'gauge', 'Seconds since SupOps started.', [[{}, Math.round(process.uptime())]]);
  return `${out.join('\n')}\n`;
}
