import { z } from 'zod';
import type { RiskContribution } from '@supops/shared';
import type { ScmConfig } from '@supops/db';
import type { ExecContext, ResolvedTarget, ToolDef } from './types.ts';
import { errOutput, stripAnsi } from './output.ts';
import { followAllowedRedirect, safeGet } from './executors/http.ts';
import { done } from './observability.ts';

/**
 * Read GitHub or GitLab: CI runs and why they failed, pull/merge requests with their
 * checks and changed files, commits, a file, issues and releases. Read-only, and only
 * for the repositories the connection allows -- a token often reaches far more.
 */

const READ: RiskContribution[] = [{ stage: 'arguments', tier: 'read_only', ruleId: 'scm.read', reason: 'a read-only query against a source control API' }];

const OPS = ['runs', 'run', 'pulls', 'pull', 'commits', 'file', 'issues', 'releases'] as const;
const REPO = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/;

const args = z.object({
  target: z.string(),
  operation: z.enum(OPS),
  repo: z.string().max(200).regex(REPO, 'owner/name (GitHub) or group/project (GitLab)'),
  id: z.union([z.string().max(64), z.number().int()]).optional(),
  branch: z.string().max(200).optional(),
  path: z.string().max(500).optional(),
  ref: z.string().max(200).optional(),
  state: z.enum(['open', 'closed', 'merged', 'all']).optional(),
  failed_only: z.boolean().optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type Args = z.infer<typeof args>;

/** Where GitHub and GitLab serve job logs after a redirect; nothing else is followed. */
const LOG_HOSTS = [/\.blob\.core\.windows\.net$/, /(^|\.)githubusercontent\.com$/, /(^|\.)actions\.githubusercontent\.com$/, /(^|\.)storage\.googleapis\.com$/, /(^|\.)amazonaws\.com$/];

const cfgOf = (t: ResolvedTarget) => t.config as unknown as ScmConfig;

/** A repo glob (`acme/*`, `platform/**`) as a regular expression. */
const globRe = (g: string) => new RegExp(`^${g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^]*')}$`, 'i');

/** Whether the connection allows this repository. An empty list allows nothing. */
export function repoAllowed(cfg: Pick<ScmConfig, 'repos'>, repo: string): boolean {
  return cfg.repos.some((g) => globRe(g.trim()).test(repo));
}

function token(t: ResolvedTarget): string | null {
  if (!t.secret) return null;
  try {
    const a = JSON.parse(t.secret) as { type?: string; token?: string };
    return a.type === 'bearer' && a.token ? a.token : null;
  } catch {
    return t.secret;
  }
}

function headers(t: ResolvedTarget, accept?: string): Record<string, string> {
  const cfg = cfgOf(t);
  const tok = token(t);
  return cfg.kind === 'github'
    ? { accept: accept ?? 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }
    : { accept: accept ?? 'application/json', ...(tok ? { 'private-token': tok } : {}) };
}

/** GitLab's API lives under /api/v4 of the instance; GitHub's base URL is the API itself. */
const apiPath = (cfg: ScmConfig, p: string) => (cfg.kind === 'gitlab' ? `/api/v4${p}` : p);
const gl = (repo: string) => encodeURIComponent(repo);

async function get(ctx: ExecContext, p: string, query: Record<string, string | number | undefined> = {}, opts: { raw?: boolean; accept?: string; follow?: boolean } = {}): Promise<{ error: string } | { body: string; json?: unknown }> {
  const cfg = cfgOf(ctx.target);
  try {
    const first = await safeGet({
      baseUrl: cfg.baseUrl,
      path: apiPath(cfg, p),
      query,
      headers: headers(ctx.target, opts.accept),
      allowPrivateNetwork: cfg.allowPrivateNetwork,
      insecureSkipVerify: cfg.insecureSkipVerify,
      timeoutMs: ctx.timeoutMs,
      maxBytes: 3 * 1024 * 1024,
      signal: ctx.signal,
    });
    const r = opts.follow ? await followAllowedRedirect(first, LOG_HOSTS, { timeoutMs: ctx.timeoutMs, maxBytes: 3 * 1024 * 1024, signal: ctx.signal }) : first;
    if (r.status >= 300 && r.status < 400) return { error: `redirected to ${r.location ? new URL(r.location, cfg.baseUrl).hostname : 'another address'}, which SupOps does not follow` };
    if (r.status === 404) return { error: 'not found (or the token cannot see it)' };
    if (r.status >= 400) return { error: `HTTP ${r.status}: ${r.body.slice(0, 300)}` };
    if (opts.raw) return { body: r.body };
    return { body: r.body, json: JSON.parse(r.body) as unknown };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** A CI log, cut to what explains a failure: error-looking lines (with a little context) and the tail. */
export function condenseLog(raw: string, tail = 40): string {
  const lines = stripAnsi(raw).split('\n').map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '').replace(/\r$/, ''));
  const hit = /\b(error|failed|failure|fatal|exception|panic|traceback|denied|not found|exit code [1-9]|exited with)\b/i;
  const keep = new Set<number>();
  lines.forEach((l, i) => { if (hit.test(l)) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j += 1) keep.add(j); });
  const picked = [...keep].sort((a, b) => a - b).slice(-60);
  const start = Math.max(0, lines.length - tail);
  const out: string[] = [];
  let last = -2;
  for (const i of picked.filter((i) => i < start)) {
    if (i !== last + 1) out.push('  ...');
    out.push(lines[i]!);
    last = i;
  }
  if (out.length) out.push(`  ... (last ${lines.length - start} lines:)`);
  out.push(...lines.slice(start));
  return out.join('\n');
}

const day = (s: unknown) => (typeof s === 'string' ? s.slice(0, 16).replace('T', ' ') : '');

async function githubOp(ctx: ExecContext, a: Args): Promise<string> {
  const r = `/repos/${a.repo}`;
  const n = a.limit ?? 15;
  switch (a.operation) {
    case 'runs': {
      const res = await get(ctx, `${r}/actions/runs`, { per_page: n, branch: a.branch, status: a.failed_only ? 'failure' : undefined });
      if ('error' in res) return `ERROR: ${res.error}`;
      const runs = ((res.json as { workflow_runs?: Array<Record<string, unknown>> }).workflow_runs ?? []);
      return runs.length ? runs.map((w) => `#${w.id} ${w.name} on ${w.head_branch} (${String(w.head_sha).slice(0, 7)}): ${w.conclusion ?? w.status} · ${day(w.created_at)} · ${w.event}`).join('\n') : 'No runs.';
    }
    case 'run': {
      if (!a.id) return 'ERROR: give the run id (from operation runs)';
      const res = await get(ctx, `${r}/actions/runs/${a.id}/jobs`, { per_page: 50 });
      if ('error' in res) return `ERROR: ${res.error}`;
      const jobs = ((res.json as { jobs?: Array<{ id: number; name: string; conclusion: string | null; status: string; steps?: Array<{ name: string; conclusion: string | null }> }> }).jobs ?? []);
      const out = jobs.map((j) => `job ${j.id} ${j.name}: ${j.conclusion ?? j.status}${j.conclusion === 'failure' ? ` (failed step: ${j.steps?.find((s) => s.conclusion === 'failure')?.name ?? '?'})` : ''}`);
      for (const j of jobs.filter((j) => j.conclusion === 'failure').slice(0, 2)) {
        const log = await get(ctx, `${r}/actions/jobs/${j.id}/logs`, {}, { raw: true, follow: true });
        out.push('', `--- log of ${j.name}, condensed ---`, 'error' in log ? `(could not read the log: ${log.error})` : condenseLog(log.body));
      }
      return out.join('\n');
    }
    case 'pulls': {
      const res = await get(ctx, `${r}/pulls`, { state: a.state === 'merged' ? 'closed' : a.state ?? 'open', per_page: n, sort: 'updated', direction: 'desc' });
      if ('error' in res) return `ERROR: ${res.error}`;
      const prs = (res.json as Array<Record<string, unknown> & { user?: { login?: string }; head?: { ref?: string } }>).filter((p) => a.state !== 'merged' || p.merged_at);
      return prs.length ? prs.map((p) => `#${p.number} ${p.title} · ${p.user?.login ?? '?'} · ${p.head?.ref ?? ''} · ${p.merged_at ? `merged ${day(p.merged_at)}` : p.state}`).join('\n') : 'None.';
    }
    case 'pull': {
      if (!a.id) return 'ERROR: give the pull request number';
      const pr = await get(ctx, `${r}/pulls/${a.id}`);
      if ('error' in pr) return `ERROR: ${pr.error}`;
      const p = pr.json as Record<string, unknown> & { user?: { login?: string }; head?: { sha?: string; ref?: string }; base?: { ref?: string } };
      const files = await get(ctx, `${r}/pulls/${a.id}/files`, { per_page: 100 });
      const checks = p.head?.sha ? await get(ctx, `${r}/commits/${p.head.sha}/check-runs`, { per_page: 50 }) : { error: 'no head' };
      const out = [`#${p.number} ${p.title} (${p.state}${p.merged_at ? `, merged ${day(p.merged_at)}` : ''}) by ${p.user?.login ?? '?'}: ${p.head?.ref} -> ${p.base?.ref}`, String(p.body ?? '').slice(0, 1500)];
      if (!('error' in checks)) out.push('', 'Checks:', ...((checks.json as { check_runs?: Array<{ name: string; conclusion: string | null; status: string }> }).check_runs ?? []).map((c) => `  ${c.name}: ${c.conclusion ?? c.status}`));
      if (!('error' in files)) out.push('', 'Files:', ...(files.json as Array<{ filename: string; status: string; additions: number; deletions: number }>).map((f) => `  ${f.status} ${f.filename} (+${f.additions} -${f.deletions})`));
      return out.join('\n');
    }
    case 'commits': {
      const res = await get(ctx, `${r}/commits`, { per_page: n, sha: a.branch ?? a.ref, path: a.path });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<{ sha: string; commit: { message: string; author?: { name?: string; date?: string } } }>).map((c) => `${c.sha.slice(0, 7)} ${day(c.commit.author?.date)} ${c.commit.author?.name ?? ''}: ${c.commit.message.split('\n')[0]}`).join('\n') || 'None.';
    }
    case 'file': {
      if (!a.path) return 'ERROR: give the path';
      const res = await get(ctx, `${r}/contents/${a.path.split('/').map(encodeURIComponent).join('/')}`, { ref: a.ref ?? a.branch }, { raw: true, accept: 'application/vnd.github.raw' });
      return 'error' in res ? `ERROR: ${res.error}` : res.body;
    }
    case 'issues': {
      const res = await get(ctx, `${r}/issues`, { state: a.state === 'merged' ? 'closed' : a.state ?? 'open', per_page: n });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown>>).filter((i) => !i.pull_request).map((i) => `#${i.number} ${i.title} · ${i.state} · ${day(i.updated_at)}`).join('\n') || 'None.';
    }
    case 'releases': {
      const res = await get(ctx, `${r}/releases`, { per_page: n });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown>>).map((x) => `${x.tag_name} ${x.name ?? ''} · ${day(x.published_at)}`).join('\n') || 'None.';
    }
  }
}

async function gitlabOp(ctx: ExecContext, a: Args): Promise<string> {
  const r = `/projects/${gl(a.repo)}`;
  const n = a.limit ?? 15;
  switch (a.operation) {
    case 'runs': {
      const res = await get(ctx, `${r}/pipelines`, { per_page: n, ref: a.branch, status: a.failed_only ? 'failed' : undefined });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown>>).map((p) => `#${p.id} ${p.ref} (${String(p.sha).slice(0, 7)}): ${p.status} · ${day(p.created_at)} · ${p.source}`).join('\n') || 'No pipelines.';
    }
    case 'run': {
      if (!a.id) return 'ERROR: give the pipeline id (from operation runs)';
      const res = await get(ctx, `${r}/pipelines/${a.id}/jobs`, { per_page: 100 });
      if ('error' in res) return `ERROR: ${res.error}`;
      const jobs = res.json as Array<{ id: number; name: string; stage: string; status: string; failure_reason?: string }>;
      const out = jobs.map((j) => `job ${j.id} ${j.stage}/${j.name}: ${j.status}${j.failure_reason ? ` (${j.failure_reason})` : ''}`);
      for (const j of jobs.filter((j) => j.status === 'failed').slice(0, 2)) {
        const log = await get(ctx, `${r}/jobs/${j.id}/trace`, {}, { raw: true, accept: 'text/plain' });
        out.push('', `--- log of ${j.name}, condensed ---`, 'error' in log ? `(could not read the log: ${log.error})` : condenseLog(log.body));
      }
      return out.join('\n');
    }
    case 'pulls': {
      const res = await get(ctx, `${r}/merge_requests`, { state: a.state === 'open' || !a.state ? 'opened' : a.state, per_page: n, order_by: 'updated_at' });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown> & { author?: { username?: string } }>).map((m) => `!${m.iid} ${m.title} · ${m.author?.username ?? '?'} · ${m.source_branch} · ${m.merged_at ? `merged ${day(m.merged_at)}` : m.state}`).join('\n') || 'None.';
    }
    case 'pull': {
      if (!a.id) return 'ERROR: give the merge request iid';
      const mr = await get(ctx, `${r}/merge_requests/${a.id}`);
      if ('error' in mr) return `ERROR: ${mr.error}`;
      const m = mr.json as Record<string, unknown> & { author?: { username?: string }; head_pipeline?: { id?: number; status?: string } };
      const changes = await get(ctx, `${r}/merge_requests/${a.id}/diffs`, { per_page: 100 });
      const out = [`!${m.iid} ${m.title} (${m.state}${m.merged_at ? `, merged ${day(m.merged_at)}` : ''}) by ${m.author?.username ?? '?'}: ${m.source_branch} -> ${m.target_branch}`, String(m.description ?? '').slice(0, 1500)];
      if (m.head_pipeline) out.push('', `Pipeline #${m.head_pipeline.id}: ${m.head_pipeline.status}`);
      if (!('error' in changes)) out.push('', 'Files:', ...(changes.json as Array<{ new_path: string; new_file: boolean; deleted_file: boolean; renamed_file: boolean }>).map((f) => `  ${f.new_file ? 'added' : f.deleted_file ? 'removed' : f.renamed_file ? 'renamed' : 'modified'} ${f.new_path}`));
      return out.join('\n');
    }
    case 'commits': {
      const res = await get(ctx, `${r}/repository/commits`, { per_page: n, ref_name: a.branch ?? a.ref, path: a.path });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<{ short_id: string; title: string; author_name: string; created_at: string }>).map((c) => `${c.short_id} ${day(c.created_at)} ${c.author_name}: ${c.title}`).join('\n') || 'None.';
    }
    case 'file': {
      if (!a.path) return 'ERROR: give the path';
      const res = await get(ctx, `${r}/repository/files/${encodeURIComponent(a.path)}/raw`, { ref: a.ref ?? a.branch ?? 'HEAD' }, { raw: true, accept: 'text/plain' });
      return 'error' in res ? `ERROR: ${res.error}` : res.body;
    }
    case 'issues': {
      const res = await get(ctx, `${r}/issues`, { state: a.state === 'open' || !a.state ? 'opened' : a.state === 'merged' ? 'closed' : a.state, per_page: n });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown>>).map((i) => `#${i.iid} ${i.title} · ${i.state} · ${day(i.updated_at)}`).join('\n') || 'None.';
    }
    case 'releases': {
      const res = await get(ctx, `${r}/releases`, { per_page: n });
      if ('error' in res) return `ERROR: ${res.error}`;
      return (res.json as Array<Record<string, unknown>>).map((x) => `${x.tag_name} ${x.name ?? ''} · ${day(x.released_at)}`).join('\n') || 'None.';
    }
  }
}

/** One cheap call that proves the token works and can see the first allowed repository. */
export async function scmProbe(ctx: ExecContext): Promise<{ ok: boolean; detail: string }> {
  const cfg = cfgOf(ctx.target);
  const first = cfg.repos.find((r) => !r.includes('*'));
  const res = first ? await get(ctx, cfg.kind === 'github' ? `/repos/${first}` : `/projects/${gl(first)}`) : await get(ctx, cfg.kind === 'github' ? '/rate_limit' : '/version');
  if ('error' in res) return { ok: false, detail: res.error };
  return { ok: true, detail: first ? `Connected; can read ${first}.` : 'Connected.' };
}

export const scmTool: ToolDef<Args> = {
  key: 'scm',
  kind: 'http',
  description:
    'Read GitHub or GitLab (read-only), for the repositories this connection allows. ' +
    'runs: recent CI runs (branch, failed_only). run: one run\'s jobs, with each failed job\'s log cut to its errors and tail. ' +
    'pulls / pull: pull or merge requests, and one with its checks and changed files. commits: recent commits (branch, path). ' +
    'file: a file at a ref. issues, releases. Typical use: a deploy failed or a release broke something -> runs failed_only, then run on the failure.',
  parameters: {
    operation: { type: 'string', enum: [...OPS], description: 'runs, run, pulls, pull, commits, file, issues or releases.' },
    repo: { type: 'string', description: 'owner/name on GitHub, group/project on GitLab.' },
    id: { type: 'string', description: 'run: the run or pipeline id; pull: the PR number or MR iid.' },
    branch: { type: 'string', description: 'Filter by branch (runs, commits) or read from it (file).' },
    path: { type: 'string', description: 'file: the path; commits: only commits touching it.' },
    ref: { type: 'string', description: 'file: a commit, tag or branch.' },
    state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], description: 'pulls, issues: default open.' },
    failed_only: { type: 'boolean', description: 'runs: only failed ones.' },
    limit: { type: 'integer', description: 'Most items (default 15, max 50).' },
  },
  required: ['operation', 'repo'],
  argsSchema: args,
  baselineRisk: 'read_only',
  targetKinds: ['github', 'gitlab'],
  mutating: false,
  timeoutMs: 45_000,
  render: (a, t) => `[${t.slug}] ${a.operation} ${a.repo}${a.id ? ` #${a.id}` : ''}${a.path ? ` ${a.path}` : ''}${a.branch ? ` (${a.branch})` : ''}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    const cfg = cfgOf(ctx.target);
    if (!repoAllowed(cfg, a.repo)) return errOutput(`${a.repo} is not one of the repositories this connection allows (${cfg.repos.join(', ') || 'none'}).`);
    const text = cfg.kind === 'github' ? await githubOp(ctx, a) : await gitlabOp(ctx, a);
    return text.startsWith('ERROR: ') ? errOutput(text.slice(7)) : done(ctx, text);
  },
};
