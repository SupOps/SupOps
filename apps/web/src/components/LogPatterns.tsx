import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ScrollText, Search } from 'lucide-react';
import { api } from '../lib/api';
import { Empty, Panel, Spinner } from './ui';
import { Sparkline } from './viz';
import type { ObsConnection } from '../lib/types';

interface Pattern { template: string; count: number; example: string; buckets?: number[]; isNew?: boolean; spiking?: boolean }

const DEFAULT: Record<string, string> = { loki: '{job=~".+"} |~ "(?i)(error|exception|fatal|panic)"', elasticsearch: 'level:(error OR fatal) OR message:(error OR exception)' };

/** A log search as patterns: the variable parts masked, counts over the window, what is new or spiking first. */
export function LogPatterns({ projectId, connections }: { projectId: string; connections: ObsConnection[] }) {
  const logs = connections.filter((c) => c.kind === 'loki' || c.kind === 'elasticsearch');
  const [connId, setConnId] = useState(logs[0]?.id ?? '');
  const conn = logs.find((c) => c.id === connId);
  const [draft, setDraft] = useState(conn ? DEFAULT[conn.kind] ?? '' : '');
  const [query, setQuery] = useState(draft);
  const [hours, setHours] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({
    queryKey: ['log-patterns', projectId, connId, query, hours],
    queryFn: () => api<{ lines: number; patterns: Pattern[] }>(`/observability/log-patterns?projectId=${projectId}&connectionId=${connId}&hours=${hours}&query=${encodeURIComponent(query)}`),
    enabled: !!connId,
  });
  if (!logs.length) return <Panel><Empty icon={<ScrollText size={24} />} title="No logs connected" hint="Add a Loki or Elasticsearch connection to see log patterns." /></Panel>;
  return (
    <Panel title="Log patterns" accent="bg-cyan">
      <div className="space-y-3 px-5 pb-5">
        <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); setQuery(draft); }}>
          {logs.length > 1 && (
            <select className="input sm:w-40" value={connId} onChange={(e) => { setConnId(e.target.value); const k = logs.find((c) => c.id === e.target.value)?.kind ?? ''; setDraft(DEFAULT[k] ?? ''); setQuery(DEFAULT[k] ?? ''); }} aria-label="Connection">
              {logs.map((c) => <option key={c.id} value={c.id}>{c.slug}</option>)}
            </select>
          )}
          <input className="input min-w-0 flex-1 font-mono text-xs" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={conn?.kind === 'loki' ? 'LogQL' : 'Query'} />
          <select className="input sm:w-32" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="Window">
            <option value={0.25}>15 min</option>
            <option value={1}>1 hour</option>
            <option value={6}>6 hours</option>
            <option value={24}>24 hours</option>
          </select>
          <button className="btn-primary" type="submit"><Search size={14} /> Group</button>
        </form>
        {q.isLoading ? (
          <div className="grid place-items-center py-8"><Spinner /></div>
        ) : q.error ? (
          <p className="text-sm text-red">{(q.error as Error).message}</p>
        ) : q.data?.patterns.length ? (
          <>
            <p className="text-[11px] text-muted">{q.data.lines.toLocaleString()} lines{q.data.lines >= 2000 ? ' (the newest 2000)' : ''} in {q.data.patterns.length} pattern{q.data.patterns.length === 1 ? '' : 's'}. &lt;*&gt; marks the parts that vary.</p>
            <ul className="divide-y divide-hairline rounded-inner border border-hairline">
              {q.data.patterns.map((p, i) => (
                <li key={i} className="px-3 py-2">
                  <button className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
                    <span className="w-14 shrink-0 text-right font-mono text-xs text-ink">{p.count.toLocaleString()}</span>
                    <span className="min-w-0 flex-1">
                      {(p.isNew || p.spiking) && <span className={clsx('chip mr-1.5 !text-[10px]', p.isNew ? 'border-red/30 bg-red/10 text-red' : 'border-amber/30 bg-amber/10 text-amber')}>{p.isNew ? 'new' : 'spiking'}</span>}
                      <span className="break-all font-mono text-[11.5px] text-ink/90">{p.template}</span>
                    </span>
                    {p.buckets && (
                      <span className="hidden w-[90px] shrink-0 sm:block">
                        <Sparkline points={p.buckets} width={90} height={22} ariaLabel="count over the window" color={p.isNew ? 'rgb(var(--red))' : p.spiking ? 'rgb(var(--amber))' : undefined} />
                      </span>
                    )}
                  </button>
                  {open === i && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-inner border border-hairline bg-ground/70 p-2.5 font-mono text-[11px] text-ink/85">{p.example}</pre>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted">No lines matched in this window.</p>
        )}
      </div>
    </Panel>
  );
}
