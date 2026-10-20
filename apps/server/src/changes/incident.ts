import type { alerts, incidents } from '@supops/db';

type IncidentRow = typeof incidents.$inferSelect;
type AlertRow = typeof alerts.$inferSelect;

/** Labels that name the service an alert is about, in the usual conventions. */
const SERVICE_LABELS = ['service', 'service_name', 'app', 'app_kubernetes_io_name', 'application', 'job', 'deployment', 'container', 'component'];

/** What an incident is about, for matching changes: its services, its machines, and when it began. */
export function incidentServices(inc: IncidentRow, members: AlertRow[]): { startedAt: Date; services: string[]; targetIds: string[] } {
  const services = new Set<string>();
  for (const a of members) {
    for (const k of SERVICE_LABELS) {
      const v = a.labels?.[k];
      if (v && v.length < 120) services.add(v);
    }
  }
  const starts = members.map((a) => (a.startsAt ?? a.receivedAt)?.getTime()).filter((t): t is number => typeof t === 'number');
  return { startedAt: new Date(starts.length ? Math.min(...starts) : inc.openedAt.getTime()), services: [...services], targetIds: inc.targetIds ?? [] };
}
