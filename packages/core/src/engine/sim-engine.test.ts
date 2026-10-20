import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { DEFAULT_RISK_POLICY, runs, toolCalls, users } from '@supops/db';
import type { SimulateInput, SimulationResult } from '../sim/index.ts';
import { ScriptedLLM, SpyTool, freshDb, makeEngine, seedRun, toolCall } from './harness.test-util.ts';

const SPEC = [{
  type: 'function' as const,
  function: {
    name: 'shell',
    description: 'test shell',
    parameters: { type: 'object' as const, properties: { target: { type: 'string' as const, enum: ['web-1'] }, command: { type: 'string' as const } }, required: ['target', 'command'] },
  },
}];

const fakeSim = (r: Partial<SimulationResult>) => async (_i: SimulateInput): Promise<SimulationResult> => ({ status: 'observed', simulator: 'fake', observations: [], contributions: [], ...r });

function run(sim: ReturnType<typeof fakeSim>, command = 'systemctl restart nginx', autoMedium = true) {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command })] },
    { role: 'assistant', content: 'done.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()], { simulate: sim });
  const runId = seedRun(db, SPEC);
  if (autoMedium) db.update(runs).set({ policySnapshot: { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' } }).where(eq(runs.id, runId)).run();
  return { db, spy, engine, runId };
}
const theCall = (db: ReturnType<typeof freshDb>, runId: string) => db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get()!;

test('an observed forbidden effect blocks the action, and it never runs', async () => {
  const sim = fakeSim({
    observations: [{ kind: 'net.connect', detail: 'reads /etc/shadow then connects to 203.0.113.9:443' }],
    contributions: [{ stage: 'observed', tier: 'forbidden', ruleId: 'sim.exfil', reason: 'credential read followed by an outbound connection' }],
  });
  const { db, spy, engine, runId } = run(sim);
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.equal(c.state, 'blocked');
  assert.equal(c.tier, 'forbidden');
  assert.deepEqual(spy.executions, [], 'a command the sandbox condemned must never run');
  assert.equal(c.riskJson?.observed?.status, 'observed');
  assert.equal(c.riskJson?.observed?.items[0]!.kind, 'net.connect');
  assert.ok(c.riskJson?.contributions.some((x) => x.stage === 'observed' && x.tier === 'forbidden'));
});

test('a simulation that raises past the auto ceiling turns an auto change into one that waits', async () => {
  // 'systemctl restart nginx' is medium and would auto-run under this policy; the
  // sandbox sees it would also wipe a data directory, so it must now wait for a person.
  const sim = fakeSim({
    observations: [{ kind: 'file.delete', detail: 'deletes /var/lib/postgresql/data' }],
    contributions: [{ stage: 'observed', tier: 'high', ruleId: 'sim.destroy', reason: 'deletes a data directory' }],
  });
  const { db, spy, engine, runId } = run(sim);
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.equal(c.state, 'awaiting_approval');
  assert.equal(c.tier, 'high');
  assert.deepEqual(spy.executions, []);
});

test('an informational observation fills the panel but never changes the tier', async () => {
  const sim = fakeSim({ observations: [{ kind: 'deps.reverse', detail: '3 units depend on nginx' }], blindSpots: ['systemd itself is not observed'] });
  const { db, engine, runId } = run(sim);
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.equal(c.tier, 'medium', 'unchanged');
  assert.equal(c.riskJson?.observed?.items[0]!.detail, '3 units depend on nginx');
  assert.deepEqual(c.riskJson?.observed?.blindSpots, ['systemd itself is not observed']);
  assert.ok(!c.riskJson?.contributions.some((x) => x.stage === 'observed'), 'no observed contribution added');
});

test('fail closed: a skipped simulation attaches nothing and changes nothing', async () => {
  const { db, engine, runId } = run(fakeSim({ status: 'skipped', simulator: null }));
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.equal(c.tier, 'medium');
  assert.equal(c.riskJson?.observed, undefined);
});

test('a read-only command is never simulated', async () => {
  let called = false;
  const sim = async (_i: SimulateInput): Promise<SimulationResult> => { called = true; return { status: 'skipped', simulator: null, observations: [], contributions: [] }; };
  const { db, engine, runId } = run(sim, 'df -h');
  await engine.runToCompletion(runId);
  assert.equal(called, false, 'df -h is read-only; the simulator is not invoked');
  assert.equal(theCall(db, runId).tier, 'read_only');
});

test('TOCTOU: a stale, human-approved change is re-checked, and a worse result sends it back for approval', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'done.' },
  ]);
  let worse = false;
  const sim = async (_i: SimulateInput): Promise<SimulationResult> => worse
    ? { status: 'observed', simulator: 'fake', observations: [{ kind: 'file.delete', detail: 'now also deletes /var/lib/postgresql/data' }], contributions: [{ stage: 'observed', tier: 'high', ruleId: 'sim.destroy', reason: 'deletes a data directory' }] }
    : { status: 'observed', simulator: 'fake', observations: [{ kind: 'deps.reverse', detail: '3 units depend on nginx' }], contributions: [] };
  const engine = makeEngine(db, llm, [spy.def()], { simulate: sim });
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  let c = theCall(db, runId);
  assert.equal(c.state, 'awaiting_approval');
  assert.equal(c.tier, 'medium');

  // A person approves -- but time passes and the target drifts before it runs.
  worse = true;
  db.insert(users).values({ id: 'u1', email: 'u1@example.test', name: 'Ada', globalRole: 'admin', passwordHash: null }).run();
  db.update(toolCalls).set({ state: 'approved', decidedBy: 'u1', decidedAt: new Date(), riskJson: { ...c.riskJson!, observed: { ...c.riskJson!.observed!, at: Date.now() - 20 * 60_000 } } }).where(eq(toolCalls.id, c.id)).run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  await engine.runToCompletion(runId);

  c = theCall(db, runId);
  assert.equal(c.state, 'awaiting_approval', 're-parked rather than run on the stale approval');
  assert.equal(c.tier, 'high');
  assert.deepEqual(spy.executions, [], 'it must not run on a decision that no longer holds');
  assert.equal(c.decidedBy, null, 'the stale approval was dropped');
  assert.equal(c.riskJson?.observed?.items[0]!.kind, 'file.delete');
});

test('TOCTOU: a fresh approval runs without re-simulating; a stale one that is no worse just runs', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'done.' },
  ]);
  let simCount = 0;
  const sim = async (_i: SimulateInput): Promise<SimulationResult> => { simCount += 1; return { status: 'observed', simulator: 'fake', observations: [{ kind: 'deps.reverse', detail: '3 units depend on nginx' }], contributions: [] }; };
  const engine = makeEngine(db, llm, [spy.def()], { simulate: sim });
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  assert.equal(simCount, 1, 'simulated once at classification');
  let c = theCall(db, runId);

  // Approve with a FRESH simulation timestamp: no re-check, it runs.
  db.insert(users).values({ id: 'u1', email: 'u1@example.test', name: 'Ada', globalRole: 'admin', passwordHash: null }).run();
  db.update(toolCalls).set({ state: 'approved', decidedBy: 'u1', decidedAt: new Date(), riskJson: { ...c.riskJson!, observed: { ...c.riskJson!.observed!, at: Date.now() } } }).where(eq(toolCalls.id, c.id)).run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  await engine.runToCompletion(runId);
  assert.equal(simCount, 1, 'a fresh approval is not re-simulated');
  assert.deepEqual(spy.executions, ['systemctl restart nginx']);
});

// ---- Fail-closed sandbox gate (SUPOPS_SANDBOX_GATE) --------------------------------

test('sandbox gate (all): an unverified change is blocked, never run on real infra', async () => {
  process.env.SUPOPS_SANDBOX_GATE = 'all';
  try {
    const sim = fakeSim({ status: 'skipped', simulator: null });
    const { db, spy, engine, runId } = run(sim);
    await engine.runToCompletion(runId);
    const c = theCall(db, runId);
    assert.equal(c.state, 'blocked', 'an unverified change is blocked under the gate');
    assert.equal(c.tier, 'forbidden');
    assert.deepEqual(spy.executions, [], 'it must not reach real infrastructure');
    assert.ok(c.riskJson?.contributions.some((x) => x.stage === 'observed' && x.tier === 'forbidden' && /could not verify/.test(x.reason)));
  } finally {
    delete process.env.SUPOPS_SANDBOX_GATE;
  }
});

test('sandbox gate (all): a verified clean change is allowed through the normal gate', async () => {
  process.env.SUPOPS_SANDBOX_GATE = 'all';
  try {
    const sim = fakeSim({ status: 'observed', simulator: 'fake' }); // ran, saw nothing bad
    const { db, spy, engine, runId } = run(sim);
    await engine.runToCompletion(runId);
    const c = theCall(db, runId);
    assert.notEqual(c.state, 'blocked');
    assert.deepEqual(spy.executions, ['systemctl restart nginx'], 'a sandbox-verified change still runs');
  } finally {
    delete process.env.SUPOPS_SANDBOX_GATE;
  }
});

test('sandbox gate off (default): an unverified change follows the normal gate, not blocked', async () => {
  const sim = fakeSim({ status: 'skipped', simulator: null });
  const { db, spy, engine, runId } = run(sim);
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.notEqual(c.state, 'blocked');
  assert.deepEqual(spy.executions, ['systemctl restart nginx']);
});

test('sandbox gate (scripts): a plain command is not gated -- only run_script is', async () => {
  process.env.SUPOPS_SANDBOX_GATE = 'scripts';
  try {
    const sim = fakeSim({ status: 'skipped', simulator: null });
    const { db, spy, engine, runId } = run(sim);
    await engine.runToCompletion(runId);
    const c = theCall(db, runId);
    assert.notEqual(c.state, 'blocked', 'the scripts gate leaves ordinary commands alone');
    assert.deepEqual(spy.executions, ['systemctl restart nginx']);
  } finally {
    delete process.env.SUPOPS_SANDBOX_GATE;
  }
});
