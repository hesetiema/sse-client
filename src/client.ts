import { SSEError, isRetryableStatus, toSSEError } from "./errors.js";
import {
  DEFAULT_MAX_BUFFER_SIZE,
  createSSEParser,
  type OverflowPolicy,
  type ParsedEvent,
  type SSEParser,
} from "./parser.js";
import {
  deriveResumeKey,
  readResumePoint,
  resolveResumeStorage,
  writeResumePoint,
  type ResumeStorage,
} from "./resume.js";
import type {
  SSECloseReason,
  SSEEventMap,
  SSEGapInfo,
  SSEGapReason,
  SSEMessage,
  SSEResumeInfo,
  SSEStatus,
  Unsubscribe,
} from "./types.js";

/** Same shape as `fetch`; inject a custom transport for SSR, tests or signed requests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Context passed to a retry policy. */
export interface RetryContext {
  /** Retry number, starting at 1. */
  attempt: number;
  /** Why the reconnect happens; `undefined` when the server closed the stream normally. */
  error?: SSEError;
  /** How long the attempt was alive, in milliseconds. */
  elapsed: number;
}

/**
 * Custom retry policy: return the delay in milliseconds before the next attempt,
 * or `false` to give up. May be async, which makes flows such as
 * "401 → refresh the token → retry" straightforward. When omitted, the built-in
 * exponential backoff with jitter and a max attempt count is used.
 */
export type RetryPolicy = (
  context: RetryContext,
) => number | false | Promise<number | false>;

/** Client options. */
export interface SSEClientOptions {
  /** Request URL (include your gateway prefix yourself). */
  url: string;
  /** HTTP method; business push endpoints usually use POST. */
  method?: "GET" | "POST";
  /** Request body. Serialized as JSON, or passed through when it is a string / Blob / FormData. */
  body?: unknown;
  /**
   * Extra headers. Pass a function to recompute them before every (re)connect,
   * which is the recommended way to pick up a refreshed token:
   * `() => getAuthHeaders()`.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Payload decoder, e.g. `(raw) => JSON.parse(raw)`. Defaults to the raw string. */
  parse?: (raw: string) => unknown;
  /**
   * Resume point for the very first request, sent as `Last-Event-ID`. Use it to
   * continue where a previous page load stopped instead of starting fresh (which
   * silently skips everything produced while the page was loading).
   */
  resumeFrom?: string;
  /**
   * Keep `lastEventId` across page loads. `true` derives a key from the
   * subscription, a string is used as-is; without it the resume point lives in
   * memory only and an F5 loses it.
   *
   * Writes are throttled to one per second and flushed on close and `pagehide`,
   * so a fast stream does not turn into one synchronous storage write per message.
   */
  persistKey?: string | boolean;
  /** Storage for `persistKey`; defaults to `sessionStorage`. Pass `null` to disable. */
  persistStorage?: ResumeStorage | null;
  /**
   * Idle timeout in milliseconds: reconnect when no bytes arrived for this long.
   * `0` disables it. Two to three times the server heartbeat interval is a good value.
   */
  idleTimeout?: number;
  /** Proactive rotation interval in milliseconds: reconnect on schedule to avoid zombie connections. `0` disables it. */
  rotateInterval?: number;
  /**
   * How `rotateInterval` is applied (default `"restart"`).
   *
   * - `restart`: close the current connection, then reopen it. Relies on `Last-Event-ID` to
   *   resume; without server-side id support everything produced during the gap is lost.
   * - `overlap`: open the candidate first and take it over as soon as it is accepted, so a
   *   scheduled rotation never leaves a gap. A candidate that fails leaves the current
   *   connection untouched instead of trading a working stream for a broken one.
   */
  rotateMode?: "restart" | "overlap";
  /** How long to wait for the candidate before giving up on a rotation, defaults to 30000. */
  rotateTimeout?: number;
  /** Custom retry policy, overrides the built-in backoff. */
  retry?: RetryPolicy;
  /** Maximum retry count, unlimited by default (only used when `retry` is not provided). */
  maxRetry?: number;
  /** Delay before the first retry in milliseconds, defaults to 1000. */
  retryBaseDelay?: number;
  /** Upper bound for reconnect delays in milliseconds, defaults to 30000. */
  retryMaxDelay?: number;
  /** Reconnect when the server closes the stream normally, defaults to true. */
  reconnectOnEnd?: boolean;
  /** An attempt that lived at least this long resets the retry counter, defaults to 10000. */
  stableAfter?: number;
  /**
   * Require the response `content-type` to be `text/event-stream`, defaults to true.
   * This catches silent failures such as a gateway returning a 200 HTML page;
   * disable it for non-compliant backends.
   */
  strictContentType?: boolean;
  /** Cap for a single message buffer in characters, defaults to 1MB, guards against runaway streams. */
  maxBufferSize?: number;
  /**
   * What an oversized message does, defaults to `"close"`:
   * `close` ends the connection with a terminal `protocol` error, `drop` discards
   * that message, reports it through `onOverflow`, and keeps streaming.
   */
  overflowPolicy?: OverflowPolicy;
  /**
   * Dispatch at most this many events per task, then yield to the event loop.
   * A single chunk carrying thousands of events would otherwise parse and
   * deliver all of them in one task, blocking rendering and input. `0` (default)
   * keeps the whole chunk in one task. Values between 1 and 500 are sensible.
   */
  yieldEvery?: number;
  /**
   * Stream-end sentinel: when `data` equals this value the stream is treated as
   * finished (OpenAI / AI SDK style `[DONE]`) and no reconnect happens.
   * Disabled by default.
   */
  endSignal?: string;
  /** Event allow-list: only these event names are dispatched. All events are dispatched when omitted. */
  events?: string[];
  /**
   * Suspend the connection while the page is hidden and reconnect when it becomes
   * visible again. Defaults to false; recommended for WebViews and mobile, where
   * the OS freezes background pages and leaves zombie connections behind.
   */
  pauseWhenHidden?: boolean;
  /** Connect in the constructor, defaults to true. */
  autoStart?: boolean;
  /** Inject a fetch implementation, defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Fallback when a handler throws, defaults to `console.error`. */
  onHandlerError?: (error: unknown) => void;
  /** Fired once the connection is established (response headers received). Same as `client.onOpen()`. */
  onOpen?: (response: Response) => void;
  /** Fired for every message. Same as `client.onMessage()`. */
  onMessage?: (message: SSEMessage) => void;
  /** Fired on every state change. Same as `client.onStatus()`. */
  onStatus?: (status: SSEStatus) => void;
  /** Fired for every failed attempt. Same as `client.onError()`. */
  onError?: (error: SSEError, attempt: number) => void;
  /** Fired once when the connection is finally closed. Same as `client.onClose()`. */
  onClose?: (reason: SSECloseReason, error?: SSEError) => void;
  /**
   * Fired when a message is discarded because of `overflowPolicy: "drop"`.
   * Receives the cumulative drop count for this client.
   */
  onOverflow?: (dropped: number) => void;
  /**
   * Fired when the stream may not be continuous — a reconnect, a resume after a
   * hidden page or offline period, a `restart`-mode rotation, or a dropped
   * message. The usual reaction is to refetch a snapshot and call
   * `setResumePoint(snapshot.id)`; the client itself cannot tell what was missed.
   *
   * Fires at most once per episode: the flag resets when a connection opens
   * again, so a long outage does not produce one report per retry.
   */
  onSuspectGap?: (info: SSEGapInfo) => void;
  /**
   * Fired once per connection, on the first event that carries an id after a
   * request that sent `Last-Event-ID`. It answers the question `onSuspectGap`
   * can only raise: *did* the server resume, and from where?
   *
   * `skipped` and `continuous` stay `undefined` when ids are not integers — the
   * client refuses to guess an ordering it cannot know.
   */
  onResume?: (info: SSEResumeInfo) => void;
}

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";
/** Prevents tight reconnect loops when the server drops the connection immediately. */
const MIN_RETRY_DELAY = 200;
/** At most one resume-point write per second, no matter how fast the stream is. */
const PERSIST_THROTTLE = 1000;

/**
 * Server-Sent Events client.
 *
 * - Built on `fetch` + `ReadableStream`, so custom headers and POST bodies work
 * - Reconnects automatically (exponential backoff with jitter); terminal errors
 *   such as 401 stop immediately
 * - Resumes with `Last-Event-ID`
 * - Routes events by name to multiple subscribers, so one connection serves many components
 * - Idle watchdog, proactive rotation, offline/background suspension, shared
 *   connections (see `acquireSSEClient`)
 */
export class SSEClient<E extends object = SSEEventMap> {
  private readonly options: SSEClientOptions;
  private readonly parser: SSEParser;
  private readonly eventFilter: Set<string> | null;

  private state: SSEStatus = "idle";
  private finished = false;
  private running = false;
  private suspended: "hidden" | "offline" | null = null;
  private attempt = 0;
  private lastEventIdValue = "";
  private serverRetryDelay: number | undefined;
  /** Where `lastEventId` is persisted, `null` when persistence is off. */
  private readonly persistKey: string | null;
  private readonly persistStorage: ResumeStorage | null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDirty = false;
  private onPageHide?: () => void;
  /** Resume point requested by `setResumePoint`, applied by the next request. */
  private pendingResumePoint: string | null = null;
  private idleTimedOut = false;
  private rotating = false;
  /** Overlap rotation: the candidate connection is accepted and waits for the loop to adopt it. */
  private handedOver = false;
  private probing = false;
  private preparedAttempt: { response: Response; controller: AbortController } | null = null;
  private probeController: AbortController | null = null;
  /** Set when `suspend()` aborts the attempt, so the abort is not read as an error. */
  private suspendAbort = false;
  /** Set by `restart()` while the old loop is still unwinding. */
  private pendingRestart = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private rotateTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelController = new AbortController();
  private attemptController: AbortController | null = null;
  private runPromise: Promise<void> | null = null;
  private resumeWaiter: (() => void) | null = null;
  private lifecycleBound = false;
  private onVisibilityChange?: () => void;
  private onOffline?: () => void;
  private onOnline?: () => void;

  private readonly messageHandlers = new Set<(message: SSEMessage) => void>();
  private readonly eventHandlers = new Map<string, Set<(data: unknown, message: SSEMessage) => void>>();
  private readonly statusHandlers = new Set<(status: SSEStatus) => void>();
  private readonly errorHandlers = new Set<(error: SSEError, attempt: number) => void>();
  private readonly openHandlers = new Set<(response: Response) => void>();
  private readonly closeHandlers = new Set<(reason: SSECloseReason, error?: SSEError) => void>();
  private readonly overflowHandlers = new Set<(dropped: number) => void>();
  private readonly gapHandlers = new Set<(info: SSEGapInfo) => void>();
  private readonly resumeHandlers = new Set<(info: SSEResumeInfo) => void>();
  /** Last reported drop count, so `onOverflow` fires once per drop instead of once per chunk. */
  private lastDropped = 0;
  /** Set once a gap is reported; cleared when a connection opens again. */
  private gapReported = false;
  /** Set when a connection opens with a resume point, consumed by its first identified event. */
  private resumeCheckPending = false;
  private resumeCheckFrom = "";

  constructor(options: SSEClientOptions) {
    if (!options?.url) {
      throw new Error("[sse-client] missing required option: url");
    }
    this.options = options;
    this.persistKey = options.persistKey
      ? typeof options.persistKey === "string"
        ? options.persistKey
        : deriveResumeKey({ url: options.url, method: options.method, body: options.body })
      : null;
    this.persistStorage = this.persistKey
      ? resolveResumeStorage(options.persistStorage)
      : null;
    // An explicit `resumeFrom` wins over what the previous page load stored.
    this.lastEventIdValue =
      options.resumeFrom ?? readResumePoint(this.persistStorage, this.persistKey ?? "");
    this.parser = createSSEParser({
      maxBufferSize: options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
      overflowPolicy: options.overflowPolicy ?? "close",
      onEvent: (event) => this.handleParsedEvent(event),
      onRetry: (delay) => {
        this.serverRetryDelay = delay;
      },
    });
    this.eventFilter = options.events?.length ? new Set(options.events) : null;
    if (options.onMessage) this.onMessage(options.onMessage);
    if (options.onStatus) this.onStatus(options.onStatus);
    if (options.onError) this.onError(options.onError);
    if (options.onOpen) this.onOpen(options.onOpen);
    if (options.onClose) this.onClose(options.onClose);
    if (options.onOverflow) this.onOverflow(options.onOverflow);
    if (options.onSuspectGap) this.onSuspectGap(options.onSuspectGap);
    if (options.onResume) this.onResume(options.onResume);
    if (options.autoStart !== false) {
      this.start();
    }
  }

  /** Current state. */
  get status(): SSEStatus {
    return this.state;
  }

  /** Whether the client is finally closed and will not reconnect. */
  get closed(): boolean {
    return this.finished;
  }

  /** Consecutive retry count; resets once a connection proves stable. */
  get attempts(): number {
    return this.attempt;
  }

  /** Latest event id, sent back as `Last-Event-ID` on reconnect. */
  get lastEventId(): string {
    return this.lastEventIdValue;
  }

  /** Messages discarded under `overflowPolicy: "drop"` so far. */
  get dropped(): number {
    return this.parser.dropped;
  }

  /** Resolves when the connection terminates (closed or retries exhausted). Never rejects. */
  get done(): Promise<void> {
    return this.runPromise ?? Promise.resolve();
  }

  /** Open the connection. No-op while already running or suspended. */
  start(): this {
    if (this.running) {
      // `close()` aborts the attempt, but `running` only clears once the loop has
      // unwound. Queueing the start is what makes `stop(); start();` work instead
      // of silently leaving the client closed.
      if (this.finished) {
        this.pendingRestart = true;
      }
      return this;
    }
    if (this.finished) {
      this.reset();
    }
    // A suspended loop (offline, hidden page) is woken by resume(), not by start().
    if (this.suspended) {
      return this;
    }
    // Bind the lifecycle listeners before the hidden-page check: a client
    // constructed while the page is hidden (WebView preload, background tab)
    // must still hear the visibilitychange event that resumes it later.
    this.bindLifecycle();
    // Do not request anything while the page is hidden; wait for visibilitychange.
    // This is the usual case for WebView preloading.
    if (
      this.options.pauseWhenHidden &&
      typeof document !== "undefined" &&
      document.hidden
    ) {
      this.suspended = "hidden";
      this.setState("idle");
      return this;
    }
    this.running = true;
    this.runPromise = this.connect()
      .catch((error: unknown) => {
        // Safety net: a throwing callback must not become an unhandled rejection.
        this.finish("error", toSSEError(error));
      })
      .finally(() => {
        this.running = false;
        // Only now is it safe to start again: the old loop has fully exited.
        if (this.pendingRestart && this.finished) {
          this.pendingRestart = false;
          this.start();
        }
      });
    return this;
  }

  /** Close the connection and stop reconnecting. */
  close(): void {
    // An explicit close must win over a queued restart.
    this.pendingRestart = false;
    if (this.finished) {
      return;
    }
    this.finish("user");
  }

  /**
   * Replace the resume point used by the next connection.
   *
   * The usual caller is an `onSuspectGap` handler: refetch a snapshot, then hand
   * its id to the client so the reconnect asks the server to continue from there.
   * The running stream is left untouched — rewinding `Last-Event-ID` mid-stream
   * would desynchronise the parser instead of healing the gap.
   */
  setResumePoint(id: string): void {
    this.pendingResumePoint = id;
  }

  /** Reconnect after closing, keeping `lastEventId` so the server can resume. */
  restart(): this {
    this.close();
    // `start()` queues itself when the loop has not unwound yet, and the resume
    // state survives because only `reset()` clears it.
    return this.start();
  }

  /** Subscribe to one event name; returns an unsubscribe function. */
  on<K extends Extract<keyof E, string>>(
    event: K,
    handler: (data: E[K], message: SSEMessage) => void,
  ): Unsubscribe;
  /** Subscribe to every message by passing `"*"`. */
  on(event: "*", handler: (data: unknown, message: SSEMessage) => void): Unsubscribe;
  on(event: string, handler: (data: unknown, message: SSEMessage) => void): Unsubscribe {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.eventHandlers.get(event);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (!current.size) {
        this.eventHandlers.delete(event);
      }
    };
  }

  /** Subscribe to one event name for a single delivery. */
  once<K extends Extract<keyof E, string>>(
    event: K,
    handler: (data: E[K], message: SSEMessage) => void,
  ): Unsubscribe {
    const off = this.on(event, (data, message) => {
      off();
      handler(data, message);
    });
    return off;
  }

  /** Subscribe to every message regardless of event name. */
  onMessage(handler: (message: SSEMessage) => void): Unsubscribe {
    return subscribe(this.messageHandlers, handler);
  }

  onStatus(handler: (status: SSEStatus) => void): Unsubscribe {
    return subscribe(this.statusHandlers, handler);
  }

  onError(handler: (error: SSEError, attempt: number) => void): Unsubscribe {
    return subscribe(this.errorHandlers, handler);
  }

  onOpen(handler: (response: Response) => void): Unsubscribe {
    return subscribe(this.openHandlers, handler);
  }

  onClose(handler: (reason: SSECloseReason, error?: SSEError) => void): Unsubscribe {
    return subscribe(this.closeHandlers, handler);
  }

  /** Subscribe to discarded oversized messages (see `overflowPolicy`). */
  onOverflow(handler: (dropped: number) => void): Unsubscribe {
    return subscribe(this.overflowHandlers, handler);
  }

  /** Subscribe to "the stream may have skipped data" reports (see `onSuspectGap`). */
  onSuspectGap(handler: (info: SSEGapInfo) => void): Unsubscribe {
    return subscribe(this.gapHandlers, handler);
  }

  /** Subscribe to resume verification reports (see `onResume`). */
  onResume(handler: (info: SSEResumeInfo) => void): Unsubscribe {
    return subscribe(this.resumeHandlers, handler);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private get retryBaseDelay(): number {
    return this.options.retryBaseDelay ?? 1000;
  }

  private get retryMaxDelay(): number {
    return this.options.retryMaxDelay ?? 30_000;
  }

  private get maxRetry(): number {
    return this.options.maxRetry ?? Infinity;
  }

  private get stableAfter(): number {
    return this.options.stableAfter ?? 10_000;
  }

  private get reconnectOnEnd(): boolean {
    return this.options.reconnectOnEnd ?? true;
  }

  private reset(): void {
    this.finished = false;
    this.attempt = 0;
    this.idleTimedOut = false;
    this.gapReported = false;
    this.resumeCheckPending = false;
    this.resumeCheckFrom = "";
    this.rotating = false;
    this.handedOver = false;
    this.probing = false;
    this.discardPreparedAttempt();
    this.suspended = null;
    this.suspendAbort = false;
    this.pendingRestart = false;
    this.serverRetryDelay = undefined;
    this.clearTimers();
    this.cancelController = new AbortController();
    this.attemptController = null;
    this.parser.reset();
  }

  private async connect(): Promise<void> {
    while (!this.finished) {
      if (this.suspended) {
        // Do not reconnect while suspended; wait for resume() to wake us up.
        await this.waitForResume();
        continue;
      }

      const startedAt = Date.now();
      // Cleared per attempt: a suspend that happened while the loop was sleeping
      // must not be mistaken for a failure of this attempt.
      this.suspendAbort = false;
      this.setState(this.attempt === 0 ? "connecting" : "reconnecting");

      // An overlap rotation leaves an accepted candidate behind: adopt its controller so
      // closing or suspending the client also aborts the connection that replaced the old one.
      const prepared = this.preparedAttempt;
      this.preparedAttempt = null;
      this.attemptController = prepared?.controller ?? new AbortController();
      const signal = this.attemptController.signal;

      let failure: SSEError | null = null;
      try {
        await this.openOnce(signal, prepared?.response);
      } catch (error) {
        failure = toSSEError(error);
      }

      this.clearIdle();
      this.clearRotate();
      if (this.finished) {
        return;
      }
      // A suspend (offline, hidden page) aborts the running attempt. `resume()`
      // may already have cleared `suspended` before this rejection is observed,
      // so the abort flag is checked as well; otherwise an interrupted attempt
      // looks like a terminal error and closes the client for good.
      const suspendedAbort = this.suspendAbort;
      this.suspendAbort = false;
      if (this.suspended || suspendedAbort) {
        this.setState("idle");
        continue;
      }

      // Proactive rotation: reconnect immediately, keeping lastEventId and skipping backoff.
      // In overlap mode the abort comes from handing the stream over, which is not a failure.
      if (this.rotating || this.handedOver) {
        this.rotating = false;
        this.handedOver = false;
        this.attempt = 0;
        continue;
      }

      // Treat an idle timeout as a retryable network error so a missing
      // heartbeat cannot leave a zombie connection behind.
      if (this.idleTimedOut) {
        this.idleTimedOut = false;
        failure = new SSEError("SSE idle timeout, reconnecting", {
          kind: "heartbeat",
          retryable: true,
        });
      }

      const elapsed = Date.now() - startedAt;
      // A connection that lived long enough means the failure was transient,
      // so reset the retry budget.
      if (elapsed >= this.stableAfter) {
        this.attempt = 0;
      }
      this.attempt += 1;

      if (failure) {
        this.emit(this.errorHandlers, failure, this.attempt);
      }

      if (!failure && !this.reconnectOnEnd) {
        this.finish("end");
        return;
      }

      const delay = await this.decideDelay({
        attempt: this.attempt,
        error: failure ?? undefined,
        elapsed,
      });
      if (delay === false) {
        this.finish(failure ? "error" : "end", failure ?? undefined);
        return;
      }

      // Report before sleeping: the handler may refetch a snapshot and call
      // `setResumePoint`, which then applies to the attempt that is about to open.
      this.reportGap("reconnect");
      this.setState("reconnecting");
      await this.sleep(delay);
    }
  }

  /** Open one connection and validate it (throws on failure). */
  private async request(signal: AbortSignal): Promise<Response> {
    const { url, method = "POST", body, fetch: fetchImpl } = this.options;
    const init: RequestInit = {
      method,
      headers: await this.resolveHeaders(),
      body: method === "GET" || body === undefined ? undefined : serializeBody(body),
      signal,
      cache: "no-store",
      credentials: "same-origin",
    };

    const response = fetchImpl ? await fetchImpl(url, init) : await fetch(url, init);

    if (!response.ok) {
      throw new SSEError(`SSE request failed: HTTP ${response.status}`, {
        kind: "http",
        status: response.status,
        retryable: isRetryableStatus(response.status),
        // A 429/503 usually knows better than the backoff curve when to come back.
        retryAfter: parseRetryAfter(response.headers.get("retry-after")),
      });
    }
    if (this.options.strictContentType !== false) {
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.startsWith(EVENT_STREAM_CONTENT_TYPE)) {
        // Two usual causes: a gateway/auth page returned HTML, or the backend
        // did not declare produces.
        throw new SSEError(
          `SSE response content-type is not ${EVENT_STREAM_CONTENT_TYPE} (got "${contentType || "(empty)"}")`,
          { kind: "protocol", status: response.status, retryable: false },
        );
      }
    }
    if (!response.body) {
      throw new SSEError("Streaming is not supported in this environment (response.body is null)", {
        kind: "protocol",
        status: response.status,
        retryable: false,
      });
    }
    return response;
  }

  /**
   * Open one connection and read it until the stream ends (throws on failure).
   *
   * @param prepared an already accepted candidate from an overlap rotation: it replaces the
   *   request, so the switch costs no reconnect gap.
   */
  private async openOnce(signal: AbortSignal, prepared?: Response): Promise<void> {
    const response = prepared ?? (await this.request(signal));

    this.setState("open");
    // A fresh connection starts a new episode: the next gap is worth reporting again.
    this.gapReported = false;
    // If this request carried a resume point, the first identified event decides
    // whether the server continued from it or silently started at "now".
    if (this.lastEventIdValue) {
      this.resumeCheckPending = true;
      this.resumeCheckFrom = this.lastEventIdValue;
    }
    this.armRotate();
    this.emit(this.openHandlers, response);

    this.parser.reset();
    const body = response.body;
    if (!body) {
      // A prepared response already passed validation; this narrowing is for the compiler.
      throw new SSEError("Streaming is not supported in this environment (response.body is null)", {
        kind: "protocol",
        status: response.status,
        retryable: false,
      });
    }
    const reader = body.getReader();
    // Decode in streaming mode so multi-byte characters split across chunks survive.
    const decoder = new TextDecoder("utf-8");
    this.armIdle();

    const yieldEvery = this.options.yieldEvery ?? 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        this.armIdle();
        this.parser.feed(decoder.decode(value, { stream: true }), yieldEvery);
        // With a budget the parser stops mid-chunk: yield, then continue. This is
        // what keeps a chunk carrying thousands of events out of a single task.
        while (this.parser.stalled) {
          await this.yieldToEventLoop(signal);
          this.parser.feed("", yieldEvery);
          this.reportOverflow();
        }
        this.reportOverflow();
      }
      this.parser.feed(decoder.decode());
      this.reportOverflow();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // releaseLock can throw after an abort; that is fine.
      }
      this.clearIdle();
      this.clearRotate();
    }
  }

  /**
   * Hand control back to the page between parser budget slices. `scheduler.yield()`
   * keeps the work at the front of the queue; setTimeout is the fallback, and an
   * abort during the pause is reported exactly like an abort inside `reader.read()`.
   */
  private async yieldToEventLoop(signal: AbortSignal): Promise<void> {
    const schedulerLike = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof schedulerLike?.yield === "function") {
      await schedulerLike.yield();
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (signal.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
  }

  /** Report discarded messages, and turn an overflow into a terminal error under the "close" policy. */
  private reportOverflow(): void {
    if (this.parser.dropped !== this.lastDropped) {
      this.lastDropped = this.parser.dropped;
      this.emit(this.overflowHandlers, this.lastDropped);
      this.reportGap("drop");
    }
    if (this.parser.overflowed) {
      // The server never terminates a line, or a single message is huge;
      // reconnecting would not help.
      throw new SSEError("SSE buffer size limit exceeded, connection reset", {
        kind: "protocol",
        retryable: false,
      });
    }
  }

  /**
   * Tell listeners the stream may have skipped data. At most once per episode:
   * the flag clears when a connection opens, so a ten-minute outage with retries
   * every 30s produces one report, not twenty.
   */
  private reportGap(reason: SSEGapReason): void {
    // Without a resume point there is nothing to continue from, but a dropped
    // message is data loss either way, so that reason is always reported.
    if (reason !== "drop" && !this.lastEventIdValue) {
      return;
    }
    if (this.gapReported) {
      return;
    }
    this.gapReported = true;
    this.emit(this.gapHandlers, {
      reason,
      lastId: this.lastEventIdValue,
      attempt: this.attempt,
    });
  }

  /** Compare the first id of the new stream with the resume point that was sent. */
  private reportResume(firstId: string): void {
    const lastId = this.resumeCheckFrom;
    this.resumeCheckFrom = "";
    const from = toIntegerId(lastId);
    const to = toIntegerId(firstId);
    const skipped = from === null || to === null ? undefined : to - from;
    this.emit(this.resumeHandlers, {
      lastId,
      firstId,
      skipped,
      // 0 replays the last event, 1 is a perfect continuation; anything above is a
      // hole, and negatives are duplicates the server sent twice.
      continuous: skipped === undefined ? undefined : skipped <= 1,
      attempt: this.attempt,
    });
  }

  private async resolveHeaders(): Promise<Headers> {
    const { headers, method = "POST" } = this.options;
    const extra = typeof headers === "function" ? await headers() : headers;
    const resolved = new Headers(extra);
    if (!resolved.has("Accept")) {
      resolved.set("Accept", EVENT_STREAM_CONTENT_TYPE);
    }
    if (method !== "GET" && !resolved.has("Content-Type")) {
      resolved.set("Content-Type", "application/json");
    }
    // A resume point set while a stream was running replaces the in-memory one at
    // the moment the next request is built, so an in-flight stream is never
    // rewound and the new position is what the server resumes from.
    if (this.pendingResumePoint !== null) {
      this.lastEventIdValue = this.pendingResumePoint;
      this.pendingResumePoint = null;
      this.schedulePersist();
    }
    if (this.lastEventIdValue) {
      resolved.set("Last-Event-ID", this.lastEventIdValue);
    }
    return resolved;
  }

  private handleParsedEvent(event: ParsedEvent): void {
    // Check the end sentinel before parsing: `[DONE]` is not valid JSON and
    // would make the parser throw.
    if (this.options.endSignal !== undefined && event.data === this.options.endSignal) {
      this.finish("end");
      return;
    }
    let data: unknown = event.data;
    if (this.options.parse) {
      try {
        data = this.options.parse(event.data);
      } catch (error) {
        this.reportHandlerError(error);
        return;
      }
    }
    // Verified before the allow-list filter and before the id fallback: the check
    // is about what the server said, not about what this client cares about.
    if (this.resumeCheckPending && event.id) {
      this.resumeCheckPending = false;
      this.reportResume(event.id);
    }
    const id = event.id || this.lastEventIdValue;
    if (id && id !== this.lastEventIdValue) {
      this.lastEventIdValue = id;
      this.schedulePersist();
    }
    const name = event.event || "message";
    // Filter after updating the id so the resume position never moves backwards.
    if (this.eventFilter && !this.eventFilter.has(name)) {
      return;
    }
    this.dispatch({
      id,
      event: name,
      data,
      raw: event.data,
      receivedAt: Date.now(),
    });
  }

  private dispatch(message: SSEMessage): void {
    this.emit(this.messageHandlers, message);

    const named = this.eventHandlers.get(message.event);
    if (named) {
      for (const handler of [...named]) {
        this.safeCall(handler, message.data, message);
      }
    }
    if (message.event !== "*") {
      const wildcard = this.eventHandlers.get("*");
      if (wildcard) {
        for (const handler of [...wildcard]) {
          this.safeCall(handler, message.data, message);
        }
      }
    }
  }

  private emit<A extends unknown[]>(handlers: Set<(...args: A) => void>, ...args: A): void {
    for (const handler of [...handlers]) {
      this.safeCall(handler, ...args);
    }
  }

  private safeCall<A extends unknown[]>(handler: (...args: A) => void, ...args: A): void {
    try {
      handler(...args);
    } catch (error) {
      this.reportHandlerError(error);
    }
  }

  private reportHandlerError(error: unknown): void {
    if (this.options.onHandlerError) {
      this.options.onHandlerError(error);
      return;
    }
    console.error("[sse-client] a callback threw", error);
  }

  private async decideDelay(context: RetryContext): Promise<number | false> {
    if (this.options.retry) {
      return await this.options.retry(context);
    }
    if (context.error && !context.error.retryable) {
      return false;
    }
    if (context.attempt > this.maxRetry) {
      return false;
    }
    return this.nextDelay(context.attempt, context.error?.retryAfter);
  }

  /**
   * Reconnect delay. Precedence: `Retry-After` on the failed response, then the
   * stream's `retry:` field, then exponential backoff with ±20% jitter. Both
   * server hints are clamped so a broken header cannot park the client for a day.
   */
  private nextDelay(attempt: number, retryAfter?: number): number {
    const hinted = retryAfter ?? this.serverRetryDelay;
    if (hinted !== undefined) {
      return Math.max(Math.min(hinted, this.retryMaxDelay), MIN_RETRY_DELAY);
    }
    const exponential = Math.min(this.retryMaxDelay, this.retryBaseDelay * 2 ** (attempt - 1));
    const jittered = Math.round(exponential * (0.8 + Math.random() * 0.4));
    return Math.max(jittered, MIN_RETRY_DELAY);
  }

  private sleep(delay: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.finished) {
        resolve();
        return;
      }
      const onCancel = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.cancelController.signal.removeEventListener("abort", onCancel);
        resolve();
      }, delay);
      this.cancelController.signal.addEventListener("abort", onCancel, { once: true });
    });
  }

  private waitForResume(): Promise<void> {
    if (this.finished) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      // Only resume() / finish() wake this up, so the loop never exits while suspended.
      this.resumeWaiter = resolve;
    });
  }

  private armIdle(): void {
    const timeout = this.options.idleTimeout ?? 0;
    if (!timeout) {
      return;
    }
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimedOut = true;
      this.attemptController?.abort();
    }, timeout);
  }

  private armRotate(): void {
    const interval = this.options.rotateInterval ?? 0;
    if (!interval) {
      return;
    }
    this.clearRotate();
    this.rotateTimer = setTimeout(() => {
      if (this.options.rotateMode === "overlap") {
        void this.rotateOverlap();
        return;
      }
      // `restart` closes first and leans on `Last-Event-ID`; `overlap` promises no
      // gap, so only the restart path is worth warning about.
      this.reportGap("rotate");
      this.rotating = true;
      this.attemptController?.abort();
    }, interval);
  }

  /**
   * Overlap rotation: request the next connection while the current one keeps streaming, and
   * take it over only once it is accepted.
   *
   * The switch is the abort plus the prepared response: the loop unwinds the old attempt and
   * adopts the candidate instead of opening a third one. Everything the server wrote in
   * between waits in the candidate's stream buffer, so no event is lost and none is replayed.
   */
  private async rotateOverlap(): Promise<void> {
    if (this.probing || this.finished || this.suspended || this.preparedAttempt) {
      return;
    }
    this.probing = true;
    const controller = new AbortController();
    this.probeController = controller;
    const timeout = this.options.rotateTimeout ?? DEFAULT_ROTATE_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.request(controller.signal);
      const current = this.attemptController;
      if (this.finished || this.suspended || !current) {
        // Nothing to hand the candidate over to: release it instead of parking a stream.
        await discardBody(response);
        return;
      }
      this.preparedAttempt = { response, controller };
      this.handedOver = true;
      current.abort();
    } catch (error) {
      // A candidate that cannot be opened says nothing about the stream that is running:
      // keep it and try again on the next tick instead of trading it for a broken connection.
      const probeError = toSSEError(error);
      if (!this.finished && !this.suspended && probeError.kind !== "aborted") {
        this.emit(this.errorHandlers, probeError, this.attempt);
        this.armRotate();
      }
    } finally {
      clearTimeout(timer);
      this.probeController = null;
      this.probing = false;
    }
  }

  /** Drop a candidate the loop never adopted (close, restart, reset). */
  private discardPreparedAttempt(): void {
    const prepared = this.preparedAttempt;
    this.preparedAttempt = null;
    this.handedOver = false;
    if (!prepared) {
      return;
    }
    prepared.controller.abort();
    void discardBody(prepared.response);
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearRotate(): void {
    if (this.rotateTimer) {
      clearTimeout(this.rotateTimer);
      this.rotateTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdle();
    this.clearRotate();
  }

  // ---------------------------------------------------------------------------
  // Resume point persistence
  // ---------------------------------------------------------------------------

  /**
   * Mark the resume point dirty.
   *
   * Writing on every event would turn a fast stream into one synchronous storage
   * write per message, so writes are coalesced to at most one per
   * `PERSIST_THROTTLE` and flushed on close, suspend and `pagehide`.
   */
  private schedulePersist(): void {
    if (!this.persistStorage) {
      return;
    }
    this.persistDirty = true;
    if (this.persistTimer) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersist();
    }, PERSIST_THROTTLE);
  }

  /** Write the pending resume point to storage, if it changed. */
  private flushPersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistDirty) {
      return;
    }
    this.persistDirty = false;
    writeResumePoint(this.persistStorage, this.persistKey ?? "", this.lastEventIdValue);
  }

  private setState(next: SSEStatus): void {
    if (this.state === next) {
      return;
    }
    this.state = next;
    this.emit(this.statusHandlers, next);
  }

  // ---------------------------------------------------------------------------
  // Offline / background handling
  // ---------------------------------------------------------------------------

  /** Network state is always observed: no reconnects while offline, an immediate one when back online. */
  private bindLifecycle(): void {
    if (this.lifecycleBound) {
      return;
    }
    this.lifecycleBound = true;

    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      this.onOffline = () => this.suspend("offline");
      this.onOnline = () => {
        if (this.suspended === "offline") {
          this.resume();
        }
      };
      window.addEventListener("offline", this.onOffline);
      window.addEventListener("online", this.onOnline);
    }

    if (
      this.persistStorage &&
      typeof window !== "undefined" &&
      typeof window.addEventListener === "function"
    ) {
      // `pagehide` also fires when the page enters the back/forward cache, which is
      // the last moment a synchronous storage write is guaranteed to complete.
      this.onPageHide = () => this.flushPersist();
      window.addEventListener("pagehide", this.onPageHide);
    }

    if (
      this.options.pauseWhenHidden &&
      typeof document !== "undefined" &&
      typeof document.addEventListener === "function"
    ) {
      this.onVisibilityChange = () => {
        if (document.hidden) {
          this.suspend("hidden");
        } else if (this.suspended === "hidden") {
          this.resume();
        }
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
  }

  private unbindLifecycle(): void {
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      if (this.onOffline) window.removeEventListener("offline", this.onOffline);
      if (this.onOnline) window.removeEventListener("online", this.onOnline);
    }
    if (this.onPageHide && typeof window !== "undefined") {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    if (this.onVisibilityChange && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.onOffline = undefined;
    this.onOnline = undefined;
    this.onPageHide = undefined;
    this.onVisibilityChange = undefined;
    this.lifecycleBound = false;
  }

  private suspend(reason: "hidden" | "offline"): void {
    if (this.finished || this.suspended) {
      return;
    }
    this.suspended = reason;
    this.suspendAbort = true;
    // The page may be frozen from here on: persist before anything else.
    this.flushPersist();
    this.clearTimers();
    this.probeController?.abort();
    this.probeController = null;
    this.discardPreparedAttempt();
    this.attemptController?.abort();
    this.setState("idle");
  }

  private resume(): void {
    if (this.finished) {
      return;
    }
    // The connection was aborted at suspend time, so anything produced since then
    // is unaccounted for.
    this.reportGap("resume");
    this.suspended = null;
    this.attempt = 0;
    if (this.running) {
      this.resumeWaiter?.();
      this.resumeWaiter = null;
      return;
    }
    this.start();
  }

  private finish(reason: SSECloseReason, error?: SSEError): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.flushPersist();
    this.clearTimers();
    this.probeController?.abort();
    this.probeController = null;
    this.discardPreparedAttempt();
    this.unbindLifecycle();
    this.cancelController.abort();
    this.attemptController?.abort();
    // Wake the connection loop in case it is waiting on a suspended state.
    this.resumeWaiter?.();
    this.resumeWaiter = null;
    this.setState("closed");
    this.emit(this.closeHandlers, reason, error);
  }
}

/** Default time budget for an overlap rotation candidate. */
const DEFAULT_ROTATE_TIMEOUT = 30_000;

/** Release a candidate stream the client decided not to adopt. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be locked, aborted or fully read; nothing to release then.
  }
}

/**
 * Parse an event id as an integer, or `null`.
 *
 * SSE ids are opaque strings — the spec never says they are ordered — so this is
 * only a best-effort reading, and `onResume` leaves `skipped` undefined when it
 * fails instead of inventing a comparison.
 */
function toIntegerId(id: string): number | null {
  if (!/^-?\d+$/.test(id)) {
    return null;
  }
  const value = Number(id);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * `Retry-After` is either delta-seconds (`120`) or an HTTP date
 * (`Wed, 21 Oct 2015 07:28:00 GMT`); both become a delay in milliseconds.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, at - Date.now());
}

/** Serialize the body: strings / Blob / FormData pass through, everything else becomes JSON. */
function serializeBody(body: unknown): BodyInit {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData) {
    return body;
  }
  return JSON.stringify(body);
}

/** Shared subscribe/unsubscribe implementation. */
function subscribe<T>(handlers: Set<T>, handler: T): Unsubscribe {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}
