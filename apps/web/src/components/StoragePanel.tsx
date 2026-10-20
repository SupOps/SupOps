import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { HardDrive, Trash2 } from 'lucide-react';
import { api, post, put } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Panel, Segmented, Spinner } from './ui';

interface Storage {
  databaseBytes: number;
  walBytes: number;
  freeInsideBytes: number;
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
  incrementalVacuum: boolean;
  runs: number;
  images: number;
  imageBytes: number;
  retention: {
    days: number | null;
    dropImagesAfterDays: number | null;
    lastRunAt: number | null;
    lastResult: { at: number; runs: number; images: number; freedBytes: number; error?: string } | null;
  };
}

interface Preview {
  runs: number;
  images: number;
  imageBytes: number;
  imagesOnly: number;
  kept: { pinned: number; active: number; linked: number };
}

/** The retention choices offered; custom values set elsewhere still display. */
const CHOICES = ['off', '7', '15', '30'] as const;
type Choice = (typeof CHOICES)[number] | 'custom';
const toChoice = (d: number | null): Choice => (d === null ? 'off' : (CHOICES as readonly string[]).includes(String(d)) ? (String(d) as Choice) : 'custom');
const fromChoice = (c: Choice, custom: number | null): number | null => (c === 'off' ? null : c === 'custom' ? custom : Number(c));

export const formatBytes = (b: number): string => {
  if (b < 1024) return `${b} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

/**
 * Settings › Storage & retention. Shows what history costs on disk, sets the
 * automatic clean-up policy, and runs a clean-up now with a preview of exactly what
 * would go (and what is kept, and why). Changing anything is admin-only.
 */
export function StoragePanel({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const storage = useQuery({ queryKey: ['storage'], queryFn: () => api<Storage>('/maintenance/storage'), refetchInterval: 60_000 });
  const s = storage.data;

  const [runsChoice, setRunsChoice] = useState<Choice>('off');
  const [imagesChoice, setImagesChoice] = useState<Choice>('off');
  useEffect(() => {
    if (!s) return;
    setRunsChoice(toChoice(s.retention.days));
    setImagesChoice(toChoice(s.retention.dropImagesAfterDays));
  }, [s?.retention.days, s?.retention.dropImagesAfterDays]);

  const savePolicy = useMutation({
    mutationFn: (body: { days: number | null; dropImagesAfterDays: number | null }) => put('/maintenance/retention', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['storage'] }),
  });
  const choose = (which: 'runs' | 'images', c: Choice) => {
    const days = which === 'runs' ? fromChoice(c, s?.retention.days ?? null) : fromChoice(runsChoice, s?.retention.days ?? null);
    const img = which === 'images' ? fromChoice(c, s?.retention.dropImagesAfterDays ?? null) : fromChoice(imagesChoice, s?.retention.dropImagesAfterDays ?? null);
    if (which === 'runs') setRunsChoice(c);
    else setImagesChoice(c);
    savePolicy.mutate({ days, dropImagesAfterDays: img });
  };

  // ---- clean up now ----
  const [nowChoice, setNowChoice] = useState<'1' | '7' | '15' | '30' | '90'>('30');
  const nowDays = Number(nowChoice);
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState(false);
  const preview = useQuery({
    queryKey: ['cleanup-preview', nowDays],
    queryFn: () => post<Preview>('/maintenance/cleanup/preview', { olderThanDays: nowDays }),
    enabled: open,
  });
  const cleanup = useMutation({
    mutationFn: () => post<{ runs: number; images: number; freedBytes: number; shrunk: boolean }>('/maintenance/cleanup', { olderThanDays: nowDays, confirm }),
    onSuccess: () => {
      setConfirm('');
      void qc.invalidateQueries({ queryKey: ['storage'] });
      void qc.invalidateQueries({ queryKey: ['cleanup-preview'] });
      void qc.invalidateQueries({ queryKey: ['runs'] });
    },
  });

  const used = s ? s.databaseBytes + s.walBytes : 0;
  const diskUsedPct = s?.totalDiskBytes && s.freeDiskBytes !== null ? Math.round(((s.totalDiskBytes - s.freeDiskBytes) / s.totalDiskBytes) * 100) : null;
  const low = !!s && s.freeDiskBytes !== null && (s.freeDiskBytes < 1024 ** 3 || (diskUsedPct ?? 0) >= 90);

  return (
    <Panel title="Storage & retention" accent="bg-cyan">
      <div className="space-y-5 px-5 pb-5 pt-1">
        {!s ? (
          <div className="grid h-20 place-items-center text-muted"><Spinner /></div>
        ) : (
          <>
            {/* ---- meter ---- */}
            <div className="grid gap-3 sm:grid-cols-3">
              <Stat label="History database" value={formatBytes(used)} hint={`${s.runs.toLocaleString()} run${s.runs === 1 ? '' : 's'} kept`} />
              <Stat label="Pasted images" value={formatBytes(s.imageBytes)} hint={`${s.images} image${s.images === 1 ? '' : 's'}`} />
              <Stat
                label="Free disk"
                value={s.freeDiskBytes === null ? '—' : formatBytes(s.freeDiskBytes)}
                hint={diskUsedPct === null ? '' : `${diskUsedPct}% of disk used`}
                warn={low}
              />
            </div>
            {diskUsedPct !== null && (
              <div className="h-1.5 overflow-hidden rounded-full bg-tile-2" aria-hidden>
                <div className={clsx('h-full rounded-full', low ? 'bg-red' : 'bg-cyan')} style={{ width: `${diskUsedPct}%` }} />
              </div>
            )}
            {!s.incrementalVacuum && (
              <p className="text-[11px] text-amber">
                Space from deleted history is reused inside the database but not returned to the disk yet. It is enabled automatically at the next restart when there is enough free space.
              </p>
            )}

            {/* ---- policy ---- */}
            <div className="space-y-3 border-t border-hairline pt-4">
              <Row label="Delete finished runs older than" hint="Their transcripts, command output and images go too.">
                <Segmented
                  label="Run retention"
                  value={runsChoice}
                  disabled={!canEdit}
                  onChange={(c) => choose('runs', c)}
                  options={[
                    { value: 'off', label: 'Keep forever' },
                    { value: '7', label: '7 days' },
                    { value: '15', label: '15 days' },
                    { value: '30', label: '30 days' },
                    ...(runsChoice === 'custom' ? [{ value: 'custom' as const, label: `${s.retention.days} days` }] : []),
                  ]}
                />
              </Row>
              <Row label="Delete pasted images older than" hint="The run stays; the agent sees a note where the image was.">
                <Segmented
                  label="Image retention"
                  value={imagesChoice}
                  disabled={!canEdit}
                  onChange={(c) => choose('images', c)}
                  options={[
                    { value: 'off', label: 'Keep' },
                    { value: '7', label: '7 days' },
                    { value: '15', label: '15 days' },
                    { value: '30', label: '30 days' },
                    ...(imagesChoice === 'custom' ? [{ value: 'custom' as const, label: `${s.retention.dropImagesAfterDays} days` }] : []),
                  ]}
                />
              </Row>
              <p className="text-[11px] text-muted">
                Runs that are pinned, still working, waiting for approval, or linked to an open health issue are always kept. Checked daily.
                {s.retention.lastResult && (
                  <>
                    {' '}Last clean-up {timeAgo(s.retention.lastResult.at)}:{' '}
                    {s.retention.lastResult.error
                      ? <span className="text-red">{s.retention.lastResult.error}</span>
                      : `${s.retention.lastResult.runs} runs, ${s.retention.lastResult.images} images, ${formatBytes(s.retention.lastResult.freedBytes)} freed.`}
                  </>
                )}
              </p>
              {savePolicy.error && <p className="text-[11px] text-red">{(savePolicy.error as Error).message}</p>}
            </div>

            {/* ---- clean up now ---- */}
            {canEdit && (
              <div className="border-t border-hairline pt-4">
                {!open ? (
                  <button className="btn-ghost" onClick={() => setOpen(true)}>
                    <Trash2 size={15} /> Clean up now…
                  </button>
                ) : (
                  <div className="space-y-3">
                    <Row label="Delete finished runs older than">
                      <Segmented
                        label="Clean up runs older than"
                        value={nowChoice}
                        onChange={setNowChoice}
                        options={[
                          { value: '1', label: '1 day' },
                          { value: '7', label: '7 days' },
                          { value: '15', label: '15 days' },
                          { value: '30', label: '30 days' },
                          { value: '90', label: '90 days' },
                        ]}
                      />
                    </Row>
                    <div className="rounded-inner border border-hairline bg-tile-2/50 px-3 py-2.5 text-xs text-muted">
                      {preview.isLoading || !preview.data ? (
                        <Spinner />
                      ) : (
                        <>
                          <span className="text-ink">
                            {preview.data.runs} run{preview.data.runs === 1 ? '' : 's'} and {preview.data.images} image{preview.data.images === 1 ? '' : 's'} ({formatBytes(preview.data.imageBytes)})
                          </span>{' '}
                          will be deleted permanently.
                          {(preview.data.kept.pinned + preview.data.kept.active + preview.data.kept.linked) > 0 && (
                            <> Kept: {[
                              preview.data.kept.pinned && `${preview.data.kept.pinned} pinned`,
                              preview.data.kept.active && `${preview.data.kept.active} still active`,
                              preview.data.kept.linked && `${preview.data.kept.linked} linked to open health issues`,
                            ].filter(Boolean).join(', ')}.</>
                          )}
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        className="input !w-48"
                        placeholder="Type DELETE to confirm"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        aria-label="Type DELETE to confirm"
                      />
                      <button
                        className="btn-danger"
                        disabled={confirm !== 'DELETE' || cleanup.isPending || (!preview.data?.runs && !preview.data?.images)}
                        onClick={() => cleanup.mutate()}
                      >
                        {cleanup.isPending ? <Spinner /> : <Trash2 size={15} />} Delete
                      </button>
                      <button className="btn-quiet" onClick={() => { setOpen(false); setConfirm(''); }}>Cancel</button>
                    </div>
                    {cleanup.data && (
                      <p className="text-xs text-green">
                        Removed {cleanup.data.runs} runs and {cleanup.data.images} images
                        {cleanup.data.shrunk ? `; ${formatBytes(cleanup.data.freedBytes)} returned to the disk.` : '; the space will be reused by new runs.'}
                      </p>
                    )}
                    {cleanup.error && <p className="text-xs text-red">{(cleanup.error as Error).message}</p>}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {canEdit && <Backups />}
      </div>
    </Panel>
  );
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint?: string; warn?: boolean }) {
  return (
    <div className="rounded-inner border border-hairline bg-tile-2/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
        <HardDrive size={12} aria-hidden /> {label}
      </div>
      <div className={clsx('tabular mt-1 text-lg font-semibold', warn ? 'text-red' : 'text-ink')}>{value}</div>
      {hint && <div className="text-[11px] text-muted">{hint}</div>}
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <div className="text-sm text-ink">{label}</div>
        {hint && <div className="text-[11px] text-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** The database's scheduled backups, newest first, and one on demand. */
function Backups() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api<{ dir: string; everyHours: number; keep: number; backups: Array<{ file: string; bytes: number; at: number }>; last: { ok: boolean; error?: string } | null }>('/maintenance/backups') });
  const now = useMutation({ mutationFn: () => post('/maintenance/backups', {}), onSuccess: () => void qc.invalidateQueries({ queryKey: ['backups'] }) });
  const d = q.data;
  return (
    <div className="mt-5 border-t border-hairline pt-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-medium text-ink">Backups</h3>
        <span className="text-[11px] text-muted">
          {d ? (d.everyHours ? `Every ${d.everyHours} h, the newest ${d.keep} kept, in ${d.dir}` : 'Scheduled backups are off (SUPOPS_BACKUP_EVERY_HOURS=0).') : ''}
        </span>
        <button className="btn-ghost ml-auto !min-h-[32px] !text-xs" disabled={now.isPending} onClick={() => now.mutate()}>{now.isPending ? <Spinner /> : <HardDrive size={13} />} Back up now</button>
      </div>
      {d?.last && !d.last.ok && <p className="mt-2 text-xs text-red">The last scheduled backup failed: {d.last.error}</p>}
      {now.error && <p className="mt-2 text-xs text-red">{(now.error as Error).message}</p>}
      {d?.backups.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {d.backups.map((b) => (
            <li key={b.file} className="flex flex-wrap gap-x-3 font-mono text-muted"><span className="break-all text-ink/85">{b.file}</span><span>{formatBytes(b.bytes)}</span><span>{timeAgo(new Date(b.at).toISOString())}</span></li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-muted">No backup yet.</p>
      )}
      <p className="mt-2 text-[11px] text-muted">Secrets in a backup stay encrypted with the master key: keep SUPOPS_MASTER_KEY safe separately, or the backup cannot be read.</p>
    </div>
  );
}
