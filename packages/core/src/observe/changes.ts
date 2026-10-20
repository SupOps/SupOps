import type { SuspectModel } from './suspect-model.ts';
import { learnedAdjustment } from './suspect-model.ts';
/**
 * Changes: deploys, config changes, rollbacks and SupOps' own approved actions. A change
 * never opens an incident; it is evidence. When something breaks, the changes just
 * before it, on the same service or one it depends on, are the first suspects.
 */

export type ChangeKind = 'deploy' | 'config' | 'rollback' | 'flag' | 'infra' | 'action' | 'other';
export const CHANGE_KINDS: ChangeKind[] = ['deploy', 'config', 'rollback', 'flag', 'infra', 'action', 'other'];

/** A change as a sender describes it, before it is stored. */
export interface ChangeInput {
  externalId?: string;
  kind: ChangeKind;
  title: string;
  service?: string;
  environment?: string;
  version?: string;
  previousVersion?: string;
  author?: string;
  url?: string;
  status?: 'started' | 'succeeded' | 'failed';
  startedAt: Date;
  finishedAt?: Date;
  labels?: Record<string, string>;
}

const str = (v: unknown, max = 300): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : undefined);
function time(v: unknown): Date | undefined {
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  if (typeof v === 'string' && v) {
    const t = /^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : Date.parse(v);
    return Number.isNaN(t) ? undefined : new Date(t);
  }
  return undefined;
}
const KIND_WORDS: Array<[RegExp, ChangeKind]> = [[/rollback|revert/i, 'rollback'], [/config|setting/i, 'config'], [/flag|feature/i, 'flag'], [/infra|terraform|scale/i, 'infra'], [/deploy|release|rollout/i, 'deploy']];

function generic(o: Record<string, unknown>, now: Date): ChangeInput | string {
  const service = str(o.service ?? o.app ?? o.application ?? o.component);
  const version = str(o.version ?? o.tag ?? o.image_tag ?? o.revision ?? o.sha, 120);
  const title = str(o.title ?? o.description ?? o.message ?? o.summary) ?? (service ? `${service}${version ? ` ${version}` : ''} deployed` : undefined);
  if (!title) return 'a change needs a title, or a service (and version) to name it by';
  const kindText = str(o.kind ?? o.type) ?? '';
  const kind = (CHANGE_KINDS as string[]).includes(kindText) ? (kindText as ChangeKind) : KIND_WORDS.find(([re]) => re.test(kindText))?.[1] ?? 'deploy';
  const statusText = (str(o.status ?? o.state) ?? '').toLowerCase();
  const status = /fail|error/.test(statusText) ? 'failed' : /start|progress|pending|running/.test(statusText) ? 'started' : statusText ? 'succeeded' : undefined;
  const labels = o.labels && typeof o.labels === 'object' ? Object.fromEntries(Object.entries(o.labels as Record<string, unknown>).filter(([, v]) => typeof v === 'string').slice(0, 30)) as Record<string, string> : undefined;
  return {
    kind,
    title,
    ...(str(o.id ?? o.external_id ?? o.deployment_id, 200) ? { externalId: str(o.id ?? o.external_id ?? o.deployment_id, 200)! } : {}),
    ...(service ? { service } : {}),
    ...(str(o.environment ?? o.env) ? { environment: str(o.environment ?? o.env)! } : {}),
    ...(version ? { version } : {}),
    ...(str(o.previous_version ?? o.from_version, 120) ? { previousVersion: str(o.previous_version ?? o.from_version, 120)! } : {}),
    ...(str(o.author ?? o.user ?? o.actor) ? { author: str(o.author ?? o.user ?? o.actor)! } : {}),
    ...(str(o.url ?? o.link, 1000) ? { url: str(o.url ?? o.link, 1000)! } : {}),
    ...(status ? { status: status as ChangeInput['status'] } : {}),
    startedAt: time(o.started_at ?? o.startedAt ?? o.time ?? o.timestamp) ?? now,
    ...(time(o.finished_at ?? o.finishedAt) ? { finishedAt: time(o.finished_at ?? o.finishedAt)! } : {}),
    ...(labels && Object.keys(labels).length ? { labels } : {}),
  };
}

/** GitHub's deployment_status webhook: the repository is the service, the ref the version. */
function githubDeployment(o: Record<string, unknown>, now: Date): ChangeInput | string {
  const d = (o.deployment ?? {}) as Record<string, unknown>;
  const s = (o.deployment_status ?? {}) as Record<string, unknown>;
  const repo = (o.repository ?? {}) as Record<string, unknown>;
  const state = String(s.state ?? '');
  const service = str(repo.name) ?? 'unknown';
  const version = str(d.ref, 120) ?? str(d.sha, 7);
  return {
    externalId: `github:${String(d.id ?? '')}`,
    kind: 'deploy',
    title: `${service}${version ? ` ${version}` : ''} deployed to ${str(d.environment ?? s.environment) ?? 'an environment'}${str(d.description) ? `: ${str(d.description)}` : ''}`,
    service,
    ...(str(d.environment ?? s.environment) ? { environment: str(d.environment ?? s.environment)! } : {}),
    ...(version ? { version } : {}),
    ...(str((d.creator as Record<string, unknown> | undefined)?.login) ? { author: str((d.creator as Record<string, unknown>).login)! } : {}),
    ...(str(s.target_url ?? s.log_url ?? repo.html_url, 1000) ? { url: str(s.target_url ?? s.log_url ?? repo.html_url, 1000)! } : {}),
    status: state === 'success' ? 'succeeded' : state === 'failure' || state === 'error' ? 'failed' : 'started',
    startedAt: time(d.created_at) ?? now,
    ...(time(s.created_at) && state !== 'in_progress' && state !== 'queued' && state !== 'pending' ? { finishedAt: time(s.created_at)! } : {}),
  };
}

/**
 * What a CI/CD sender posted: one change, `{ "changes": [...] }`, or GitHub's
 * deployment_status event. Generic fields: service, version, title, kind, environment,
 * author, url, status, started_at, finished_at, previous_version, id, labels.
 */
export function parseChangePayload(payload: unknown, now = new Date()): { ok: true; changes: ChangeInput[] } | { ok: false; error: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'Send a JSON object describing the change.' };
  const o = payload as Record<string, unknown>;
  const items = Array.isArray(o.changes) ? (o.changes as unknown[]) : Array.isArray(payload) ? (payload as unknown[]) : [payload];
  if (items.length > 100) return { ok: false, error: 'At most 100 changes per request.' };
  const out: ChangeInput[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'Each change must be a JSON object.' };
    const it = item as Record<string, unknown>;
    const c = it.deployment_status && it.deployment ? githubDeployment(it, now) : generic(it, now);
    if (typeof c === 'string') return { ok: false, error: c };
    out.push(c);
  }
  return out.length ? { ok: true, changes: out } : { ok: false, error: 'No change in the request.' };
}

// ---------------------------------------------------------------------------
// Kubernetes rollouts
// ---------------------------------------------------------------------------

/** What a workload looked like at the last poll. */
export interface WorkloadState {
  generation: number;
  images: Record<string, string>;
}

/**
 * Compare workloads (`kubectl get deployments,statefulsets,daemonsets -o json`) with the
 * last poll. A new generation is a rollout: a deploy when an image changed (with the old
 * and new tag), otherwise a config change (env, resources, replicas are not counted: a
 * scale is not a rollout). The first sight of a workload records it without a change.
 */
export function detectRollouts(prev: Map<string, WorkloadState>, list: unknown, now = new Date()): { changes: ChangeInput[]; next: Map<string, WorkloadState> } {
  const items = ((list as { items?: unknown[] })?.items ?? []) as Array<{
    kind?: string;
    metadata?: { name?: string; namespace?: string; generation?: number; annotations?: Record<string, string> };
    spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ name: string; image: string }> } } };
  }>;
  const next = new Map<string, WorkloadState>();
  const changes: ChangeInput[] = [];
  for (const w of items) {
    const ns = w.metadata?.namespace ?? 'default';
    const name = w.metadata?.name;
    if (!name) continue;
    const key = `${ns}/${(w.kind ?? 'Deployment').toLowerCase()}/${name}`;
    const images = Object.fromEntries((w.spec?.template?.spec?.containers ?? []).map((c) => [c.name, c.image]));
    const state = { generation: w.metadata?.generation ?? 0, images };
    next.set(key, state);
    const before = prev.get(key);
    if (!before || state.generation <= before.generation) continue;
    const changed = Object.keys(images).filter((c) => before.images[c] !== images[c]);
    const tag = (img: string | undefined) => img?.split('@')[0]?.split(':').slice(1).join(':') || img;
    const first = changed[0];
    const cause = w.metadata?.annotations?.['kubernetes.io/change-cause'];
    if (first) {
      changes.push({
        externalId: `k8s:${key}@${state.generation}`,
        kind: 'deploy',
        title: `${name} rolled out ${tag(images[first])}${before.images[first] ? ` (was ${tag(before.images[first])})` : ''}${cause ? `: ${cause}` : ''}`,
        service: name,
        environment: ns,
        version: tag(images[first])!,
        ...(before.images[first] ? { previousVersion: tag(before.images[first])! } : {}),
        startedAt: now,
        labels: { namespace: ns, workload: `${(w.kind ?? 'Deployment').toLowerCase()}/${name}` },
      });
    } else {
      changes.push({
        externalId: `k8s:${key}@${state.generation}`,
        kind: 'config',
        title: `${name} changed (generation ${state.generation}, same images)${cause ? `: ${cause}` : ''}`,
        service: name,
        environment: ns,
        startedAt: now,
        labels: { namespace: ns, workload: `${(w.kind ?? 'Deployment').toLowerCase()}/${name}` },
      });
    }
  }
  return { changes, next };
}

// ---------------------------------------------------------------------------
// Ranking: which changes may have caused this?
// ---------------------------------------------------------------------------

export interface StoredChange {
  id: string;
  kind: ChangeKind;
  title: string;
  service: string | null;
  targetId: string | null;
  startedAt: Date;
  source: string;
  /** A deploy's before/after verdict, when one was worked out. */
  verdict?: { overall: string } | null;
}

export interface RankedChange<C extends StoredChange = StoredChange> {
  change: C;
  /** Higher is likelier. */
  score: number;
  /** In words: why it is a suspect. */
  reason: string;
  relation: 'same' | 'upstream' | 'other';
  /** What the learned ranking sees (SUSPECT_FEATURES order). */
  features: number[];
  /** How much learning moved it (0 when there is no model yet). */
  learned: number;
}

/**
 * Rank the changes before an incident as suspects. Only changes from a day before the
 * first failure until shortly after it count (a change after the failure did not cause
 * it, but one in the same minute may be logged a little late). Same service or machine
 * first, then a service the failing one depends on; within each, the nearest in time.
 */
export function rankChanges<C extends StoredChange>(
  incident: { startedAt: Date; services: string[]; targetIds: string[]; upstream: string[] },
  changes: C[],
  opts: { lookbackMs?: number; graceMs?: number; limit?: number; model?: SuspectModel | null } = {},
): Array<RankedChange<C>> {
  const t0 = incident.startedAt.getTime();
  const from = t0 - (opts.lookbackMs ?? 24 * 3_600_000);
  const to = t0 + (opts.graceMs ?? 2 * 60_000);
  const lower = (s: string) => s.toLowerCase();
  const same = new Set(incident.services.map(lower));
  const up = new Set(incident.upstream.map(lower));
  const targets = new Set(incident.targetIds);
  const out: Array<RankedChange<C>> = [];
  for (const c of changes) {
    const t = c.startedAt.getTime();
    if (t < from || t > to) continue;
    const svc = c.service ? lower(c.service) : null;
    const relation: RankedChange['relation'] = (svc && same.has(svc)) || (c.targetId && targets.has(c.targetId)) ? 'same' : svc && up.has(svc) ? 'upstream' : 'other';
    const before = Math.max(0, t0 - t);
    // Changes on the failing service or one it depends on come before anything else;
    // among those the nearest in time first (the same service slightly ahead), and
    // deploys, rollbacks and config changes a little ahead of other kinds.
    const closeness = 1 / (1 + before / (30 * 60_000)) + (relation === 'same' ? 0.2 : 0);
    const tier = relation === 'other' ? 0 : 2;
    const kindWeight = c.kind === 'deploy' || c.kind === 'rollback' || c.kind === 'config' ? 1 : c.kind === 'action' ? 0.9 : 0.7;
    const mins = Math.round(before / 60_000);
    const when = t > t0 ? 'just after the first failure' : mins < 1 ? 'less than a minute before the first failure' : mins < 120 ? `${mins} min before the first failure` : `${Math.round(mins / 60)} h before the first failure`;
    const where = relation === 'same' ? 'on the failing service' : relation === 'upstream' ? `on ${c.service}, which the failing service depends on` : 'elsewhere';
    const features = [1, relation === 'same' ? 1 : 0, relation === 'upstream' ? 1 : 0, Math.min(1, closeness), c.kind === 'deploy' || c.kind === 'rollback' || c.kind === 'config' ? 1 : 0, c.kind === 'action' ? 1 : 0, c.verdict?.overall === 'worse' ? 1 : 0, t > t0 ? 1 : 0];
    const learned = learnedAdjustment(opts.model ?? null, features);
    const nudge = Math.abs(learned) >= 0.15 ? `; ranked ${learned > 0 ? 'higher' : 'lower'} by what this team confirmed before` : '';
    out.push({ change: c, score: tier + closeness * kindWeight + learned, relation, reason: `${when}, ${where}${nudge}`, features, learned: Number(learned.toFixed(3)) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 8);
}

/** The RECENT CHANGES block for the incident prompt, suspects first. */
export function changesBlock(ranked: Array<RankedChange>): string | null {
  if (!ranked.length) return null;
  return [
    'RECENT CHANGES (possible causes, likeliest first; a change is a suspect, not proof):',
    ...ranked.map((r, i) => `[C${i + 1}] ${r.change.startedAt.toISOString().slice(0, 16).replace('T', ' ')} ${r.change.kind}: ${r.change.title} -- ${r.reason} (source: ${r.change.source})`),
  ].join('\n');
}
