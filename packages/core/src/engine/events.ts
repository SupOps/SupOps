import type { RiskAssessment, RiskTier, RunStatus } from '@supops/shared';

/**
 * Semantic events, in the order the UI should render them.
 *
 * These are persisted to `run_events` and only then emitted, so a reconnecting or
 * late-joining client replays `seq > lastSeq` from SQLite and is exactly caught up.
 * Token deltas deliberately do NOT go through here -- they are best-effort and
 * live-only, because durably storing every fragment would swamp the write path for
 * information that is worthless ten seconds later.
 */
export type RunEventPayload =
  | { type: 'status'; status: RunStatus; reason?: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_call'; toolCallId: string; toolKey: string; target: string | null; rendered: string }
  | { type: 'tool_classified'; toolCallId: string; tier: RiskTier; assessment: RiskAssessment }
  | { type: 'tool_simulated'; toolCallId: string; status: 'observed' | 'skipped' | 'unavailable' | 'error'; tier: RiskTier }
  | { type: 'tool_blocked'; toolCallId: string; reason: string }
  | { type: 'tool_started'; toolCallId: string }
  | { type: 'tool_result'; toolCallId: string; ok: boolean; text: string; exitCode?: number }
  | { type: 'approval_required'; toolCallId: string; tier: RiskTier; rendered: string }
  | { type: 'approval_decided'; toolCallId: string; decision: 'approved' | 'denied'; by: string; selfApproved?: boolean }
  | { type: 'approval_expired'; toolCallId: string; aborted?: boolean }
  | { type: 'error'; message: string };

/**
 * The seam that keeps `packages/core` free of express and socket.io. The worker can
 * move to its own process later by swapping the implementation rather than
 * rewriting the engine.
 */
export interface EventSink {
  emit(runId: string, seq: number, payload: RunEventPayload): void;
}

export const nullSink: EventSink = { emit: () => {} };

/**
 * Live, best-effort output. Deliberately NOT part of `RunEventPayload`: those are
 * written to `run_events` before being emitted, and command output would swamp that
 * table. A client that reconnects mid-command misses these and receives the complete
 * output in the `tool_result` event instead -- the same trade already made for
 * token deltas.
 */
export interface OutputSink {
  chunk(runId: string, toolCallId: string, text: string): void;
}

export const nullOutputSink: OutputSink = { chunk: () => {} };
