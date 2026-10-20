import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, KeyRound, Plus, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { timeAgo } from '../lib/format';
import { Empty, Field, Panel, Spinner } from './ui';

type Scope = 'read' | 'investigate' | 'changes' | 'metrics' | 'mcp';
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

const SCOPES: Array<{ key: Scope; label: string; hint: string }> = [
  { key: 'read', label: 'Read', hint: 'Runs, incidents, alerts, changes, SLOs and the rest, read-only.' },
  { key: 'investigate', label: 'Investigate', hint: 'Start an investigation. It runs with the same approvals as one started by a person.' },
  { key: 'changes', label: 'Record changes', hint: 'POST /api/changes, for CI/CD to mark deploys.' },
  { key: 'metrics', label: 'Metrics', hint: "GET /api/metrics, SupOps' own health for Prometheus." },
  { key: 'mcp', label: 'MCP server', hint: 'Other agents use SupOps over MCP at /api/mcp. With Investigate too, they can start read-only investigations.' },
];

/** Keys for machines: CI marking deploys, Prometheus scraping /metrics, another agent using SupOps over MCP. */
export function ApiKeysPanel() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['apiKeys'], queryFn: () => api<ApiKey[]>('/api-keys') });
  const [adding, setAdding] = useState(false);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['apiKeys'] });
  const keys = list.data ?? [];
  const live = keys.filter((k) => !k.revokedAt);
  const revoked = keys.filter((k) => k.revokedAt);
  return (
    <Panel title="API keys" accent="bg-violet">
      <div className="space-y-4 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          For machines: CI marking deploys, Prometheus scraping SupOps' metrics, another agent using SupOps as an MCP server. Send a key as <code className="font-mono text-ink/80">Authorization: Bearer sok_…</code>;
          it acts in the name of the admin who made it, with only the scopes it was given, and stops working when that admin is removed or disabled.
        </p>
        {made && <NewToken name={made.name} token={made.token} onDone={() => setMade(null)} />}
        {!adding && !made && <button className="btn-primary" onClick={() => setAdding(true)}><Plus size={15} /> Make a key</button>}
        {adding && <KeyForm onCancel={() => setAdding(false)} onMade={(m) => { setAdding(false); setMade(m); refresh(); }} />}
        {list.isLoading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
        ) : live.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">
            {live.map((k) => <KeyRow key={k.id} k={k} onChanged={refresh} />)}
          </ul>
        ) : (
          !adding && !made && <Empty icon={<KeyRound size={24} />} title="No API keys" hint="Make one for CI, for Prometheus, or for another agent." />
        )}
        {revoked.length > 0 && (
          <div>
            <button className="text-xs text-blue-text hover:underline" onClick={() => setShowRevoked((v) => !v)} aria-expanded={showRevoked}>
              {showRevoked ? 'Hide' : 'Show'} {revoked.length} revoked
            </button>
            {showRevoked && (
              <ul className="mt-2 divide-y divide-hairline rounded-inner border border-hairline opacity-70">
                {revoked.map((k) => <KeyRow key={k.id} k={k} onChanged={refresh} />)}
              </ul>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

function KeyForm({ onCancel, onMade }: { onCancel: () => void; onMade: (m: { name: string; token: string }) => void }) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['read']);
  const [days, setDays] = useState('');
  const make = useMutation({
    mutationFn: () => post<{ key: ApiKey; token: string }>('/api-keys', { name, scopes, expiresInDays: days ? Number(days) : null }),
    onSuccess: (r) => onMade({ name: r.key.name, token: r.token }),
  });
  const toggle = (s: Scope) => setScopes((v) => (v.includes(s) ? v.filter((x) => x !== s) : [...v, s]));
  return (
    <form className="space-y-3 rounded-inner border border-hairline bg-tile-2/40 p-4" onSubmit={(e) => { e.preventDefault(); make.mutate(); }}>
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem]">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="ci-deploys" maxLength={80} autoFocus /></Field>
        <Field label="Expires after (days)"><input className="input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} placeholder="never" /></Field>
      </div>
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted">Scopes</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SCOPES.map((s) => (
            <label key={s.key} className={clsx('flex cursor-pointer items-start gap-2.5 rounded-inner border p-2.5', scopes.includes(s.key) ? 'border-blue/40 bg-blue/5' : 'border-hairline')}>
              <input type="checkbox" className="mt-0.5" checked={scopes.includes(s.key)} onChange={() => toggle(s.key)} />
              <span className="min-w-0">
                <span className="block text-sm text-ink">{s.label}</span>
                <span className="block text-[11px] leading-snug text-muted">{s.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {make.error && <p className="text-xs text-red">{(make.error as Error).message}</p>}
      <div className="flex gap-2">
        <button className="btn-primary" type="submit" disabled={!name.trim() || !scopes.length || make.isPending}>{make.isPending ? <Spinner /> : <KeyRound size={14} />} Make key</button>
        <button className="btn-ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function NewToken({ name, token, onDone }: { name: string; token: string; onDone: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null);
  return (
    <div className="space-y-2 rounded-inner border border-green/30 bg-green/5 p-4">
      <p className="text-sm text-ink">Key <span className="font-medium">{name}</span> made. Copy it now: SupOps keeps only a hash, so it cannot be shown again.</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <code className="min-w-0 flex-1 select-all break-all rounded-inner border border-hairline bg-ground/70 px-2.5 py-2 font-mono text-xs text-ink">{token}</code>
        <button className="btn-ghost shrink-0" onClick={async () => setCopied(await copyText(token))}>{copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}</button>
      </div>
      {copied === false && <p className="text-[11px] text-amber">The browser blocked copying: select the key above and press Ctrl+C.</p>}
      <button className="btn-ghost !px-2.5 !text-xs" onClick={onDone}><X size={13} /> Done</button>
    </div>
  );
}

function KeyRow({ k, onChanged }: { k: ApiKey; onChanged: () => void }) {
  const [sure, setSure] = useState(false);
  const revoke = useMutation({ mutationFn: () => post(`/api-keys/${k.id}/revoke`, {}), onSuccess: onChanged });
  const expired = !!k.expiresAt && new Date(k.expiresAt).getTime() <= Date.now();
  return (
    <li className="flex flex-wrap items-start gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-ink">{k.name}</span>
          <code className="font-mono text-[11px] text-muted">{k.prefix}…</code>
          {k.revokedAt ? <span className="chip border-edge bg-tile-2 text-muted">revoked</span> : expired ? <span className="chip border-amber/30 bg-amber/10 text-amber">expired</span> : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          {k.scopes.map((s) => <span key={s} className="chip whitespace-nowrap border-edge bg-tile-2 !text-[10px] text-ink/80">{SCOPES.find((x) => x.key === s)?.label ?? s}</span>)}
        </div>
        <p className="mt-1 text-[11px] text-muted">
          Made {timeAgo(k.createdAt)}{k.createdByName ? ` by ${k.createdByName}` : ''}
          {' · '}{k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}` : 'never used'}
          {k.expiresAt && !k.revokedAt ? ` · ${expired ? 'expired' : 'expires'} ${new Date(k.expiresAt).toLocaleDateString()}` : ''}
          {k.revokedAt ? ` · revoked ${timeAgo(k.revokedAt)}` : ''}
        </p>
      </div>
      {!k.revokedAt && (
        sure ? (
          <span className="flex shrink-0 gap-1.5">
            <button className="btn-ghost !px-2.5 !text-xs !text-red" disabled={revoke.isPending} onClick={() => revoke.mutate()}>Revoke for good</button>
            <button className="btn-ghost !px-2.5 !text-xs" onClick={() => setSure(false)}>Keep</button>
          </span>
        ) : (
          <button className="btn-ghost shrink-0 !px-2.5 !text-xs" onClick={() => setSure(true)}>Revoke</button>
        )
      )}
    </li>
  );
}
