import { Check, X } from 'lucide-react';
import type { RunApprovals } from '../lib/types';

/** "approved by A, B · rejected by C" for one run -- each person once, not per step. */
export function Approvers({ approvals, className }: { approvals: RunApprovals; className?: string }) {
  const approvedBy = approvals.by.filter((p) => p.approved > 0);
  const rejectedBy = approvals.by.filter((p) => p.denied > 0);
  if (!approvedBy.length && !rejectedBy.length) return null;
  const steps = (n: number) => `${n} step${n === 1 ? '' : 's'}`;
  return (
    <span className={className}>
      {approvedBy.length > 0 && (
        <span className="inline-flex max-w-full items-center gap-1" title={`${steps(approvals.approved)} approved`}>
          <Check size={11} className="text-green" aria-hidden />
          approved by <span className="font-medium text-ink">{approvedBy.map((p) => p.name).join(', ')}</span>
        </span>
      )}
      {approvedBy.length > 0 && rejectedBy.length > 0 && <span aria-hidden> · </span>}
      {rejectedBy.length > 0 && (
        <span className="inline-flex max-w-full items-center gap-1" title={`${steps(approvals.denied)} rejected`}>
          <X size={11} className="text-red" aria-hidden />
          rejected by <span className="font-medium text-ink">{rejectedBy.map((p) => p.name).join(', ')}</span>
        </span>
      )}
    </span>
  );
}
