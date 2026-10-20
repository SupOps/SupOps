import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { z } from 'zod';
import type { AssistantMessage, ChatMessage, ToolSpec } from '@supops/shared';
import {
  DEFAULT_RISK_POLICY,
  DEFAULT_RUN_BUDGET,
  agents,
  createDb,
  projects,
  runs,
  setMasterKey,
  targets,
} from '@supops/db';
import type { Db } from '@supops/db';
import type { LLMClient, CompletionResult } from '../llm/client.ts';
import { ToolRegistry } from '../tools/registry.ts';
import type { ToolDef } from '../tools/types.ts';
import { okOutput } from '../tools/output.ts';
import { Engine } from './runner.ts';
import type { EngineOptions } from './runner.ts';
import { nullSink } from './events.ts';

setMasterKey(Buffer.alloc(32, 7));

const MIGRATIONS = join(import.meta.dirname, '../../../db/migrations');

export function freshDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'supops-test-'));
  const { db } = createDb(join(dir, 'test.db'));
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

/**
 * A scripted model. Each entry is one assistant turn, returned in order, so a test
 * describes the exact sequence of decisions it wants to exercise rather than hoping
 * a real model produces it.
 */
export class ScriptedLLM {
  calls: ChatMessage[][] = [];
  /** Mirrors LLMClient.config; the runner reads it to detect a provider change. */
  readonly config = { baseUrl: 'http://test', apiKey: 'test', model: 'test-model' };
  private script: AssistantMessage[];
  private i = 0;

  constructor(script: AssistantMessage[]) {
    this.script = script;
  }

  async complete(messages: ChatMessage[], _tools: ToolSpec[]): Promise<CompletionResult> {
    // Record what the engine actually sent, so tests can assert on the rebuilt
    // conversation -- which is the thing most likely to be subtly wrong.
    this.calls.push(structuredClone(messages));
    const scripted = this.script[this.i++];
    if (!scripted) throw new Error('ScriptedLLM ran out of scripted turns');
    // A scripted turn may carry `__finishReason` to simulate e.g. an output-limit cut-off.
    const { __finishReason, ...message } = scripted as AssistantMessage & { __finishReason?: string };
    return {
      message,
      finishReason: __finishReason ?? (message.tool_calls?.length ? 'tool_calls' : 'stop'),
      promptTokens: 10,
      completionTokens: 5,
      latencyMs: 1,
      model: 'scripted',
    };
  }

  asClient(): LLMClient {
    return this as unknown as LLMClient;
  }
}

export const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});

/** Records every execution so a test can prove a command ran exactly once. */
export class SpyTool {
  executions: string[] = [];

  def(key = 'shell'): ToolDef<never> {
    const schema = z.object({
      target: z.string(),
      command: z.string(),
      intent: z.string().optional(),
      expected_effect: z.string().optional(),
    });
    return {
      key,
      kind: 'ssh_exec',
      description: 'test shell',
      parameters: { command: { type: 'string', description: 'command' } },
      required: ['command'],
      argsSchema: schema,
      baselineRisk: 'read_only',
      targetKinds: ['ssh'],
      mutating: true,
      timeoutMs: 5_000,
      render: (a: { command: string }) => a.command,
      execute: async (a: { command: string }) => {
        this.executions.push(a.command);
        return okOutput(`[exit 0]\nran: ${a.command}`);
      },
    } as unknown as ToolDef<never>;
  }
}

export function seedRun(db: Db, tools: ToolSpec[], task = 'investigate'): string {
  const project = db
    .insert(projects)
    .values({
      slug: 'p', name: 'P', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date(),
    })
    .returning().get();

  db.insert(targets).values({
    projectId: project.id, slug: 'web-1', name: 'web', kind: 'ssh', env: 'staging',
    sensitivity: 1, description: 'app server', tags: [],
    config: { kind: 'ssh', host: '10.0.0.5', port: 22, user: 'ops', sudo: false },
    createdAt: new Date(),
  }).run();

  const agent = db
    .insert(agents)
    .values({
      projectId: project.id, slug: 'a', name: 'A', role: 'triage',
      systemPrompt: 'test agent', toolKeys: tools.map((t) => t.function.name),
      budget: DEFAULT_RUN_BUDGET, createdAt: new Date(),
    })
    .returning().get();

  const run = db
    .insert(runs)
    .values({
      projectId: project.id, agentId: agent.id, trigger: 'chat', title: task,
      status: 'queued', providerBaseUrl: 'http://test', model: 'test-model',
      systemSnapshot: 'test agent', toolsSnapshot: tools,
      targetsSnapshot: [{ slug: 'web-1', kind: 'ssh', env: 'staging', description: 'app server' }],
      policySnapshot: DEFAULT_RISK_POLICY, startedAt: new Date(),
    })
    .returning().get();

  return run.id;
}

export function makeEngine(db: Db, llm: ScriptedLLM, defs: ToolDef<never>[], opts: { simulate?: EngineOptions['simulate'] } = {}): Engine {
  const registry = new ToolRegistry();
  for (const d of defs) registry.register(d);
  return new Engine({
    db, llm: llm.asClient(), registry, sink: nullSink, workerId: 'test-worker', ...(opts.simulate ? { simulate: opts.simulate } : {}),
  });
}
