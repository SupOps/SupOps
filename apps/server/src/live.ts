import type { Server } from 'socket.io';

/** The one thing this needs from the SQLite handle. */
interface Sqlite {
  prepare(sql: string): { all(): unknown[] };
}

export type LiveTopic = 'runs' | 'approvals' | 'alerts' | 'observability' | 'health' | 'knowledge';

/**
 * Tells open pages when the data behind them changed, so they refetch at once instead
 * of polling every few seconds.
 *
 * Database triggers (migration 0025) bump a version per topic on every write, from any
 * part of the code -- the engine, the alert poller, the watcher, a route. This reads
 * those numbers once a second (one tiny query) and broadcasts the topics that moved.
 * Only topic names go out, never data: each page still fetches through the API with
 * its own session.
 */
export class LiveChanges {
  private io: Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private last = new Map<string, number>();
  private readonly sqlite: Sqlite;

  constructor(sqlite: Sqlite) {
    this.sqlite = sqlite;
  }

  attach(io: Server): void {
    this.io = io;
  }

  /** Topics whose version moved since the last call. The first call only records. */
  check(): LiveTopic[] {
    const rows = this.sqlite.prepare('SELECT topic, version FROM live_versions').all() as Array<{ topic: LiveTopic; version: number }>;
    const first = this.last.size === 0;
    const moved: LiveTopic[] = [];
    for (const r of rows) {
      if (!first && this.last.get(r.topic) !== r.version) moved.push(r.topic);
      this.last.set(r.topic, r.version);
    }
    return moved;
  }

  start(everyMs = 1000): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => {
      try {
        const topics = this.check();
        if (topics.length) this.io?.emit('live:changed', { topics });
      } catch (err) {
        console.error('live changes:', err instanceof Error ? err.message : err);
      }
    }, everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
