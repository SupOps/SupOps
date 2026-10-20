import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { RiskTier } from '@supops/shared';
import { RISK_TIERS, tierRank } from '@supops/shared';
import type { Db } from '@supops/db';
import { learnedRules, runs, toolCalls, users } from '@supops/db';

/**
 * Turns what happened to an action into a rule for next time. Only recorded facts
 * count -- who denied it, with what comment, and whether an automatic change failed --
 * never anything a model wrote. Rules only ever raise:
 *
 *  - denied twice (the same action, on the same machine): it needs one tier more;
 *  - denied three times, by two or more people or with two or more comments: blocked;
 *  - an automatic change that failed twice: it waits for approval next time.
 *
 * Each call is counted once (`tool_calls.learned_at`), and its evidence is copied onto
 * the rule, so a rule someone deletes or resets does not come back from old history,
 * and one someone switched off stays off.
 */

export const DENIALS_TO_RAISE = 2;
export const DENIALS_TO_BLOCK = 3;
export const FAILURES_TO_ASK = 2;

type Evidence = { runId: string | null; at: number; by: string | null; comment: string | null; state: string };
type Trigger = 'denied' | 'failed_change';

const up = (t: RiskTier): RiskTier => RISK_TIERS[Math.min(tierRank(t) + 1, tierRank('high'))]!;
const maxOf = (ts: RiskTier[]): RiskTier => ts.reduce((a, b) => (tierRank(b) > tierRank(a) ? b : a), 'read_only' as RiskTier);

export interface HarvestResult {
  ruleId: string;
  effect: 'raise' | 'block';
  minTier: RiskTier;
  created: boolean;
}

/** What the evidence adds up to, or null while there is not enough of it. */
export function decide(trigger: Trigger, ev: Evidence[], tiers: RiskTier[], ceilings: RiskTier[]): { effect: 'raise' | 'block'; minTier: RiskTier; reason: string } | null {
  const n = ev.length;
  if (trigger === 'denied') {
    if (n < DENIALS_TO_RAISE) return null;
    const people = new Set(ev.map((e) => e.by).filter(Boolean)).size;
    const comments = ev.filter((e) => e.comment?.trim()).length;
    if (n >= DENIALS_TO_BLOCK && (people >= 2 || comments >= 2)) {
      return { effect: 'block', minTier: 'forbidden', reason: `denied ${n} times${people >= 2 ? ` by ${people} people` : ''}; blocked so it is not proposed again` };
    }
    const seen = maxOf(tiers);
    return { effect: 'raise', minTier: up(seen), reason: `denied ${n} times; needs more approval than ${seen.replace('_', '-')} next time` };
  }
  if (n < FAILURES_TO_ASK) return null;
  // One tier above what could run alone, so it waits for a person.
  const ceiling = maxOf(ceilings.length ? ceilings : tiers);
  return { effect: 'raise', minTier: up(ceiling), reason: `ran on its own and failed ${n} times; a person approves it next time` };
}

/**
 * Count the not-yet-counted calls with this signature in this project, and create or
 * update the rules they justify. Safe to call after every denial or failed change.
 */
export function harvest(db: Db, projectId: string, signature: string): HarvestResult[] {
  const rows = db
    .select({ c: toolCalls, projectId: runs.projectId })
    .from(toolCalls)
    .innerJoin(runs, eq(runs.id, toolCalls.runId))
    .where(and(eq(runs.projectId, projectId), eq(toolCalls.signature, signature), isNull(toolCalls.learnedAt), inArray(toolCalls.state, ['denied', 'failed'])))
    .all()
    .map((r) => r.c)
    // A failure counts only for a change that ran without anyone approving it.
    .filter((c) => c.state === 'denied' || (c.riskJson?.decision === 'auto' && c.tier !== 'read_only' && !c.decidedBy));
  if (!rows.length) return [];

  const out: HarvestResult[] = [];
  const groups = new Map<string, typeof rows>();
  for (const c of rows) {
    const key = `${c.state === 'denied' ? 'denied' : 'failed_change'}|${c.targetId ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const names = new Map(db.select({ id: users.id, name: users.name }).from(users).all().map((u) => [u.id, u.name]));

  for (const [key, calls] of groups) {
    const [trigger, targetId] = key.split('|') as [Trigger, string];
    const existing = db
      .select()
      .from(learnedRules)
      .where(and(eq(learnedRules.projectId, projectId), eq(learnedRules.signature, signature), eq(learnedRules.trigger, trigger), targetId ? eq(learnedRules.targetId, targetId) : isNull(learnedRules.targetId)))
      .get();
    const fresh: Evidence[] = calls.map((c) => ({ runId: c.runId, at: (c.decidedAt ?? c.finishedAt ?? c.createdAt).getTime(), by: c.decidedBy ? names.get(c.decidedBy) ?? c.decidedBy : null, comment: c.decisionComment, state: c.state }));
    const evidence = [...(existing?.evidenceJson ?? []), ...fresh];
    const tiers = calls.map((c) => c.tier ?? 'medium');
    const ceilings = calls.map((c) => c.riskJson?.ceiling).filter((t): t is RiskTier => !!t);
    if (existing) tiers.push(existing.effect === 'block' ? 'high' : existing.minTier);
    const verdict = decide(trigger, evidence, tiers, ceilings);
    if (!verdict) continue; // not enough yet: the calls stay uncounted until there is

    const example = calls[calls.length - 1]!.renderedCommand ?? signature;
    const now = new Date();
    let ruleId: string;
    if (existing) {
      // Never weaker than before: a block stays a block, a raise only goes up.
      const effect = existing.effect === 'block' ? 'block' : verdict.effect;
      const minTier = effect === 'block' ? 'forbidden' : maxOf([existing.minTier, verdict.minTier]);
      db.update(learnedRules).set({ effect, minTier, reason: verdict.reason, example, evidenceJson: evidence, updatedAt: now }).where(eq(learnedRules.id, existing.id)).run();
      ruleId = existing.id;
      out.push({ ruleId, effect, minTier, created: false });
    } else {
      ruleId = db
        .insert(learnedRules)
        .values({ projectId, signature, example, targetId: targetId || null, effect: verdict.effect, minTier: verdict.minTier, trigger, reason: verdict.reason, evidenceJson: evidence })
        .returning({ id: learnedRules.id })
        .get().id;
      out.push({ ruleId, effect: verdict.effect, minTier: verdict.minTier, created: true });
    }
    db.update(toolCalls).set({ learnedAt: now }).where(inArray(toolCalls.id, calls.map((c) => c.id))).run();
  }
  return out;
}
