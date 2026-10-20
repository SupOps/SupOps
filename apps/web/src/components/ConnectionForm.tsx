import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { patch, post } from '../lib/api';
import { Field, Panel, Segmented, Spinner, Switch } from './ui';
import type { Target } from '../lib/types';

type Kind = 'prometheus' | 'alertmanager' | 'loki' | 'elasticsearch' | 'grafana' | 'tempo' | 'jaeger' | 'signoz' | 'github' | 'gitlab';
type AuthType = 'none' | 'bearer' | 'basic';

const KINDS: Array<{ value: Kind; label: string; hint: string; placeholder: string }> = [
  { value: 'prometheus', label: 'Prometheus', hint: 'Metrics via PromQL (Prometheus, Thanos, Mimir, VictoriaMetrics).', placeholder: 'https://prometheus.internal:9090' },
  { value: 'alertmanager', label: 'Alertmanager', hint: 'Active alerts and silences.', placeholder: 'https://alertmanager.internal:9093' },
  { value: 'loki', label: 'Loki', hint: 'Logs via LogQL.', placeholder: 'https://loki.internal:3100' },
  { value: 'elasticsearch', label: 'Elasticsearch', hint: 'Logs via Lucene query syntax (Elasticsearch or OpenSearch).', placeholder: 'https://es.internal:9200' },
  { value: 'grafana', label: 'Grafana', hint: 'PromQL through a Grafana Prometheus datasource (use a Viewer service-account token).', placeholder: 'https://grafana.internal' },
  { value: 'tempo', label: 'Tempo', hint: 'Traces: search by service, duration, errors or TraceQL, and read one trace as a summary.', placeholder: 'https://tempo.internal:3200' },
  { value: 'signoz', label: 'SigNoz', hint: 'Traces through the SigNoz query API (v5). Use a service account API key as the bearer token; it is sent as SIGNOZ-API-KEY.', placeholder: 'https://signoz.internal:8080' },
  { value: 'jaeger', label: 'Jaeger', hint: 'Traces through the Jaeger query API (the UI address, e.g. port 16686).', placeholder: 'https://jaeger.internal:16686' },
  { value: 'github', label: 'GitHub', hint: 'CI runs and why they failed, pull requests with checks and changed files, commits, files, releases. Read-only, only for the repositories listed. Use a fine-grained token with read access to Actions, Contents and Pull requests.', placeholder: 'https://api.github.com' },
  { value: 'gitlab', label: 'GitLab', hint: 'Pipelines and failed job logs, merge requests, commits, files, releases. Read-only, only for the projects listed. Use a token with the read_api scope.', placeholder: 'https://gitlab.com' },
];
const isScm = (k: Kind) => k === 'github' || k === 'gitlab';

/**
 * Add or edit an observability connection. These are read-only to the agent: it can
 * query metrics, logs and alerts, never change anything. Credentials are sent once
 * and stored encrypted; they are never shown again.
 */
export function ConnectionForm({ projectId, existing, onDone }: { projectId: string; existing?: Target; onDone: () => void }) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const cfg = (existing?.config ?? {}) as { kind?: Kind; baseUrl?: string; allowPrivateNetwork?: boolean; insecureSkipVerify?: boolean; tenantId?: string; indices?: string[]; datasourceUid?: string; ingestAlerts?: boolean; watch?: boolean; repos?: string[] };
  const [kind, setKind] = useState<Kind>(cfg.kind ?? 'prometheus');
  const [form, setForm] = useState({
    slug: existing?.slug ?? '',
    name: existing?.name ?? '',
    env: existing?.env ?? ('prod' as 'dev' | 'staging' | 'prod'),
    description: existing?.description ?? '',
    baseUrl: cfg.baseUrl ?? '',
    allowPrivateNetwork: cfg.allowPrivateNetwork ?? true,
    insecureSkipVerify: cfg.insecureSkipVerify ?? false,
    tenantId: cfg.tenantId ?? '',
    indices: (cfg.indices ?? []).join(', '),
    datasourceUid: cfg.datasourceUid ?? '',
    repos: (cfg.repos ?? []).join(', '),
    // Unset means the default: Alertmanager alerts are read, metrics are watched.
    ingestAlerts: cfg.ingestAlerts as boolean | undefined,
    watch: cfg.watch ?? true,
  });
  const ingestDefault = kind === 'alertmanager';
  const ingest = form.ingestAlerts ?? ingestDefault;
  const canIngest = kind === 'alertmanager' || kind === 'prometheus' || kind === 'grafana';
  const canWatch = kind === 'prometheus' || kind === 'grafana';
  const [authType, setAuthType] = useState<AuthType>(isEdit ? 'none' : 'none');
  const [changeAuth, setChangeAuth] = useState(!isEdit);
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const meta = KINDS.find((k) => k.value === kind)!;

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? (e.target as HTMLInputElement).checked : e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const config = {
        kind,
        baseUrl: form.baseUrl.trim(),
        allowPrivateNetwork: form.allowPrivateNetwork,
        ...(form.insecureSkipVerify ? { insecureSkipVerify: true } : {}),
        ...((kind === 'loki' || kind === 'tempo') && form.tenantId.trim() ? { tenantId: form.tenantId.trim() } : {}),
        ...(kind === 'elasticsearch' ? { indices: form.indices.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) } : {}),
        ...(kind === 'grafana' && form.datasourceUid.trim() ? { datasourceUid: form.datasourceUid.trim() } : {}),
        ...(isScm(kind) ? { repos: form.repos.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean) } : {}),
        ...(canIngest ? { ingestAlerts: ingest } : {}),
        ...(canWatch ? { watch: form.watch } : {}),
      };
      const auth =
        authType === 'bearer' ? { type: 'bearer', token } : authType === 'basic' ? { type: 'basic', username, password } : { type: 'none' };
      const body = {
        name: form.name || form.slug,
        env: form.env,
        description: form.description,
        config,
        ...(changeAuth ? { auth } : {}),
      };
      return isEdit ? patch<Target>(`/targets/${existing.id}`, body) : post<Target>('/targets', { ...body, projectId, slug: form.slug });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the connection'),
  });

  return (
    <Panel title={isEdit ? `Edit ${existing.slug}` : 'Add a connection (observability, GitHub or GitLab)'} accent="bg-cyan" className="p-4">
      <div className="space-y-4 px-1 pb-1">
        {!isEdit && (
          <div>
            <label className="label" htmlFor="connection-kind">Connection type</label>
            <select id="connection-kind" className="input w-full sm:w-64" value={kind} onChange={(e) => { const k = e.target.value as Kind; setKind(k); if (isScm(k)) setAuthType('bearer'); }}>
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <p className="mt-1.5 text-[11px] text-muted">{meta.hint} The agent can only read from it.</p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {!isEdit && (
            <Field label="Slug (what the agent calls it)">
              <input className="input font-mono" value={form.slug} placeholder={`${kind}-prod`} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
            </Field>
          )}
          <Field label="Name"><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="Environment">
            <select className="input" value={form.env} onChange={set('env')}>
              <option value="dev">dev</option>
              <option value="staging">staging</option>
              <option value="prod">prod</option>
            </select>
          </Field>
          <Field label="API URL"><input className="input font-mono" value={form.baseUrl} placeholder={meta.placeholder} onChange={set('baseUrl')} /></Field>
          {(kind === 'loki' || kind === 'tempo') && <Field label="Tenant (X-Scope-OrgID, optional)"><input className="input" value={form.tenantId} onChange={set('tenantId')} /></Field>}
          {kind === 'grafana' && <Field label="Prometheus datasource uid"><input className="input font-mono" value={form.datasourceUid} placeholder="e.g. P1809F7CD0C75ACF3" onChange={set('datasourceUid')} /></Field>}
          {isScm(kind) && (
            <Field label={kind === 'github' ? 'Repositories it may read (owner/name; * allowed)' : 'Projects it may read (group/project; * allowed)'}>
              <input className="input font-mono" value={form.repos} placeholder={kind === 'github' ? 'acme/shop, acme/infra-*' : 'platform/api, platform/*'} onChange={set('repos')} />
            </Field>
          )}
          {kind === 'elasticsearch' && <Field label="Allowed index patterns (blank = any)"><input className="input font-mono" value={form.indices} placeholder="logs-*, app-*" onChange={set('indices')} /></Field>}
          <Field label="Description (helps the agent pick it)"><input className="input" value={form.description} onChange={set('description')} /></Field>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.allowPrivateNetwork} onChange={set('allowPrivateNetwork')} /> On a private network (LAN / in-cluster)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={form.insecureSkipVerify} onChange={set('insecureSkipVerify')} /> Accept a self-signed certificate</label>
        </div>

        {(canIngest || canWatch) && (
          <div className="space-y-2.5 border-t border-hairline pt-3">
            {canIngest && (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-ink">Read alerts from it</div>
                  <p className="text-[11px] text-muted">
                    {kind === 'grafana' ? 'Grafana-managed alerts, through its built-in Alertmanager.' : kind === 'prometheus' ? "Prometheus' own firing alerts. Leave off if they already reach SupOps through Alertmanager." : 'Every minute. Nothing to configure on the Alertmanager side.'}
                  </p>
                </div>
                <Switch label="Read alerts" checked={ingest} onChange={(v) => setForm((f) => ({ ...f, ingestAlerts: v }))} />
              </div>
            )}
            {canWatch && (
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm text-ink">Watch key signals</div>
                  <p className="text-[11px] text-muted">CPU, memory, disk, errors, latency and the stack itself, sampled every few minutes to spot what is unusual and what will run out.</p>
                </div>
                <Switch label="Watch signals" checked={form.watch} onChange={(v) => setForm((f) => ({ ...f, watch: v }))} />
              </div>
            )}
          </div>
        )}

        <div className="space-y-2 border-t border-hairline pt-3">
          {isEdit && !changeAuth ? (
            <button className="btn-ghost" onClick={() => setChangeAuth(true)}>Change authentication…</button>
          ) : (
            <>
              <Segmented
                label="Authentication"
                value={authType}
                onChange={setAuthType}
                options={isScm(kind) ? [{ value: 'bearer', label: 'Token' }] : [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'basic', label: 'Username & password' }]}
              />
              {authType === 'bearer' && <input className="input font-mono" type="password" placeholder="token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />}
              {authType === 'basic' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <input className="input" placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
                  <input className="input" type="password" placeholder="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
                </div>
              )}
              <p className="text-[11px] text-muted">Stored encrypted and never shown again. Use a read-only token where the backend supports one.</p>
            </>
          )}
        </div>

        {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
        <div className="flex gap-2">
          <button
            className="btn-primary"
            disabled={save.isPending || !form.baseUrl.trim() || (!isEdit && !form.slug) || (isScm(kind) && !form.repos.trim())}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner /> : null} {isEdit ? 'Save' : 'Add connection'}
          </button>
          <button className="btn-ghost" onClick={onDone}>Cancel</button>
        </div>
      </div>
    </Panel>
  );
}
