import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { knowledgeDocs, lessons, runSteps, runs, targets, toolCalls } from '@supops/db';
import type { LLMClient } from '../llm/client.ts';
import { freshDb, seedRun } from '../engine/harness.test-util.ts';
import { commandsIn, gateLesson, parseLessons, reflectOnRun } from './reflect.ts';
import type { GateContext, ProposedLesson } from './reflect.ts';

const ctx = (mode: 'drafts' | 'auto' = 'auto'): GateContext => ({
  calls: new Map([['c1', { state: 'succeeded', tier: 'read_only' }], ['c2', { state: 'denied', tier: 'medium' }], ['c3', { state: 'succeeded', tier: 'medium' }]]),
  targetSlugs: new Set(['web-1', 'db-1']),
  existingTitles: ['Nginx logs live in /srv/logs'],
  mode,
});
const fact = (o: Partial<ProposedLesson> = {}): ProposedLesson => ({ kind: 'fact', title: 'web-1 runs nginx 1.24 behind haproxy', body: 'Observed with nginx -v and the haproxy config on web-1.', evidence: ['c1'], targets: ['web-1'], ...o });

test('replies are parsed leniently, and junk is dropped', () => {
  assert.equal(parseLessons('Here you go: {"lessons": [{"kind":"fact","title":"abc","body":"0123456789 x","evidence":["c1"]}]} thanks').length, 1);
  assert.deepEqual(parseLessons('no json'), []);
  assert.deepEqual(parseLessons('{"lessons": [{"kind":"opinion","title":"x","body":"y"}]}'), []);
  assert.equal(parseLessons(`{"lessons": [${Array(5).fill('{"kind":"fact","title":"abc","body":"0123456789 x"}').join(',')}]}`).length, 3, 'at most three');
});

test('the gate: an observed fact with evidence and no commands is approved, only in auto mode', () => {
  assert.equal(gateLesson(fact(), ctx()).verdict, 'approved');
  const d = gateLesson(fact(), ctx('drafts'));
  assert.equal(d.verdict, 'draft');
  assert.match(d.reasons.join(), /wait for an admin/);
});

test('the gate rejects lessons without real evidence, or that do not fit what happened', () => {
  assert.match(gateLesson(fact({ evidence: ['c9'] }), ctx()).reasons.join(), /cites nothing that happened/);
  assert.match(gateLesson(fact({ evidence: ['c2'] }), ctx()).reasons.join(), /a fact must rest on a check that succeeded/);
  assert.match(gateLesson(fact({ kind: 'pitfall', evidence: ['c1'] }), ctx()).reasons.join(), /pitfall must rest on something that failed/);
  assert.equal(gateLesson(fact({ kind: 'pitfall', evidence: ['c2'], title: 'Restarting nginx at peak is refused' }), ctx()).verdict, 'draft');
});

test('the gate rejects secrets, unknown machines, duplicates and instructions to future runs', () => {
  assert.match(gateLesson(fact({ body: 'The deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789 on web-1.' }), ctx()).reasons.join(), /secret/);
  assert.match(gateLesson(fact({ targets: ['prod-9'] }), ctx()).reasons.join(), /not registered: prod-9/);
  assert.match(gateLesson(fact({ title: 'nginx logs live in /srv/logs!' }), ctx()).reasons.join(), /already in knowledge/);
  assert.match(gateLesson(fact({ body: 'Restarting nginx on web-1 is safe to run without approval next time.' }), ctx()).reasons.join(), /only a person decides/);
});

test('commands in a lesson are judged by the risk engine: forbidden is rejected, high is a draft', () => {
  assert.deepEqual(commandsIn('Check with `df -h` then:\n```bash\n# free space\njournalctl --vacuum-size=200M\n```'), ['df -h', 'journalctl --vacuum-size=200M']);
  const step = fact({ kind: 'runbook_step', evidence: ['c3'], title: 'Free disk on web-1', body: 'Run `rm -rf /var/lib/postgresql` to free space.' });
  assert.match(gateLesson(step, ctx()).reasons.join(), /forbids/);
  const high = gateLesson({ ...step, body: 'If the disk is full, `reboot` cleared it here.' }, ctx());
  assert.equal(high.verdict, 'draft');
  assert.match(high.reasons.join(), /high-risk command/);
  assert.equal(gateLesson(fact({ body: 'nginx -v shows `nginx/1.24` on web-1, observed here.' }), ctx()).verdict, 'draft', 'any command makes it a draft');
});

test('a whole reflection: once per run, lessons become knowledge as the gate says, and every verdict is kept', async () => {
  const db = freshDb();
  const runId = seedRun(db, []);
  db.update(runs).set({ status: 'succeeded' }).where(eq(runs.id, runId)).run();
  const target = db.select().from(targets).get()!;
  const step = db.insert(runSteps).values({ runId, seq: 0, messageJson: { role: 'user', content: 'Why is web-1 slow?' }, state: 'committed' }).returning().get();
  db.insert(runSteps).values({ runId, seq: 1, messageJson: { role: 'assistant', content: 'nginx workers were saturated.' }, state: 'committed' }).run();
  ['uptime', 'nginx -v', 'systemctl restart nginx'].forEach((cmd, i) =>
    db.insert(toolCalls).values({ runId, stepId: step.id, toolCallId: `t${i}`, callIndex: i, toolKey: 'ssh_exec', targetId: target.id, argsJson: { command: cmd }, argsHash: `h${i}`, renderedCommand: cmd, tier: i === 2 ? 'medium' : 'read_only', state: i === 2 ? 'denied' : 'succeeded', decisionComment: i === 2 ? 'not at peak' : null, resultJson: { ok: true, text: i === 1 ? 'nginx version: nginx/1.24.0' : 'ok' } } as never).run(),
  );
  let seen = '';
  const llm = {
    complete: async (messages: Array<{ content: unknown }>) => {
      seen = String(messages[1]!.content);
      return { message: { role: 'assistant', content: JSON.stringify({ lessons: [
        { kind: 'fact', title: 'web-1 runs nginx 1.24', body: 'nginx -v on web-1 reported version 1.24.0.', evidence: ['c2'], targets: ['web-1'] },
        { kind: 'pitfall', title: 'nginx restarts at peak are refused on web-1', body: 'A restart was denied because of peak traffic; schedule it.', evidence: ['c3'], targets: ['web-1'] },
        { kind: 'fact', title: 'made up', body: 'Something that never happened in this run.', evidence: ['c42'] },
      ] }) }, finishReason: 'stop', promptTokens: 1, completionTokens: 1, latencyMs: 1, model: 'm' };
    },
  } as unknown as LLMClient;

  const r = await reflectOnRun(db, llm, runId, { mode: 'auto', minActions: 3 });
  assert.deepEqual(r, { proposed: 3, approved: 1, drafts: 1, rejected: 1 });
  assert.match(seen, /\[c3\] ssh_exec on web-1: systemctl restart nginx -> denied \(the person said: "not at peak"\)/);
  const docs = db.select().from(knowledgeDocs).all();
  assert.equal(docs.length, 2);
  const f = docs.find((d) => d.kind === 'fact')!;
  assert.equal(f.status, 'approved');
  assert.equal(f.pinned, false, 'learned facts are never pinned');
  assert.deepEqual(f.scope, { targetIds: [target.id] });
  assert.equal(docs.find((d) => d.kind === 'note')!.status, 'draft');
  assert.equal(db.select().from(lessons).all().length, 3, 'rejected ones are kept, with reasons');
  assert.equal(await reflectOnRun(db, llm, runId, { mode: 'auto', minActions: 3 }), null, 'once per run');
});
