import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { runSteps, runs, toolCalls } from '@supops/db';
import type { ChatMessage } from '@supops/shared';
import { ScriptedLLM, SpyTool, freshDb, makeEngine, seedRun, toolCall } from './harness.test-util.ts';

/**
 * A model that returns a turn with no action AND no answer has stalled, not finished.
 * The engine should nudge it to continue (bounded) instead of silently ending a run
 * whose plan is unfinished, and if it still gives nothing, say so rather than present a
 * clean "succeeded".
 */

const SPEC = [{
  type: 'function' as const,
  function: { name: 'shell', description: 'test shell', parameters: { type: 'object' as const, properties: { target: { type: 'string' as const, enum: ['web-1'] }, command: { type: 'string' as const } }, required: ['target', 'command'] } },
}];

/** The stall nudges actually stored in the run (not the cumulative message snapshots). */
const nudgeCount = (db: ReturnType<typeof freshDb>, runId: string) =>
  db.select().from(runSteps).where(eq(runSteps.runId, runId)).all()
    .filter((s) => s.origin === 'engine' && typeof (s.messageJson as ChatMessage).content === 'string' && ((s.messageJson as ChatMessage).content as string).startsWith('[SupOps] Before you conclude')).length;

function run(script: ConstructorParameters<typeof ScriptedLLM>[0]) {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM(script);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  return { db, spy, llm, engine, runId };
}
const theRun = (db: ReturnType<typeof freshDb>, runId: string) => db.select().from(runs).where(eq(runs.id, runId)).get()!;

test('an empty turn is nudged to continue, and the run finishes cleanly once it answers', async () => {
  const { db, spy, engine, runId } = run([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant', content: '' }, // stalled: no action, no answer
    { role: 'assistant', content: 'Disk is at 41%. All healthy.' },
  ]);
  await engine.runToCompletion(runId);
  assert.deepEqual(spy.executions, ['df -h']);
  assert.equal(nudgeCount(db, runId), 1, 'the empty turn was nudged once');
  const r = theRun(db, runId);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.statusReason, null, 'it ended with a real answer, so no "ended without an answer" reason');
});

test('a run that stays empty concludes as succeeded but flagged "ended without a final answer"', async () => {
  const { db, engine, runId } = run([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '' },
    { role: 'assistant', content: '' },
  ]);
  await engine.runToCompletion(runId);
  assert.equal(nudgeCount(db, runId), 2, 'nudged twice, then gave up rather than looping');
  const r = theRun(db, runId);
  assert.equal(r.status, 'succeeded');
  assert.match(r.statusReason ?? '', /ended without a final answer/);
});

test('a normal final answer is untouched: no nudge, no reason', async () => {
  const { db, engine, runId } = run([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant', content: 'Disk is at 41%. Nothing wrong.' },
  ]);
  await engine.runToCompletion(runId);
  assert.equal(nudgeCount(db, runId), 0);
  const r = theRun(db, runId);
  assert.equal(r.status, 'succeeded');
  assert.equal(r.statusReason, null);
});

test('a final answer with a plan step still open is nudged to finish or mark it, then flagged', async () => {
  const { db, engine, runId } = run([
    { role: 'assistant', content: 'Here is a partial summary.' },
    { role: 'assistant', content: 'Still summarising.' },
    { role: 'assistant', content: 'Final summary.' },
  ]);
  // Seed a plan whose last step is still "doing". Take a seq from the run's own
  // counter so it never collides with the steps the engine appends.
  const seq = db.update(runs).set({ nextSeq: sql`${runs.nextSeq} + 1` }).where(eq(runs.id, runId)).returning({ next: runs.nextSeq }).get()!.next - 1;
  const step = db.insert(runSteps).values({ runId, seq, messageJson: { role: 'assistant', content: '' }, state: 'committed' }).returning().get();
  db.insert(toolCalls).values({ runId, stepId: step.id, toolCallId: 'plan0', callIndex: 0, toolKey: 'update_plan', argsJson: { steps: [{ step: 'Check pods', status: 'done' }, { step: 'Summarise findings', status: 'doing' }] }, argsHash: 'h', state: 'succeeded' } as never).run();
  await engine.runToCompletion(runId);
  assert.equal(nudgeCount(db, runId), 2, 'nudged to finish the open plan step, bounded');
  const r = theRun(db, runId);
  assert.equal(r.status, 'succeeded');
  assert.match(r.statusReason ?? '', /plan step .* still marked unfinished|still marked unfinished/);
});
