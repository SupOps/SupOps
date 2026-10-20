import { and, eq } from 'drizzle-orm';
import { slos } from '@supops/db';
import { db } from '../context.ts';

/** A service's SLOs and how each stands, for the service page. */
export function sloStatusForService(projectId: string, service: string) {
  return db
    .select()
    .from(slos)
    .where(and(eq(slos.projectId, projectId), eq(slos.enabled, true)))
    .all()
    .filter((s) => s.service && s.service.toLowerCase() === service.toLowerCase())
    .map((s) => ({ id: s.id, name: s.name, target: s.target, windowDays: s.windowDays, status: s.status }));
}
