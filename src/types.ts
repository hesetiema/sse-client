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
