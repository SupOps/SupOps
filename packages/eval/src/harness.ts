import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET, agents, createDb, projects, runs, setMasterKey, targets, toolCalls } from '@supops/db';
import type { Db, TargetConfig } from '@supops/db';
import type { ChatMessage } from '@supops/shared';
import {
  BUILTIN_TOOL_KEYS,
  Engine,
  RunStore,
  SESSION_TOOL_KEYS,
  TRIAGE_AGENT_PROMPT,
  ToolRegistry,
  bindTools,
  buildOpeningMessage,
  buildSystemPrompt,
  coverageBlock,
  createDefaultRegistry,
  effectiveToolKeys,
  errOutput,
  loadTargets,
  nullSink,
  okOutput,
  renderSkills,
  selectSkills,
} from '@supops/core';
import type { LLMClient, ToolDef } from '@supops/core';
import type { CallRecord, CaseRun, EvalCase } from './types.ts';

/**
 * Run one case through SupOps' real engine: the same system prompt, opening message,
 * tool schemas, risk engine, context handling and step loop a triage run gets. Only
 * the tools' effects are replaced: each call is answered from the case's recordings.
 *
 * The run is unattended, as the automatic diagnosis is: anything that would need
 * approval is refused, so a case measures the diagnosis, never a change.
 *
 * Kept close to services/start-run.ts in the server; when that changes how a run is
 * framed, this should follow.
 */

const MIGRATIONS = join(import.meta.dirname, '../../db/migrations');
/** These answer from the run itself; they are never replayed. */
const REAL = new Set(['read_output', 'update_plan', 'record_finding', 'confirm_target']);

function freshDb(): { db: Db; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'supops-eval-'));
  const { db } = createDb(join(dir, 'eval.db'));
  migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, dir };
}

function configFor(t: EvalCase['targets'][number]): TargetConfig {
  if (t.kind === 'ssh') return { kind: 'ssh', host: `${t.slug}.eval.invalid`, port: 22, user: 'ops', sudo: false } as TargetConfig;
  if (t.kind === 'k8s') return { kind: 'k8s', server: `https://${t.slug}.eval.invalid`, defaultNamespace: 'default', allowedNamespaces: [] } as unknown as TargetConfig;
  return { kind: t.kind, baseUrl: `http://${t.slug}.eval.invalid`, allowPrivateNetwork: false } as unknown as TargetConfig;
}

/** The registry with every system-touching tool answering from recordings. */
function replayRegistry(c: EvalCase, unrecorded: Set<string>): ToolRegistry {
  const real = createDefaultRegistry();
  const out = new ToolRegistry();
  for (const key of real.keys()) {
    const def = real.get(key)!;
    if (REAL.has(key)) {
      out.register(def);
      continue;
    }
    const replay: ToolDef<never> = {
      ...def,
      execute: async (args, ctx) => {
        const rendered = def.render(args, ctx.target);
        const rule = c.replay.find((r) => (!r.tool || r.tool === key) && (!r.target || r.target === ctx.target.slug) && new RegExp(r.match, 'i').test(rendered));
        const shell = def.kind === 'ssh_exec';
        if (!rule) {
          unrecorded.add(ctx.toolCallId);
          return shell ? okOutput('[exit 0]\n(no output)', { exitCode: 0 }) : okOutput('(no data)');
        }
        const code = rule.exitCode ?? 0;
        const text = shell ? `[exit ${code}]\n${rule.output}` : rule.output;
        return code === 0 ? okOutput(text, { exitCode: code }) : errOutput(text, { exitCode: code });
      },
    };
    out.register(replay);
  }
  return out;
}

export interface RunOptions {
  /** Give up on a case after this long (default 10 minutes). */
  timeoutMs?: number;
}

export async function runCase(c: EvalCase, llm: LLMClient, opts: RunOptions = {}): Promise<CaseRun> {
  setMasterKey(randomBytes(32));
  const { db, dir } = freshDb();
  const started = Date.now();
  try {
    const project = db.insert(projects).values({ slug: 'eval', name: 'Eval', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
    for (const t of c.targets) {
      db.insert(targets)
        .values({ projectId: project.id, slug: t.slug, name: t.slug, kind: t.kind, env: t.env ?? 'prod', sensitivity: 1, description: t.description ?? null, tags: [], config: configFor(t), createdAt: new Date() } as never)
        .run();
    }
    const toolKeys = c.tools ?? [...BUILTIN_TOOL_KEYS];
    const maxSteps = c.expect.maxSteps ?? 20;
    const agent = db
      .insert(agents)
      .values({ projectId: project.id, slug: 'triage', name: 'Triage Agent', role: 'triage', systemPrompt: TRIAGE_AGENT_PROMPT, toolKeys, budget: { ...DEFAULT_RUN_BUDGET, maxIterations: maxSteps }, createdAt: new Date() })
      .returning()
      .get();

    const unrecorded = new Set<string>();
    const registry = replayRegistry(c, unrecorded);
    const all = loadTargets(db, project.id);
    // As an unattended run: no confirm_target (nobody to confirm with), the session tools always.
    const defs = [
      ...registry.resolve(effectiveToolKeys(toolKeys)).filter((d) => d.key !== 'confirm_target' && !SESSION_TOOL_KEYS.includes(d.key)),
      ...SESSION_TOOL_KEYS.map((k) => registry.get(k)!),
    ];
    const tools = bindTools(defs, all);
    const summaries = all.map((t) => ({ slug: t.slug, kind: t.kind, env: t.env as 'dev' | 'staging' | 'prod', description: t.description }));
    const incident = c.mode === 'incident';
    // The playbooks a real run would get for the same machines and task.
    const playbooks = renderSkills(selectSkills({ kinds: [...new Set(c.targets.map((t) => t.kind))], task: c.task }));
    const system = buildSystemPrompt(null, TRIAGE_AGENT_PROMPT, playbooks, { incident: incident ? 'diagnose' : false });
    const obs = c.targets.filter((t) => !['ssh', 'k8s'].includes(t.kind));
    const opening = buildOpeningMessage({
      projectName: 'Eval',
      targets: summaries,
      task: c.task,
      autonomy: 'This run is unattended: only read-only actions run, and anything that would need approval is refused.',
      ...(c.evidence ? { evidence: c.evidence } : {}),
      dataSources: coverageBlock({
        sources: obs.map((t) => ({ slug: t.slug, kind: t.kind, problem: null })),
        machines: c.targets.filter((t) => t.kind === 'ssh').length,
        clusters: c.targets.filter((t) => t.kind === 'k8s').length,
        alertSenders: 0,
      }),
    });
    const run = db
      .insert(runs)
      .values({
        projectId: project.id, agentId: agent.id, trigger: incident ? 'alert' : 'chat', title: c.task.slice(0, 120), status: 'queued',
        providerBaseUrl: llm.config.baseUrl, model: llm.config.model, systemSnapshot: system, toolsSnapshot: tools.map((t) => t.spec),
        targetsSnapshot: summaries, policySnapshot: { ...DEFAULT_RISK_POLICY, unattended: true }, startedAt: new Date(),
      })
      .returning()
      .get();
    const store = new RunStore(db);
    store.appendStep(run.id, { role: 'system', content: system });
    store.appendStep(run.id, { role: 'user', content: opening });

    const engine = new Engine({ db, llm, registry, sink: nullSink, workerId: 'eval' });
    const deadline = started + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      await engine.runToCompletion(run.id);
      const now = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
      // A rate-limited provider parks the run; wait as the worker would, then carry on.
      if (now.status !== 'suspended' || Date.now() > deadline) break;
      const wait = Math.max(1_000, Math.min(60_000, (now.resumeAfter?.getTime() ?? Date.now()) - Date.now()));
      await new Promise((r) => setTimeout(r, wait));
    }

    const done = db.select().from(runs).where(eq(runs.id, run.id)).get()!;
    const messages = store.rebuildMessages(run.id) as ChatMessage[];
    const answer = [...messages].reverse().find((m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim())?.content as string | undefined;
    const calls: CallRecord[] = db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.runId, run.id))
      .all()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.callIndex - b.callIndex)
      .map((r) => ({
        tool: r.toolKey,
        target: typeof r.argsJson.target === 'string' ? r.argsJson.target : null,
        rendered: r.renderedCommand ?? `${r.toolKey} ${JSON.stringify(r.argsJson)}`,
        state: r.state,
        unrecorded: unrecorded.has(r.toolCallId),
      }));
    return {
      caseId: c.id,
      model: llm.config.model,
      status: done.status === 'succeeded' ? 'succeeded' : `${done.status}${done.statusReason ? `: ${done.statusReason}` : ''}`,
      answer: answer ?? '',
      calls,
      steps: done.iteration,
      promptTokens: done.promptTokens,
      completionTokens: done.completionTokens,
      ms: Date.now() - started,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
