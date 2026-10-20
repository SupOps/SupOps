import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.ts';
import { sqlite } from './context.ts';

/**
 * Scheduled backups of the database: SQLite's online backup, which copies a consistent
 * snapshot while SupOps keeps running, into a folder of dated files, the oldest pruned.
 * The secrets in it stay encrypted with the master key: keep that key safe separately,
 * since a backup cannot be read without it. Restore: see docs/operations.md.
 */

export const backupSettings = () => ({
  dir: process.env.SUPOPS_BACKUP_DIR ?? join(dirname(config.databasePath), 'backups'),
  everyHours: Math.max(0, Number(process.env.SUPOPS_BACKUP_EVERY_HOURS ?? 24)),
  keep: Math.max(1, Number(process.env.SUPOPS_BACKUP_KEEP ?? 7)),
});

const NAME = /^supops-(\d{8})-(\d{6,9})\.db$/;

export function listBackups(dir = backupSettings().dir): Array<{ file: string; bytes: number; at: number }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => NAME.test(n))
    .map((n) => {
      const st = statSync(join(dir, n));
      return { file: n, bytes: st.size, at: st.mtimeMs };
    })
    // The name carries the time to the millisecond: newest first.
    .sort((a, b) => b.file.localeCompare(a.file));
}

/** One backup now; then keep only the newest `keep`. */
export async function backupNow(s = backupSettings()): Promise<{ file: string; bytes: number; ms: number }> {
  mkdirSync(s.dir, { recursive: true });
  const t = new Date();
  // 20261018-104207123: sorts by time, and two in one second never collide.
  const stamp = t.toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 18);
  const file = join(s.dir, `supops-${stamp}.db`);
  const started = Date.now();
  await sqlite.backup(file);
  for (const old of listBackups(s.dir).slice(s.keep)) {
    try {
      unlinkSync(join(s.dir, old.file));
    } catch {
      // Already gone.
    }
  }
  return { file, bytes: statSync(file).size, ms: Date.now() - started };
}

class BackupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  last: { at: number; ok: boolean; file?: string; error?: string } | null = null;

  async tick(): Promise<void> {
    const s = backupSettings();
    if (!s.everyHours || this.busy) return;
    const newest = listBackups(s.dir)[0];
    if (newest && Date.now() - newest.at < s.everyHours * 3_600_000) return;
    this.busy = true;
    try {
      const r = await backupNow(s);
      this.last = { at: Date.now(), ok: true, file: r.file };
    } catch (err) {
      this.last = { at: Date.now(), ok: false, error: err instanceof Error ? err.message : String(err) };
      console.error('database backup failed:', err);
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    setTimeout(() => void this.tick(), 60_000);
    this.timer = setInterval(() => void this.tick(), 15 * 60_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

export const backupScheduler = new BackupScheduler();
