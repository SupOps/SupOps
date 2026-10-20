import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, put } from '../lib/api';
import { Panel, Segmented, Spinner, Switch } from './ui';
import type { ObservabilitySettings } from '../lib/types';

interface Retention {
  days: number | null;
  dropImagesAfterDays: number | null;
  observabilityDays?: number;
}

/**
 * Settings › Observability: how often alerts are read and signals sampled, whether
 * new incidents are investigated on their own, when a forecast becomes an incident,
 * and how long the history is kept.
 */
export function ObservabilityPanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const cfg = useQuery({ queryKey: ['obsSettings'], queryFn: () => api<ObservabilitySettings>('/observability/settings') });
  const storage = useQuery({ queryKey: ['storage'], queryFn: () => api<{ retention: Retention }>('/maintenance/storage') });
  const save = useMutation({
    mutationFn: (patch: Partial<ObservabilitySettings>) => put<ObservabilitySettings>('/observability/settings', patch),
    onSuccess: (d) => qc.setQueryData(['obsSettings'], d),
  });
  const saveDays = useMutation({
    mutationFn: (observabilityDays: number) => {
      const r = storage.data!.retention;
      return put('/maintenance/retention', { days: r.days, dropImagesAfterDays: r.dropImagesAfterDays, observabilityDays });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['storage'] }),
  });

  const c = cfg.data;
  const days = String(storage.data?.retention.observabilityDays ?? 15);
  const error = (save.error ?? saveDays.error) as Error | null;

  return (
    <Panel title="Observability" accent="bg-violet">
      {!c ? (
        <div className="grid place-items-center py-8"><Spinner /></div>
      ) : (
        <div className="divide-y divide-hairline border-t border-hairline">
          <Row title="Diagnose every new alert automatically" hint="Read-only, like a health scan: it gathers evidence and finds the cause. Investigate then starts the fix, and every change waits for approval.">
            <Switch label="Automatic diagnosis" checked={c.autoTriage} disabled={!canEdit || save.isPending} onChange={(v) => save.mutate({ autoTriage: v })} />
          </Row>
          {c.autoTriage && (
            <>
              <Row title="Only from severity" hint="Unknown severity counts as warning.">
                <Segmented
                  label="Minimum severity"
                  value={c.triageMinSeverity}
                  disabled={!canEdit}
                  onChange={(v) => save.mutate({ triageMinSeverity: v })}
                  options={[{ value: 'info', label: 'Every alert' }, { value: 'warning', label: 'Warning and up' }, { value: 'critical', label: 'Critical' }]}
                />
              </Row>
              <Row title="Wait before diagnosing" hint="Problems rarely arrive as one alert: related alerts that start within a few minutes join the incident first, so it is diagnosed once, as a whole.">
                <Segmented
                  label="Wait"
                  value={String(c.triageGatherSeconds) as '0' | '60' | '180' | '300'}
                  disabled={!canEdit}
                  onChange={(v) => save.mutate({ triageGatherSeconds: Number(v) })}
                  options={[{ value: '0', label: 'None' }, { value: '60', label: '1 min' }, { value: '180', label: '3 min' }, { value: '300', label: '5 min' }]}
                />
              </Row>
              <Row title="At most per hour" hint="Automatic diagnoses across all projects; beyond this, incidents still get their evidence and Investigate starts one.">
                <Segmented
                  label="Per hour"
                  value={String(c.triageMaxPerHour) as '6' | '20' | '50'}
                  disabled={!canEdit}
                  onChange={(v) => save.mutate({ triageMaxPerHour: Number(v) })}
                  options={[{ value: '6', label: '6' }, { value: '20', label: '20' }, { value: '50', label: '50' }, ...(![6, 20, 50].includes(c.triageMaxPerHour) ? [{ value: String(c.triageMaxPerHour) as '6', label: String(c.triageMaxPerHour) }] : [])]}
                />
              </Row>
            </>
          )}
          <Row title="Raise an incident when something runs out within" hint={`Critical when under ${c.predictCriticalHours}h away. Forecasts further out are shown, not raised.`}>
            <Segmented
              label="Prediction horizon"
              value={String(c.predictWarningHours) as '12' | '24' | '72'}
              disabled={!canEdit}
              onChange={(v) => save.mutate({ predictWarningHours: Number(v), predictCriticalHours: Math.max(1, Number(v) / 6) })}
              options={[{ value: '12', label: '12h' }, { value: '24', label: '24h' }, { value: '72', label: '3 days' }, ...(![12, 24, 72].includes(c.predictWarningHours) ? [{ value: String(c.predictWarningHours) as '12', label: `${c.predictWarningHours}h` }] : [])]}
            />
          </Row>
          <Row title="Reply in the Slack thread" hint="When an alert arrived through Slack, post its diagnosis as a reply in that alert's thread.">
            <Switch label="Reply in Slack threads" checked={c.slackThreadReplies} disabled={!canEdit || save.isPending} onChange={(v) => save.mutate({ slackThreadReplies: v })} />
          </Row>
          <Row
            title="Flapping after"
            hint={`An alert that fires and resolves this often within ${c.flapWindowMin} minutes stays one incident, is marked flapping, and is diagnosed once it has been quiet that long.`}
          >
            <Segmented
              label="Flapping threshold"
              value={String(c.flapChanges) as '4' | '6' | '10'}
              disabled={!canEdit}
              onChange={(v) => save.mutate({ flapChanges: Number(v) })}
              options={[{ value: '4', label: '4 changes' }, { value: '6', label: '6' }, { value: '10', label: '10' }, ...(![4, 6, 10].includes(c.flapChanges) ? [{ value: String(c.flapChanges) as '4', label: String(c.flapChanges) }] : [])]}
            />
          </Row>
          <Row title="Sample signals every" hint="Each signal is one query per sample.">
            <Segmented
              label="Watch interval"
              value={String(c.watchIntervalMs / 60_000) as '1' | '5' | '15'}
              disabled={!canEdit}
              onChange={(v) => save.mutate({ watchIntervalMs: Number(v) * 60_000 })}
              options={[{ value: '1', label: '1m' }, { value: '5', label: '5m' }, { value: '15', label: '15m' }]}
            />
          </Row>
          <Row title="Keep history for" hint="Closed alerts and incidents, observations and metric samples. Open ones are always kept.">
            <Segmented
              label="Observability retention"
              value={days as '7' | '15' | '30'}
              disabled={!canEdit || !storage.data || saveDays.isPending}
              onChange={(v) => saveDays.mutate(Number(v))}
              options={[{ value: '7', label: '7 days' }, { value: '15', label: '15 days' }, { value: '30', label: '30 days' }, ...(!['7', '15', '30'].includes(days) ? [{ value: days as '7', label: `${days} days` }] : [])]}
            />
          </Row>
          {error && <p className="px-5 py-3 text-sm text-red">{error.message}</p>}
          {!canEdit && <p className="px-5 py-3 text-[11px] text-muted">Only owners and admins can change these.</p>}
        </div>
      )}
    </Panel>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm text-ink">{title}</div>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
