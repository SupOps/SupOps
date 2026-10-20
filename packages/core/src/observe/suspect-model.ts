/**
 * Learned weights for "which change caused this incident". People mark a suspect "this
 * was the cause" or "not this"; a small logistic model learns, per project, how much
 * each feature matters (the same service, a service upstream, how close in time, the
 * kind of change, a deploy that already looked worse...). Its score is blended into the
 * fixed ranking with a weight that grows with the number of examples, so a few clicks
 * cannot swing it, and it only ever changes the order of a list of suggestions.
 *
 * The model is retrained from every recorded mark each time (a few hundred at most),
 * so it is deterministic: the same marks give the same weights, and a mark taken back
 * is simply gone.
 */

export const SUSPECT_FEATURES = ['bias', 'same service', 'upstream', 'close in time', 'deploy, rollback or config', 'SupOps action', 'deploy looked worse', 'after the first failure'] as const;

export interface SuspectExample {
  x: number[];
  /** 1: it was the cause. 0: it was not. */
  y: 0 | 1;
  /** How much the example counts: 1 for a person's mark, less for an implied "not this". */
  w: number;
}

export interface SuspectModel {
  weights: number[];
  /** Explicit marks it learned from. */
  examples: number;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

export function predictCause(m: SuspectModel, x: number[]): number {
  return sigmoid(dot(m.weights, x));
}

/**
 * Fit by gradient descent with a little L2, from zero weights each time. Too few
 * examples (fewer than three marks) gives no model at all.
 */
export function trainSuspectModel(examples: SuspectExample[], opts: { epochs?: number; lr?: number; l2?: number } = {}): SuspectModel | null {
  const explicit = examples.filter((e) => e.w >= 1).length;
  if (explicit < 3) return null;
  const n = SUSPECT_FEATURES.length;
  const w = new Array<number>(n).fill(0);
  const lr = opts.lr ?? 0.5;
  const l2 = opts.l2 ?? 0.01;
  const total = examples.reduce((s, e) => s + e.w, 0);
  for (let epoch = 0; epoch < (opts.epochs ?? 300); epoch += 1) {
    const grad = new Array<number>(n).fill(0);
    for (const e of examples) {
      const err = sigmoid(dot(w, e.x)) - e.y;
      for (let i = 0; i < n; i += 1) grad[i]! += e.w * err * (e.x[i] ?? 0);
    }
    for (let i = 0; i < n; i += 1) w[i]! -= lr * (grad[i]! / total + (i === 0 ? 0 : l2 * w[i]!));
  }
  return { weights: w.map((v) => Number(v.toFixed(4))), examples: explicit };
}

/** How much the learned score may move a suspect: nothing at first, at most 1.5 after about 30 marks. */
export const blendWeight = (m: SuspectModel | null): number => (m ? Math.min(1.5, m.examples / 20) : 0);

/** The learned adjustment for one suspect, between -1.5 and +1.5. */
export function learnedAdjustment(m: SuspectModel | null, x: number[]): number {
  const a = blendWeight(m);
  return a ? a * (2 * predictCause(m!, x) - 1) : 0;
}

/** The features the model leans on most, for showing what it has learned. */
export function describeModel(m: SuspectModel): Array<{ feature: string; weight: number }> {
  return SUSPECT_FEATURES.map((feature, i) => ({ feature, weight: m.weights[i] ?? 0 }))
    .filter((f) => f.feature !== 'bias')
    .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}
