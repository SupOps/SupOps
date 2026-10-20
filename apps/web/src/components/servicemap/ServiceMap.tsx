import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowRight, BookOpen, Check, FileImage, FileText, GitMerge, Maximize2, Minimize2, Network, Pencil, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { api, del, patch, post } from '../../lib/api';
import { timeAgo } from '../../lib/format';
import { CERTAINTY, DRIFT, KIND_LABEL, SOURCE_LABEL, TYPE_META, healthOf } from '../../lib/servicemap';
import type { CiLinkKind, CiType, MapItem, MapLink, Proposal, ServiceMapData } from '../../lib/servicemap';
import { Empty, Field, Segmented, Spinner } from '../ui';
import { MapGraph, type Highlight } from './MapGraph';
import { DiagramImport } from './DiagramImport';
import { DIAGRAM_PREFIX } from '@supops/shared';

/**
 * The service map, in the Knowledge page: what the project is made of and how the
 * parts depend on each other, built from your documents (reviewed), registered
 * targets, live connections, Kubernetes and metrics. Every entry shows how sure it
 * is and why; anyone can edit (admins directly, others as suggestions).
 */

type Sel = { kind: 'item' | 'link'; id: string } | null;
type View = 'map' | 'list' | 'suggestions';

export function ServiceMap({ projectId, isAdmin, expanded, onToggleExpand }: { projectId: string; isAdmin: boolean; expanded: boolean; onToggleExpand: () => void }) {
  const qc = useQueryClient();
  const data = useQuery({
    queryKey: ['serviceMap', projectId],
    queryFn: () => api<ServiceMapData>(`/service-map?projectId=${projectId}`),
    refetchInterval: 30_000,
  });
  const [view, setView] = useState<View>('map');
  const [sel, setSel] = useState<Sel>(null);
  const detailHost = useRef<HTMLDivElement>(null);
  // Below the map, bring a newly picked component's details into view.
  useEffect(() => {
    if (!sel || expanded) return;
    detailHost.current?.querySelector('aside')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel?.id, expanded]);
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<'focus' | 'impact' | 'deps'>('focus');
  const [showMonitoring, setShowMonitoring] = useState(false);
  const [form, setForm] = useState<{ kind: 'item'; existing?: MapItem } | { kind: 'link'; existing?: MapLink; fromId?: string } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [diagram, setDiagram] = useState(false);
  const [wipe, setWipe] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['serviceMap', projectId] });

  const discover = useMutation({
    mutationFn: () => post<{ sources: Record<string, { found: number; errors: string[] }> }>('/service-map/discover', { projectId }),
    onSuccess: (r) => {
      const errs = Object.values(r.sources).flatMap((s) => s.errors);
      const found = Object.values(r.sources).reduce((a, s) => a + s.found, 0);
      setNote(
        `Checked the map against what is running: ${found} confirmation${found === 1 ? '' : 's'}. Nothing is added this way; the map comes from your documents, diagrams and edits.` +
          (errs.length ? ` Some sources could not be read: ${errs.slice(0, 2).join('; ')}${errs.length > 2 ? '…' : ''}` : ''),
      );
      refresh();
    },
    onError: (e) => setNote((e as Error).message),
  });
  const fromDocs = useMutation({
    mutationFn: () => post<{ queued: number }>('/service-map/from-documents', { projectId }),
    onSuccess: (r) => {
      setNote(`Reading ${r.queued} approved document${r.queued === 1 ? '' : 's'}. What they add appears under Suggestions for you to accept.`);
      setTimeout(refresh, 8000);
    },
  });

  const d = data.data;
  const items = d?.items ?? [];
  // Drawn once: a host-level connection a service-level one spells out is not repeated.
  const links = useMemo(() => (d?.links ?? []).filter((l) => (showMonitoring || l.kind !== 'monitors') && !l.supersededBy), [d?.links, showMonitoring]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // Monitoring tools with nothing but monitoring links stay off the picture unless asked for.
  const graphItems = useMemo(() => {
    if (showMonitoring) return items;
    const linked = new Set(links.flatMap((l) => [l.fromId, l.toId]));
    return items.filter((i) => i.type !== 'monitoring' || linked.has(i.id) || i.id === sel?.id);
  }, [items, links, showMonitoring, sel?.id]);
  const needle = q.trim().toLowerCase();
  const matches = needle ? new Set(items.filter((i) => `${i.name} ${i.key} ${i.aliases.join(' ')} ${i.type}`.toLowerCase().includes(needle)).map((i) => i.id)) : null;

  const selItem = sel?.kind === 'item' ? itemById.get(sel.id) : undefined;
  const selLink = sel?.kind === 'link' ? d?.links.find((l) => l.id === sel.id) : undefined;
  const impact = useQuery({
    queryKey: ['mapImpact', selItem?.id],
    queryFn: () => api<{ impact: Array<{ id: string; via: string[] }>; dependencies: Array<{ id: string; via: string[] }> }>(`/service-map/items/${selItem!.id}/impact`),
    enabled: !!selItem && mode !== 'focus',
  });

  const highlight: Highlight | null = useMemo(() => {
    if (matches) return { ids: matches, tone: 'search' };
    if (selItem) {
      if (mode !== 'focus' && impact.data) {
        const list = mode === 'impact' ? impact.data.impact : impact.data.dependencies;
        return { ids: new Set([selItem.id, ...list.map((x) => x.id), ...list.flatMap((x) => x.via)]), tone: mode };
      }
      const ids = new Set([selItem.id]);
      for (const l of links) if (l.fromId === selItem.id || l.toId === selItem.id) { ids.add(l.id); ids.add(l.fromId); ids.add(l.toId); }
      return { ids, tone: 'focus' };
    }
    if (selLink) return { ids: new Set([selLink.id, selLink.fromId, selLink.toId]), tone: 'focus' };
    return null;
  }, [matches, selItem, selLink, mode, impact.data, links]);

  const counts = {
    notSeen: (d?.links ?? []).filter((l) => l.confidence.drift === 'not_seen').length,
    notDocumented: (d?.links ?? []).filter((l) => l.confidence.drift === 'not_documented' && l.kind !== 'monitors' && l.kind !== 'runs_on').length,
  };
  const disc = d?.discovery;

  return (
    <section className="tile flex min-w-0 flex-col">
      {/* Header */}
      <header className="flex flex-col gap-3 px-5 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink"><Network size={16} className="text-cyan" /> Service map</h2>
            <p className="mt-0.5 text-xs leading-5 text-muted sm:[&>span]:whitespace-nowrap">
              {items.length} components · {(d?.links ?? []).filter((l) => l.kind !== 'monitors').length} connections
              {counts.notSeen > 0 && <span className="text-red"> · {counts.notSeen} documented but not seen</span>}
              {counts.notDocumented > 0 && <span className="text-cyan"> · {counts.notDocumented} not documented</span>}
              {disc && <span className="text-dim"> · checked live {timeAgo(disc.at)}</span>}
            </p>
          </div>
          <button className="btn-ghost !min-h-[32px] !px-2" onClick={onToggleExpand} aria-label={expanded ? 'Shrink' : 'Expand'} title={expanded ? 'Shrink' : 'Full width'}>
            {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" disabled={fromDocs.isPending} onClick={() => { setNote(null); fromDocs.mutate(); }} title="Read every approved document for components and dependencies">
            <BookOpen size={13} /> From documents
          </button>
          <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" onClick={() => { setNote(null); setDiagram(true); }} title="A picture, draw.io file, or Mermaid / PlantUML / Graphviz text of your architecture">
            <FileImage size={13} /> From a diagram
          </button>
          <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" onClick={() => setForm({ kind: 'item' })}><Plus size={13} /> Component</button>
          <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" onClick={() => setForm({ kind: 'link' })} disabled={items.length < 2}><Plus size={13} /> Connection</button>
          {isAdmin && (items.length > 0 || (d?.pending ?? 0) > 0) && (
            <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs text-red hover:border-red/40" onClick={() => setWipe(true)} title="Delete every component, connection and suggestion">
              <Trash2 size={13} /> Delete map
            </button>
          )}
          {items.length > 0 && (
            <button className="btn-ghost !min-h-[32px] !px-2.5 text-xs" disabled={discover.isPending} onClick={() => { setNote(null); discover.mutate(); }} title="Confirm the map against registered targets, connections on machines, Kubernetes and metrics. Adds nothing.">
              {discover.isPending ? <Spinner className="!h-3 !w-3" /> : <RefreshCw size={13} />} Check live
            </button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-y border-hairline px-5 py-2.5">
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[{ value: 'map', label: 'Map' }, { value: 'list', label: 'List' }, { value: 'suggestions', label: `Suggestions${d?.pending ? ` ${d.pending}` : ''}` }]}
        />
        {view !== 'suggestions' && (
          <div className="relative min-w-[160px] flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dim" />
            <input className="input !min-h-[32px] !py-1 !pl-8 text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a component (name, IP, alias)" aria-label="Find a component" />
          </div>
        )}
        {view === 'map' && (
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={showMonitoring} onChange={(e) => setShowMonitoring(e.target.checked)} /> Show monitoring
          </label>
        )}
      </div>

      {note && (
        <p className="flex items-start gap-2 border-b border-hairline px-5 py-2 text-xs text-muted">
          <span className="flex-1">{note}</span>
          <button onClick={() => setNote(null)} aria-label="Dismiss" className="text-dim hover:text-ink"><X size={13} /></button>
        </p>
      )}

      {data.isLoading ? (
        <div className="grid h-60 place-items-center"><Spinner /></div>
      ) : !items.length && view !== 'suggestions' ? (
        <Empty
          icon={<Network size={28} />}
          title="No service map yet"
          hint="The map is built from what your documents and architecture diagrams describe, and what you add by hand; you review every change. Your live systems then confirm it, and show where a document is out of date."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <button className="btn-primary" onClick={() => setDiagram(true)}><FileImage size={14} /> From a diagram</button>
              <button className="btn-ghost" disabled={fromDocs.isPending} onClick={() => fromDocs.mutate()}><BookOpen size={14} /> From documents</button>
            </div>
          }
        />
      ) : view === 'suggestions' ? (
        <Suggestions projectId={projectId} isAdmin={isAdmin} onChanged={refresh} />
      ) : (
        // Side by side only at full width; in the half-width panel the details go below the map.
        <div ref={detailHost} className={clsx('grid min-w-0', expanded && (selItem || selLink) && 'xl:grid-cols-[minmax(0,1fr)_340px] xl:[&>aside]:border-l xl:[&>aside]:border-t-0')}>
          <div className="min-w-0 p-3">
            {view === 'map' ? (
              <MapGraph items={graphItems} links={links} selected={sel} onSelect={(s) => { setSel(s); setMode('focus'); }} highlight={highlight} height={expanded ? 680 : 520} />
            ) : (
              <MapList items={items} links={d?.links ?? []} filter={needle} selected={sel} onSelect={(s) => { setSel(s); setMode('focus'); }} />
            )}
          </div>
          {selItem && (
            <ItemDetail
              item={selItem}
              links={d?.links ?? []}
              itemById={itemById}
              mode={mode}
              onMode={setMode}
              impactCount={impact.data ? (mode === 'impact' ? impact.data.impact.length : impact.data.dependencies.length) : null}
              onSelect={setSel}
              onEdit={() => setForm({ kind: 'item', existing: selItem })}
              onConnect={() => setForm({ kind: 'link', fromId: selItem.id })}
              isAdmin={isAdmin}
              projectId={projectId}
              items={items}
              onChanged={(msg) => { if (msg) setNote(msg); refresh(); }}
              onClose={() => setSel(null)}
            />
          )}
          {selLink && <LinkDetail link={selLink} itemById={itemById} onSelect={setSel} onEdit={() => setForm({ kind: 'link', existing: selLink })} onChanged={(msg) => { if (msg) setNote(msg); setSel(null); refresh(); }} onClose={() => setSel(null)} />}
        </div>
      )}

      {wipe && (
        <Modal title="Delete the service map?" onClose={() => setWipe(false)}>
          <DeleteMap
            projectId={projectId}
            components={items.length}
            connections={(d?.links ?? []).length}
            pending={d?.pending ?? 0}
            onDone={(msg) => { setWipe(false); setSel(null); setView('map'); setNote(msg); refresh(); void qc.invalidateQueries({ queryKey: ['mapProposals'] }); }}
            onCancel={() => setWipe(false)}
          />
        </Modal>
      )}
      {diagram && (
        <Modal title="Map from a diagram" onClose={() => setDiagram(false)}>
          <DiagramImport projectId={projectId} onDone={(msg) => { setDiagram(false); setNote(msg); setView('suggestions'); refresh(); void qc.invalidateQueries({ queryKey: ['mapProposals'] }); }} />
        </Modal>
      )}
      {form && (
        <Modal title={form.kind === 'item' ? (form.existing ? `Edit ${form.existing.name}` : 'Add a component') : form.existing ? 'Edit connection' : 'Add a connection'} onClose={() => setForm(null)}>
          {form.kind === 'item' ? (
            <ItemForm projectId={projectId} existing={form.existing} onDone={(msg) => { setForm(null); if (msg) setNote(msg); refresh(); }} />
          ) : (
            <LinkForm projectId={projectId} items={items} existing={form.existing} fromId={form.fromId} onDone={(msg) => { setForm(null); if (msg) setNote(msg); refresh(); }} />
          )}
        </Modal>
      )}
    </section>
  );
}

// ---- detail ------------------------------------------------------------------------------

function CertaintyChip({ c }: { c: MapItem['confidence'] }) {
  const m = CERTAINTY[c.certainty];
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className={clsx('chip whitespace-nowrap', m.chip)} title={m.hint}>{m.label}</span>
      {c.drift && <span className={clsx('chip whitespace-nowrap', c.drift === 'not_seen' ? 'border-red/40 bg-red/10 text-red' : 'border-cyan/40 bg-cyan/10 text-cyan')} title={DRIFT[c.drift].hint}>{DRIFT[c.drift].label}</span>}
    </span>
  );
}

function EvidenceList({ evidence }: { evidence: MapItem['evidence'] }) {
  if (!evidence.length) return <p className="text-xs text-muted">No evidence recorded.</p>;
  return (
    <ul className="space-y-2">
      {evidence.map((e) => (
        <li key={e.id} className="text-[12px] leading-snug">
          <div className="flex items-baseline gap-1.5">
            <span className="font-medium text-ink/90">{e.source === 'doc' && e.ref.startsWith(DIAGRAM_PREFIX) ? 'Diagram' : SOURCE_LABEL[e.source]}</span>
            {e.refName && (e.source === 'doc' ? <span className="truncate text-blue-text">{e.refName}</span> : <span className="truncate font-mono text-[11px] text-muted">{e.refName}</span>)}
            <span className="ml-auto shrink-0 text-[10.5px] text-dim">{timeAgo(e.lastSeenAt)}</span>
          </div>
          {e.detail && <p className={clsx('mt-0.5 text-muted', e.source === 'doc' && 'border-l-2 border-hairline pl-2 italic')}>{e.source === 'doc' ? `“${e.detail}”` : e.detail}</p>}
        </li>
      ))}
    </ul>
  );
}

function ItemDetail({
  item, links, itemById, mode, onMode, impactCount, onSelect, onEdit, onConnect, isAdmin, projectId, items, onChanged, onClose,
}: {
  item: MapItem;
  links: MapLink[];
  itemById: Map<string, MapItem>;
  mode: 'focus' | 'impact' | 'deps';
  onMode: (m: 'focus' | 'impact' | 'deps') => void;
  impactCount: number | null;
  onSelect: (s: Sel) => void;
  onEdit: () => void;
  onConnect: () => void;
  isAdmin: boolean;
  projectId: string;
  items: MapItem[];
  onChanged: (msg?: string) => void;
  onClose: () => void;
}) {
  const meta = TYPE_META[item.type];
  const Icon = meta.icon;
  const out = links.filter((l) => l.fromId === item.id && l.kind !== 'monitors');
  const inc = links.filter((l) => l.toId === item.id && l.kind !== 'monitors');
  const [merging, setMerging] = useState(false);
  const remove = useMutation({
    mutationFn: () => del<{ applied: boolean; message?: string }>(`/service-map/items/${item.id}`),
    onSuccess: (r) => onChanged(r.applied ? `${item.name} removed from the map.` : r.message),
  });
  const merge = useMutation({
    mutationFn: (into: string) => post(`/service-map/items/${item.id}/merge`, { into }),
    onSuccess: () => { onChanged(`${item.name} merged.`); onSelect(null); },
  });
  const health = healthOf(item);
  const linkRow = (l: MapLink, dir: 'out' | 'in') => {
    const other = itemById.get(dir === 'out' ? l.toId : l.fromId);
    if (!other) return null;
    return (
      <li key={l.id}>
        <button className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] hover:bg-white/[0.04]" onClick={() => onSelect({ kind: 'item', id: other.id })}>
          <span className="shrink-0 text-dim">{dir === 'out' ? KIND_LABEL[l.kind] : `${KIND_LABEL[l.kind]} this`}</span>
          <span className="min-w-0 flex-1 truncate text-ink">{other.name}</span>
          <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', l.confidence.drift === 'not_seen' ? 'bg-red' : l.confidence.certainty === 'confirmed' || l.confidence.certainty === 'manual' ? 'bg-green' : l.confidence.certainty === 'observed' ? 'bg-cyan' : 'bg-dim')} title={CERTAINTY[l.confidence.certainty].label} />
        </button>
      </li>
    );
  };
  return (
    <aside className="min-w-0 border-t border-hairline p-4">
      <div className="flex items-start gap-2">
        <Icon size={18} color={meta.color} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="break-words text-[14px] font-semibold text-ink">{item.name}</h3>
          <p className="text-[11px] text-muted">{meta.label}{item.env ? ` · ${item.env}` : ''} · <span className="font-mono">{item.key}</span></p>
        </div>
        <button onClick={onClose} className="text-dim hover:text-ink" aria-label="Close"><X size={15} /></button>
      </div>
      <div className="mt-2"><CertaintyChip c={item.confidence} /></div>

      {(item.target || item.incidents.length > 0) && (
        <div className="mt-3 space-y-1 text-[12px]">
          {item.target && <p className="text-muted">Target <Link to="/targets" className="font-mono text-ink hover:underline">{item.target.slug}</Link> · <span className={health === 'down' ? 'text-red' : health === 'degraded' ? 'text-amber' : 'text-green'}>{item.target.healthState}</span></p>}
          {item.incidents.map((i) => <Link key={i.id} to={`/observability/incidents/${i.id}`} className="block truncate text-red hover:underline">Open incident: {i.title}</Link>)}
        </div>
      )}
      {item.description && <p className="mt-3 text-[12.5px] leading-relaxed text-ink/90">{item.description}</p>}
      {CATALOGUE.some(([k]) => item.attrs[k]) && (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {CATALOGUE.filter(([k]) => item.attrs[k]).map(([k, label]) => (
            <Fragment key={k}>
              <dt className="text-muted">{label}</dt>
              <dd className="min-w-0 break-words text-ink">
                {/^https?:\/\//.test(item.attrs[k]!) ? <a className="text-blue-text hover:underline" href={item.attrs[k]} target="_blank" rel="noreferrer">{item.attrs[k]}</a> : item.attrs[k]}
              </dd>
            </Fragment>
          ))}
        </dl>
      )}
      {item.aliases.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">{item.aliases.slice(0, 12).map((a) => <span key={a} className="rounded bg-tile-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">{a}</span>)}</div>
      )}

      <div className="mt-4 grid grid-cols-2 gap-1.5">
        <button className={clsx('rounded-inner border px-2 py-1.5 text-[11.5px]', mode === 'impact' ? 'border-red/50 bg-red/10 text-red' : 'border-hairline text-muted hover:text-ink')} onClick={() => onMode(mode === 'impact' ? 'focus' : 'impact')}>
          What breaks if it fails{mode === 'impact' && impactCount !== null ? ` (${impactCount})` : ''}
        </button>
        <button className={clsx('rounded-inner border px-2 py-1.5 text-[11.5px]', mode === 'deps' ? 'border-blue/50 bg-blue/10 text-blue-text' : 'border-hairline text-muted hover:text-ink')} onClick={() => onMode(mode === 'deps' ? 'focus' : 'deps')}>
          What it relies on{mode === 'deps' && impactCount !== null ? ` (${impactCount})` : ''}
        </button>
      </div>

      {out.length > 0 && <><h4 className="mt-4 text-[10.5px] font-semibold uppercase tracking-wider text-dim">It</h4><ul className="mt-1">{out.map((l) => linkRow(l, 'out'))}</ul></>}
      {inc.length > 0 && <><h4 className="mt-3 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Used by</h4><ul className="mt-1">{inc.map((l) => linkRow(l, 'in'))}</ul></>}

      <h4 className="mt-4 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Why it is on the map</h4>
      <div className="mt-1.5"><EvidenceList evidence={item.evidence} /></div>

      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-hairline pt-3">
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px]" onClick={onEdit}><Pencil size={12} /> Edit</button>
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px]" onClick={onConnect}><Plus size={12} /> Connection</button>
        {isAdmin && <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px]" onClick={() => setMerging((v) => !v)}><GitMerge size={12} /> Same as…</button>}
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px] text-red" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={12} /> Remove</button>
      </div>
      {merging && (
        <div className="mt-2">
          <select className="input !min-h-[32px] text-xs" defaultValue="" onChange={(e) => e.target.value && merge.mutate(e.target.value)} aria-label="Merge into">
            <option value="" disabled>Merge into… (names, links and evidence move there)</option>
            {items.filter((i) => i.id !== item.id).sort((a, b) => a.name.localeCompare(b.name)).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        </div>
      )}
      {[remove, merge].some((m) => m.isError) && <p className="mt-2 text-xs text-red">{([remove, merge].find((m) => m.isError)!.error as Error).message}</p>}
      {!isAdmin && <p className="mt-2 text-[10.5px] text-dim">Your changes are saved as suggestions for an admin, like documents.</p>}
    </aside>
  );
}

function LinkDetail({ link, itemById, onSelect, onEdit, onChanged, onClose }: { link: MapLink; itemById: Map<string, MapItem>; onSelect: (s: Sel) => void; onEdit: () => void; onChanged: (msg?: string) => void; onClose: () => void }) {
  const a = itemById.get(link.fromId);
  const b = itemById.get(link.toId);
  const remove = useMutation({
    mutationFn: () => del<{ applied: boolean; message?: string }>(`/service-map/links/${link.id}`),
    onSuccess: (r) => onChanged(r.applied ? 'Connection removed.' : r.message),
  });
  return (
    <aside className="min-w-0 border-t border-hairline p-4">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-[13.5px] leading-snug">
          <button className="font-semibold text-ink hover:underline" onClick={() => a && onSelect({ kind: 'item', id: a.id })}>{a?.name}</button>
          <span className="text-muted"> {KIND_LABEL[link.kind]} </span>
          <button className="font-semibold text-ink hover:underline" onClick={() => b && onSelect({ kind: 'item', id: b.id })}>{b?.name}</button>
          {link.detail && <p className="mt-0.5 font-mono text-[11px] text-muted">{link.detail}</p>}
        </div>
        <button onClick={onClose} className="text-dim hover:text-ink" aria-label="Close"><X size={15} /></button>
      </div>
      <div className="mt-2"><CertaintyChip c={link.confidence} /></div>
      {link.confidence.drift === 'not_seen' && <p className="mt-2 rounded-inner border border-red/30 bg-red/[0.06] px-2.5 py-2 text-[11.5px] leading-relaxed text-red">{DRIFT.not_seen.hint}</p>}
      <h4 className="mt-4 text-[10.5px] font-semibold uppercase tracking-wider text-dim">Why it is on the map</h4>
      <div className="mt-1.5"><EvidenceList evidence={link.evidence} /></div>
      {!!link.alsoSupportedBy?.length && (
        <p className="mt-2 text-[11px] text-muted">Also supported by {link.alsoSupportedBy.map((s) => SOURCE_LABEL[s].toLowerCase()).join(' and ')} for the same connection at the {b?.type === 'host' ? 'service' : 'machine'} level.</p>
      )}
      <div className="mt-4 flex gap-1.5 border-t border-hairline pt-3">
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px]" onClick={onEdit}><Pencil size={12} /> Edit</button>
        <button className="btn-ghost !min-h-[30px] !px-2.5 text-[11.5px] text-red" disabled={remove.isPending} onClick={() => remove.mutate()}><Trash2 size={12} /> Remove</button>
      </div>
    </aside>
  );
}

// ---- list ---------------------------------------------------------------------------------

function MapList({ items, links, filter, selected, onSelect }: { items: MapItem[]; links: MapLink[]; filter: string; selected: Sel; onSelect: (s: Sel) => void }) {
  const [show, setShow] = useState<'all' | 'not_seen' | 'not_documented' | 'documented' | 'confirmed'>('all');
  const deg = (id: string) => links.filter((l) => l.kind !== 'monitors' && (l.fromId === id || l.toId === id)).length;
  const driftOf = (i: MapItem) => i.confidence.drift ?? (links.some((l) => (l.fromId === i.id || l.toId === i.id) && l.confidence.drift === 'not_seen') ? 'not_seen' : null);
  const rows = items
    .filter((i) => !filter || `${i.name} ${i.key} ${i.aliases.join(' ')} ${i.type}`.toLowerCase().includes(filter))
    .filter((i) => show === 'all' || (show === 'not_seen' ? driftOf(i) === 'not_seen' : show === 'not_documented' ? i.confidence.drift === 'not_documented' : show === 'documented' ? i.confidence.certainty === 'documented' : ['confirmed', 'manual'].includes(i.confidence.certainty)))
    .sort((a, b) => TYPE_META[a.type].tier - TYPE_META[b.type].tier || a.name.localeCompare(b.name));
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {([['all', 'All'], ['confirmed', 'Confirmed'], ['documented', 'Documented only'], ['not_documented', 'Not documented'], ['not_seen', 'Documented, not seen']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setShow(k)} className={clsx('rounded-full border px-2.5 py-1 text-[11px]', show === k ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-inner border border-hairline">
        <table className="w-full min-w-[560px] text-left text-[12px]">
          <thead className="bg-tile-2/60 text-[10.5px] uppercase tracking-wider text-dim">
            <tr><th className="px-3 py-2 font-semibold">Component</th><th className="px-3 py-2 font-semibold">Type</th><th className="px-3 py-2 font-semibold">Connections</th><th className="px-3 py-2 font-semibold">Certainty</th><th className="px-3 py-2 font-semibold">From</th></tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {rows.map((i) => {
              const Icon = TYPE_META[i.type].icon;
              return (
                <tr key={i.id} className={clsx('cursor-pointer hover:bg-white/[0.03]', selected?.id === i.id && 'bg-blue/10')} onClick={() => onSelect({ kind: 'item', id: i.id })}>
                  <td className="px-3 py-2"><span className="flex items-center gap-2"><Icon size={14} color={TYPE_META[i.type].color} /> <span className="text-ink">{i.name}</span>{i.env && <span className="text-[10.5px] text-dim">{i.env}</span>}</span></td>
                  <td className="px-3 py-2 text-muted">{TYPE_META[i.type].label}</td>
                  <td className="px-3 py-2 font-mono text-muted">{deg(i.id)}</td>
                  <td className="px-3 py-2"><CertaintyChip c={{ ...i.confidence, drift: driftOf(i) }} /></td>
                  <td className="px-3 py-2 text-[11px] text-muted">{[...new Set(i.evidence.map((e) => SOURCE_LABEL[e.source]))].join(', ')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && <p className="px-4 py-6 text-center text-xs text-muted">Nothing matches.</p>}
      </div>
    </div>
  );
}

// ---- suggestions ----------------------------------------------------------------------------

function describe(p: Proposal): string {
  const pl = p.payload as Record<string, unknown>;
  switch (p.op) {
    case 'add_item': return `Add ${String(pl.name)} (${TYPE_META[(pl.type as CiType) ?? 'service']?.label ?? pl.type})`;
    case 'update_item': return `Update ${String(pl.name)}: ${Object.entries((pl.changes ?? {}) as Record<string, unknown>).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ')}`;
    case 'remove_item': return `Remove ${String(pl.name)}`;
    case 'add_link': return `${String(pl.from)} ${KIND_LABEL[(pl.kind as CiLinkKind) ?? 'depends_on']} ${String(pl.to)}${pl.detail ? ` (${String(pl.detail)})` : ''}`;
    case 'update_link': return 'Change a connection';
    case 'remove_link': return `Remove: ${String(pl.from)} ${KIND_LABEL[(pl.kind as CiLinkKind) ?? 'depends_on']} ${String(pl.to)}`;
  }
}

function Suggestions({ projectId, isAdmin, onChanged }: { projectId: string; isAdmin: boolean; onChanged: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['mapProposals', projectId], queryFn: () => api<Proposal[]>(`/service-map/proposals?projectId=${projectId}`), refetchInterval: 15_000 });
  const done = () => { void qc.invalidateQueries({ queryKey: ['mapProposals', projectId] }); onChanged(); };
  const decide = useMutation({ mutationFn: (v: { id: string; accept: boolean }) => post(`/service-map/proposals/${v.id}/${v.accept ? 'accept' : 'reject'}`, {}), onSuccess: done });
  const all = useMutation({ mutationFn: (sourceRef?: string) => post('/service-map/proposals/accept-all', { projectId, ...(sourceRef ? { sourceRef } : {}) }), onSuccess: done });
  const groups = useMemo(() => {
    const m = new Map<string, { title: string; ref: string | null; origin: Proposal['origin']; rows: Proposal[] }>();
    for (const p of list.data ?? []) {
      const k = `${p.origin}|${p.sourceRef ?? ''}`;
      if (!m.has(k)) m.set(k, { title: p.sourceTitle ?? 'Suggestion', ref: p.sourceRef, origin: p.origin, rows: [] });
      m.get(k)!.rows.push(p);
    }
    return [...m.values()];
  }, [list.data]);

  if (list.isLoading) return <div className="grid h-40 place-items-center"><Spinner /></div>;
  if (!groups.length) return <Empty icon={<Check size={24} />} title="Nothing to review" hint="When a document is approved or changes, or a diagram is imported, what it says about your systems shows up here before it changes the map." />;
  const err = (decide.error ?? all.error) as Error | null;
  return (
    <div className="space-y-3 p-4">
      {isAdmin && (list.data?.length ?? 0) > 1 && (
        <div className="flex justify-end"><button className="btn-ghost !min-h-[30px] text-xs" disabled={all.isPending} onClick={() => all.mutate(undefined)}>{all.isPending ? <Spinner className="!h-3 !w-3" /> : <Check size={13} />} Accept all {list.data!.length}</button></div>
      )}
      {err && <p className="text-xs text-red">{err.message}</p>}
      {groups.map((g) => (
        <div key={`${g.origin}${g.ref}`} className="rounded-inner border border-hairline">
          <div className="flex items-center gap-2 border-b border-hairline px-3 py-2">
            {g.ref?.startsWith(DIAGRAM_PREFIX) ? <FileImage size={14} className="shrink-0 text-cyan" /> : g.origin === 'doc' ? <FileText size={14} className="shrink-0 text-blue-text" /> : <Pencil size={13} className="shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{g.ref?.startsWith(DIAGRAM_PREFIX) ? `From the diagram “${g.title}”` : g.origin === 'doc' ? `From “${g.title}”` : g.title}</span>
            {isAdmin && g.rows.length > 1 && <button className="text-[11px] text-blue-text hover:underline" onClick={() => all.mutate(g.ref ?? undefined)}>Accept these {g.rows.length}</button>}
          </div>
          <ul className="divide-y divide-hairline">
            {g.rows.map((p) => (
              <li key={p.id} className="flex flex-wrap items-start gap-3 px-3 py-2.5">
                <span className={clsx('mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase', p.op.startsWith('add') ? 'bg-green/10 text-green' : p.op.startsWith('remove') ? 'bg-red/10 text-red' : 'bg-amber/10 text-amber')}>{p.op.split('_')[0]}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-ink">{describe(p)}</p>
                  {p.quote && <p className="mt-0.5 border-l-2 border-hairline pl-2 text-[11.5px] italic text-muted">“{p.quote}”</p>}
                </div>
                {isAdmin ? (
                  <div className="flex shrink-0 gap-1.5">
                    <button className="btn-primary !min-h-[28px] !px-2.5 text-[11px]" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, accept: true })}><Check size={12} /> Accept</button>
                    <button className="btn-ghost !min-h-[28px] !px-2.5 text-[11px]" disabled={decide.isPending} onClick={() => decide.mutate({ id: p.id, accept: false })}><X size={12} /> Reject</button>
                  </div>
                ) : (
                  <span className="shrink-0 text-[10.5px] text-dim">Waiting for an admin</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---- forms --------------------------------------------------------------------------------

function DeleteMap({ projectId, components, connections, pending, onDone, onCancel }: { projectId: string; components: number; connections: number; pending: number; onDone: (msg: string) => void; onCancel: () => void }) {
  const remove = useMutation({
    mutationFn: () => del<{ items: number; links: number }>(`/service-map?projectId=${projectId}`),
    onSuccess: (r) => onDone(`Deleted the service map: ${r.items} component${r.items === 1 ? '' : 's'} and ${r.links} connection${r.links === 1 ? '' : 's'}. Build it again from your documents or a diagram.`),
  });
  const n = (v: number, one: string) => `${v} ${one}${v === 1 ? '' : 's'}`;
  return (
    <div className="space-y-4">
      <p className="text-[13px] leading-relaxed text-ink/90">
        This removes all {n(components, 'component')}, {n(connections, 'connection')}{pending ? ` and ${n(pending, 'pending suggestion')}` : ''}, including everything people added or edited by hand. It cannot be undone.
      </p>
      <p className="text-[12px] leading-relaxed text-muted">
        Your documents and diagrams are not touched: <span className="text-ink/80">From documents</span> or <span className="text-ink/80">From a diagram</span> builds the map again, as suggestions to review.
      </p>
      {remove.isError && <p className="text-xs text-red">{(remove.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className="btn-primary !bg-red hover:!bg-red/90" disabled={remove.isPending} onClick={() => remove.mutate()}>
          {remove.isPending ? <Spinner /> : <Trash2 size={14} />} Delete the map
        </button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="tile max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-4 flex items-center gap-3"><h2 className="flex-1 text-base font-semibold text-ink">{title}</h2><button className="text-dim hover:text-ink" onClick={onClose} aria-label="Close"><X size={16} /></button></div>
        {children}
      </div>
    </div>
  );
}

const TYPES = Object.keys(TYPE_META) as CiType[];

/** The service catalogue: details alerts about a component pick up as labels. */
const CATALOGUE = [
  ['owner', 'Owner', 'Ana'],
  ['team', 'Team', 'payments'],
  ['runbook', 'Runbook', 'https://wiki.example.com/runbooks/checkout'],
  ['repo', 'Repository', 'https://git.example.com/shop/checkout'],
  ['tier', 'Tier', 'critical'],
] as const;
type CatalogueKey = (typeof CATALOGUE)[number][0];
const KINDS = Object.keys(KIND_LABEL) as CiLinkKind[];

function ItemForm({ projectId, existing, onDone }: { projectId: string; existing?: MapItem; onDone: (msg?: string) => void }) {
  const [f, setF] = useState({ name: existing?.name ?? '', type: existing?.type ?? ('service' as CiType), env: existing?.env ?? '', description: existing?.description ?? '', aliases: (existing?.aliases ?? []).join(', ') });
  const [cat, setCat] = useState<Record<CatalogueKey, string>>(() => Object.fromEntries(CATALOGUE.map(([k]) => [k, existing?.attrs[k] ?? ''])) as Record<CatalogueKey, string>);
  const save = useMutation({
    mutationFn: () => {
      // Details are saved whole: keep the others, set or clear the catalogue fields.
      const attrs = { ...Object.fromEntries(Object.entries(existing?.attrs ?? {}).filter(([k]) => !CATALOGUE.some(([c]) => c === k))), ...Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v)) };
      const body = { name: f.name.trim(), type: f.type, env: f.env.trim() || null, description: f.description.trim() || null, aliases: f.aliases.split(',').map((a) => a.trim()).filter(Boolean), attrs };
      return existing ? patch<{ applied: boolean; message?: string }>(`/service-map/items/${existing.id}`, body) : post<{ applied: boolean; message?: string }>('/service-map/items', { projectId, ...body });
    },
    onSuccess: (r) => onDone(r.applied ? undefined : r.message),
  });
  return (
    <div className="space-y-3">
      <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="checkout-api" autoFocus /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Type">
          <select className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as CiType })}>{TYPES.map((t) => <option key={t} value={t}>{TYPE_META[t].label}</option>)}</select>
        </Field>
        <Field label="Environment"><input className="input" value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} placeholder="prod" /></Field>
      </div>
      <Field label="What it is"><textarea className="input min-h-[60px]" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label="Other names" hint="Hostnames, IPs, scrape jobs, Kubernetes names -- comma separated. They let live sources find it."><input className="input font-mono text-[12px]" value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} placeholder="10.0.4.21, checkout.prod.internal" /></Field>
      <div className="rounded-inner border border-hairline bg-ground/40 p-3">
        <p className="mb-2 text-[11px] leading-relaxed text-muted">Who owns it. Alerts about this component get these as labels (<span className="font-mono">owner</span>, <span className="font-mono">team</span>, <span className="font-mono">runbook_url</span>…), so they can be grouped and routed by team.</p>
        <div className="grid grid-cols-2 gap-3">
          {CATALOGUE.map(([k, label, ph]) => (
            <Field key={k} label={label}><input className="input text-[12px]" value={cat[k]} onChange={(e) => setCat({ ...cat, [k]: e.target.value })} placeholder={ph} /></Field>
          ))}
        </div>
      </div>
      {existing && !existing.locked && <p className="text-[11px] text-dim">Once you edit it, automatic sources add evidence but never change what you set.</p>}
      {save.isError && <p className="text-sm text-red">{(save.error as Error).message}</p>}
      <button className="btn-primary" disabled={!f.name.trim() || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Check size={14} />} Save</button>
    </div>
  );
}

function LinkForm({ projectId, items, existing, fromId, onDone }: { projectId: string; items: MapItem[]; existing?: MapLink; fromId?: string; onDone: (msg?: string) => void }) {
  const sorted = [...items].sort((a, b) => a.name.localeCompare(b.name));
  const [f, setF] = useState({ fromId: existing?.fromId ?? fromId ?? '', kind: existing?.kind ?? ('depends_on' as CiLinkKind), toId: existing?.toId ?? '', detail: existing?.detail ?? '' });
  const save = useMutation({
    mutationFn: () => {
      const body = { fromId: f.fromId, toId: f.toId, kind: f.kind, detail: f.detail.trim() || null };
      return existing ? patch<{ applied: boolean; message?: string }>(`/service-map/links/${existing.id}`, body) : post<{ applied: boolean; message?: string }>('/service-map/links', { projectId, ...body });
    },
    onSuccess: (r) => onDone(r.applied ? undefined : r.message),
  });
  const pick = (v: string, set: (id: string) => void, label: string) => (
    <select className="input" value={v} onChange={(e) => set(e.target.value)} aria-label={label}>
      <option value="" disabled>Choose…</option>
      {sorted.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
    </select>
  );
  return (
    <div className="space-y-3">
      <Field label="This">{pick(f.fromId, (id) => setF({ ...f, fromId: id }), 'From')}</Field>
      <Field label="Connection">
        <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as CiLinkKind })}>{KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select>
      </Field>
      <Field label="That">{pick(f.toId, (id) => setF({ ...f, toId: id }), 'To')}</Field>
      <Field label="Detail (optional)"><input className="input font-mono text-[12px]" value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} placeholder="tcp/5432, HTTPS via /api" /></Field>
      {f.fromId && f.toId && <p className="flex items-center gap-1.5 text-xs text-muted">{items.find((i) => i.id === f.fromId)?.name} <ArrowRight size={12} /> {KIND_LABEL[f.kind]} <ArrowRight size={12} /> {items.find((i) => i.id === f.toId)?.name}</p>}
      {save.isError && <p className="text-sm text-red">{(save.error as Error).message}</p>}
      <button className="btn-primary" disabled={!f.fromId || !f.toId || f.fromId === f.toId || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : <Check size={14} />} Save</button>
    </div>
  );
}
