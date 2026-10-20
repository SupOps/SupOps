import { and, eq } from 'drizzle-orm';
import { DEFAULT_RUN_BUDGET, agents, projects } from '@supops/db';
import { BUILTIN_TOOL_KEYS, CONSOLE_TOOL_KEYS, TRIAGE_AGENT_PROMPT } from '@supops/core';
import { db } from '../context.ts';
import { HEALTH_AGENT_SPECS, ensureScanAgent } from './health.ts';

/**
 * The agents every project ships with. One definition, used when seeding, when a
 * project is created, and (later) when an admin resets an agent to its default --
 * it used to be copied in two places, which is how copies drift.
 *
 * The health-check agents are defined in HEALTH_AGENT_SPECS (services/health.ts),
 * next to the scan that uses them, and created here with the rest so they show on
 * the Agents page before the first scan.
 */
export const BUILTIN_AGENTS = [
  {
    slug: 'triage',
    name: 'Triage Agent',
    role: 'triage',
    toolKeys: BUILTIN_TOOL_KEYS,
    systemPrompt: TRIAGE_AGENT_PROMPT,
  },
  {
    slug: 'console',
    name: 'Console Assistant',
    role: 'assistant',
    toolKeys: CONSOLE_TOOL_KEYS,
    systemPrompt:
      'You are an operations assistant working alongside an engineer. Unlike an ' +
      'incident triage run, most of what you are asked is ordinary work: check ' +
      'something, make something, or explain something.\n\n' +
      'If a question can be answered without touching a machine, just answer it -- do ' +
      'not invent a command to look busy. If it needs a machine, run the narrowest ' +
      'command that answers it and say what you found in plain language.\n\n' +
      'Keep replies short. The engineer can see every command and its output beside ' +
      'this conversation, so do not repeat output back at them -- interpret it. Ask a ' +
      'clarifying question when the request is ambiguous rather than guessing at ' +
      'something destructive.',
  },
] as const;

/**
 * Create any built-in agent the project is missing. Per agent, not "only if the
 * project has none", so a newly introduced built-in reaches existing installs.
 * Returns the slugs it created.
 */
export function ensureBuiltinAgents(projectId: string): string[] {
  const created: string[] = [];
  for (const a of BUILTIN_AGENTS) {
    const exists = db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.projectId, projectId), eq(agents.slug, a.slug)))
      .get();
    if (exists) continue;
    db.insert(agents)
      .values({ projectId, ...a, toolKeys: [...a.toolKeys], budget: DEFAULT_RUN_BUDGET, createdAt: new Date() })
      .run();
    created.push(a.slug);
  }
  // The health agents: created if missing, and their prompts kept in sync with the spec.
  for (const type of ['quick', 'deep'] as const) {
    const { slug } = HEALTH_AGENT_SPECS[type];
    const existed = !!db.select({ id: agents.id }).from(agents).where(and(eq(agents.projectId, projectId), eq(agents.slug, slug))).get();
    ensureScanAgent(projectId, type);
    if (!existed) created.push(slug);
  }
  return created;
}

/** Every project gets its missing built-in agents (e.g. after an upgrade adds one). */
export function ensureBuiltinAgentsEverywhere(): void {
  for (const p of db.select({ id: projects.id }).from(projects).all()) {
    const created = ensureBuiltinAgents(p.id);
    if (created.length) console.log(`  agents: added ${created.join(', ')} to project ${p.id}`);
  }
}
