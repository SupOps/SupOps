import type { ToolCallRow } from './store.ts';

/**
 * The engine watching its own run, the way a careful engineer checks themselves:
 *
 *  - before concluding, a change that has not been looked at since must be verified;
 *  - the same action again and again, or failure after failure, means stop and rethink;
 *  - an approver is told when a change comes before anything on that machine was read.
 *
 * Built only from what the engine recorded (states, tiers, signatures), never from the
 * model's own claims. Each note is written once, and says why it was written.
 */

/** Tools that keep the run's own notes; they neither change nor check anything. */
const BOOKKEEPING = new Set(['update_plan', 'read_output', 'record_finding', 'confirm_target', 'search_knowledge', 'read_knowledge']);

export const VERIFY_MARK = '[SupOps] Self-check: verify';
export const STUCK_MARK = '[SupOps] Self-check: stuck';

const isChange = (c: ToolCallRow) => c.state === 'succeeded' && !!c.tier && c.tier !== 'read_only' && !BOOKKEEPING.has(c.toolKey);
const isCheck = (c: ToolCallRow) => c.state === 'succeeded' && c.tier === 'read_only' && !BOOKKEEPING.has(c.toolKey);
/** The same action: its signature, or for a tool without one, the exact arguments. */
const identity = (c: ToolCallRow) => c.signature ?? `${c.toolKey}|${c.argsHash}`;
const done = (c: ToolCallRow) => ['succeeded', 'failed', 'blocked', 'denied', 'expired'].includes(c.state);

/**
 * The model is about to finish this turn. If it changed something and has run no
 * read-only check since, ask it to verify -- once per turn.
 */
export function verifyNote(callsThisTurn: ToolCallRow[], notesThisTurn: string[]): string | null {
  if (notesThisTurn.some((n) => n.startsWith(VERIFY_MARK))) return null;
  let lastChange = -1;
  callsThisTurn.forEach((c, i) => { if (isChange(c)) lastChange = i; });
  if (lastChange < 0) return null;
  if (callsThisTurn.slice(lastChange + 1).some(isCheck)) return null;
  const c = callsThisTurn[lastChange]!;
  const what = c.renderedCommand ? `\`${c.renderedCommand.slice(0, 200)}\`` : c.toolKey;
  return (
    `${VERIFY_MARK}. You changed something (${what}) and have not checked the result since. ` +
    'Run one read-only check that shows whether it worked (the symptom or metric that started this), then conclude. ' +
    'If it cannot be checked, say so plainly in your answer instead of reporting success.'
  );
}

/**
 * Before the next model call: the same action three times in a row, or four failures in
 * a row, means the approach is not working. Written once per pattern (keyed on the
 * last call it saw).
 */
export function stuckNote(callsThisTurn: ToolCallRow[], notesThisTurn: string[]): string | null {
  const calls = callsThisTurn.filter((c) => !BOOKKEEPING.has(c.toolKey) && done(c));
  const last = calls[calls.length - 1];
  if (!last || notesThisTurn.some((n) => n.startsWith(STUCK_MARK) && n.includes(`[${last.id}]`))) return null;

  const tail3 = calls.slice(-3);
  if (tail3.length === 3 && tail3.every((c) => identity(c) === identity(last))) {
    return (
      `${STUCK_MARK} [${last.id}]. You have run the same action three times in a row. Running it again will not tell you anything new. ` +
      'Re-read what it returned, revise your hypothesis, and try a different check -- or tell the operator what is blocking you.'
    );
  }
  const tail4 = calls.slice(-4);
  if (tail4.length === 4 && tail4.every((c) => c.state !== 'succeeded')) {
    const why = [...new Set(tail4.map((c) => c.state))].join(', ');
    return (
      `${STUCK_MARK} [${last.id}]. Your last four actions did not succeed (${why}). Stop and rethink before the next one: ` +
      'read the errors and the reasons given, check your assumptions (the right machine, the right path, the right permissions), ' +
      'and if you cannot proceed safely, say so and stop.'
    );
  }
  return null;
}

/**
 * For the approval card: a change proposed before anything on that machine was read in
 * this run. Null when something was checked first, or when the call is itself a read.
 */
export function preflightWarning(callsInRun: ToolCallRow[], targetId: string | null, targetSlug: string): string | null {
  if (!targetId) return null;
  const looked = callsInRun.some((c) => c.targetId === targetId && isCheck(c));
  return looked ? null : `Nothing on ${targetSlug} was checked in this run before this change.`;
}
