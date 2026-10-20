import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Archive, BookOpen, Check, Eye, FileText, Pencil, Play, Plus, Search, Trash2, Upload } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';
import { PageHeader } from '../components/Layout';
import { ServiceMap } from '../components/servicemap/ServiceMap';
import { Markdown } from '../components/Markdown';
import { Empty, Panel, Segmented, Spinner, Switch } from '../components/ui';
import { KnowledgeImport } from '../components/KnowledgeImport';
import type { Target } from '../lib/types';

type Kind = 'runbook' | 'note' | 'fact';
type Status = 'draft' | 'approved' | 'archived';

export interface KnowledgeDoc {
  id: string;
  projectId: string;
  slug: string;
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  scope: { targetIds?: string[]; kinds?: string[]; envs?: string[] };
  pinned: boolean;
  /** Runbooks: the alerts it is for (names or Alertmanager matchers). */
  alertMatch?: string | null;
  status: Status;
  /** Where an imported document came from, e.g. "ops-handbook.pdf, p. 4–7". */
  source?: string | null;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number | null;
  usedIn?: Array<{ runId: string; via: string; at: number; title: string }>;
}

const KIND_LABEL: Record<Kind, string> = { runbook: 'Runbook', note: 'Note', fact: 'Fact' };

/**
 * Knowledge: runbooks, notes and facts the agent is given at the start of a run.
 * Only approved documents reach a run; members write drafts that an admin approves.
 */
export function Knowledge() {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [status, setStatus] = useState<Status>('approved');
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  /** The service map at full width (the document list hides). */
  const [mapExpanded, setMapExpanded] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const qc = useQueryClient();

  const list = useQuery({
    queryKey: ['knowledge', projectId, status, q],
    queryFn: () =>
      api<KnowledgeDoc[]>(q.trim() ? `/knowledge?projectId=${projectId}&q=${encodeURIComponent(q.trim())}` : `/knowledge?projectId=${projectId}&status=${status}`),
    enabled: !!projectId,
  });
  const drafts = useQuery({
    queryKey: ['knowledge-drafts', projectId],
    queryFn: () => api<{ drafts: number }>(`/knowledge/drafts/count?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const docs = (list.data ?? []).filter((d) => kind === 'all' || d.kind === kind);

  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="Runbooks, notes and facts your agents are given at the start of every run. Only approved documents are used."
        action={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => { setImporting(true); setNotice(null); }}>
              <Upload size={16} /> Import
            </button>
            <button className="btn-primary" onClick={() => { setImporting(false); setSelected('new'); }}>
              <Plus size={16} /> New document
            </button>
          </div>
        }
      />
      {importing ? (
        <div className="p-6">
          <KnowledgeImport
            projectId={projectId!}
            isAdmin={isAdmin}
            onClose={() => setImporting(false)}
            onSaved={(message) => {
              setImporting(false);
              setNotice(message);
              setStatus(isAdmin ? 'approved' : 'draft');
              void qc.invalidateQueries({ queryKey: ['knowledge'] });
              void qc.invalidateQueries({ queryKey: ['knowledge-drafts'] });
            }}
          />
        </div>
      ) : (
      mapExpanded && !selected ? (
        <div className="p-6">
          <ServiceMap projectId={projectId!} isAdmin={isAdmin} expanded onToggleExpand={() => setMapExpanded(false)} />
        </div>
      ) : (
      <div className="grid grid-cols-1 gap-4 p-6 lg:grid-cols-5">
        <div className="min-w-0 space-y-3 lg:col-span-2">
          {notice && (
            <p className="flex items-center gap-2 rounded-inner border border-green/30 bg-green/10 px-3 py-2 text-xs text-green">
              <Check size={14} /> {notice}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Status"
              value={status}
              onChange={(v) => { setStatus(v); setQ(''); }}
              options={[
                { value: 'approved', label: 'Approved' },
                { value: 'draft', label: `Drafts${drafts.data?.drafts ? ` (${drafts.data.drafts})` : ''}` },
                { value: 'archived', label: 'Archived' },
              ]}
            />
            <Segmented
              label="Kind"
              value={kind}
              onChange={setKind}
              options={[{ value: 'all', label: 'All' }, { value: 'runbook', label: 'Runbooks' }, { value: 'note', label: 'Notes' }, { value: 'fact', label: 'Facts' }]}
            />
          </div>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input className="input pl-9" placeholder="Search approved knowledge…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search knowledge" />
          </div>
          <Panel>
            {list.isLoading ? (
              <div className="grid h-24 place-items-center text-muted"><Spinner /></div>
            ) : docs.length ? (
              <ul className="divide-y divide-hairline">
                {docs.map((d) => (
                  <li key={d.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(d.id)}
                      className={clsx('flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-white/[0.03]', selected === d.id && 'bg-white/[0.04]')}
                    >
                      <BookOpen size={15} className="mt-0.5 shrink-0 text-cyan" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm text-ink">{d.title}</span>
                          {d.pinned && <span className="chip border border-edge bg-tile-2 text-muted">pinned</span>}
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted">
                          {KIND_LABEL[d.kind]} · <span className="font-mono">{d.slug}</span>
                          {d.useCount > 0 && <> · used in {d.useCount} run{d.useCount === 1 ? '' : 's'}</>}
                        </div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty
                icon={<BookOpen size={26} />}
                title={q ? 'No matches' : status === 'draft' ? 'No drafts waiting' : 'Nothing here yet'}
                hint="Write down how things are set up and how you fix them, or import existing runbooks and docs — the agent reads them at the start of every run."
              />
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-4 lg:col-span-3">
          {/* An open document goes on top; the service map moves down, still there. */}
          {selected && (
            <DocEditor
              key={selected}
              id={selected === 'new' ? null : selected}
              projectId={projectId!}
              isAdmin={isAdmin}
              onClose={() => setSelected(null)}
            />
          )}
          <ServiceMap projectId={projectId!} isAdmin={isAdmin} expanded={false} onToggleExpand={() => { setSelected(null); setMapExpanded(true); }} />
        </div>
      </div>
      )
      )}
    </>
  );
}

function DocEditor({ id, projectId, isAdmin, onClose }: { id: string | null; projectId: string; isAdmin: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const doc = useQuery({ queryKey: ['knowledge-doc', id], queryFn: () => api<KnowledgeDoc>(`/knowledge/${id}`), enabled: !!id });
  const targets = useQuery({ queryKey: ['targets', projectId], queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`) });
  const [form, setForm] = useState({ slug: '', kind: 'note' as Kind, title: '', body: '', tags: '', pinned: false, alertMatch: '', envs: [] as string[], targetIds: [] as string[] });
  const [editing, setEditing] = useState(!id);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = doc.data;
    if (!d) return;
    setForm({ slug: d.slug, kind: d.kind, title: d.title, body: d.body, tags: d.tags.join(', '), pinned: d.pinned, alertMatch: d.alertMatch ?? '', envs: d.scope.envs ?? [], targetIds: d.scope.targetIds ?? [] });
  }, [doc.data]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['knowledge'] });
    void qc.invalidateQueries({ queryKey: ['knowledge-drafts'] });
    void qc.invalidateQueries({ queryKey: ['knowledge-doc', id] });
  };
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : 'Could not save');
  const body = () => ({
    kind: form.kind,
    title: form.title.trim(),
    body: form.body,
    tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
    pinned: form.pinned,
    ...(form.kind === 'runbook' ? { alertMatch: form.alertMatch.trim() || null } : {}),
    scope: { ...(form.envs.length ? { envs: form.envs } : {}), ...(form.targetIds.length ? { targetIds: form.targetIds } : {}) },
  });
  const save = useMutation({
    mutationFn: () => (id ? patch(`/knowledge/${id}`, body()) : post('/knowledge', { projectId, slug: form.slug, ...body() })),
    onSuccess: () => { refresh(); if (!id) onClose(); else setEditing(false); },
    onError: fail,
  });
  const act = useMutation({
    mutationFn: (what: 'approve' | 'archive' | 'restore') => post(`/knowledge/${id}/${what}`, {}),
    onSuccess: refresh,
    onError: fail,
  });
  const remove = useMutation({ mutationFn: () => del(`/knowledge/${id}`), onSuccess: () => { refresh(); onClose(); }, onError: fail });

  if (id && doc.isLoading) return <Panel><div className="grid h-40 place-items-center text-muted"><Spinner /></div></Panel>;
  const d = doc.data;
  const canEdit = !d || isAdmin || d.status === 'draft';
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Panel
      title={d ? d.title : 'New document'}
      accent={d?.status === 'approved' ? 'bg-green' : d?.status === 'archived' ? 'bg-dim' : 'bg-amber'}
      action={d && <span className="text-[11px] text-muted">{d.status}{d.updatedAt ? ` · edited ${timeAgo(d.updatedAt)}` : ''}</span>}
    >
      <div className="space-y-4 px-5 pb-5 pt-1">
        {d && d.status === 'draft' && (
          <p className="rounded-inner border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
            Draft — not used by any run until an admin approves it.
          </p>
        )}

        {editing ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              {!id && (
                <label className="block"><span className="label">Slug</span>
                  <input className="input font-mono" value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
                </label>
              )}
              <label className={clsx('block', id ? 'sm:col-span-2' : '')}><span className="label">Title</span>
                <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </label>
              <div><span className="label">Kind</span>
                <Segmented label="Kind" value={form.kind} onChange={(k) => setForm({ ...form, kind: k, pinned: k === 'fact' ? true : form.pinned })} options={[{ value: 'runbook', label: 'Runbook' }, { value: 'note', label: 'Note' }, { value: 'fact', label: 'Fact' }]} />
              </div>
            </div>
            <label className="block">
              <span className="label">{form.kind === 'runbook' ? 'Steps (Markdown)' : 'Text (Markdown)'} · about {Math.round(form.body.length / 4)} tokens</span>
              <textarea className="input min-h-56 resize-y font-mono text-xs leading-relaxed" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })}
                placeholder={form.kind === 'fact' ? 'e.g. db-1 is the PostgreSQL primary; db-2 is the streaming replica.' : form.kind === 'runbook' ? '1. Check disk with df -h\n2. …' : 'How this part of the system is set up…'} />
            </label>
            {form.kind === 'runbook' && (
              <label className="block">
                <span className="label">For these alerts (optional)</span>
                <input className="input font-mono text-xs" value={form.alertMatch} onChange={(e) => setForm({ ...form, alertMatch: e.target.value })}
                  placeholder={'DiskFilling, HighMemory*   or   alertname=~"Disk.*", env="prod"'} />
                <span className="mt-1 block text-[11px] text-muted">
                  Alert names (* matches anything) or matchers. An incident with a matching alert is diagnosed by following this runbook, and the answer says which steps were followed.
                </span>
              </label>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block"><span className="label">Tags (comma-separated)</span>
                <input className="input" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
              </label>
              <div><span className="label">Applies to environments (none = all)</span>
                <div className="flex gap-3 text-xs text-muted">
                  {['dev', 'staging', 'prod'].map((e) => (
                    <label key={e} className="flex items-center gap-1.5"><input type="checkbox" checked={form.envs.includes(e)} onChange={() => setForm({ ...form, envs: toggle(form.envs, e) })} /> {e}</label>
                  ))}
                </div>
              </div>
            </div>
            {!!targets.data?.length && (
              <div><span className="label">Applies to targets (none = all)</span>
                <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
                  {targets.data.map((t) => (
                    <button key={t.id} type="button" onClick={() => setForm({ ...form, targetIds: toggle(form.targetIds, t.id) })}
                      className={clsx('chip border font-mono', form.targetIds.includes(t.id) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted')}>
                      {t.slug}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-3">
              <Switch label="Pinned" checked={form.pinned} onChange={(v) => setForm({ ...form, pinned: v })} />
              <span className="text-sm text-ink">Pinned</span>
              <span className="text-[11px] text-muted">Always included in matching runs (otherwise only when relevant to the task).</span>
            </div>
            <div className="flex gap-2">
              <button className="btn-primary" disabled={save.isPending || !form.title.trim() || !form.body.trim() || (!id && !form.slug)} onClick={() => save.mutate()}>
                {save.isPending ? <Spinner /> : null} {id ? 'Save' : isAdmin ? 'Create' : 'Save draft'}
              </button>
              <button className="btn-ghost" onClick={() => (id ? setEditing(false) : onClose())}>Cancel</button>
            </div>
          </>
        ) : (
          d && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                <span className="chip border border-edge bg-tile-2">{KIND_LABEL[d.kind]}</span>
                <span className="font-mono">{d.slug}</span>
                {d.pinned && <span>· pinned</span>}
                {d.kind === 'runbook' && d.alertMatch && <span className="min-w-0 break-all">· for alerts <span className="font-mono text-ink/80">{d.alertMatch}</span></span>}
                {d.scope.envs?.length ? <span>· {d.scope.envs.join(', ')} only</span> : null}
                {d.scope.targetIds?.length ? <span>· {d.scope.targetIds.length} target{d.scope.targetIds.length === 1 ? '' : 's'}</span> : null}
                {d.tags.map((t) => <span key={t} className="chip border border-edge bg-tile-2">{t}</span>)}
              </div>
              {d.source && (
                <p className="flex items-center gap-1.5 text-[11px] text-muted"><FileText size={12} /> Imported from {d.source}</p>
              )}
              <div className="rounded-inner border border-hairline bg-ground/40 p-4"><Markdown>{d.body}</Markdown></div>
              <div className="flex flex-wrap gap-2">
                {canEdit && <button className="btn-ghost" onClick={() => setEditing(true)}><Pencil size={15} /> Edit</button>}
                {d.kind === 'runbook' && d.status === 'approved' && (
                  <Link className="btn-primary" to={`/investigate?runbook=${d.id}`}><Play size={15} /> Run this runbook</Link>
                )}
                {isAdmin && d.status === 'draft' && <button className="btn-primary" onClick={() => act.mutate('approve')}><Check size={15} /> Approve</button>}
                {isAdmin && d.status !== 'archived' && <button className="btn-ghost" onClick={() => act.mutate('archive')}><Archive size={15} /> Archive</button>}
                {isAdmin && d.status === 'archived' && <button className="btn-ghost" onClick={() => act.mutate('restore')}><Eye size={15} /> Restore as draft</button>}
                {(isAdmin || d.status === 'draft') && <button className="btn-ghost ml-auto hover:!text-red" onClick={() => remove.mutate()}><Trash2 size={15} /> Delete</button>}
              </div>
              {!!d.usedIn?.length && (
                <div className="border-t border-hairline pt-3">
                  <div className="mb-1 text-xs text-muted">Used in</div>
                  <ul className="space-y-1 text-[11px]">
                    {d.usedIn.map((u) => (
                      <li key={u.runId + u.at}><Link to={`/runs/${u.runId}`} className="text-blue-text hover:underline">{u.title}</Link> <span className="text-muted">· {u.via} · {timeAgo(u.at)}</span></li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )
        )}
        {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
      </div>
    </Panel>
  );
}
