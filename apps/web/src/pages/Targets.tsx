import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Activity, Boxes, ChevronDown, ChevronRight, Minus, Pencil, Plug, Plus, Server, Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { useApp } from '../lib/store';
import { timeAgo } from '../lib/format';

import { PageHeader } from '../components/Layout';
import { Empty, EnvBadge, Field, HealthBadge, Panel, Spinner } from '../components/ui';
import { HealthRing } from '../components/viz';
import { HEALTH_STYLE, targetAddress } from '../lib/format';
import { DiscoverVms } from '../components/DiscoverVms';
import { ClusterForm } from '../components/ClusterForm';
import { ConnectionForm } from '../components/ConnectionForm';
import { isObservabilityKind as isObs, isScmKind } from '@supops/shared';

/** Connections reached over an API (observability, source control), edited with ConnectionForm. */
const isObservabilityKind = (k: string) => isObs(k) || isScmKind(k);
import type { Target } from '../lib/types';

export function Targets() {
  const projectId = useApp((s) => s.projectId);
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [addingCluster, setAddingCluster] = useState(false);
  const [addingConnection, setAddingConnection] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [editing, setEditing] = useState<Target | null>(null);
  const [openHosts, setOpenHosts] = useState<Set<string>>(new Set());

  const targets = useQuery({
    queryKey: ['targets', projectId],
    queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`),
    enabled: !!projectId,
  });

  // Connection tests run per target and often several at once ("Test all"). A single
  // shared mutation only ever reflects its LAST call -- so with a loop of mutate()s
  // only the last card spun and only its result showed. We track each in-flight test
  // by id, and keep each target's own result, so every card reports independently.
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const testing = (id: string) => testingIds.has(id);

  const runTest = (ids: string[]) => {
    if (!ids.length) return;
    setTestingIds((s) => new Set([...s, ...ids]));
    setTestResults((r) => {
      const next = { ...r };
      for (const id of ids) delete next[id];
      return next;
    });
    for (const id of ids) {
      void (async () => {
        try {
          const res = await post<{ ok: boolean; detail: string }>(`/targets/${id}/test`, {});
          setTestResults((r) => ({ ...r, [id]: res }));
        } catch (e) {
          setTestResults((r) => ({ ...r, [id]: { ok: false, detail: String((e as Error).message ?? e) } }));
        } finally {
          setTestingIds((s) => {
            const n = new Set(s);
            n.delete(id);
            return n;
          });
          void qc.invalidateQueries({ queryKey: ['targets', projectId] });
        }
      })();
    }
  };

  const remove = useMutation({
    mutationFn: (id: string) => del<{ archived: boolean; reason?: string }>(`/targets/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['targets', projectId] }),
  });

  // Group VMs reached via a jump under that jump, so the list doesn't fill up with
  // dozens of flat cards. Each VM is still its own target -- this is display only.
  const all = targets.data ?? [];
  const viaOf = (t: Target) => (t.config as { via?: { alias?: string } }).via?.alias;
  const hostOf = (t: Target) => (t.config as { host?: string }).host ?? '';
  const viaByHost = new Map<string, Target[]>();
  for (const t of all) {
    if (viaOf(t)) {
      const list = viaByHost.get(hostOf(t)) ?? [];
      list.push(t);
      viaByHost.set(hostOf(t), list);
    }
  }
  const jumpHosts = new Set(viaByHost.keys());
  const standalone = all.filter((t) => !viaOf(t) && !jumpHosts.has(hostOf(t)));
  const jumpByHost = new Map<string, Target>();
  for (const t of all) if (!viaOf(t) && jumpHosts.has(hostOf(t))) jumpByHost.set(hostOf(t), t);

  return (
    <>
      <PageHeader
        title="Targets"
        subtitle="Everything your agents can reach — machines, clusters and observability backends. If it's not here, they can't touch it."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost" onClick={() => setAddingConnection((v) => !v)}>
              <Activity size={15} /> Add connection
            </button>
            <button className="btn-ghost" onClick={() => setAddingCluster((v) => !v)}>
              <Boxes size={15} /> Add cluster
            </button>
            <button className="btn-ghost" onClick={() => setDiscovering((v) => !v)}>
              <Server size={15} /> Discover via jump
            </button>
            <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
              <Plus size={16} /> Add target
            </button>
          </div>
        }
      />

      <div className="space-y-4 p-6">
        {discovering && (
          <DiscoverVms
            projectId={projectId!}
            // Only machines SupOps connects to directly can be a jump: not clusters, and
            // not VMs already discovered behind a jump (those would list twice, as a
            // jump AND as one of its own machines).
            jumpTargets={(targets.data ?? []).filter((t) => t.kind === 'ssh' && !viaOf(t))}
            onDone={() => setDiscovering(false)}
          />
        )}
        {adding && <TargetForm projectId={projectId!} onDone={() => setAdding(false)} />}
        {addingCluster && <ClusterForm projectId={projectId!} onDone={() => setAddingCluster(false)} />}
        {addingConnection && <ConnectionForm projectId={projectId!} onDone={() => setAddingConnection(false)} />}
        {editing && isObservabilityKind(editing.kind) && (
          <ConnectionForm key={editing.id} projectId={projectId!} existing={editing} onDone={() => setEditing(null)} />
        )}
        {editing?.kind === 'k8s' && (
          <ClusterForm key={editing.id} projectId={projectId!} existing={editing} onDone={() => setEditing(null)} />
        )}
        {editing && editing.kind !== 'k8s' && !isObservabilityKind(editing.kind) && (
          /* Keyed by target id: TargetForm seeds its fields in `useState`, which
             runs only on mount, so without a key React reuses the instance and
             clicking a second target's edit shows the first target's values. */
          <TargetForm
            key={editing.id}
            projectId={projectId!}
            existing={editing}
            onDone={() => setEditing(null)}
          />
        )}

        {targets.data?.length ? (
          /* One grid for every target card -- jump groups and standalone alike -- so
             they are all the same width and flow left-to-right, wrapping as they fill.
             items-start (not stretch) so expanding one card's machines grows only that
             card, rather than stretching its neighbours to match. */
          <div className="grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(340px,100%),1fr))]">
        {[...viaByHost.entries()].map(([host, vms]) => {
          const jump = jumpByHost.get(host);
          const open = openHosts.has(host);
          const h = jump ? HEALTH_STYLE[jump.healthState] ?? HEALTH_STYLE.unknown! : null;
          const groupIds = [...(jump ? [jump.id] : []), ...vms.map((v) => v.id)];
          const testAll = () => runTest(groupIds);
          const groupTesting = groupIds.some(testing);
          // Delete all removes only the machines behind the jump -- the jump target
          // itself stays, so you keep the connection and can re-discover later.
          const deleteAll = () => {
            if (confirm(`Remove all ${vms.length} machine${vms.length === 1 ? '' : 's'} behind ${jump?.slug ?? host}? The jump itself is kept.`)) {
              vms.forEach((v) => remove.mutate(v.id));
            }
          };
          const jcfg = (jump?.config ?? {}) as { host?: string; port?: number; user?: string };
          return (
            <div key={host} className="tile flex flex-col overflow-hidden">
              {/* The jump keeps the full target card; its machines live under it. */}
              <div className="flex flex-1 items-start gap-4 p-5">
                <HealthRing
                    interactive={false}
                  size={62}
                  thickness={6}
                  centreSize={24}
                  segments={[{ label: h?.label ?? 'unknown', value: 1, hex: h?.hex ?? 'rgb(var(--dim))' }]}
                  center={(jump?.env ?? 'p').slice(0, 1).toUpperCase()}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm text-ink">{jump?.slug ?? host}</span>
                    {jump && <EnvBadge env={jump.env} />}
                    <span className="rounded border border-edge px-1.5 py-px text-[10px] uppercase tracking-wider text-muted">jump</span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-muted">{jump?.description ?? jump?.name ?? host}</p>
                  <p className="mt-1.5 truncate font-mono text-[11px] text-muted">
                    {jcfg.user}@{jcfg.host}:{jcfg.port}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    {jump && <HealthBadge state={jump.healthState} />}
                    <span className="text-[11px] text-violet">{vms.length} machine{vms.length === 1 ? '' : 's'} behind it</span>
                    {jump?.lastCheckedAt && <span className="text-[11px] text-muted">checked {timeAgo(jump.lastCheckedAt)}</span>}
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 border-t border-hairline px-3 py-2">
                <button className="btn-quiet !min-h-[44px] flex-1 !text-xs" onClick={testAll} disabled={groupTesting} title="Test the jump and every machine behind it">
                  {groupTesting ? <Spinner className="!h-3.5 !w-3.5" /> : <Plug size={14} />} Test all
                </button>
                {jump && (
                  <button className="btn-quiet !min-h-[44px] !w-11 !px-0" onClick={() => setEditing(jump)} title={`Edit ${jump.slug}`} aria-label={`Edit ${jump.slug}`}>
                    <Pencil size={14} />
                  </button>
                )}
                {jump && (
                  <button
                    className="btn-quiet !min-h-[44px] !w-11 !px-0 hover:!text-red"
                    onClick={() => { if (confirm(`Remove the jump ${jump.slug}? The machines behind it become unreachable.`)) remove.mutate(jump.id); }}
                    disabled={remove.isPending}
                    title={`Remove jump ${jump.slug}`}
                    aria-label={`Remove jump ${jump.slug}`}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>

              {/* the machines behind it */}
              <button
                className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2 text-left text-[11px] text-muted hover:bg-tile-2/50"
                onClick={() => setOpenHosts((s) => { const n = new Set(s); n.has(host) ? n.delete(host) : n.add(host); return n; })}
              >
                {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {open ? 'Hide' : 'Show'} the {vms.length} machine{vms.length === 1 ? '' : 's'} behind it
              </button>

              {open && (
                <div className="border-t border-hairline">
                  <div className="flex items-center justify-between px-4 py-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Machines</span>
                    <button className="btn-ghost !min-h-0 !py-1 !text-[11px] hover:!text-red" onClick={deleteAll} disabled={remove.isPending || vms.length === 0}>
                      <Trash2 size={12} /> Delete all
                    </button>
                  </div>
                  <div className="divide-y divide-hairline border-t border-hairline">
                    {vms.map((v) => (
                      <VmRow
                        key={v.id}
                        target={v}
                        testing={testing(v.id)}
                        onTest={() => runTest([v.id])}
                        onEdit={() => setEditing(v)}
                        onRemove={() => { if (confirm(`Remove ${v.slug}?`)) remove.mutate(v.id); }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
            {standalone.map((t) => {
              const cfg = t.config as { host?: string; port?: number; user?: string };
              const h = HEALTH_STYLE[t.healthState] ?? HEALTH_STYLE.unknown!;
              const isTesting = testing(t.id);
              return (
                <div key={t.id} className="tile flex flex-col overflow-hidden">
                  <div className="flex flex-1 items-start gap-4 p-5">
                    {/* A single-segment ring reads as a status light but still carries
                        the word beneath it -- health is never colour alone. */}
                    <HealthRing
                    interactive={false}
                      size={62}
                      thickness={6}
                      centreSize={24}
                      segments={[{ label: h.label, value: 1, hex: h.hex }]}
                      center={t.env.slice(0, 1).toUpperCase()}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-sm text-ink">{t.slug}</span>
                        <EnvBadge env={t.env} />
                      </div>
                      <p className="mt-1 truncate text-[11px] text-muted">{t.description ?? t.name}</p>
                      <p className="mt-1.5 truncate font-mono text-[11px] text-muted">
                        {t.kind === 'k8s' || isObservabilityKind(t.kind) ? targetAddress(t) : `${cfg.user}@${cfg.host}:${cfg.port}`}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <HealthBadge state={t.healthState} />
                        {!t.hasCredential && !isObservabilityKind(t.kind) && (
                          <span className="text-[11px] text-amber">no credential</span>
                        )}
                        {t.lastCheckedAt && (
                          <span className="text-[11px] text-muted">checked {timeAgo(t.lastCheckedAt)}</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 border-t border-hairline px-3 py-2">
                    <button
                      className="btn-quiet !min-h-[44px] flex-1 !text-xs"
                      onClick={() => runTest([t.id])}
                      disabled={isTesting}
                    >
                      {isTesting ? <Spinner className="!h-3.5 !w-3.5" /> : <Plug size={14} />} Test
                    </button>
                    <button
                      className="btn-quiet !min-h-[44px] !w-11 !px-0"
                      onClick={() => setEditing(t)}
                      title={`Edit ${t.slug}`}
                      aria-label={`Edit ${t.slug}`}
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      className="btn-quiet !min-h-[44px] !w-11 !px-0 hover:!text-red"
                      onClick={() => {
                        if (confirm(`Remove ${t.slug}? Agents will no longer be able to reach it.`)) {
                          remove.mutate(t.id);
                        }
                      }}
                      disabled={remove.isPending}
                      title={`Remove ${t.slug}`}
                      aria-label={`Remove ${t.slug}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>

                  {/* Mirrors the jump card's "machines behind it" row so a standalone
                      target reads as the same kind of card, just with nothing behind it. */}
                  <div className="flex w-full items-center gap-2 border-t border-hairline px-4 py-2 text-[11px] text-dim">
                    <Minus size={14} className="shrink-0" />
                    No machines behind it
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <Panel>
            <Empty
              icon={<Server size={28} />}
              title="No targets registered"
              hint="Add a server and its slug becomes the only name the agent can use to reach it. Anything not listed here is unreachable by construction."
              action={<button className="btn-primary" onClick={() => setAdding(true)}>Add your first target</button>}
            />
          </Panel>
        )}

        {remove.data && (
          <div className="rounded-lg border border-hairline bg-tile px-4 py-3 text-sm text-muted">
            {remove.data.archived
              ? `Target archived — ${remove.data.reason}. It is hidden and unreachable by agents, but past runs still resolve it.`
              : 'Target deleted.'}
          </div>
        )}

        {Object.keys(testResults).length > 0 && (
          <Panel title="Connection tests">
            <div className="divide-y divide-hairline">
              {Object.entries(testResults).map(([id, r]) => {
                const t = all.find((x) => x.id === id);
                return (
                  <div key={id} className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className={clsx('h-1.5 w-1.5 rounded-full', r.ok ? 'bg-green' : 'bg-red')} />
                      <span className="font-mono text-xs text-ink">{t?.slug ?? id}</span>
                      <span className={clsx('text-[11px]', r.ok ? 'text-green' : 'text-red')}>
                        {r.ok ? 'connected' : 'failed'}
                      </span>
                    </div>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted">
                      {r.detail}
                    </pre>
                  </div>
                );
              })}
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function TargetForm({
  projectId,
  existing,
  onDone,
}: {
  projectId: string;
  existing?: Target;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const cfg = (existing?.config ?? {}) as {
    host?: string; port?: number; user?: string; sudo?: boolean; hostKeyFingerprint?: string;
    become?: { method?: 'none' | 'sudo' | 'su' | 'sudo-su'; user?: string; pty?: boolean; template?: string };
    via?: { alias?: string; pty?: boolean; sshFlags?: string; become?: { method: 'sudo' | 'su' | 'sudo-su'; user?: string } };
    loginShell?: boolean; prelude?: string;
  };

  const [form, setForm] = useState({
    slug: existing?.slug ?? '',
    name: existing?.name ?? '',
    host: cfg.host ?? '',
    port: cfg.port ?? 22,
    user: cfg.user ?? 'root',
    env: existing?.env ?? ('staging' as 'dev' | 'staging' | 'prod'),
    description: existing?.description ?? '',
    // Never prefilled: the server does not return credentials, so blank means
    // "leave whatever is stored alone".
    secret: '',
    sudo: cfg.sudo ?? false,
    becomeMethod: cfg.become?.method ?? 'none',
    becomeUser: cfg.become?.user ?? '',
    becomePty: cfg.become?.pty ?? false,
    becomeTemplate: cfg.become?.template ?? '',
    viaAlias: cfg.via?.alias ?? '',
    viaFlags: cfg.via?.sshFlags ?? '',
    viaBecomeMethod: (cfg.via?.become?.method ?? 'none') as 'none' | 'sudo' | 'su' | 'sudo-su',
    viaBecomeUser: cfg.via?.become?.user ?? '',
    loginShell: cfg.loginShell ?? false,
    prelude: cfg.prelude ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState(cfg.hostKeyFingerprint ?? '');

  // Pinned on first connect; forgetting it lets the next connection trust a new key
  // (after an expected rebuild). Confirmed first, because it's also what an
  // interception would want.
  const forgetKey = useMutation({
    mutationFn: () => post<Target>(`/targets/${existing!.id}/forget-host-key`, {}),
    onSuccess: () => {
      setPinnedKey('');
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not forget the host key'),
  });

  // Elevation passwords keyed by the sudo account each is for ('' = default/any).
  // Prefilled with the accounts already stored (passwords blank — never returned).
  // `becomeDirty` gates replace-all: untouched, we omit it so the stored set stays.
  const [becomePasswords, setBecomePasswords] = useState<Array<{ user: string; password: string }>>(
    () => (existing?.becomeUsers ?? []).map((u) => ({ user: u, password: '' })),
  );
  const [becomeDirty, setBecomeDirty] = useState(false);
  const editPasswords = (next: Array<{ user: string; password: string }>) => {
    setBecomePasswords(next);
    setBecomeDirty(true);
  };

  // Passwords are needed if either the far host or the jump hop elevates.
  const needsPasswords = form.becomeMethod !== 'none' || form.viaBecomeMethod !== 'none';

  const save = useMutation({
    mutationFn: () => {
      const become = {
        method: form.becomeMethod as 'none' | 'sudo' | 'su' | 'sudo-su',
        ...(form.becomeUser ? { user: form.becomeUser } : {}),
        ...(form.becomePty ? { pty: true } : {}),
        ...(form.becomeTemplate ? { template: form.becomeTemplate } : {}),
      };
      const config = {
        kind: 'ssh' as const,
        host: form.host,
        port: Number(form.port),
        user: form.user,
        sudo: form.sudo,
        become,
        ...(form.viaAlias
          ? {
              via: {
                alias: form.viaAlias,
                ...(cfg.via?.pty !== undefined ? { pty: cfg.via.pty } : {}),
                ...(form.viaFlags ? { sshFlags: form.viaFlags } : {}),
                ...(form.viaBecomeMethod !== 'none'
                  ? { become: { method: form.viaBecomeMethod, ...(form.viaBecomeUser ? { user: form.viaBecomeUser } : {}) } }
                  : {}),
              },
            }
          : {}),
        ...(form.loginShell ? { loginShell: true } : {}),
        ...(form.prelude ? { prelude: form.prelude } : {}),
      };
      const body = {
        name: form.name || form.slug,
        env: form.env,
        // Send the value even when blank, so clearing it actually clears it.
        // `|| undefined` dropped an emptied field, and PATCH treats missing as "keep".
        description: form.description,
        config,
        ...(form.secret ? { secret: form.secret } : {}),
        // Replace-all when touched (drops blank rows); omit when untouched so the
        // stored set is kept. No elevation → clear any stored passwords.
        ...(becomeDirty || !needsPasswords
          ? {
              becomePasswords:
                !needsPasswords
                  ? []
                  : becomePasswords.filter((r) => r.password).map((r) => ({ user: r.user, password: r.password })),
            }
          : {}),
      };
      return isEdit
        ? patch(`/targets/${existing.id}`, body)
        : post('/targets', { projectId, slug: form.slug, ...body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the target'),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Panel title={isEdit ? `Edit ${existing.slug}` : 'Add an SSH target'} className="p-4">
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Slug" hint={isEdit ? 'Fixed — agents and past runs refer to it.' : 'The name the agent will use. Lowercase, no spaces.'}>
          <input
            className="input disabled:opacity-60"
            placeholder="web-1"
            value={form.slug}
            onChange={set('slug')}
            disabled={isEdit}
          />
        </Field>
        <Field label="Display name">
          <input className="input" placeholder="App server 1" value={form.name} onChange={set('name')} />
        </Field>
        <Field
          label={form.viaAlias ? 'Host (jump / bastion)' : 'Host'}
          hint={
            form.viaAlias
              ? 'The bastion SupOps connects to; commands run on the machine below.'
              : 'A hostname or IP this machine can actually reach.'
          }
        >
          <input className="input" placeholder="10.0.0.5" value={form.host} onChange={set('host')} />
          {isEdit && (
            <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
              {pinnedKey ? (
                <>
                  <span>Host key</span>
                  <code className="truncate font-mono text-[10px]" title={pinnedKey}>{pinnedKey}</code>
                  <button
                    type="button"
                    className="text-amber hover:underline"
                    disabled={forgetKey.isPending}
                    onClick={() => {
                      if (window.confirm('Forget the pinned host key? The next connection will trust whatever key the server presents. Only do this after an expected rebuild.')) {
                        forgetKey.mutate();
                      }
                    }}
                  >
                    Forget host key
                  </button>
                </>
              ) : (
                <span>Host key: not pinned yet (saved automatically on the first successful connection).</span>
              )}
            </p>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Port">
            <input className="input" type="number" value={form.port} onChange={set('port')} />
          </Field>
          <Field label="User">
            <input className="input" value={form.user} onChange={set('user')} />
          </Field>
        </div>
        <Field label="Environment" hint="Production raises the risk tier of anything that changes state.">
          <select className="input" value={form.env} onChange={set('env')}>
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Second hop (optional)"
            hint="Reach a machine behind the host above: SupOps runs `ssh <alias>` on it, so the alias must be defined in the jump's ~/.ssh/config. Leave blank for a direct connection."
          >
            <input
              className="input font-mono text-xs"
              placeholder="e.g. logstore2"
              value={form.viaAlias}
              onChange={set('viaAlias')}
            />
          </Field>
          {form.viaAlias && (
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <Field label="Hop from account on the jump" hint="For jumps where you `sudo su -` before `ssh <alias>` works.">
                <select
                  className="input"
                  value={form.viaBecomeMethod}
                  onChange={(e) => setForm((f) => ({ ...f, viaBecomeMethod: e.target.value as typeof f.viaBecomeMethod }))}
                >
                  <option value="none">Login user</option>
                  <option value="sudo">sudo</option>
                  <option value="su">su - user</option>
                  <option value="sudo-su">sudo su - user</option>
                </select>
              </Field>
              {form.viaBecomeMethod !== 'none' && (
                <Field label="Account" hint="Blank = root. Its password goes in Elevation passwords below.">
                  <input className="input font-mono text-xs" placeholder="root" value={form.viaBecomeUser} onChange={set('viaBecomeUser')} />
                </Field>
              )}
            </div>
          )}
          {form.viaAlias && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted">Advanced: extra ssh flags</summary>
              <input
                className="input mt-2 font-mono text-xs"
                placeholder="-o StrictHostKeyChecking=accept-new"
                value={form.viaFlags}
                onChange={set('viaFlags')}
              />
            </details>
          )}
        </div>

        <div className="sm:col-span-2 border-t border-hairline pt-4">
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={form.loginShell}
              onChange={(e) => setForm((f) => ({ ...f, loginShell: e.target.checked }))}
            />
            Run in a login shell
          </label>
          <p className="mt-1 text-[11px] text-muted">
            Loads the login user's aliases, functions and PATH (from ~/.bashrc / ~/.profile). Turn on
            when commands are shell aliases (e.g. <code className="font-mono">prodlogin</code>) or tools
            aren't on the default PATH.
          </p>
        </div>
        <div className="sm:col-span-2">
          <Field
            label="Prelude (optional)"
            hint="Run before every command, in the same shell — e.g. an alias that logs in. Runs on each call."
          >
            <input
              className="input font-mono text-xs"
              placeholder="e.g. prodlogin"
              value={form.prelude}
              onChange={set('prelude')}
            />
          </Field>
        </div>
        <Field label="Description" hint="The agent reads this when choosing where to look.">
          <input className="input" placeholder="Add a short description" value={form.description} onChange={set('description')} />
        </Field>
        <div className="sm:col-span-2">
          <Field
            label="Password or private key"
            hint={
              isEdit
                ? existing.hasCredential
                  ? 'A credential is stored. Leave blank to keep it, or paste a new one to replace it.'
                  : 'No credential stored — connections will fail until you add one.'
                : 'Encrypted with AES-256-GCM before storage, and redacted from anything the agent sees.'
            }
          >
            <textarea
              className="input min-h-20 font-mono text-xs"
              placeholder={isEdit && existing.hasCredential ? '•••••••••••• (unchanged)' : 'password, or paste a PEM private key'}
              value={form.secret}
              onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
            />
          </Field>
        </div>

        {/* --- Execution / privilege -------------------------------------- */}
        <div className="sm:col-span-2 mt-1 border-t border-hairline pt-4">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Execution &amp; privilege</p>
          <p className="mb-3 text-[11px] text-muted">
            How every command is elevated before it runs. Enforced on each command — you don't have to
            tell the agent about it.
          </p>
        </div>
        <Field label="Elevation" hint="Applied to every command on this target.">
          <select
            className="input"
            value={form.becomeMethod}
            onChange={(e) => setForm((f) => ({ ...f, becomeMethod: e.target.value as typeof f.becomeMethod }))}
          >
            <option value="none">None — run as the SSH user</option>
            <option value="sudo">sudo (with password)</option>
            <option value="su">su - &lt;user&gt;</option>
            <option value="sudo-su">sudo su - &lt;user&gt;</option>
          </select>
        </Field>
        <Field label="Become user" hint="For su / sudo-su, or sudo -u. Defaults to root.">
          <input
            className="input disabled:opacity-50"
            placeholder="deploy"
            value={form.becomeUser}
            onChange={set('becomeUser')}
            disabled={form.becomeMethod === 'none' || form.becomeMethod === 'sudo' ? form.becomeMethod === 'none' : false}
          />
        </Field>
        {needsPasswords && (
          <>
            <div className="sm:col-span-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="label">Elevation passwords</span>
                <button
                  type="button"
                  className="btn-ghost !min-h-0 !py-1 !text-[11px]"
                  onClick={() => editPasswords([...becomePasswords, { user: '', password: '' }])}
                >
                  <Plus size={12} /> Add password
                </button>
              </div>
              <p className="mb-2 text-[11px] text-muted">
                One per sudo account. Leave the account blank for the default. When sudo asks for a
                specific user (<span className="font-mono">password for X</span>), SupOps sends the
                matching one. Fed over stdin, redacted from output. None = passwordless (NOPASSWD).
                {isEdit && ' Editing replaces the whole set — re-enter each password.'}
              </p>
              {becomePasswords.length === 0 && (
                <p className="mb-2 text-[11px] text-muted">
                  No passwords stored{isEdit ? '' : ' yet'}. Add one, or leave empty if the target is passwordless.
                </p>
              )}
              <div className="space-y-2">
                {becomePasswords.map((row, i) => (
                  <div key={i} className="flex gap-2">
                    <input
                      className="input w-40 font-mono text-xs"
                      placeholder="sudo user"
                      value={row.user}
                      onChange={(e) =>
                        editPasswords(becomePasswords.map((r, j) => (j === i ? { ...r, user: e.target.value } : r)))
                      }
                    />
                    <input
                      className="input flex-1 font-mono text-xs"
                      type="password"
                      placeholder="password for this user"
                      value={row.password}
                      onChange={(e) =>
                        editPasswords(becomePasswords.map((r, j) => (j === i ? { ...r, password: e.target.value } : r)))
                      }
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="btn-quiet !min-h-0 !w-9 !px-0"
                      onClick={() => editPasswords(becomePasswords.filter((_, j) => j !== i))}
                      title="Remove"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
            <label className="sm:col-span-2 flex items-center gap-2 text-xs text-ink">
              <input
                type="checkbox"
                checked={form.becomePty}
                onChange={(e) => setForm((f) => ({ ...f, becomePty: e.target.checked }))}
              />
              Request a PTY (only if sudo complains about <code className="font-mono">requiretty</code>)
            </label>
            <details className="sm:col-span-2">
              <summary className="cursor-pointer text-[11px] text-muted">Advanced: custom wrapper template</summary>
              <div className="mt-2">
                <Field label="Wrapper template" hint="Overrides the method above. Must contain {{CMD}}, which is replaced with the shell-quoted command.">
                  <input
                    className="input font-mono text-xs"
                    placeholder="e.g. kubectl exec mypod -- {{CMD}}"
                    value={form.becomeTemplate}
                    onChange={set('becomeTemplate')}
                  />
                </Field>
              </div>
            </details>
          </>
        )}
      </div>

      {error && <p className="px-4 text-sm text-red">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
        <button className="btn-ghost" onClick={onDone}>Cancel</button>
        <button
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.slug || !form.host}
        >
          {save.isPending ? <Spinner /> : null} {isEdit ? 'Save changes' : 'Add target'}
        </button>
      </div>
    </Panel>
  );
}

/** A compact row for a machine reached behind a jump (or the jump itself). */
function VmRow({
  target, isJump, testing, onTest, onEdit, onRemove,
}: {
  target: Target;
  isJump?: boolean;
  testing: boolean;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const cfg = target.config as { host?: string; user?: string; via?: { alias?: string } };
  const h = HEALTH_STYLE[target.healthState] ?? HEALTH_STYLE.unknown!;
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', h.dot)} title={h.label} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-mono text-sm text-ink">{target.slug}</span>
          {isJump ? (
            <span className="rounded border border-edge px-1.5 py-px text-[10px] uppercase tracking-wider text-muted">jump</span>
          ) : cfg.via?.alias ? (
            <span className="font-mono text-[11px] text-cyan">ssh {cfg.via.alias}</span>
          ) : null}
          {!target.hasCredential && <span className="text-[11px] text-amber">no credential</span>}
        </div>
        <p className="truncate text-[11px] text-muted">
          {isJump ? `${cfg.user}@${cfg.host}` : target.description ?? target.name}
          {target.lastCheckedAt ? ` · checked ${timeAgo(target.lastCheckedAt)}` : ''}
        </p>
      </div>
      <button className="btn-quiet !min-h-[36px] !text-xs" onClick={onTest} disabled={testing}>
        {testing ? <Spinner className="!h-3.5 !w-3.5" /> : <Plug size={13} />} Test
      </button>
      <button className="btn-quiet !min-h-[36px] !w-9 !px-0" onClick={onEdit} title={`Edit ${target.slug}`} aria-label={`Edit ${target.slug}`}>
        <Pencil size={13} />
      </button>
      <button className="btn-quiet !min-h-[36px] !w-9 !px-0 hover:!text-red" onClick={onRemove} title={`Remove ${target.slug}`} aria-label={`Remove ${target.slug}`}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}
