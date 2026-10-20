import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bug } from 'lucide-react';
import { api } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Empty, Panel, Spinner } from './ui';

interface ErrorGroup {
  id: string;
  service: string;
  type: string;
  message: string;
  frame: string | null;
  source: 'logs' | 'traces';
  example: string;
  traceId: string | null;
  count: number;
  lastCount: number;
  firstSeen: string;
  lastSeen: string;
  isNew: boolean;
  newAfterChange: { changeId: string; title: string; startedAt: number } | null;
}

/** Errors grouped by kind: new kinds first (and those that followed a change), then the most frequent. */
export function ErrorList({ projectId, service, title = 'Errors' }: { projectId: string; service?: string; title?: string }) {
  const [hours, setHours] = useState(24);
  const q = useQuery({
    queryKey: ['errors', projectId, service ?? '', hours],
    queryFn: () => api<ErrorGroup[]>(`/errors?projectId=${projectId}&hours=${hours}${service ? `&service=${encodeURIComponent(service)}` : ''}`),
  });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Panel
      title={title}
      accent="bg-red"
      action={
        <select className="input !min-h-[32px] !py-1 !text-xs" value={hours} onChange={(e) => setHours(Number(e.target.value))} aria-label="How far back">
          <option value={1}>Last hour</option>
          <option value={24}>Last day</option>
          <option value={168}>Last week</option>
        </select>
      }
    >
      <div className="px-5 pb-5">
        {q.isLoading ? (
          <Spinner />
        ) : q.data?.length ? (
          <ul className="divide-y divide-hairline rounded-inner border border-hairline">
            {q.data.map((g) => (
              <li key={g.id} className="px-3 py-2.5">
                <button className="w-full text-left" onClick={() => setOpen(open === g.id ? null : g.id)} aria-expanded={open === g.id}>
                  <div className="flex flex-wrap items-center gap-2">
                    {g.isNew && <span className="chip !text-[10.5px] border-red/30 bg-red/10 text-red">new</span>}
                    <span className="break-all font-mono text-[12.5px] text-ink">{g.type}</span>
                    {!service && <Link to={`/services/${encodeURIComponent(g.service)}`} onClick={(e) => e.stopPropagation()} className="text-[11px] text-blue-text hover:underline">{g.service}</Link>}
                    <span className="ml-auto font-mono text-[11px] text-muted">{g.count.toLocaleString()}×</span>
                  </div>
                  {g.message && <p className="mt-0.5 break-words text-[12.5px] text-ink/85">{g.message}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">
                    {[g.frame && `at ${g.frame}`, `first ${timeAgo(g.firstSeen)}`, `last ${timeAgo(g.lastSeen)}`, g.lastCount ? `${g.lastCount} in the latest scan` : 'not in the latest scan', `from ${g.source}`].filter(Boolean).join(' · ')}
                  </p>
                  {g.newAfterChange && <p className="mt-0.5 text-[11px] text-amber">First seen after: {g.newAfterChange.title}</p>}
                </button>
                {open === g.id && (
                  <pre className={clsx('mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-inner border border-hairline bg-ground/70 p-2.5 font-mono text-[11px] text-ink/85')}>{g.example}{g.traceId ? `\n\ntrace ${g.traceId}` : ''}</pre>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={<Bug size={24} />} title="No errors in this window" hint="Errors are read every few minutes from connected Loki logs and Tempo traces, grouped by kind: exception type, the top frame of your own code, and the message." />
        )}
      </div>
    </Panel>
  );
}
