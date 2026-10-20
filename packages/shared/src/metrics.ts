/** "12.3 GB", "87%", "2.1/s" -- a metric value in its unit, for people. */
export function formatValue(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '-';
  const r = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2)).replace(/\.0+$|(\.\d*?)0+$/, '$1');
  switch (unit) {
    case 'percent': return `${r(v)}%`;
    case 'bytes': {
      const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let i = 0;
      let x = v;
      while (Math.abs(x) >= 1000 && i < u.length - 1) { x /= 1000; i++; }
      return `${r(x)} ${u[i]}`;
    }
    case 'seconds': return Math.abs(v) < 1 ? `${r(v * 1000)} ms` : `${r(v)} s`;
    case 'per_second': return `${r(v)}/s`;
    case 'days': return `${r(v)} days`;
    case 'count': return Math.abs(v) >= 1e6 ? `${r(v / 1e6)}M` : Math.abs(v) >= 1e4 ? `${r(v / 1e3)}k` : r(v);
    default: return r(v);
  }
}

/** "45m", "3h 20m", "2.5 days" */
export function formatEta(ms: number): string {
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60_000);
  // Rounding would say "0m" for the last half-minute.
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = ms / 3_600_000;
  if (h < 48) return `${Math.floor(h)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${(h / 24).toFixed(1)} days`;
}
