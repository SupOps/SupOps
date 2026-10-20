import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { DEFAULT_RISK_POLICY, runs, toolCalls } from '@supops/db';
import type { ChatMessage } from '@supops/shared';
import { RunStore } from './store.ts';
import { STUCK_MARK, VERIFY_MARK, preflightWarning, stuckNote, verifyNote } from './self-check.ts';
import type { ToolCallRow } from './store.ts';
import { ScriptedLLM, SpyTool, freshDb, makeEngine, seedRun, toolCall } from './harness.test-util.ts';

const SPEC = [{
  type: 'function' as const,
  function: {
    name: 'shell',
    description: 'test shell',
    parameters: { type: 'object' as const, properties: { target: { type: 'string' as const, enum: ['web-1'] }, command: { type: 'string' as const } }, required: ['target', 'command'] },
  },
}];

let n = 0;
const call = (o: Partial<ToolCallRow>): ToolCallRow => ({ id: `id${++n}`, toolKey: 'shell', state: 'succeeded', tier: 'read_only', signature: null, argsHash: `h${n}`, targetId: 't1', renderedCommand: null, ...o }) as ToolCallRow;

test('verify: a change nobody looked at since must be checked before concluding, once', () => {
  const change = call({ tier: 'medium', renderedCommand: 'systemctl restart nginx' });
  assert.match(verifyNote([call({}), change], [])!, /systemctl restart nginx/);
  assert.equal(verifyNote([change, call({})], []), null, 'checked after the change');
  assert.equal(verifyNote([change, call({ toolKey: 'update_plan' })], []) === null, false, 'updating the plan is not a check');
  assert.equal(verifyNote([change], [`${VERIFY_MARK}. earlier`]), null, 'only once a turn');
  assert.equal(verifyNote([call({ tier: 'medium', state: 'denied' })], []), null, 'nothing changed');
});

test('stuck: the same action three times, or four failures in a row; once per pattern', () => {
  const same = [1, 2, 3].map(() => call({ signature: 'v1|shell|df -h' }));
  const note = stuckNote(same, [])!;
  assert.match(note, /same action three times/);
  assert.equal(stuckNote(same, [note]), null, 'not twice for the same calls');
  const fails = ['failed', 'blocked', 'failed', 'denied'].map((state) => call({ state: state as never, signature: `s${n}` }));
  assert.match(stuckNote(fails, [])!, /last four actions did not succeed \(failed, blocked, denied\)/);
  assert.equal(stuckNote(fails.slice(1), []), null, 'three failures are not yet a pattern');
  assert.ok(stuckNote(same, [])!.startsWith(STUCK_MARK));
});

test('pre-flight: an approver hears when a change comes before anything on that machine was read', () => {
  assert.match(preflightWarning([], 't1', 'web-1')!, /Nothing on web-1 was checked/);
  assert.equal(preflightWarning([call({ targetId: 't1' })], 't1', 'web-1'), null);
  assert.match(preflightWarning([call({ targetId: 't2' })], 't1', 'web-1')!, /web-1/, 'a read elsewhere does not count');
});

function scenario(script: ConstructorParameters<typeof ScriptedLLM>[0], autoMedium = false) {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM(script);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  if (autoMedium) db.update(runs).set({ policySnapshot: { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' } }).where(eq(runs.id, runId)).run();
  new RunStore(db).appendStep(runId, { role: 'user', content: 'nginx is down on web-1' });
  return { db, spy, llm, engine, runId };
}
const notes = (msgs: ChatMessage[]) => msgs.filter((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[SupOps] Self-check')).map((m) => m.content as string);

test('in a real run: the agent restarts nginx, tries to conclude, and is asked to verify first', async () => {
  const { db, spy, llm, engine, runId } = scenario([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'Restarted nginx, it is fixed.' },
    { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'shell', { target: 'web-1', command: 'systemctl status nginx' })] },
    { role: 'assistant', content: 'nginx is active (running) after the restart.' },
  ], true);
  await engine.runToCompletion(runId);
  assert.deepEqual(spy.executions, ['systemctl restart nginx', 'systemctl status nginx']);
  assert.equal(notes(llm.calls[2]!).length, 1, 'the third model call saw the verify note');
  assert.match(notes(llm.calls[2]!)[0]!, /changed something/);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
  // The pre-flight warning is for approvers; this change ran on its own, so it has none.
  assert.equal(db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get()?.riskJson?.preflight, undefined);
});

test('in a real run: the same check three times gets a note before the next model call', async () => {
  const df = (id: string) => ({ role: 'assistant' as const, content: null, tool_calls: [toolCall(id, 'shell', { target: 'web-1', command: 'df -h' })] });
  const { llm, engine, runId } = scenario([df('d1'), df('d2'), df('d3'), { role: 'assistant', content: 'Disk is fine.' }]);
  await engine.runToCompletion(runId);
  assert.equal(notes(llm.calls[2]!).length, 0);
  assert.match(notes(llm.calls[3]!)[0] ?? '', /same action three times/);
});

test('in a real run: a change waiting for approval says nothing was checked first', async () => {
  const { db, engine, runId } = scenario([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
  ]);
  await engine.runToCompletion(runId);
  const c = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get()!;
  assert.equal(c.state, 'awaiting_approval');
  assert.match(c.riskJson?.preflight ?? '', /Nothing on web-1 was checked/);
});
