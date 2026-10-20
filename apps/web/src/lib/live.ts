import { useEffect, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { QueryClient } from '@tanstack/react-query';
import { getToken } from './api';

/**
 * "Something changed" pushed by the server, so pages refetch at once instead of
 * polling every few seconds. The server sends topic names only; each query still
 * fetches through the API as usual.
 *
 * While the push is connected, pages poll only as a slow safety net. If it drops
 * (server restarting, a proxy that blocks websockets), they fall back to their
 * original fast intervals until it is back.
 */
type Topic = 'runs' | 'approvals' | 'alerts' | 'observability' | 'health' | 'knowledge';

/** Which cached queries each topic makes stale, by the first part of their key. */
const STALE: Record<Topic, string[]> = {
  runs: ['runs', 'dashboard', 'incident', 'incidents'],
  approvals: ['approvals', 'approvalHistory', 'trusted', 'dashboard', 'runs'],
  alerts: ['alerts', 'alertCount', 'incidents', 'incidentCount', 'obs', 'dashboard'],
  observability: ['obs', 'incidents', 'incident', 'incidentCount', 'atRisk', 'watches', 'dashboard'],
  health: ['health', 'healthCount', 'dashboard'],
  knowledge: ['knowledge'],
};

/** How often pages poll while the push is connected: just a safety net. */
const SAFETY_NET_MS = 60_000;

let connected = false;
const listeners = new Set<() => void>();
const setConnected = (v: boolean) => {
  if (connected === v) return;
  connected = v;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Open the push channel for the signed-in app. Call once, from the layout. */
export function useLiveUpdates(qc: QueryClient): void {
  useEffect(() => {
    const socket: Socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getToken() ?? '' }) });
    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));
    socket.on('live:changed', (e: { topics?: unknown }) => {
      const keys = new Set<string>();
      for (const t of Array.isArray(e?.topics) ? e.topics : []) for (const k of STALE[t as Topic] ?? []) keys.add(k);
      for (const k of keys) void qc.invalidateQueries({ queryKey: [k] });
    });
    return () => {
      socket.disconnect();
      setConnected(false);
    };
  }, [qc]);
}

/**
 * A refetch interval that follows the push: `fastMs` when it is down, a slow safety
 * net when it is up. Use for lists and counts the push covers.
 */
export function useLivePoll(fastMs: number): number {
  const live = useSyncExternalStore(subscribe, () => connected);
  return live ? Math.max(fastMs, SAFETY_NET_MS) : fastMs;
}
