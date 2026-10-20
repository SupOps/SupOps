import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  ArrowUpRight, Check, HeartPulse, Play, Server, ShieldCheck, Sparkles, Terminal, Zap,
} from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { ENV_STYLE, HEALTH_STYLE, SEVERITY_STYLE, duration, elapsed, targetAddress, tierCounts, timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { LowDiskBanner } from '../components/LowDiskBanner';
import { Bento, Tile, TileHead } from '../components/Bento';
import { Empty, EnvBadge, HealthBadge, StatusPill } from '../components/ui';
import {
  BarTrend, HealthRing, MetricTile, RingLegend, RiskBar,
} from '../components/viz';
import type { Agent, DashboardData, HealthOverview, PendingApproval, Run, Target } from '../lib/types';
import { topLevelTargets } from '../lib/types';
import { useLivePoll } from '../lib/live';

const ENV_ORDER = ['prod', 'staging', 'dev'];

// `awaiting_input` is deliberately absent: a parked Console session has finished
// its turn and is waiting on a human, so calling it "Running now" is simply wrong.
const LIVE = ['running', 'queued', 'awaiting_approval', 'suspended'];

export function Dashboard() {
  const projectId = useApp((s) => s.projectId);
  const on = { enabled: !!projectId };

  const stats = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => api<DashboardData>(`/dashboard?projectId=${projectId}`),
    refetchInterval: useLivePoll(5000),
    ...on,
  });
  const runs = useQuery({
    queryKey: ['runs', projectId],
    queryFn: () => api<Run[]>(`/runs?projectId=${projectId}`),
    refetchInterval: useLivePoll(4000),
    ...on,
  });
  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    ...on,
  });
  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`),
    ...on,
  });
  const approvals = useQuery({
    queryKey: ['approvals', projectId],
    queryFn: () => api<PendingApproval[]>(`/runs/approvals/pending?projectId=${projectId}`),
    enabled: !!projectId,
    refetchInterval: useLivePoll(5000),
  });
  const health = useQuery({
    queryKey: ['health', projectId],
    queryFn: () => api<HealthOverview>(`/health/overview?projectId=${projectId}`),
    refetchInterval: useLivePoll(5000),
    ...on,
  });

  const d = stats.data;
  const live = runs.data?.find((r) => LIVE.includes(r.status));
  const hero = live ?? runs.data?.[0];
  const pending = d?.approvals.pending ?? approvals.data?.length ?? 0;

  const autonomy = d?.autonomy;
  const decided = autonomy ? autonomy.auto + autonomy.approved + autonomy.refused + autonomy.blocked : 0;
  const autoPct = decided > 0 ? Math.round(((autonomy?.auto ?? 0) / decided) * 100) : null;

  // Anything that is not `ok` is worth naming explicitly; if the list is empty the
  // tile says so in one line instead of restating the total.
  const unhealthy = Object.entries(d?.targetHealth ?? {}).filter(([state, n]) => state !== 'ok' && n > 0);

  // Machines behind a jump live under their jump's umbrella -- never counted or
  // listed as separate targets outside the Targets page.
  const topTargets = topLevelTargets(targets.data);

  const byEnv = topTargets.reduce<Record<string, number>>((acc, t) => {
    acc[t.env] = (acc[t.env] ?? 0) + 1;
    return acc;
  }, {});

  const hsum = health.data?.latest?.summaryJson;
  const hsched = health.data?.schedule;
  // Notes (non-essential findings) live on the Health page; the dashboard shows real problems only.
  const problems = (health.data?.issues ?? []).filter((i) => i.severity !== 'notice');
  const openIssues = problems.length;
  const hmetrics = new Map((hsum?.targets ?? []).map((m) => [m.targetId, m]));

  const healthSegments = Object.entries(d?.targetHealth ?? {}).map(([state, n]) => ({
    label: (HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!).label,
    value: n,
    hex: (HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!).hex,
  }));

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Everything at a glance — what's running, what's done, and anything waiting on you"
        action={
          <Link to="/investigate" className="btn-primary">
            <Terminal size={16} /> Investigate
          </Link>
        }
      />

      <LowDiskBanner />

      <Bento className="p-6">
        {/* --- hero: the live run, or the last one ------------------------ */}
        <Tile span={6} rows={3} index={0} className="flex flex-col">
          <TileHead
            title={live ? 'Running now' : 'Latest run'}
            accent={live ? 'bg-blue' : 'bg-muted'}
            action={
              hero && (
                <Link to={`/runs/${hero.id}`} className="inline-flex items-center gap-1 text-[11px] text-blue-text hover:underline">
                  Open <ArrowUpRight size={12} />
                </Link>
              )
            }
          />
          {hero ? (
            <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-3">
              <div className="min-h-0 shrink">
                <div className="flex items-center gap-2">
                  <StatusPill status={hero.status} />
                  <span className="text-[11px] text-muted">{timeAgo(hero.startedAt)}</span>
                </div>
                {/* Two lines, and the size scales with the viewport. A long task
                    description used to run to three lines at a fixed 22px and push
                    the meter and the stats out through the bottom of the tile. */}
                <h3 className="mt-2.5 line-clamp-2 text-[clamp(16px,1.45vw,22px)] font-semibold leading-[1.25] tracking-[-0.02em] text-ink">
                  {hero.title}
                </h3>
              </div>

              {/* The tile is locked to three grid rows by the Autonomy tile beside
                  it, so a short run title leaves real slack. This spacer absorbs up
                  to 48px of it into the gap above the meter -- bounded, so it can
                  never reopen the void that `mt-auto` used to create -- and the
                  remainder stays below, where it reads as padding. */}
              <div aria-hidden className="min-h-0 max-h-5 flex-1" />

              {/* shrink-0: the meter and the numbers are the point of the tile, so
                  they hold their space and the title yields instead. */}
              <div className="shrink-0 space-y-2.5">
                {/* The latest-run card keeps the full-width risk bar (fingerprint +
                    tally); the plain tally alone is used where several sit together. */}
                <RiskBar counts={tierCounts(hero.actions ?? [])} bar />
                <dl className="flex flex-wrap gap-x-7 gap-y-1.5">
                  <Stat k="Actions" v={String(hero.actions?.length ?? 0)} />
                  <Stat k="Steps" v={String(hero.iteration)} />
                  <Stat k="Elapsed" v={duration(elapsed(hero.startedAt, hero.endedAt))} />
                  <Stat k="Targets" v={hero.targets?.join(', ') || '—'} />
                </dl>
              </div>
            </div>
          ) : (
            <Empty
              icon={<Zap size={26} />}
              title="No runs yet"
              hint="Describe a problem and the agent investigates it, acting where the risk is low enough."
              action={<Link to="/investigate" className="btn-primary">Investigate something</Link>}
            />
          )}
        </Tile>

        {/* --- approvals: loud when pending, calm when not ----------------- */}
        <Tile
          span={3}
          rows={3}
          index={1}
          interactive
          className={clsx(pending > 0 && 'border-amber/40')}
          onClick={() => (window.location.href = '/approvals')}
        >
          <Link to="/approvals" className="block h-full">
            <MetricTile
              size="lg"
              icon={<ShieldCheck size={22} />}
              label="Awaiting you"
              value={pending}
              tint={pending ? 'text-amber' : 'text-muted'}
              bg={pending ? 'bg-amber/15' : 'bg-white/5'}
              hint={
                pending
                  ? `oldest waiting ${timeAgo(d?.approvals.oldestWaitingSince ?? null)}`
                  : 'nothing is blocked on a human'
              }
            >
              {d && d.approvals.decided > 0 && (
                <div className="mt-5 space-y-3 border-t border-hairline pt-4 text-[13px]">
                  <Row k="Decided" v={String(d.approvals.decided)} />
                  <Row
                    k="Approved"
                    v={d.approvals.approveRate !== null ? `${Math.round(d.approvals.approveRate * 100)}%` : '—'}
                  />
                  <Row
                    k="Median wait"
                    v={d.approvals.avgDecisionMs ? duration(Math.round(d.approvals.avgDecisionMs)) : '—'}
                  />
                </div>
              )}
            </MetricTile>
          </Link>
        </Tile>

        {/* --- autonomy: the product's claim, measured --------------------- */}
        <Tile span={3} rows={3} index={2} className="flex flex-col">
          <TileHead title="Autonomy" accent="bg-green" />
          {decided > 0 ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-5 pb-5">
              {/* 104px, not 132: at the larger size the tile started scrolling as
                  soon as a third outcome appeared. This leaves room for all four
                  legend rows while keeping the percentage comfortably readable. */}
              <HealthRing
                className="shrink-0"
                size={116}
                thickness={11}
                center={autoPct === null ? '—' : `${autoPct}%`}
                caption="unassisted"
                segments={[
                  { label: 'autonomous', value: autonomy!.auto, hex: 'rgb(var(--green))' },
                  { label: 'human approved', value: autonomy!.approved, hex: 'rgb(var(--amber))' },
                  { label: 'rejected', value: autonomy!.refused, hex: 'rgb(var(--red))' },
                  { label: 'blocked by policy', value: autonomy!.blocked, hex: 'rgb(var(--dim))' },
                ]}
              />
              <RingLegend
                dense
                className="w-full shrink-0"
                segments={[
                  { label: 'autonomous', value: autonomy!.auto, hex: 'rgb(var(--green))' },
                  { label: 'human approved', value: autonomy!.approved, hex: 'rgb(var(--amber))' },
                  { label: 'rejected', value: autonomy!.refused, hex: 'rgb(var(--red))' },
                  { label: 'blocked', value: autonomy!.blocked, hex: 'rgb(var(--dim))' },
                ].filter((s) => s.value > 0)}
              />
            </div>
          ) : (
            <Empty title="Nothing measured yet" hint="This fills in once the agent has taken its first action." />
          )}
        </Tile>

        {/* --- fleet + agents --------------------------------------------- */}
        {/* Fleet: the ring carries health, the right column carries composition.
            Previously both said "2" -- the ring's total and the legend's count were
            the same number twice, which is why half the tile read as empty. */}
        <Tile span={4} rows={2} index={3} className="flex flex-col">
          <TileHead
            title="Fleet"
            accent="bg-cyan"
            action={<Link to="/targets" className="text-[11px] text-blue-text hover:underline">All →</Link>}
          />
          {topTargets.length ? (
            <div className="flex flex-1 items-center gap-5 px-5 pb-5">
              <HealthRing
                size={88}
                thickness={9}
                segments={healthSegments}
                center={topTargets.length}
                caption="targets"
              />

              <div className="min-w-0 flex-1 space-y-2.5">
                {/* One verdict line rather than a count that repeats the ring. */}
                {unhealthy.length === 0 ? (
                  <div className="inline-flex items-center gap-1.5 text-xs font-medium text-green">
                    <Check size={13} strokeWidth={2.5} />
                    All reachable
                  </div>
                ) : (
                  <div className="space-y-1">
                    {unhealthy.map(([state, n]) => (
                      <div
                        key={state}
                        className={clsx(
                          'inline-flex items-center gap-1.5 text-xs font-medium',
                          (HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!).text,
                        )}
                      >
                        <span className={clsx('h-1.5 w-1.5 rounded-full', (HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!).dot)} />
                        {n} {(HEALTH_STYLE[state] ?? HEALTH_STYLE.unknown!).label}
                      </div>
                    ))}
                  </div>
                )}

                {/* Composition by environment -- information the ring does not carry. */}
                <div className="flex flex-wrap gap-1.5 border-t border-hairline pt-2.5">
                  {ENV_ORDER.filter((e) => byEnv[e]).map((e) => (
                    <span key={e} className={clsx('chip uppercase', ENV_STYLE[e])}>
                      {e}
                      <span className="tabular font-semibold">{byEnv[e]}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <Empty title="No targets" hint="Register a server so the agent has something to work on." />
          )}
        </Tile>

        <Tile span={4} rows={2} index={4}>
          <MetricTile
            icon={<Sparkles size={18} />}
            label="Agents"
            value={agents.data?.length ?? 0}
            tint="text-violet"
            bg="bg-violet/15"
            hint={agents.data?.map((a) => a.name).join(' · ') || 'none configured'}
          >
            <div className="mt-3 border-t border-hairline pt-2.5">
              <div className="mb-1.5 text-[11px] text-muted">Risk mix across all actions</div>
              <RiskBar counts={d?.tiers ?? {}} />
            </div>
          </MetricTile>
        </Tile>

        <Tile span={4} rows={2} index={5}>
          <MetricTile
            icon={<Play size={18} />}
            label="Runs · 14 days"
            value={d?.activity.reduce((a, b) => a + b.runs, 0) ?? 0}
            tint="text-blue"
            bg="bg-blue/15"
            hint={
              d && d.activity.some((a) => a.failed > 0)
                ? `${d.activity.reduce((a, b) => a + b.failed, 0)} failed`
                : 'no failures'
            }
          >
            <div className="mt-4">
              <BarTrend
                points={d?.activity.map((a) => a.runs) ?? []}
                labels={d?.activity.map((a) =>
                  new Date(`${a.day}T00:00:00`).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  }),
                )}
                ariaLabel={`runs per day over ${d?.activity.length ?? 0} days`}
              />
            </div>
          </MetricTile>
        </Tile>

        {/* --- recent runs, as fingerprints not text ---------------------- */}
        <Tile span={8} rows={4} index={6} className="flex flex-col">
          <TileHead
            title="Recent runs"
            action={<Link to="/runs" className="text-[11px] text-blue-text hover:underline">All →</Link>}
          />
          {runs.data?.length ? (
            <ul className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto">
              {runs.data.slice(0, 8).map((run) => (
                <li key={run.id}>
                  <Link to={`/runs/${run.id}`} className="flex items-center gap-4 px-5 py-3 transition-colors hover:bg-white/[0.03]">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] text-ink">{run.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
                        <StatusPill status={run.status} />
                        <span>·</span>
                        <span>{timeAgo(run.startedAt)}</span>
                        {run.targets?.length ? (
                          <>
                            <span>·</span>
                            <span className="truncate font-mono text-cyan">{run.targets.join(', ')}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <RiskBar counts={tierCounts(run.actions ?? [])} inline className="shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={<Zap size={26} />} title="No runs yet" />
          )}
        </Tile>

        {/* --- targets board ---------------------------------------------- */}
        <Tile span={4} rows={4} index={7} className="flex flex-col">
          <TileHead
            title="Targets"
            accent="bg-cyan"
            action={<Link to="/targets" className="text-[11px] text-blue-text hover:underline">Manage →</Link>}
          />
          {topTargets.length ? (
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4">
              {topTargets.map((t) => {
                const cfg = t.config as { host?: string; user?: string };
                return (
                  <li key={t.id} className="rounded-inner border border-hairline bg-tile-2/60 p-3">
                    <div className="flex items-center gap-2">
                      <Server size={13} className="shrink-0 text-dim" />
                      <span className="truncate font-mono text-xs text-ink">{t.slug}</span>
                      <EnvBadge env={t.env} />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[10px] text-muted">
                        {targetAddress(t)}
                      </span>
                      <HealthBadge state={t.healthState} />
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty icon={<Server size={26} />} title="No targets" />
          )}
        </Tile>

        {/* --- health: the essentials from the latest scan ----------------- */}
        <Tile span={12} rows={2} index={8} className="flex flex-col">
          <TileHead
            title="Health"
            accent="bg-green"
            action={
              <Link to="/health" className="inline-flex items-center gap-1 text-[11px] text-blue-text hover:underline">
                Open <ArrowUpRight size={12} />
              </Link>
            }
          />
          {health.data?.latest ? (
            <div className="flex min-h-0 flex-1 items-stretch gap-5 px-5 pb-5 pt-1">
              {/* Left: the tallies, stacked two-up so they read as a block. */}
              <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-3 self-center">
                <HealthStat label="Checked" value={hsum?.checked ?? 0} tone="text-ink" />
                <HealthStat label="Healthy" value={hsum?.ok ?? 0} tone="text-green" />
                <HealthStat label="Degraded" value={hsum?.degraded ?? 0} tone="text-amber" />
                <HealthStat label="Unreachable" value={hsum?.unreachable ?? 0} tone="text-red" />
              </div>

              <div className="w-px shrink-0 self-stretch bg-hairline" aria-hidden />

              {/* Right: the actionable content -- open issues, else per-target essentials. */}
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
                  <HeartPulse size={13} className={hsched?.enabled ? 'text-green' : 'text-dim'} />
                  <span>
                    {hsched?.enabled
                      ? `Auto ${hsched.scanType} · next ${timeAgo(hsched.nextCheckAt).replace(' ago', '').replace('just now', 'now')}`
                      : 'Automatic checks off'}
                  </span>
                  <span aria-hidden>·</span>
                  <span>last scan {timeAgo(health.data.latest.startedAt)}</span>
                  <span className="ml-auto font-medium text-ink">
                    {openIssues > 0 ? `${openIssues} open issue${openIssues === 1 ? '' : 's'}` : 'no open issues'}
                  </span>
                </div>

                {openIssues > 0 ? (
                  <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
                    {problems.slice(0, 4).map((i) => {
                      const sev = SEVERITY_STYLE[i.severity] ?? SEVERITY_STYLE.unknown!;
                      return (
                        <Link key={i.id} to="/health" className="flex items-center gap-2.5 rounded-inner border border-hairline bg-tile-2/40 px-3 py-2.5 hover:bg-white/[0.03]">
                          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', sev.dot)} aria-hidden />
                          <span className={clsx('chip border shrink-0', sev.chip)}>{sev.label}</span>
                          <span className="truncate text-[13px] text-ink">{i.title}</span>
                        </Link>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto [grid-auto-rows:1fr] [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
                    {topTargets.map((t) => {
                      const m = hmetrics.get(t.id);
                      const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
                      const cfg = t.config as { host?: string; user?: string };
                      const chips = [
                        m?.diskPct != null ? `disk ${m.diskPct}%` : null,
                        m?.memPct != null ? `mem ${m.memPct}%` : null,
                        m?.load1 != null && m.cores ? `cpu ${m.load1.toFixed(1)}/${m.cores}` : null,
                        m?.pods != null ? `${m.pods} pods${m.badPods ? ` · ${m.badPods} bad` : ''}` : null,
                        m?.failedUnits ? `${m.failedUnits} failed` : null,
                      ].filter(Boolean) as string[];
                      return (
                        <div key={t.id} className="flex flex-col justify-center gap-1.5 rounded-inner border border-hairline bg-tile-2/50 px-3.5 py-3">
                          <div className="flex items-center gap-2">
                            <span className={clsx('grid h-6 w-6 shrink-0 place-items-center rounded', h.text)} style={{ background: `color-mix(in srgb, ${h.hex} 14%, transparent)` }}>
                              <Server size={13} />
                            </span>
                            <span className="truncate font-mono text-xs text-ink">{t.slug}</span>
                            <EnvBadge env={t.env} />
                            <span className={clsx('ml-auto text-[11px]', h.text)}>{h.label}</span>
                          </div>
                          <div className="truncate font-mono text-[10px] text-dim">{targetAddress(t)}</div>
                          {chips.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {chips.map((c) => (
                                <span key={c} className="tabular rounded border border-edge bg-tile-2 px-1.5 py-0.5 text-[10px] text-muted">{c}</span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center gap-4 px-5 pb-5 pt-1">
              <div className="grid h-11 w-11 shrink-0 place-items-center rounded-inner bg-green/15 text-green">
                <HeartPulse size={20} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-ink">No health checks yet</div>
                <p className="mt-0.5 text-xs text-muted">
                  Run a Quick or Deep scan, or turn on automatic checks, to see the essentials here.
                </p>
              </div>
              <Link to="/health" className="btn-primary shrink-0">Open Health</Link>
            </div>
          )}
        </Tile>
      </Bento>
    </>
  );
}

const Stat = ({ k, v }: { k: string; v: string }) => (
  // min-w-0 + truncate: a run scoped to several targets used to make this item wide
  // enough to wrap the whole row onto a second line, adding height the tile has not
  // got. The full value stays available on hover.
  <div className="min-w-0">
    <dt className="text-[10px] font-medium uppercase tracking-wider text-muted">{k}</dt>
    <dd className="tabular mt-0.5 truncate text-lg font-semibold leading-none text-ink" title={v}>
      {v}
    </dd>
  </div>
);

const HealthStat = ({ label, value, tone }: { label: string; value: number; tone: string }) => (
  <div className="min-w-0">
    <div className={clsx('tabular text-2xl font-semibold leading-none', tone)}>{value}</div>
    <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-muted">{label}</div>
  </div>
);

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex items-center justify-between gap-3">
    <span className="text-muted">{k}</span>
    <span className="tabular font-semibold text-ink">{v}</span>
  </div>
);
