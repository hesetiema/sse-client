/**
 * Error classification, useful for logging/telemetry and for branching inside a `retry` policy:
 * - `http`: the server responded with a non-2xx status
 * - `network`: transport-level failure (DNS, connection reset, …)
 * - `heartbeat`: no bytes received for `idleTimeout`, the connection looks zombie
 * - `protocol`: the response violates the SSE contract (wrong content-type, buffer overflow)
 * - `aborted`: the attempt was interrupted (hidden page, offline, manual close)
 * - `retry-exhausted`: retries ran out
 */
export type SSEErrorKind =
  | "http"
  | "network"
  | "heartbeat"
  | "protocol"
  | "aborted"
  | "retry-exhausted";

/**
 * Connection error. Carries a `retryable` flag so callers (and the built-in retry
 * policy) can tell transient failures apart from terminal ones such as 401.
 */
export class SSEError extends Error {
  /** Error category. */
  readonly kind: SSEErrorKind;
  /** HTTP status code, only set when `kind === "http"`. */
  readonly status?: number;
  /** Whether the connection may be retried. */
  readonly retryable: boolean;
  /**
   * Delay the server asked for through `Retry-After`, in milliseconds. Set on
   * 429/503 responses; a custom `retry` policy can read it instead of guessing.
   */
  readonly retryAfter?: number;

  constructor(
    message: string,
    options: {
      kind?: SSEErrorKind;
      status?: number;
      retryable?: boolean;
      retryAfter?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "SSEError";
    this.kind = options.kind ?? "network";
    this.status = options.status;
    this.retryable = options.retryable ?? true;
    this.retryAfter = options.retryAfter;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Statuses that indicate a temporary server-side problem and are worth retrying. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Normalize any thrown value into an `SSEError`. */
export function toSSEError(error: unknown): SSEError {
  if (error instanceof SSEError) {
    return error;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new SSEError("SSE connection aborted", {
      kind: "aborted",
      retryable: false,
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  // Transport failures (DNS errors, reset connections) are retryable by default.
  return new SSEError(`SSE connection error: ${message}`, {
    kind: "network",
    retryable: true,
    cause: error,
  });
}
