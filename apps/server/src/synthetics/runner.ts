import { and, eq, inArray, lt } from 'drizzle-orm';
import { alerts, syntheticChecks, syntheticResults } from '@supops/db';
import { runSynthetic, type SyntheticResult } from '@supops/core';
import { OPEN_ALERT_STATUSES } from '@supops/shared';
import { db } from '../context.ts';
import { ingestAlert } from '../observe/ingest.ts';

type CheckRow = typeof syntheticChecks.$inferSelect;

const KEEP_MS = 30 * 86_400_000;

const hostOf = (c: CheckRow) => {
  try {
    return c.kind === 'http' ? new URL(c.target).hostname : c.target;
  } catch {
    return c.target;
  }
};

function isOpen(projectId: string, fingerprint: string): boolean {
  return !!db.select({ id: alerts.id }).from(alerts).where(and(eq(alerts.projectId, projectId), eq(alerts.fingerprint, fingerprint), inArray(alerts.status, [...OPEN_ALERT_STATUSES]))).get();
}

/** Run one check now: store the result, and raise or resolve its alerts. */
export async function runCheck(c: CheckRow, now = Date.now()): Promise<SyntheticResult> {
  const r = await runSynthetic({
    kind: c.kind, target: c.target, port: c.port, method: c.method, expectStatus: c.expectStatus, contains: c.contains,
    maxLatencyMs: c.maxLatencyMs, certDaysWarn: c.certDaysWarn, allowPrivate: c.allowPrivate,
  });
  db.insert(syntheticResults).values({ checkId: c.id, at: new Date(now), ok: r.ok, status: r.status, latencyMs: r.latencyMs, statusCode: r.statusCode ?? null, certDaysLeft: r.certDaysLeft ?? null, error: r.error ?? null }).run();
  const streak = r.ok ? 0 : c.failStreak + 1;
  db.update(syntheticChecks).set({ lastRunAt: new Date(now), lastStatus: r.status, lastError: r.error ?? null, failStreak: streak }).where(eq(syntheticChecks.id, c.id)).run();

  const labels = { alertname: 'SyntheticCheckFailed', check: c.name, kind: c.kind, instance: hostOf(c) };
  const down = `synthetic:${c.id}`;
  // Down for long enough is an outage; the first success after it ends it.
  if (!r.ok && streak >= c.failThreshold) {
    ingestAlert({ projectId: c.projectId, source: 'supops', fingerprint: down, title: `${c.name} is down`, severity: 'critical', summary: `${c.kind.toUpperCase()} check of ${c.target} failed ${streak} times in a row: ${r.error ?? 'no answer'}.`, labels, status: 'firing', notification: false });
  } else if (r.ok && isOpen(c.projectId, down)) {
    ingestAlert({ projectId: c.projectId, source: 'supops', fingerprint: down, title: `${c.name} is down`, severity: 'critical', summary: `${c.name} answers again.`, labels, status: 'resolved', notification: false });
  }
  const cert = `synthetic-cert:${c.id}`;
  const expiring = r.certDaysLeft !== undefined && r.certDaysLeft < c.certDaysWarn;
  if (expiring) {
    ingestAlert({ projectId: c.projectId, source: 'supops', fingerprint: cert, title: `Certificate for ${hostOf(c)} expires soon`, severity: r.certDaysLeft! < 3 ? 'critical' : 'warning', summary: `The certificate served for ${hostOf(c)} expires in ${r.certDaysLeft} days.`, labels: { ...labels, alertname: 'CertificateExpiring' }, status: 'firing', notification: false });
  } else if (r.certDaysLeft !== undefined && isOpen(c.projectId, cert)) {
    ingestAlert({ projectId: c.projectId, source: 'supops', fingerprint: cert, title: `Certificate for ${hostOf(c)} expires soon`, severity: 'warning', summary: 'A renewed certificate is being served.', labels: { ...labels, alertname: 'CertificateExpiring' }, status: 'resolved', notification: false });
  }
  return r;
}

class SyntheticRunner {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private prunedAt = 0;

  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const due = db.select().from(syntheticChecks).where(eq(syntheticChecks.enabled, true)).all().filter((c) => !c.lastRunAt || c.lastRunAt.getTime() + c.intervalSec * 1000 <= now);
      for (let i = 0; i < due.length; i += 5) {
        await Promise.all(due.slice(i, i + 5).map((c) => runCheck(c).catch((err) => console.error(`synthetic check ${c.id} failed to run:`, err))));
      }
      if (now - this.prunedAt > 3_600_000) {
        db.delete(syntheticResults).where(lt(syntheticResults.at, new Date(now - KEEP_MS))).run();
        this.prunedAt = now;
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    setTimeout(() => void this.tick(), 15_000);
    this.timer = setInterval(() => void this.tick(), 15_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const syntheticRunner = new SyntheticRunner();
