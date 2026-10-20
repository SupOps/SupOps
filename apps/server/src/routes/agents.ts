import { Router } from 'express';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { DEFAULT_RUN_BUDGET, agents, projects, runs } from '@supops/db';
import type { RiskPolicy } from '@supops/db';
import { RISK_TIERS } from '@supops/shared';
import { buildSystemPrompt, mergePolicy, validateAgentOverride } from '@supops/core';
import { db, registry } from '../context.ts';
import { isAdmin } from '../auth.ts';
import { audit } from '../services/audit.ts';
import { BUILTIN_AGENTS } from '../services/builtin-agents.ts';
import { HEALTH_AGENT_SPECS } from '../services/health.ts';

export const agentRoutes = Router();

/** Health agents are kept in sync from their spec on every scan: only model and enabled are editable. */
const HEALTH_SLUGS = new Set(Object.values(HEALTH_AGENT_SPECS).map((s) => s.slug));
const RESETTABLE = new Map<string, (typeof BUILTIN_AGENTS)[number]>(BUILTIN_AGENTS.map((a) => [a.slug, a]));
const isBuiltIn = (slug: string) => RESETTABLE.has(slug) || HEALTH_SLUGS.has(slug);

const forbid = (res: import('express').Response, what: string) =>
  res.status(403).json({ error: `Only owners and admins can ${what}.` });

function decorate(a: typeof agents.$inferSelect) {
  const project = db.select({ riskPolicy: projects.riskPolicy }).from(projects).where(eq(projects.id, a.projectId)).get();
  return {
    ...a,
    builtIn: isBuiltIn(a.slug),
    healthAgent: HEALTH_SLUGS.has(a.slug),
    effectivePolicy: project ? mergePolicy(project.riskPolicy, a.riskPolicyOverride) : null,
  };
}

agentRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const archived = req.query.archived === '1';
  const where = and(
    ...(projectId ? [eq(agents.projectId, projectId)] : []),
    ...(archived ? [] : [isNull(agents.archivedAt)]),
  );
  res.json(db.select().from(agents).where(where).all().map(decorate));
});

/** What an agent is allowed to be given. */
agentRoutes.get('/available-tools', (_req, res) => {
  res.json(
    registry.keys().map((key) => {
      const def = registry.get(key)!;
      return {
        key,
        description: def.description,
        baselineRisk: def.baselineRisk,
        targetKinds: def.targetKinds,
        mutating: def.mutating,
      };
    }),
  );
});

const tier = z.enum(RISK_TIERS);
const budgetSchema = z.object({
  maxIterations: z.number().int().min(1).max(200),
  maxToolCalls: z.number().int().min(1).max(500),
  maxWallClockMs: z.number().int().min(60_000).max(4 * 60 * 60_000),
  maxOutputBytesPerCall: z.number().int().min(1024).max(64 * 1024),
  maxSessionToolCalls: z.number().int().min(10).max(5000).optional(),
  maxOutputTokens: z.number().int().min(512).max(32_768).optional(),
});
const overrideSchema = z
  .object({
    autoExecuteMaxTier: tier.optional(),
    prodAutoExecuteCap: tier.optional(),
    requireSecondPersonAtTier: tier.nullable().optional(),
  })
  .nullable();

const editable = {
  name: z.string().min(1).max(100),
  role: z.string().min(1).max(60),
  description: z.string().max(500).nullable(),
  systemPrompt: z.string().min(1).max(10_000),
  model: z.string().max(100).nullable(),
  /**
   * null means "everything the project has enabled". Prefer an explicit short list:
   * tool-call accuracy degrades noticeably past roughly a dozen tools, and much
   * sooner on small local models.
   */
  toolKeys: z.array(z.string()).nullable(),
  budget: budgetSchema,
  riskPolicyOverride: overrideSchema,
  enabled: z.boolean(),
};

const createBody = z.object({
  projectId: z.string().min(1),
  slug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
  ...editable,
  description: editable.description.optional(),
  model: editable.model.optional(),
  toolKeys: editable.toolKeys.default(null),
  budget: budgetSchema.optional(),
  riskPolicyOverride: overrideSchema.optional(),
  enabled: z.boolean().optional(),
});

/** Checks shared by create and update. Returns an error message or null. */
function checkAgent(projectId: string, body: { toolKeys?: string[] | null; riskPolicyOverride?: Partial<RiskPolicy> | null }): string | null {
  if (body.toolKeys !== undefined) {
    try {
      // MCP tools come from the project's servers and may not be connected yet.
      registry.resolve(body.toolKeys?.filter((k) => !k.startsWith('mcp_')) ?? null);
    } catch (err) {
      return err instanceof Error ? err.message : 'Unknown tool';
    }
  }
  if (body.riskPolicyOverride) {
    const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!project) return 'Project not found';
    return validateAgentOverride(project.riskPolicy, body.riskPolicyOverride);
  }
  return null;
}

agentRoutes.post('/', (req, res) => {
  // An agent's system prompt is a trusted instruction channel: only admins write it.
  if (!isAdmin(req.user)) return forbid(res, 'create agents');
  const parsed = createBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid agent' });
    return;
  }
  const problem = checkAgent(parsed.data.projectId, parsed.data as never);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const taken = db.select({ id: agents.id }).from(agents)
    .where(and(eq(agents.projectId, parsed.data.projectId), eq(agents.slug, parsed.data.slug))).get();
  if (taken) {
    res.status(409).json({ error: `An agent with the slug "${parsed.data.slug}" already exists in this project.` });
    return;
  }

  const row = db
    .insert(agents)
    .values({ ...parsed.data, budget: parsed.data.budget ?? DEFAULT_RUN_BUDGET, createdAt: new Date() } as never)
    .returning()
    .get();
  audit(req.user, { projectId: row.projectId, entity: 'agent', entityId: row.id, action: 'create', after: row });
  res.status(201).json(decorate(row));
});

agentRoutes.patch('/:id', (req, res) => {
  if (!isAdmin(req.user)) return forbid(res, 'edit agents');
  const current = db.select().from(agents).where(eq(agents.id, req.params.id)).get();
  if (!current) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const parsed = z.object(editable).partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid agent' });
    return;
  }
  let patch = parsed.data;
  // Health agents are re-synced from their spec on every scan; editing their prompt
  // or tools here would silently revert, so only the model and on/off are allowed.
  if (HEALTH_SLUGS.has(current.slug)) {
    const extra = Object.keys(patch).filter((k) => k !== 'model' && k !== 'enabled');
    if (extra.length) {
      res.status(400).json({ error: `Health-check agents follow their built-in definition; only the model and enabled can change (not ${extra.join(', ')}).` });
      return;
    }
  }
  const problem = checkAgent(current.projectId, patch as never);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  if (patch.budget) patch = { ...patch, budget: { ...current.budget, ...patch.budget } };
  const row = db.update(agents).set(patch as never).where(eq(agents.id, current.id)).returning().get();
  audit(req.user, { projectId: current.projectId, entity: 'agent', entityId: current.id, action: 'update', before: current, after: row });
  res.json(decorate(row));
});

/** Built-ins cannot be deleted. Others are archived if any run references them (runs keep their history). */
agentRoutes.delete('/:id', (req, res) => {
  if (!isAdmin(req.user)) return forbid(res, 'delete agents');
  const current = db.select().from(agents).where(eq(agents.id, req.params.id)).get();
  if (!current) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  if (isBuiltIn(current.slug)) {
    res.status(409).json({ error: 'Built-in agents cannot be deleted. Disable it instead, or reset it to its default.' });
    return;
  }
  const used = db.select({ n: sql<number>`count(*)` }).from(runs).where(eq(runs.agentId, current.id)).get()?.n ?? 0;
  if (used > 0) {
    db.update(agents).set({ enabled: false, archivedAt: new Date() }).where(eq(agents.id, current.id)).run();
    audit(req.user, { projectId: current.projectId, entity: 'agent', entityId: current.id, action: 'archive', before: current });
    res.json({ ok: true, archived: true });
    return;
  }
  db.delete(agents).where(eq(agents.id, current.id)).run();
  audit(req.user, { projectId: current.projectId, entity: 'agent', entityId: current.id, action: 'delete', before: current });
  res.json({ ok: true, archived: false });
});

agentRoutes.post('/:id/duplicate', (req, res) => {
  if (!isAdmin(req.user)) return forbid(res, 'create agents');
  const current = db.select().from(agents).where(eq(agents.id, req.params.id)).get();
  if (!current) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  let slug = `${current.slug}-copy`;
  for (let i = 2; db.select({ id: agents.id }).from(agents).where(and(eq(agents.projectId, current.projectId), eq(agents.slug, slug))).get(); i += 1) {
    slug = `${current.slug}-copy-${i}`;
  }
  const { id: _id, createdAt: _c, archivedAt: _a, ...rest } = current;
  const row = db.insert(agents).values({ ...rest, slug, name: `${current.name} (copy)`, createdAt: new Date() }).returning().get();
  audit(req.user, { projectId: row.projectId, entity: 'agent', entityId: row.id, action: 'duplicate', after: row });
  res.status(201).json(decorate(row));
});

agentRoutes.post('/:id/reset', (req, res) => {
  if (!isAdmin(req.user)) return forbid(res, 'reset agents');
  const current = db.select().from(agents).where(eq(agents.id, req.params.id)).get();
  const spec = current && RESETTABLE.get(current.slug);
  if (!current || !spec) {
    res.status(404).json({ error: 'Only the built-in triage and console agents can be reset.' });
    return;
  }
  const row = db
    .update(agents)
    .set({ name: spec.name, role: spec.role, systemPrompt: spec.systemPrompt, toolKeys: [...spec.toolKeys], budget: DEFAULT_RUN_BUDGET, riskPolicyOverride: null, model: null })
    .where(eq(agents.id, current.id))
    .returning()
    .get();
  audit(req.user, { projectId: current.projectId, entity: 'agent', entityId: current.id, action: 'reset', before: current, after: row });
  res.json(decorate(row));
});

/** The full system prompt a run with this agent would get, and a rough token count. */
agentRoutes.get('/:id/preview-prompt', (req, res) => {
  const a = db.select().from(agents).where(eq(agents.id, req.params.id)).get();
  const project = a && db.select().from(projects).where(eq(projects.id, a.projectId)).get();
  if (!a || !project) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }
  const prompt = buildSystemPrompt(project.systemPromptExtra, a.systemPrompt);
  res.json({ prompt, tokens: Math.round(prompt.length / 4) });
});
