import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { toolCalls } from '@supops/db';
import type { RawDetonation } from '../sim/detonate-report.ts';
import { runScriptTool } from '../tools/script.ts';
import type { ToolDef } from '../tools/types.ts';
import { ScriptedLLM, freshDb, makeEngine, seedRun, toolCall } from './harness.test-util.ts';

/**
 * End-to-end through the REAL simulator (not an injected fake): a malicious run_script
 * is detonated against a fake detonator and blocked before it can run. This proves the
 * whole wiring -- run_script -> simulate -> detonate -> judge -> withObservations ->
 * block -- without Docker.
 */

const SPEC = [{
  type: 'function' as const,
  function: {
    name: 'run_script',
    description: 'run a script',
    parameters: { type: 'object' as const, properties: { target: { type: 'string' as const, enum: ['web-1'] }, script: { type: 'string' as const }, interpreter: { type: 'string' as const }, intent: { type: 'string' as const }, expected_effect: { type: 'string' as const } }, required: ['target', 'script', 'intent', 'expected_effect'] },
  },
}];

let server: Server;
let raw: RawDetonation;
before(async () => {
  server = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ raw })));
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.SUPOPS_DETONATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); delete process.env.SUPOPS_DETONATOR_URL; });

function runWith(script: string) {
  const db = freshDb();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'run_script', { target: 'web-1', script, interpreter: 'bash', intent: 'set up logging', expected_effect: 'a log rotation helper is installed' })] },
    { role: 'assistant', content: 'understood.' },
  ]);
  const engine = makeEngine(db, llm, [runScriptTool as unknown as ToolDef<never>]);
  const runId = seedRun(db, SPEC);
  return { db, engine, runId };
}
const theCall = (db: ReturnType<typeof freshDb>, runId: string) => db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get()!;

test('a script that reads a credential and dials out is detonated and blocked, and never runs', async () => {
  raw = { engine: 'gvisor', exitCode: 0, durationMs: 60, stdout: 'ok', dockerDiff: 'A /tmp/app.log', dnsLog: '', tcpLog: '203.0.113.7:443 CANARY-deadbeef1234', canaryOpened: ['/root/.ssh/id_rsa'], canaryTokens: ['CANARY-deadbeef1234'] };
  const { db, engine, runId } = runWith('#!/bin/bash\n# rotate logs\ncp /etc/logrotate.conf /tmp/x\n');
  await engine.runToCompletion(runId);
  const c = theCall(db, runId);
  assert.equal(c.state, 'blocked');
  assert.equal(c.tier, 'forbidden');
  assert.ok(c.riskJson?.contributions.some((x) => x.stage === 'observed' && x.tier === 'forbidden'));
  assert.equal(c.riskJson?.observed?.items.find((o) => o.kind === 'exfil') !== undefined, true);
  // (A benign detonation leaving the tier unchanged is covered by the detonate unit
  // tests and the injected-fake engine tests, without a real SSH execution to time out.)
});
