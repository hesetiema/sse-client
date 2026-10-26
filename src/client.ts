import { SSEError, isRetryableStatus, toSSEError } from "./errors.js";
import {
  DEFAULT_MAX_BUFFER_SIZE,
  createSSEParser,
  type OverflowPolicy,
  type ParsedEvent,
  type SSEParser,
} from "./parser.js";
import type { SSECloseReason, SSEEventMap, SSEMessage, SSEStatus, Unsubscribe } from "./types.js";

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
   * Idle timeout in milliseconds: reconnect when no bytes arrived for this long.
   * `0` disables it. Two to three times the server heartbeat interval is a good value.
   */
  idleTimeout?: number;
  /** Proactive rotation interval in milliseconds: reconnect on schedule to avoid zombie connections. `0` disables it. */
  rotateInterval?: number;
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
}

const EVENT_STREAM_CONTENT_TYPE = "text/event-stream";
/** Prevents tight reconnect loops when the server drops the connection immediately. */
const MIN_RETRY_DELAY = 200;

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
  private idleTimedOut = false;
  private rotating = false;
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
  /** Last reported drop count, so `onOverflow` fires once per drop instead of once per chunk. */
  private lastDropped = 0;

  constructor(options: SSEClientOptions) {
    if (!options?.url) {
      throw new Error("[sse-client] missing required option: url");
    }
    this.options = options;
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
    if (this.running || this.suspended) {
      return this;
    }
    if (this.finished) {
      this.reset();
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

  /** Reconnect after closing, keeping `lastEventId` so the server can resume. */
  restart(): this {
    this.close();
    if (!this.running) {
      return this.start();
    }
    // `close()` aborts the loop, but `running` only clears once that loop unwinds.
    // Starting synchronously would hit the `running` guard in start() and do nothing,
    // leaving the client closed for good; hand the restart to the loop exit instead.
    this.pendingRestart = true;
    return this;
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
    this.rotating = false;
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

      this.attemptController = new AbortController();
      const signal = this.attemptController.signal;

      let failure: SSEError | null = null;
      try {
        await this.openOnce(signal);
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
      if (this.rotating) {
        this.rotating = false;
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

      this.setState("reconnecting");
      await this.sleep(delay);
    }
  }

  /** Open one connection and read it until the stream ends (throws on failure). */
  private async openOnce(signal: AbortSignal): Promise<void> {
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

    this.setState("open");
    this.armRotate();
    this.emit(this.openHandlers, response);

    this.parser.reset();
    const reader = response.body.getReader();
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
    const id = event.id || this.lastEventIdValue;
    if (id) {
      this.lastEventIdValue = id;
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
    return this.nextDelay(context.attempt);
  }

  /** Reconnect delay: the server's `retry:` wins, otherwise exponential backoff with ±20% jitter. */
  private nextDelay(attempt: number): number {
    if (this.serverRetryDelay !== undefined) {
      return Math.max(Math.min(this.serverRetryDelay, this.retryMaxDelay), MIN_RETRY_DELAY);
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
      this.rotating = true;
      this.attemptController?.abort();
    }, interval);
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
    if (this.onVisibilityChange && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    this.onOffline = undefined;
    this.onOnline = undefined;
    this.onVisibilityChange = undefined;
    this.lifecycleBound = false;
  }

  private suspend(reason: "hidden" | "offline"): void {
    if (this.finished || this.suspended) {
      return;
    }
    this.suspended = reason;
    this.suspendAbort = true;
    this.clearTimers();
    this.attemptController?.abort();
    this.setState("idle");
  }

  private resume(): void {
    if (this.finished) {
      return;
    }
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
    this.clearTimers();
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
