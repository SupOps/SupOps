import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, Pencil, Plug, Plus, RotateCcw, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, del, patch, post, put } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, Field, Panel, Segmented, Spinner, Switch } from './ui';

interface McpTool {
  name: string;
  key: string;
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}
interface McpServer {
  id: string;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[] | null;
  allowPrivateNetwork: boolean;
  enabled: boolean;
  tools: McpTool[];
  readOnly: Record<string, { by: string; at: number }>;
  identityTool: string | null;
  identity: string | null;
  serverInfo: { name: string; version: string; protocolVersion: string } | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  headerNames: string[];
  envNames: string[];
  wildcard: string;
  suggestedIdentityTool: string | null;
}

/**
 * MCP servers: tools from other systems (GitHub, Jira, a cloud, an internal API) that a
 * project's runs may call. Every tool waits for approval until an admin marks it read-only.
 */
export function McpPanel({ projectId, isAdmin }: { projectId: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['mcpServers', projectId], queryFn: () => api<{ stdioAllowed: boolean; servers: McpServer[] }>(`/mcp-servers?projectId=${projectId}`) });
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mcpServers', projectId] });
  return (
    <Panel title="MCP servers" accent="bg-cyan">
      <div className="space-y-4 border-t border-hairline px-5 pb-5 pt-4">
        <p className="max-w-3xl text-xs leading-relaxed text-muted">
          Tools from other systems, over the Model Context Protocol. Each call waits for a person's approval unless an admin marks that tool read-only; what the
          server says about its own tools is shown as a hint only. Agents allowed every tool get them; others need the server's entry (shown below) in their tool list.
        </p>
        {isAdmin && !editing && <button className="btn-primary" onClick={() => setEditing('new')}><Plus size={15} /> Add an MCP server</button>}
        {editing && (
          <ServerForm
            projectId={projectId}
            existing={editing === 'new' ? null : editing}
            stdioAllowed={!!list.data?.stdioAllowed}
            onDone={() => { setEditing(null); refresh(); }}
            onCancel={() => setEditing(null)}
          />
        )}
        {list.isLoading ? (
          <div className="grid place-items-center py-8 text-muted"><Spinner /></div>
        ) : list.data?.servers.length ? (
          list.data.servers.map((s) => <ServerRow key={s.id} s={s} isAdmin={isAdmin} onEdit={() => setEditing(s)} onChanged={refresh} />)
        ) : (
          !editing && <Empty icon={<Plug size={24} />} title="No MCP servers" hint="Add one to give investigations tools from GitHub, Jira, a cloud or your own APIs." />
        )}
      </div>
    </Panel>
  );
}

function ServerRow({ s, isAdmin, onEdit, onChanged }: { s: McpServer; isAdmin: boolean; onEdit: () => void; onChanged: () => void }) {
  const [sure, setSure] = useState(false);
  const [open, setOpen] = useState(false);
  const check = useMutation({ mutationFn: () => post(`/mcp-servers/${s.id}/check`, {}), onSuccess: onChanged });
  const toggle = useMutation({ mutationFn: () => patch(`/mcp-servers/${s.id}`, { enabled: !s.enabled }), onSuccess: onChanged });
  const remove = useMutation({ mutationFn: () => del(`/mcp-servers/${s.id}`), onSuccess: onChanged });
  const mark = useMutation({ mutationFn: (v: { tool: string; readOnly: boolean }) => put(`/mcp-servers/${s.id}/tools/${encodeURIComponent(v.tool)}/read-only`, { readOnly: v.readOnly }), onSuccess: onChanged });
  const marked = s.tools.filter((t) => s.readOnly[t.name]).length;
  return (
    <div className={clsx('rounded-inner border border-hairline bg-tile-2/40 p-3.5', !s.enabled && 'opacity-70')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{s.name}</span>
            <span className="chip border border-edge bg-tile-2 text-muted">{s.transport === 'http' ? 'HTTP' : 'local'}</span>
            {s.lastError ? <span className="chip border-red/30 bg-red/10 text-red">not working</span> : s.lastCheckedAt ? <span className="chip border-green/30 bg-green/10 text-green">connected</span> : null}
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-muted">{s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ')}</p>
          <p className="mt-1 text-[11px] text-muted">
            {s.serverInfo ? `${s.serverInfo.name} ${s.serverInfo.version} · ` : ''}
            {s.tools.length} tool{s.tools.length === 1 ? '' : 's'}, {marked} read-only
            {s.lastCheckedAt ? ` · checked ${timeAgo(s.lastCheckedAt)}` : ''}
            {s.headerNames.length ? ` · headers: ${s.headerNames.join(', ')}` : ''}
            {s.envNames.length ? ` · environment: ${s.envNames.join(', ')}` : ''}
          </p>
          {s.identity && <p className="mt-1 text-[11px] text-ink/85"><ShieldCheck size={11} className="mr-1 inline text-cyan" />Acts as: {s.identity}</p>}
          <p className="mt-1 text-[11px] text-muted">For an agent's tool list: <code className="font-mono text-ink/80">{s.wildcard}</code></p>
          {s.lastError && <p className="mt-2 flex items-start gap-1.5 text-xs text-red"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span className="break-words">{s.lastError}</span></p>}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <Switch label={s.enabled ? 'Switch off' : 'Switch on'} checked={s.enabled} onChange={() => toggle.mutate()} />
            <button className="btn-ghost !px-2.5 !text-xs" disabled={check.isPending} onClick={() => check.mutate()} title="Connect again and refresh the tools">{check.isPending ? <Spinner /> : <RotateCcw size={13} />} Check</button>
            <button className="btn-ghost !px-2.5" onClick={onEdit} aria-label="Edit"><Pencil size={13} /></button>
            {sure ? (
              <button className="btn-ghost !px-2.5 !text-xs !text-red" onClick={() => remove.mutate()}>Remove?</button>
            ) : (
              <button className="btn-ghost !px-2.5" onClick={() => setSure(true)} aria-label="Remove"><Trash2 size={13} /></button>
            )}
          </div>
        )}
      </div>
      {s.tools.length > 0 && (
        <div className="mt-3">
          <button className="text-xs text-blue-text hover:underline" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? 'Hide tools' : 'Show tools'}</button>
          {open && (
            <ul className="mt-2 divide-y divide-hairline rounded-inner border border-hairline">
              {s.tools.map((t) => {
                const ro = s.readOnly[t.name];
                return (
                  <li key={t.name} className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs text-ink">{t.name}</span>
                        {t.annotations?.readOnlyHint && <span className="chip !text-[10px] border border-edge bg-tile-2 text-muted" title="What the server says; not trusted on its own">server: read-only</span>}
                        {t.annotations?.destructiveHint && <span className="chip !text-[10px] border-red/30 bg-red/10 text-red">server: destructive</span>}
                        {s.identityTool === t.name && <span className="chip !text-[10px] border-cyan/30 bg-cyan/10 text-cyan">identity check</span>}
                      </div>
                      {t.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{t.description}</p>}
                      <p className="mt-0.5 text-[11px] text-muted">
                        {ro ? <>Runs without approval · marked read-only by {ro.by}, {timeAgo(new Date(ro.at).toISOString())}</> : 'Each call waits for approval'}
                      </p>
                    </div>
                    {isAdmin && (
                      <label className="flex shrink-0 items-center gap-2 text-[11px] text-muted">
                        <Switch label={`Mark ${t.name} read-only`} checked={!!ro} disabled={mark.isPending} onChange={(v) => mark.mutate({ tool: t.name, readOnly: v })} />
                        Read-only
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {mark.error && <p className="mt-1 text-xs text-red">{(mark.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}

type Pair = { k: string; v: string };

function Pairs({ label, hint, pairs, onChange, keyPlaceholder, valuePlaceholder }: { label: string; hint: string; pairs: Pair[]; onChange: (p: Pair[]) => void; keyPlaceholder: string; valuePlaceholder: string }) {
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-1.5">
        {pairs.map((p, i) => (
          <div key={i} className="flex gap-1.5">
            <input className="input w-2/5 min-w-0 font-mono text-xs" value={p.k} placeholder={keyPlaceholder} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} />
            <input className="input min-w-0 flex-1 font-mono text-xs" type="password" autoComplete="off" value={p.v} placeholder={valuePlaceholder} onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} />
            <button type="button" className="btn-ghost !px-2" aria-label="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}><X size={13} /></button>
          </div>
        ))}
        <button type="button" className="btn-ghost !text-xs" onClick={() => onChange([...pairs, { k: '', v: '' }])}><Plus size={13} /> Add</button>
      </div>
    </Field>
  );
}

const record = (pairs: Pair[]) => Object.fromEntries(pairs.filter((p) => p.k.trim()).map((p) => [p.k.trim(), p.v]));

function ServerForm({ projectId, existing, stdioAllowed, onDone, onCancel }: { projectId: string; existing: McpServer | null; stdioAllowed: boolean; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [transport, setTransport] = useState<'http' | 'stdio'>(existing?.transport ?? 'http');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [command, setCommand] = useState(existing?.command ?? '');
  const [args, setArgs] = useState((existing?.args ?? []).join('\n'));
  const [allowPrivate, setAllowPrivate] = useState(existing?.allowPrivateNetwork ?? false);
  const [identityTool, setIdentityTool] = useState(existing?.identityTool ?? existing?.suggestedIdentityTool ?? '');
  // Secrets are never sent back: editing them replaces all of them.
  const [replaceSecrets, setReplaceSecrets] = useState(!existing);
  const [headers, setHeaders] = useState<Pair[]>(existing ? [] : [{ k: 'Authorization', v: '' }]);
  const [env, setEnv] = useState<Pair[]>([]);
  const save = useMutation({
    mutationFn: () => {
      const body = {
        transport,
        ...(transport === 'http' ? { url: url.trim(), allowPrivateNetwork: allowPrivate } : { command: command.trim(), args: args.split('\n').map((a) => a.trim()).filter(Boolean) }),
        identityTool: identityTool.trim() || null,
        ...(replaceSecrets ? (transport === 'http' ? { headers: record(headers) } : { env: record(env) }) : {}),
      };
      return existing ? patch(`/mcp-servers/${existing.id}`, body) : post('/mcp-servers', { projectId, name: name.trim(), ...body });
    },
    onSuccess: onDone,
  });
  return (
    <div className="space-y-3 rounded-inner border border-blue/30 bg-blue/[0.04] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" hint={existing ? 'Fixed: it names the tools.' : 'Lowercase, up to 24 characters. It names the tools (mcp_<name>_<tool>) and cannot be changed later.'}>
          <input className="input font-mono" value={name} disabled={!!existing} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} placeholder="github" />
        </Field>
        <Field label="How SupOps reaches it" hint={stdioAllowed ? undefined : 'Local servers are switched off on this SupOps server (SUPOPS_MCP_STDIO).'}>
          <Segmented label="Transport" value={transport} onChange={setTransport} disabled={!!existing} options={[{ value: 'http', label: 'HTTP' }, ...(stdioAllowed || existing?.transport === 'stdio' ? [{ value: 'stdio' as const, label: 'Local program' }] : [])]} />
        </Field>
      </div>
      {transport === 'http' ? (
        <>
          <Field label="URL" hint="The server's streamable HTTP endpoint, e.g. https://mcp.example.com/mcp. Redirects are not followed.">
            <input className="input font-mono text-xs" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
          </Field>
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} /> Allow a private or internal address (cloud metadata addresses are always refused)
          </label>
        </>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Command" hint="Started on the SupOps server, with only PATH, HOME, LANG and the variables below.">
            <input className="input font-mono text-xs" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
          </Field>
          <Field label="Arguments (one per line)">
            <textarea className="input min-h-20 font-mono text-xs" value={args} onChange={(e) => setArgs(e.target.value)} />
          </Field>
        </div>
      )}
      {existing && !replaceSecrets ? (
        <p className="text-xs text-muted">
          {transport === 'http' ? `Headers set: ${existing.headerNames.join(', ') || 'none'}.` : `Variables set: ${existing.envNames.join(', ') || 'none'}.`}{' '}
          <button className="text-blue-text hover:underline" onClick={() => setReplaceSecrets(true)}>Replace them</button>
        </p>
      ) : transport === 'http' ? (
        <Pairs label="Headers" hint="Sent with every request, kept encrypted, never shown again. For example Authorization: Bearer <token>." pairs={headers} onChange={setHeaders} keyPlaceholder="Authorization" valuePlaceholder="Bearer …" />
      ) : (
        <Pairs label="Environment variables" hint="Kept encrypted, never shown again." pairs={env} onChange={setEnv} keyPlaceholder="GITHUB_TOKEN" valuePlaceholder="value" />
      )}
      <Field label="Identity tool (optional)" hint="A read-only tool, such as whoami, that the health check calls to show which account SupOps acts as. It is called only once you mark it read-only.">
        <input className="input font-mono text-xs" value={identityTool} onChange={(e) => setIdentityTool(e.target.value)} placeholder="whoami" />
      </Field>
      {save.error && <p className="text-sm text-red">{(save.error as Error).message}</p>}
      <div className="flex flex-wrap gap-2">
        <button className="btn-primary" disabled={save.isPending || (!existing && !name.trim())} onClick={() => save.mutate()}>{save.isPending ? <Spinner /> : null} {existing ? 'Save and check' : 'Add and check'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
