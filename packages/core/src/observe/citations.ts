/**
 * Every claim in an incident report should point at evidence. The model cites the
 * evidence pack as [E1], [E2]...; this checks those references against what was
 * actually gathered, so a citation to evidence that does not exist is flagged
 * instead of lending a guess the look of a finding.
 */
export function checkCitations(text: string, known: Iterable<string>): { cited: string[]; unknown: string[] } {
  const have = new Set(known);
  const cited = [...new Set([...text.matchAll(/\[(E\d{1,3})\]/g)].map((m) => m[1]!))];
  return { cited, unknown: cited.filter((c) => !have.has(c)) };
}

/**
 * The report's verdict, from its "Root cause" and "Confidence" lines. Tolerates the
 * usual Markdown decoration (bold, a heading, a list bullet).
 */
export type IncidentAction = 'act_now' | 'can_wait' | 'none';

/** "act now" / "can wait" / "none needed", however the model decorated it. */
export function parseAction(text: string): IncidentAction | null {
  const m = text.replace(/\*\*|__/g, '').match(/^[#>\-*\s]*action\s*[:\-–]\s*(.+)$/im);
  const v = m?.[1]?.toLowerCase() ?? '';
  if (/act now|urgent|immediate/.test(v)) return 'act_now';
  if (/can wait|soon|schedule|later/.test(v)) return 'can_wait';
  if (/none|no action|not needed|nothing/.test(v)) return 'none';
  return null;
}

export function parseVerdict(text: string): { rootCause: string | null; confidence: 'high' | 'medium' | 'low' | 'inconclusive' | null } {
  const plain = text.replace(/\*\*|__/g, '');
  const rc = plain.match(/^[#>\-*\s]*root cause\s*[:\-–]\s*(.+)$/im) ?? plain.match(/^#+\s*root cause\s*\n+\s*(.+)$/im);
  const conf = plain.match(/confidence\s*[:\-–]?\s*\(?\s*(high|medium|low|inconclusive)\b/i);
  const rootCause = rc?.[1]?.trim().replace(/\s*\(?confidence[^)]*\)?\s*$/i, '').slice(0, 500) || null;
  let confidence = (conf?.[1]?.toLowerCase() ?? null) as 'high' | 'medium' | 'low' | 'inconclusive' | null;
  if (!confidence && rootCause && /^inconclusive\b/i.test(rootCause)) confidence = 'inconclusive';
  return { rootCause, confidence };
}

export type HypothesisVerdict = 'confirmed' | 'ruled_out' | 'untested';
export interface Hypothesis {
  hypothesis: string;
  verdict: HypothesisVerdict;
  evidence: string;
}

function verdictOf(cell: string): HypothesisVerdict | null {
  const v = cell.toLowerCase();
  if (/ruled out|refuted|rejected|disproved|\bno\b|unlikely/.test(v)) return 'ruled_out';
  if (/confirmed|supported|\byes\b|likely|proven/.test(v)) return 'confirmed';
  if (/untested|unknown|not tested|not checked|open|unclear/.test(v)) return 'untested';
  return null;
}

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim().replace(/\*\*|__/g, ''));

/**
 * The hypotheses table from a report: the first Markdown table whose header names a
 * hypothesis (or cause) column. Verdicts are normalised; a row whose verdict cannot be
 * read is kept as untested rather than dropped, so nothing the model weighed is lost.
 */
export function parseHypotheses(text: string): Hypothesis[] {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 2; i++) {
    if (!lines[i]!.includes('|') || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) continue;
    const head = cells(lines[i]!).map((h) => h.toLowerCase());
    const hc = head.findIndex((h) => /hypothes|cause|theory/.test(h));
    if (hc < 0) continue;
    const vc = head.findIndex((h, j) => j !== hc && /verdict|status|result|outcome/.test(h));
    const ec = head.findIndex((h, j) => j !== hc && j !== vc && /evidence|why|because|reason/.test(h));
    const out: Hypothesis[] = [];
    for (let j = i + 2; j < lines.length && lines[j]!.includes('|'); j++) {
      const row = cells(lines[j]!);
      const hypothesis = row[hc]?.trim();
      if (!hypothesis) continue;
      out.push({
        hypothesis: hypothesis.slice(0, 300),
        verdict: (vc >= 0 ? verdictOf(row[vc] ?? '') : null) ?? 'untested',
        evidence: (ec >= 0 ? row[ec] ?? '' : '').slice(0, 500),
      });
      if (out.length >= 12) break;
    }
    if (out.length) return out;
  }
  return [];
}

export interface BlastRadius {
  affected: string | null;
  healthy: string | null;
  unchecked: string | null;
}

/** The "Blast radius" section: what is affected, what was checked and is fine, what was not checked. */
export function parseBlastRadius(text: string): BlastRadius | null {
  const plain = text.replace(/\*\*|__/g, '');
  const m = plain.match(/^#+\s*blast radius\s*\n([\s\S]*?)(?=^#+\s|(?![\s\S]))/im);
  if (!m) return null;
  const line = (re: RegExp) => m[1]!.match(re)?.[1]?.trim().slice(0, 500) || null;
  const r = {
    affected: line(/^[\s\-*]*affected\s*[:\-–]\s*(.+)$/im),
    healthy: line(/^[\s\-*]*checked(?: and)? (?:healthy|fine|ok)\s*[:\-–]\s*(.+)$/im),
    unchecked: line(/^[\s\-*]*not checked\s*[:\-–]\s*(.+)$/im),
  };
  return r.affected || r.healthy || r.unchecked ? r : null;
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'on', 'in', 'of', 'for', 'to', 'at', 'and', 'or', 'it', 'its', 'has', 'have', 'been', 'this', 'that', 'with', 'by', 'very', 'too']);
const words = (s: string) => s.toLowerCase().replace(/\[e\d+\]/g, ' ').split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
const CAUSAL = /\b(because|due to|caused by|after|since|from|following|triggered by|when|so that|which made|leading to|led to|filled by|exhausted by)\b/i;

/**
 * True when the "root cause" only restates what fired: it says what is wrong, not why.
 * Watchdog's rule is that a symptom is never the root cause. A root cause that names a
 * mechanism ("because", "after the deploy", "filled by") is never flagged.
 */
export function restatesSymptom(rootCause: string, alertTitles: string[]): boolean {
  if (!rootCause || /^inconclusive\b/i.test(rootCause) || CAUSAL.test(rootCause)) return false;
  const said = words(rootCause);
  if (!said.length) return false;
  return alertTitles.some((t) => {
    const fired = new Set(words(t.replace(/([a-z])([A-Z])/g, '$1 $2')));
    if (!fired.size) return false;
    const overlap = said.filter((w) => fired.has(w)).length;
    return overlap / said.length >= 0.6;
  });
}
