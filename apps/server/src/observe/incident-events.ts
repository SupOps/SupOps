import { eq } from 'drizzle-orm';
import { incidentEvents, incidents } from '@supops/db';
import type { IncidentEventKind } from '@supops/db';
import type { AuthUser } from '../auth.ts';
import { db } from '../context.ts';

/**
 * Append to an incident's record. `actor` null means SupOps itself did it; a string
 * names what did (e.g. a workflow) without being a user.
 */
export function recordIncidentEvent(incidentId: string, kind: IncidentEventKind, actor: AuthUser | string | null | undefined, data?: Record<string, unknown>): void {
  const user = typeof actor === 'object' ? actor : null;
  db.insert(incidentEvents)
    .values({ incidentId, kind, actorId: user?.id ?? null, actorName: typeof actor === 'string' ? actor : user ? user.name || user.email : null, data: data ?? null })
    .run();
}

/**
 * The incident got worse while acknowledged: the acknowledgement no longer covers
 * what is happening, so it lapses and the incident is news again.
 */
export function lapseAcknowledgement(incidentId: string, reason: string): void {
  const inc = db.select({ at: incidents.acknowledgedAt }).from(incidents).where(eq(incidents.id, incidentId)).get();
  if (!inc?.at) return;
  db.update(incidents).set({ acknowledgedAt: null, acknowledgedBy: null }).where(eq(incidents.id, incidentId)).run();
  recordIncidentEvent(incidentId, 'ack_lapsed', null, { reason });
}
