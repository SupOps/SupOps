import type { CiLinkKind, CiSource, CiType } from '@supops/db';

/**
 * Pure service-map logic: how sure an entry is (from its evidence), which way
 * trouble travels along each kind of link, and walks for "what does this depend
 * on" and "what breaks if this breaks".
 */

export interface EvidenceLite {
  source: CiSource;
  lastSeenAt: number;
}

export type Certainty = 'confirmed' | 'manual' | 'documented' | 'observed' | 'stale';

export interface Confidence {
  /** 0-100. */
  score: number;
  certainty: Certainty;
  /** Documented but not seen by discovery that could have seen it; or seen but not in any document. */
  drift: 'not_seen' | 'not_documented' | null;
  sources: CiSource[];
}

const OBSERVED: CiSource[] = ['network', 'kubernetes', 'metrics'];
const DAY = 86_400_000;

/**
 * How sure a link (or component) is, from what says so:
 *  - a person said so (manual), or a document and a live source agree: confirmed;
 *  - only documents: documented -- and "not seen" when discovery looked and did not find it;
 *  - only live sources: observed -- "not documented";
 *  - live evidence older than `staleAfterMs` and nothing else: stale.
 */
export function confidenceOf(evidence: EvidenceLite[], opts: { now?: number; staleAfterMs?: number; discoveryCovered?: boolean } = {}): Confidence {
  const now = opts.now ?? Date.now();
  const staleAfter = opts.staleAfterMs ?? 3 * DAY;
  const sources = [...new Set(evidence.map((e) => e.source))];
  const fresh = evidence.filter((e) => !OBSERVED.includes(e.source) || now - e.lastSeenAt <= staleAfter);
  const has = (s: CiSource[]) => fresh.some((e) => s.includes(e.source));
  const manual = has(['manual']);
  const doc = has(['doc']);
  const target = has(['target']);
  const observed = has(OBSERVED);

  if (manual) return { score: 100, certainty: 'manual', drift: null, sources };
  if (doc && (observed || target)) return { score: 95, certainty: 'confirmed', drift: null, sources };
  if (doc) return { score: opts.discoveryCovered ? 45 : 70, certainty: 'documented', drift: opts.discoveryCovered ? 'not_seen' : null, sources };
  if (observed) {
    const kinds = new Set(fresh.filter((e) => OBSERVED.includes(e.source)).map((e) => e.source));
    return { score: Math.min(90, 70 + kinds.size * 10), certainty: 'observed', drift: 'not_documented', sources };
  }
  if (target) return { score: 85, certainty: 'observed', drift: null, sources };
  return { score: 20, certainty: 'stale', drift: null, sources };
}

/**
 * Which way failure travels along a link. "a depends_on b": if b fails, a is hit.
 * "a replicates_to b": if a (the primary) fails, b stops getting changes.
 * "a monitors b": nothing breaks either way, only visibility.
 */
export function failureFlows(kind: CiLinkKind): 'to->from' | 'from->to' | 'none' {
  if (kind === 'replicates_to') return 'from->to';
  if (kind === 'monitors') return 'none';
  return 'to->from';
}

export interface GraphLink {
  id: string;
  fromId: string;
  toId: string;
  kind: CiLinkKind;
}

/** Everything a failure of `itemId` reaches, nearest first, with the path it took. */
export function impactOf(itemId: string, links: GraphLink[], maxDepth = 4): Array<{ id: string; depth: number; via: string[] }> {
  return walk(itemId, links, maxDepth, 'impact');
}

/** Everything `itemId` relies on, nearest first: where to look for a root cause. */
export function dependenciesOf(itemId: string, links: GraphLink[], maxDepth = 4): Array<{ id: string; depth: number; via: string[] }> {
  return walk(itemId, links, maxDepth, 'deps');
}

function walk(start: string, links: GraphLink[], maxDepth: number, mode: 'impact' | 'deps') {
  // Edge u -> v means "failure at u reaches v".
  const next = new Map<string, Array<{ to: string; link: string }>>();
  const add = (u: string, v: string, link: string) => next.set(u, [...(next.get(u) ?? []), { to: v, link }]);
  for (const l of links) {
    const flow = failureFlows(l.kind);
    if (flow === 'none') continue;
    const [src, dst] = flow === 'to->from' ? [l.toId, l.fromId] : [l.fromId, l.toId];
    if (mode === 'impact') add(src, dst, l.id);
    else add(dst, src, l.id);
  }
  const out: Array<{ id: string; depth: number; via: string[] }> = [];
  const seen = new Set([start]);
  let frontier = [{ id: start, via: [] as string[] }];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const nextFrontier: typeof frontier = [];
    for (const f of frontier) {
      for (const e of next.get(f.id) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        const via = [...f.via, e.link];
        out.push({ id: e.to, depth, via });
        nextFrontier.push({ id: e.to, via });
      }
    }
    frontier = nextFrontier;
  }
  return out;
}

/** Ranks for a left-to-right layout: entry points first, data stores last. */
export const TYPE_TIER: Record<CiType, number> = {
  external: 0, gateway: 0, load_balancer: 1, service: 2, monitoring: 2, cluster: 3, queue: 3, cache: 3, database: 4, storage: 4, host: 5, other: 2,
};

/**
 * Of the components with a problem, which are likeliest the origin: those none of whose
 * dependencies (up to `maxDepth` steps, by how failure flows) also has a problem. The
 * others are probably its effects. (Dynatrace's rule: the root cause is the most upstream
 * abnormal component; a symptom downstream of it is never the cause.)
 */
export function likelyOrigins(abnormal: Iterable<string>, links: GraphLink[], maxDepth = 4): { origins: string[]; effects: Array<{ id: string; dependsOn: string }> } {
  const bad = new Set(abnormal);
  const origins: string[] = [];
  const effects: Array<{ id: string; dependsOn: string }> = [];
  for (const id of bad) {
    const dep = dependenciesOf(id, links, maxDepth).find((d) => bad.has(d.id) && d.id !== id);
    if (dep) effects.push({ id, dependsOn: dep.id });
    else origins.push(id);
  }
  return { origins, effects };
}
