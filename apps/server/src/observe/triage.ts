import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { agents, alerts, evidence, incidents, observations, runSteps, runs } from '@supops/db';
import { isTerminalRun, OPEN_ALERT_STATUSES } from '@supops/shared';
import type { ChatMessage } from '@supops/shared';
import { changesBlock, checkCitations, loadTargets, parseAction, parseBlastRadius, parseHypotheses, parseVerdict, restatesSymptom, runChecks, scopeFromLabels, SEVERITY_RANK, withJumps, withMachinesBehind } from '@supops/core';
import type { EvidenceItem } from '@supops/core';
import { db, settingsStore } from '../context.ts';
import { startRun } from '../services/start-run.ts';
import { suspectsFor } from '../changes/store.ts';
import { incidentServices } from '../changes/incident.ts';
import { newErrorsBlock } from '../errors/collector.ts';
import { projectConnections } from './connections.ts';
import { incidentMapBlock } from '../servicemap/context.ts';

/**
 * What happens when an incident opens: gather the evidence pack (fixed read-only
 * checks, no model), then -- if automatic triage is on and within its limits --
 * start an unattended investigation that begins from that evidence. Unattended runs
 * refuse anything that would need approval, so the investigation can only read; its
 * report proposes the fix and a person starts it.
 */

type IncidentRow = typeof incidents.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;

const queue: string[] = [];
let draining = false;

/** Incidents waiting for related alerts before they are diagnosed. */
const gathering = new Set<string>();

export function enqueueTriage(incidentId: string): void {
  if (!queue.includes(incidentId)) queue.push(incidentId);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await triage(id);
      } catch (err) {
        console.error(`triage of incident ${id} failed:`, err);
        db.update(incidents).set({ triageState: 'failed', triageNote: err instanceof Error ? err.message : String(err) }).where(eq(incidents.id, id)).run();
      }
    }
  } finally {
    draining = false;
  }
}

/** Monitoring problems: run the stack checks as well. */
const STACKISH = /prometheus|alertmanager|scrape|targetdown|watchdog|deadmansswitch|rule.?eval|notification|loki|grafana|tsdb/i;

export async function gatherEvidence(inc: IncidentRow): Promise<Array<typeof evidence.$inferSelect>> {
  const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).all();
  const obs = db.select().from(observations).where(eq(observations.incidentId, inc.id)).all();
  const labelSets = [...members.map((a) => a.labels ?? {}), ...obs.map((o) => o.labels ?? {})];
  const scope = scopeFromLabels(labelSets, members.map((a) => a.title));
  const conns = projectConnections(inc.projectId);
  if (!conns.length) return [];

  const stack = members.some((a) => STACKISH.test(a.title)) || STACKISH.test(inc.title);
  const items: EvidenceItem[] = await runChecks(conns, scope, { signal: AbortSignal.timeout(90_000) });
  if (stack) {
    const extra = await runChecks(conns, scope, { stack: true, signal: AbortSignal.timeout(60_000) });
    for (const e of extra) if (!items.some((i) => i.check === e.check && i.connectionId === e.connectionId)) items.push(e);
  }

  db.delete(evidence).where(eq(evidence.incidentId, inc.id)).run();
  let n = 0;
  const rows = items.map((it) => ({
    incidentId: inc.id,
    ref: it.status === 'unavailable' ? '-' : `E${++n}`,
    check: it.check,
    title: it.title,
    connectionId: it.connectionId,
    query: it.query ?? null,
    status: it.status,
    summary: `${it.summary}`.slice(0, 4000),
    data: (it.data ?? null) as unknown,
  }));
  if (rows.length) db.insert(evidence).values(rows).run();
  return db.select().from(evidence).where(eq(evidence.incidentId, inc.id)).all();
}

const when = (d: Date | null | undefined) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '?');
const labelText = (l: Record<string, string>) =>
  `{${Object.entries(l).filter(([k]) => !k.startsWith('_') && k !== 'alertname').slice(0, 8).map(([k, v]) => `${k}="${v}"`).join(', ')}}`;

/** The incident and its evidence, for the investigation's first message. */
export function evidenceBlock(inc: IncidentRow, members: AlertRow[], ev: Array<typeof evidence.$inferSelect>): string {
  const slugOf = new Map(loadTargets(db, inc.projectId).map((t) => [t.id, t.slug]));
  const obs = db.select().from(observations).where(eq(observations.incidentId, inc.id)).all();
  const lines: string[] = [
    `INCIDENT: ${inc.title}`,
    `Severity ${inc.severity} · opened ${when(inc.openedAt)}${members.length ? ` · ${members.length} alert${members.length > 1 ? 's' : ''}` : ''}${inc.origin === 'prediction' ? ' · raised by a forecast, nothing has failed yet' : inc.origin === 'threshold' ? ' · over the limit set for this signal; decide whether that is a real problem' : ''}`,
  ];
  if (members.length) {
    lines.push('Alerts:');
    for (const a of members.slice(0, 15)) {
      lines.push(`- ${a.title} ${labelText(a.labels ?? {})} (${a.severity}, ${a.status}) since ${when(a.startsAt ?? a.receivedAt)}${a.summary ? ` -- ${a.summary.slice(0, 200)}` : ''}`);
    }
    if (members.length > 15) lines.push(`- ... ${members.length - 15} more`);
  }
  for (const o of obs) lines.push(`Forecast: ${o.message}`);
  if (inc.groupReason) lines.push(`Grouped because: ${inc.groupReason}`);
  const targets = (inc.targetIds ?? []).map((id) => slugOf.get(id)).filter(Boolean);
  if (targets.length) lines.push(`Matched to: ${targets.join(', ')}`);

  const cited = ev.filter((e) => e.ref !== '-');
  const missing = ev.filter((e) => e.ref === '-');
  if (cited.length) {
    lines.push('', 'EVIDENCE PACK (read-only checks run when the incident opened; cite as [E1], [E2]...):');
    for (const e of cited) {
      const conn = e.connectionId ? slugOf.get(e.connectionId) : null;
      lines.push(`[${e.ref}] ${e.title}${conn ? ` (${conn})` : ''} -- ${e.status}`);
      for (const l of e.summary.split('\n').slice(0, e.status === 'interesting' ? 10 : 2)) lines.push(`    ${l}`);
    }
  } else {
    lines.push('', 'EVIDENCE PACK: no metrics or logs connection could be checked for this incident.');
  }
  if (missing.length) lines.push(`Not measured here: ${[...new Set(missing.map((e) => e.title))].join(', ')}.`);
  const mapLines = incidentMapBlock(inc.projectId, inc.targetIds ?? [], inc.id, incidentServices(inc, members).services);
  if (mapLines) lines.push('', mapLines);
  return lines.join('\n');
}

export function triageAgentId(projectId: string): string | null {
  const a =
    db.select().from(agents).where(and(eq(agents.projectId, projectId), eq(agents.slug, 'triage'))).get() ??
    db.select().from(agents).where(eq(agents.projectId, projectId)).get();
  return a?.id ?? null;
}

/** The scope of an incident run: its machines, with their jumps and the machines behind them. */
function incidentTargetIds(inc: IncidentRow): string[] | undefined {
  const all = loadTargets(db, inc.projectId);
  const matched = all.filter((t) => (inc.targetIds ?? []).includes(t.id));
  if (!matched.length) return undefined;
  return withJumps(withMachinesBehind(matched, all), all).map((t) => t.id);
}

/**
 * Start a run on an incident.
 *
 * `diagnose` is the automatic, unattended one: read-only by construction (anything
 * needing approval is refused), started as soon as the incident opens. `fix` is what
 * a person starts with Investigate: it begins from that diagnosis instead of
 * repeating it, and proposes the changes, each of which waits for approval.
 */
export function startIncidentRun(
  inc: IncidentRow,
  opts: { mode: 'diagnose' | 'fix'; startedBy: string | null },
): { ok: true; runId: string } | { ok: false; error: string; code: number } {
  const agentId = triageAgentId(inc.projectId);
  if (!agentId) return { ok: false, error: 'This project has no agent to run the investigation.', code: 409 };
  const members = db.select().from(alerts).where(eq(alerts.incidentId, inc.id)).orderBy(asc(alerts.receivedAt)).all();
  const ev = db.select().from(evidence).where(eq(evidence.incidentId, inc.id)).orderBy(asc(evidence.ref)).all();
  ev.sort((a, b) => (a.ref === '-' ? 1 : b.ref === '-' ? -1 : Number(a.ref.slice(1)) - Number(b.ref.slice(1))));
  const diagnose = opts.mode === 'diagnose';

  let block = evidenceBlock(inc, members, ev);
  // What changed just before: the first suspects (deploys, config, SupOps' own actions).
  const scope = incidentServices(inc, members);
  const recent = changesBlock(suspectsFor(inc.projectId, scope));
  if (recent) block += `\n\n${recent}`;
  // New kinds of error around when it began: often the first symptom of the cause.
  const errors = newErrorsBlock(inc.projectId, scope.services, scope.startedAt);
  if (errors) block += `\n\n${errors}`;
  // The fix starts where the read-only diagnosis ended.
  const prior = !diagnose && inc.runId ? finalAnswer(inc.runId) : null;
  if (prior) block += `\n\nREAD-ONLY DIAGNOSIS ALREADY DONE (by SupOps, automatically, when the incident opened):\n${prior.trim()}`;

  const task = diagnose
    ? inc.origin === 'threshold'
      ? `Check this: ${inc.title}. Is it a real problem (and getting worse), or a stable value that only crossed the line set for it?`
      : inc.origin === 'prediction'
      ? `Investigate this predicted problem before it happens: ${inc.title}. Find why it is heading there and what to do.`
      : `Investigate incident: ${inc.title} (${inc.severity}). Find the root cause.`
    : prior
      ? `Fix incident: ${inc.title}. The read-only diagnosis above is done; confirm it if needed and carry out the fix.`
      : `Investigate and fix incident: ${inc.title} (${inc.severity}).`;

  const result = startRun({
    projectId: inc.projectId,
    agentId,
    task,
    targetIds: incidentTargetIds(inc),
    trigger: 'alert',
    triggerPayload: { incidentId: inc.id, auto: diagnose, phase: opts.mode },
    startedBy: opts.startedBy,
    unattended: diagnose,
    incident: { evidence: block, mode: opts.mode, alerts: members.map((a) => ({ title: a.title, severity: a.severity, source: a.source, labels: a.labels })) },
  });
  if (!result.ok) return { ok: false, error: result.error, code: result.code };

  if (diagnose) {
    // The alerts stay New: the diagnosis is automatic, the decision is still a person's.
    db.update(incidents).set({ runId: result.run.id, triageState: 'running', triageNote: null }).where(eq(incidents.id, inc.id)).run();
  } else {
    db.update(alerts)
      .set({ status: 'investigating', runId: result.run.id, decidedAt: new Date(), decidedBy: opts.startedBy })
      .where(and(eq(alerts.incidentId, inc.id), inArray(alerts.status, ['new', 'investigating'])))
      .run();
  }
  return { ok: true, runId: result.run.id };
}

/** The latest fix run a person started on an incident, if any. */
export function latestFixRun(incidentId: string): { id: string; status: string; startedAt: Date } | null {
  return (
    db
      .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt })
      .from(runs)
      .where(and(sql`json_extract(${runs.triggerPayload}, '$.incidentId') = ${incidentId}`, sql`json_extract(${runs.triggerPayload}, '$.phase') = 'fix'`))
      .orderBy(desc(runs.startedAt))
      .get() ?? null
  );
}

const sevRank = (s: string) => SEVERITY_RANK[s === 'unknown' ? 'warning' : s] ?? 0;

/** How a diagnosis held for a flapping alert is marked, so settling knows to start it. */
export const FLAPPING_NOTE = 'Flapping: firing and resolving over and over. Diagnosed once it settles.';

/** Is any open alert of this incident flapping? Its diagnosis waits until it settles. */
export function incidentIsFlapping(incidentId: string): boolean {
  return !!db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.incidentId, incidentId), eq(alerts.flapping, true), inArray(alerts.status, [...OPEN_ALERT_STATUSES])))
    .get();
}

async function triage(incidentId: string): Promise<void> {
  let inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc || inc.status !== 'open') return;
  // Waiting for its rule's threshold: diagnosed once enough alerts join.
  if (inc.held) return;
  // Diagnosed already (e.g. reopened after an ignore): the diagnosis stands.
  if (inc.runId && inc.triageState === 'done') return;
  // A test alert sent from SupOps: nothing to check or diagnose.
  const members = db.select({ labels: alerts.labels }).from(alerts).where(eq(alerts.incidentId, incidentId)).all();
  if (members.length && members.every((m) => m.labels?.supops_test === 'true')) {
    db.update(incidents).set({ triageState: 'skipped', triageNote: 'A test alert sent from SupOps: nothing to diagnose.' }).where(eq(incidents.id, incidentId)).run();
    return;
  }
  if (incidentIsFlapping(incidentId)) {
    db.update(incidents).set({ triageState: 'skipped', triageNote: FLAPPING_NOTE }).where(eq(incidents.id, incidentId)).run();
    return;
  }
  // Problems rarely arrive as one alert: wait a few minutes after the incident opens so
  // related alerts join it, and diagnose the whole picture once.
  const gatherMs = settingsStore.observability().triageGatherSeconds * 1000;
  const waited = Date.now() - inc.openedAt.getTime();
  if (inc.origin === 'alerts' && !inc.runId && waited < gatherMs) {
    if (!gathering.has(incidentId)) {
      gathering.add(incidentId);
      setTimeout(() => { gathering.delete(incidentId); enqueueTriage(incidentId); }, gatherMs - waited).unref();
    }
    return;
  }
  db.update(incidents).set({ triageState: 'evidence' }).where(eq(incidents.id, inc.id)).run();
  await gatherEvidence(inc);
  inc = db.select().from(incidents).where(eq(incidents.id, incidentId)).get()!;

  const cfg = settingsStore.observability();
  const skip = (note: string) => db.update(incidents).set({ triageState: 'skipped', triageNote: note }).where(eq(incidents.id, incidentId)).run();
  if (inc.runId) return void db.update(incidents).set({ triageState: 'running' }).where(eq(incidents.id, incidentId)).run();
  if (!cfg.autoTriage) return void skip('Automatic diagnosis is off. Investigate starts one.');
  if (sevRank(inc.severity) < sevRank(cfg.triageMinSeverity)) return void skip(`Below the ${cfg.triageMinSeverity} severity investigated automatically.`);
  const lastHour = db
    .select({ n: sql<number>`count(*)` })
    .from(runs)
    .where(and(gt(runs.startedAt, new Date(Date.now() - 3_600_000)), sql`json_extract(${runs.triggerPayload}, '$.auto') = 1`))
    .get()?.n ?? 0;
  if (lastHour >= cfg.triageMaxPerHour) return void skip(`${lastHour} automatic diagnoses already ran in the last hour (limit ${cfg.triageMaxPerHour}). Investigate starts one.`);

  const r = startIncidentRun(inc, { mode: 'diagnose', startedBy: null });
  if (!r.ok) skip(r.error);
}

/** The run's last answer. */
function finalAnswer(runId: string): string | null {
  const steps = db.select({ m: runSteps.messageJson }).from(runSteps).where(eq(runSteps.runId, runId)).orderBy(desc(runSteps.seq)).limit(20).all();
  for (const s of steps) {
    const m = s.m as ChatMessage;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

/**
 * Harvest finished investigations: the root cause and confidence from the report,
 * and a note when it cites evidence that does not exist.
 */
export function reconcileTriage(): void {
  const active = db.select().from(incidents).where(and(eq(incidents.triageState, 'running'))).all();
  for (const inc of active) {
    if (!inc.runId) continue;
    const run = db.select({ status: runs.status }).from(runs).where(eq(runs.id, inc.runId)).get();
    if (!run) {
      db.update(incidents).set({ triageState: 'none' }).where(eq(incidents.id, inc.id)).run();
      continue;
    }
    if (!isTerminalRun(run.status) && run.status !== 'awaiting_input') continue;
    const text = finalAnswer(inc.runId) ?? '';
    const verdict = parseVerdict(text);
    const refs = db.select({ ref: evidence.ref }).from(evidence).where(eq(evidence.incidentId, inc.id)).all().map((e) => e.ref);
    const cites = checkCitations(text, refs);
    const notes: string[] = [];
    if (run.status !== 'succeeded' && run.status !== 'awaiting_input') notes.push(`The investigation ended: ${run.status}.`);
    if (cites.unknown.length) notes.push(`Cites evidence that does not exist: ${cites.unknown.join(', ')} -- treat those claims as unverified.`);
    if (!verdict.rootCause && text) notes.push('The report did not state a root cause.');
    // A symptom is never the root cause: one that only restates what fired is kept,
    // marked, and its confidence capped, so it is not read as an explanation.
    let confidence = verdict.confidence;
    if (verdict.rootCause) {
      const titles = db.select({ title: alerts.title }).from(alerts).where(eq(alerts.incidentId, inc.id)).all().map((a) => a.title);
      if (restatesSymptom(verdict.rootCause, [inc.title, ...titles])) {
        notes.push('The root cause only restates what fired (a symptom); it does not say what made it happen. Treat it as unexplained.');
        if (confidence === 'high' || confidence === 'medium') confidence = 'low';
      }
    }
    const hypotheses = parseHypotheses(text);
    db.update(incidents)
      .set({
        triageState: 'done',
        rootCause: verdict.rootCause,
        confidence,
        hypotheses: hypotheses.length ? hypotheses : null,
        blastRadius: parseBlastRadius(text),
        action: parseAction(text),
        triageNote: notes.join(' ') || null,
      })
      .where(eq(incidents.id, inc.id))
      .run();
  }
}

/** Incidents opened while the server was down, or whose triage never started. */
export function resumeTriage(): void {
  const stuck = db
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.status, 'open'), inArray(incidents.triageState, ['none', 'evidence'])))
    .all();
  for (const s of stuck) enqueueTriage(s.id);
}
