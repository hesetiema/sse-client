/** A single Server-Sent Event message. */
export interface SSEMessage<T = unknown> {
  /** Event id. Falls back to the previous id when the server omits it, used for Last-Event-ID resume. */
  id: string;
  /** Event name; defaults to "message" when the server does not send an `event:` field. */
  event: string;
  /** Parsed payload. Raw string by default, or whatever `parse` returns. */
  data: T;
  /** Raw `data:` text (multi-line payloads joined with a newline), useful for debugging. */
  raw: string;
  /** Client-side receive timestamp, handy for staleness checks. */
  receivedAt: number;
}

/** Connection state machine: idle → connecting → open → reconnecting → closed. */
export type SSEStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** Why the connection ended. */
export type SSECloseReason = "user" | "end" | "error";

/** Event-name → payload map, used to infer handler argument types. */
export type SSEEventMap = Record<string, unknown>;

/** Unsubscribe function returned by every subscription helper. */
export type Unsubscribe = () => void;

/**
 * Why the client cannot prove the stream is continuous:
 * - `reconnect`: an attempt ended and a new one will be opened
 * - `resume`: the page/network came back after a suspend
 * - `rotate`: a scheduled `restart`-mode rotation closed the stream
 * - `drop`: a message exceeded `maxBufferSize` and was discarded
 * - `promote`: a multi-tab follower took over from a leader that went away
 */
export type SSEGapReason = "reconnect" | "resume" | "rotate" | "drop" | "promote";

/**
 * Reported through `onResume` on the first event after a connection that carried
 * a `Last-Event-ID`, so the caller can tell "the server resumed" from "it started
 * from now and everything in between is gone".
 */
export interface SSEResumeInfo {
  /** Resume point that was sent as `Last-Event-ID`. */
  lastId: string;
  /** Id of the first event received on the new connection. */
  firstId: string;
  /**
   * `firstId - lastId` when both ids are integers, `undefined` for opaque ids.
   * `0` means the last event was replayed, `> 1` means events are missing.
   */
  skipped: number | undefined;
  /**
   * `true` when the stream provably continued (`skipped <= 1`, duplicates
   * included), `false` when it skipped ahead, `undefined` when ids are not
   * numeric and the client cannot judge.
   */
  continuous: boolean | undefined;
  /** Attempt number the new connection belongs to. */
  attempt: number;
}

/** Reported through `onSuspectGap`; the caller decides whether to refetch a snapshot. */
export interface SSEGapInfo {
  reason: SSEGapReason;
  /** Resume point the client holds, empty when the server never sent an id. */
  lastId: string;
  /** Consecutive attempts so far; `0` for a gap found while no attempt is running. */
  attempt: number;
}
