/**
 * Log lines grouped into templates: the variable parts (numbers, IDs, addresses,
 * quoted values, timestamps) replaced by placeholders, so a thousand copies of the
 * same error with different request IDs read as one line with a count.
 */
export function logTemplate(line: string): string {
  return line
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '<ip>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<hex>')
    .replace(/"[^"]{0,200}"/g, '"<str>"')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|h|kb|mb|gb|b|%)?\b/gi, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Log patterns with Drain (He et al., 2017): lines are masked (logTemplate), split into
 * tokens, routed by length and first token, and joined to the most similar pattern in
 * that leaf when at least SIMILARITY of their tokens agree; the tokens that differ become
 * <*>. Unlike exact templates, "user alice logged in" and "user bob logged in" become one
 * pattern without a rule for user names.
 */
const SIMILARITY = 0.5;
const MAX_PATTERNS = 500;

export interface LogPattern {
  template: string;
  count: number;
  example: string;
  /** Lines per time bucket, oldest first, when the lines had times. */
  buckets?: number[];
  /** Only in the latest part of the window: a pattern that was not there before. */
  isNew?: boolean;
  /** Its latest bucket is well above its own average before. */
  spiking?: boolean;
}

interface Cluster {
  tokens: string[];
  count: number;
  example: string;
  buckets: number[];
  first: number;
}

const hasDigit = /\d/;

export function drainPatterns(
  lines: Array<string | { line: string; ts?: number }>,
  opts: { buckets?: number; start?: number; end?: number } = {},
): LogPattern[] {
  const items = lines.map((l) => (typeof l === 'string' ? { line: l, ts: undefined as number | undefined } : l)).filter((l) => l.line.trim());
  const times = items.map((l) => l.ts).filter((t): t is number => typeof t === 'number');
  const nb = times.length ? Math.max(1, opts.buckets ?? 6) : 0;
  const start = opts.start ?? (times.length ? Math.min(...times) : 0);
  const end = opts.end ?? (times.length ? Math.max(...times) + 1 : 1);
  const width = Math.max(1, (end - start) / Math.max(1, nb));
  const bucketOf = (ts: number | undefined) => (ts === undefined || !nb ? -1 : Math.min(nb - 1, Math.max(0, Math.floor((ts - start) / width))));

  const tree = new Map<string, Cluster[]>();
  const all: Cluster[] = [];
  for (const { line, ts } of items) {
    const tokens = logTemplate(line).split(' ').filter(Boolean);
    if (!tokens.length) continue;
    const head = hasDigit.test(tokens[0]!) ? '<*>' : tokens[0]!;
    const key = `${tokens.length}\u0000${head}`;
    const leaf = tree.get(key) ?? [];
    let best: Cluster | null = null;
    let bestSim = -1;
    for (const c of leaf) {
      let same = 0;
      for (let i = 0; i < tokens.length; i++) if (c.tokens[i] === tokens[i] || c.tokens[i] === '<*>') same++;
      const sim = same / tokens.length;
      if (sim > bestSim) {
        bestSim = sim;
        best = c;
      }
    }
    const b = bucketOf(ts);
    if (best && bestSim >= SIMILARITY) {
      for (let i = 0; i < tokens.length; i++) if (best.tokens[i] !== tokens[i]) best.tokens[i] = '<*>';
      best.count++;
      if (b >= 0) best.buckets[b]!++;
    } else if (all.length < MAX_PATTERNS) {
      const c: Cluster = { tokens: [...tokens], count: 1, example: line.slice(0, 300), buckets: Array.from({ length: nb }, () => 0), first: b };
      if (b >= 0) c.buckets[b]!++;
      leaf.push(c);
      tree.set(key, leaf);
      all.push(c);
    }
  }
  return all
    .map((c) => {
      const out: LogPattern = { template: c.tokens.join(' '), count: c.count, example: c.example };
      if (nb) {
        out.buckets = c.buckets;
        const last = c.buckets[nb - 1]!;
        const earlier = c.buckets.slice(0, nb - 1);
        const before = earlier.reduce((a, x) => a + x, 0);
        if (nb > 1 && before === 0 && last > 0) out.isNew = true;
        else if (nb > 1 && last >= 5 && last > 3 * (before / earlier.length)) out.spiking = true;
      }
      return out;
    })
    .sort((a, b) => Number(!!b.isNew || !!b.spiking) - Number(!!a.isNew || !!a.spiking) || b.count - a.count);
}

/** Lines grouped into patterns, most frequent first (new or spiking first when the lines had times). */
export function clusterLogLines(lines: Array<string | { line: string; ts?: number }>): LogPattern[] {
  return drainPatterns(lines);
}

/** One line per pattern: count, a marker when it is new or spiking, and the pattern. */
export function patternLine(p: LogPattern): string {
  return `${p.count}x${p.isNew ? ' [NEW]' : p.spiking ? ' [SPIKING]' : ''} ${p.template}${p.buckets ? ` (per bucket: ${p.buckets.join(' ')})` : ''}`;
}
