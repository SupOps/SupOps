import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BookOpen, Boxes, GitBranch, Gauge } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { useLivePoll } from '../lib/live';
import { Empty, Panel, Segmented, Spinner } from '../components/ui';
import { PageHeader } from '../components/Layout';
import { LineChart } from '../components/viz';
import { ChangeLine, type Change } from '../components/Changes';
import { ErrorList } from '../components/Errors';
import { SloCard, type Slo } from './Slos';

interface ServiceSummary { name: string; inMap: boolean; lastChange: string | null; openIncidents: number; owner: string | null; tier: string | null }
interface ServiceDetail {
  name: string;
  description: string | null;
  inMap: boolean;
  catalogue: { owner: string | null; team: string | null; runbook: string | null; repo: string | null; tier: string | null };
  dependsOn: Array<{ name: string; type: string }>;
  usedBy: Array<{ name: string; type: string }>;
  window: { start: number; end: number; step: number };
  metrics: null | { family: string; label: string; connection: string; series: Record<string, Array<[number, number]>> };
  changes: Change[];
  incidents: Array<{ id: string; title: string; severity: string; openedAt: string; rootCause: string | null }>;
  slos: Slo[];
}

const FAMILY: Record<string, string> = { 'otel-http': 'OpenTelemetry HTTP metrics', 'otel-http-ms': 'OpenTelemetry HTTP metrics', micrometer: 'Micrometer (Spring) metrics', 'ingress-nginx': 'ingress-nginx metrics', istio: 'Istio metrics', spanmetrics: 'span metrics from traces', 'spanmetrics-s': 'span metrics from traces' };

/** Every service SupOps knows of, trouble first. */
export function Services() {
  const projectId = useApp((s) => s.projectId);
  const list = useQuery({ queryKey: ['services', projectId], queryFn: () => api<ServiceSummary[]>(`/service-health?projectId=${projectId}`), enabled: !!projectId, refetchInterval: useLivePoll(30_000) });
  return (
    <>
      <PageHeader title="Services" subtitle="Each service on one page: its requests, errors and latency from your metrics, its changes, SLOs, open incidents, owner and dependencies." />
      <div className="px-4 pb-8 pt-2 sm:px-6">
        {list.isLoading ? (
          <div className="grid place-items-center py-16"><Spinner /></div>
        ) : list.data?.length ? (
          <Panel>
            <ul className="divide-y divide-hairline">
              {list.data.map((s) => (
                <li key={s.name}>
                  <Link to={`/services/${encodeURIComponent(s.name)}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-white/[0.02]">
                    <span className="min-w-0 flex-1 truncate font-medium text-ink">{s.name}</span>
                    {s.openIncidents > 0 && <span className="chip border-red/30 bg-red/10 text-red">{s.openIncidents} open</span>}
                    <span className="text-[11px] text-muted">
                      {[s.owner && `owner ${s.owner}`, s.tier && `tier ${s.tier}`, s.lastChange && `changed ${timeAgo(s.lastChange)}`, !s.inMap && 'not on the service map'].filter(Boolean).join(' · ')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <Panel>
            <Empty icon={<Boxes size={26} />} title="No services yet" hint="Services come from the service map, from changes your CI reports, and from the labels of open alerts." />
          </Panel>
        )}
      </div>
    </>
  );
}

function Chart({ title, unit, series, markers, empty }: { title: string; unit: string; series: Array<{ key: string; name: string; points: Array<[number, number]> }>; markers: Array<{ at: number; label: string; tone?: 'bad' }>; empty?: string }) {
  return (
    <div className="min-w-0 rounded-inner border border-hairline bg-tile-2/40 p-3">
      <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted">{title}</h3>
      <LineChart series={series.filter((s) => s.points.length)} unit={unit} height={150} markers={markers} empty={empty ?? 'No data in this window'} />
    </div>
  );
}

export function ServiceDetailPage() {
  const { name = '' } = useParams<{ name: string }>();
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const [hours, setHours] = useState<'6' | '24' | '168'>('6');
  const d = useQuery({
    queryKey: ['service', projectId, name, hours],
    queryFn: () => api<ServiceDetail>(`/service-health/${encodeURIComponent(name)}?projectId=${projectId}&hours=${hours}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(60_000),
  });
  const addSlo = useMutation({
    mutationFn: () => post('/slos/from-service', { projectId, service: name, target: 0.999 }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['service', projectId, name] }),
  });
  if (d.isLoading) return <div className="grid h-full place-items-center"><Spinner /></div>;
  if (!d.data) return <div className="grid h-full place-items-center text-muted">Service not found</div>;
  const s = d.data;
  const markers = s.changes.map((c) => ({ at: new Date(c.startedAt).getTime(), label: `${c.kind}: ${c.title}`, ...(c.verdict?.overall === 'worse' ? { tone: 'bad' as const } : {}) }));
  const ser = s.metrics?.series ?? {};
  const pct = (pts?: Array<[number, number]>) => (pts ?? []).map(([t, v]) => [t, v * 100] as [number, number]);
  const cat = s.catalogue;
  return (
    <>
      <header className="border-b border-hairline px-4 py-5 sm:px-6">
        <Link to="/services" className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink"><ArrowLeft size={13} /> All services</Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="break-words text-xl font-semibold text-ink">{s.name}</h1>
            {s.description && <p className="mt-1 text-sm text-muted">{s.description}</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              {cat.owner && <span className="chip border border-edge bg-tile-2">owner {cat.owner}</span>}
              {cat.team && <span className="chip border border-edge bg-tile-2">team {cat.team}</span>}
              {cat.tier && <span className="chip border border-edge bg-tile-2">tier {cat.tier}</span>}
              {cat.runbook && <a className="chip border border-edge bg-tile-2 hover:text-ink" href={cat.runbook} target="_blank" rel="noreferrer"><BookOpen size={11} /> runbook</a>}
              {cat.repo && <a className="chip border border-edge bg-tile-2 hover:text-ink" href={cat.repo.startsWith('http') ? cat.repo : `https://${cat.repo}`} target="_blank" rel="noreferrer"><GitBranch size={11} /> repo</a>}
              {!s.inMap && <span>Not on the service map: add it there for its owner, runbook and dependencies.</span>}
            </div>
          </div>
          <Segmented label="Window" value={hours} onChange={setHours} options={[{ value: '6', label: '6 h' }, { value: '24', label: '24 h' }, { value: '168', label: '7 d' }]} />
        </div>
        {(s.dependsOn.length > 0 || s.usedBy.length > 0) && (
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-xs text-muted">
            {s.dependsOn.length > 0 && <span>Depends on: {s.dependsOn.map((x, i) => <span key={x.name}>{i > 0 && ', '}<Link className="text-blue-text hover:underline" to={`/services/${encodeURIComponent(x.name)}`}>{x.name}</Link></span>)}</span>}
            {s.usedBy.length > 0 && <span>Used by: {s.usedBy.map((x, i) => <span key={x.name}>{i > 0 && ', '}<Link className="text-blue-text hover:underline" to={`/services/${encodeURIComponent(x.name)}`}>{x.name}</Link></span>)}</span>}
          </div>
        )}
      </header>

      <div className="space-y-4 px-4 pb-8 pt-4 sm:px-6">
        {s.incidents.length > 0 && (
          <Panel title="Open incidents" accent="bg-red">
            <ul className="divide-y divide-hairline px-5 pb-4">
              {s.incidents.map((i) => (
                <li key={i.id} className="py-2">
                  <Link to={`/observability/incidents/${i.id}`} className="text-sm text-ink hover:underline">{i.title}</Link>
                  <p className="text-[11px] text-muted">{i.severity} · opened {timeAgo(i.openedAt)}{i.rootCause ? ` · ${i.rootCause}` : ''}</p>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        <Panel title="Requests, errors and latency" accent="bg-blue" action={s.metrics && <span className="text-[11px] text-muted">{FAMILY[s.metrics.family] ?? s.metrics.family} on {s.metrics.connection}, by {s.metrics.label}</span>}>
          <div className="px-5 pb-5">
            {s.metrics ? (
              <>
                <div className="grid gap-3 lg:grid-cols-2">
                  <Chart title="Requests" unit="per_second" markers={markers} series={[{ key: 'rate', name: 'requests/s', points: ser.rate ?? [] }]} />
                  <Chart title="Errors" unit="percent" markers={markers} series={[{ key: 'errors', name: 'failed %', points: pct(ser.errors) }]} />
                  <Chart title="Latency" unit="seconds" markers={markers} series={[{ key: 'p50', name: 'p50', points: ser.p50 ?? [] }, { key: 'p95', name: 'p95', points: ser.p95 ?? [] }, { key: 'p99', name: 'p99', points: ser.p99 ?? [] }]} />
                  {ser.cpu && <Chart title="CPU (cores)" unit="count" markers={markers} series={[{ key: 'cpu', name: 'CPU', points: ser.cpu }]} />}
                  {ser.memory && <Chart title="Memory" unit="bytes" markers={markers} series={[{ key: 'mem', name: 'memory', points: ser.memory }]} />}
                </div>
                {markers.length > 0 && <p className="mt-2 text-[11px] text-muted">Dashed lines are changes (red: a deploy that made things worse).</p>}
              </>
            ) : (
              <p className="text-sm text-muted">
                No request metrics found for {s.name}. SupOps recognises OpenTelemetry HTTP, Micrometer, ingress-nginx, Istio and span metrics in a connected Prometheus or Grafana, by a label naming the service (service_name, job, application, service).
              </p>
            )}
          </div>
        </Panel>

        <Panel title="SLOs" accent="bg-green" action={isAdmin && s.metrics && !s.slos.length ? <button className="btn-ghost !min-h-[32px] !text-xs" disabled={addSlo.isPending} onClick={() => addSlo.mutate()}>{addSlo.isPending ? <Spinner /> : <Gauge size={13} />} Add a 99.9% availability SLO</button> : undefined}>
          <div className="space-y-3 px-5 pb-5">
            {s.slos.length ? s.slos.map((slo) => <SloCard key={slo.id} slo={slo} compact />) : <p className="text-sm text-muted">No SLO for this service. {s.metrics ? 'One can be made from its request metrics.' : <>Define one on the <Link className="text-blue-text hover:underline" to="/slos">SLOs</Link> page.</>}</p>}
            {addSlo.error && <p className="text-xs text-red">{(addSlo.error as Error).message}</p>}
          </div>
        </Panel>

        {projectId && <ErrorList projectId={projectId} service={s.name} title="Errors in this service" />}

        <Panel title="Changes" accent="bg-violet">
          <div className="px-5 pb-5">
            {s.changes.length ? (
              <ul className="divide-y divide-hairline rounded-inner border border-hairline">{s.changes.map((c) => <li key={c.id}><ChangeLine c={c} /></li>)}</ul>
            ) : (
              <p className="text-sm text-muted">No change recorded for {s.name} in the last week.</p>
            )}
          </div>
        </Panel>
      </div>
    </>
  );
}

