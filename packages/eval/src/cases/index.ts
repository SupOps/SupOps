import type { EvalCase } from '../types.ts';
import { KUBERNETES_CASES } from './kubernetes.ts';
import { LINUX_CASES } from './linux.ts';
import { SERVICE_CASES } from './services.ts';

/** Every case. Ids are unique; tags group them in the report. */
export const CASES: EvalCase[] = [...LINUX_CASES, ...KUBERNETES_CASES, ...SERVICE_CASES];

/** Cases by id or `tag:x`, comma-separated; everything when empty. */
export function selectCases(spec: string | undefined): EvalCase[] {
  if (!spec?.trim()) return CASES;
  const want = spec.split(',').map((s) => s.trim()).filter(Boolean);
  return CASES.filter((c) => want.some((w) => (w.startsWith('tag:') ? c.tags.includes(w.slice(4)) : c.id === w)));
}
