import type { SSEError } from "./errors.js";
import type { OverflowPolicy } from "./parser.js";
import type { ResumeStorage } from "./resume.js";
import type { SSECloseReason, SSEGapInfo, SSEMessage, SSEResumeInfo, SSEStatus } from "./types.js";

/** Same shape as `fetch`; inject a custom transport for SSR, tests or signed requests. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Context handed to a custom retry policy. */
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

/** How the request is made. */
export interface RequestOptions {
  /** HTTP method; business push endpoints usually use POST. Defaults to `"POST"`. */
  method?: "GET" | "POST";
  /**
   * Request body. Serialized as JSON, or passed through when it is a string / Blob / FormData.
   *
   * Pass a function to recompute the body before every (re)connect — the same
   * contract `headers` has. This is how a subscription follows reactive filters
   * or instance ids without rebuilding the client:
   * `body: () => [{ floorId: floor.value }]`.
   */
  body?: unknown;
  /**
   * Extra headers. Pass a function to recompute them before every (re)connect,
   * which is the recommended way to pick up a refreshed token:
   * `() => getAuthHeaders()`.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /**
   * `credentials` for the fetch call, defaults to `"same-origin"`.
   * Use `"include"` when the SSE endpoint lives on another origin and
   * authentication rides on cookies.
   */
  credentials?: RequestCredentials;
  /** Inject a fetch implementation, defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/** Where the next connection resumes from, and whether that survives a reload. */
export interface ResumeOptions {
  /**
   * Resume point for the very first request, sent as `Last-Event-ID`. Use it to
   * continue where a previous page load stopped instead of starting fresh (which
   * silently skips everything produced while the page was loading).
   */
  from?: string;
  /**
   * Keep `lastEventId` across page loads. `true` derives a key from the
   * subscription, a string is used as-is; without it the resume point lives in
   * memory only and an F5 loses it.
   *
   * Writes are throttled to one per second and flushed on close and `pagehide`,
   * so a fast stream does not turn into one synchronous storage write per message.
   */
  persist?: string | boolean;
  /** Storage for `persist`; defaults to `sessionStorage`. Pass `null` to disable. */
  storage?: ResumeStorage | null;
}

/**
 * Backoff knobs, used when `retry` is a policy function this object cannot be
 * combined with: a custom policy owns the delay completely.
 */
export interface RetryOptions {
  /** Maximum retry count, unlimited by default. */
  max?: number;
  /** Delay before the first retry in milliseconds, defaults to 1000. */
  baseDelay?: number;
  /** Upper bound for reconnect delays in milliseconds, defaults to 30000. */
  maxDelay?: number;
  /** An attempt that lived at least this long resets the retry counter, defaults to 10000. */
  stableAfter?: number;
}

/** How `rotate()` is applied. */
export interface RotateOptions {
  /** Proactive rotation interval in milliseconds; `0` disables it. */
  interval: number;
  /**
   * How the interval is applied, defaults to `"restart"`.
   *
   * - `restart`: close the current connection, then reopen it. Relies on `Last-Event-ID` to
   *   resume; without server-side id support everything produced during the gap is lost.
   * - `overlap`: open the candidate first and take it over as soon as it is accepted, so a
   *   scheduled rotation never leaves a gap. A candidate that fails leaves the current
   *   connection untouched instead of trading a working stream for a broken one.
   */
  mode?: "restart" | "overlap";
  /** How long to wait for the candidate before giving up on a rotation, defaults to 30000. */
  timeout?: number;
}

/** Lifecycle of the stream itself: health checks, rotation, and clean shutdown. */
export interface StreamOptions {
  /**
   * Idle timeout in milliseconds: reconnect when no bytes arrived for this long.
   * `0` disables it. Two to three times the server heartbeat interval is a good value.
   */
  idleTimeout?: number;
  /**
   * Proactive rotation: reconnect on schedule to avoid zombie connections.
   * A number is shorthand for `{ interval }`; `0` disables it.
   */
  rotate?: number | RotateOptions;
  /**
   * Suspend the connection while the page is hidden and reconnect when it becomes
   * visible again. Defaults to false; recommended for WebViews and mobile, where
   * the OS freezes background pages and leaves zombie connections behind.
   */
  pauseWhenHidden?: boolean;
  /**
   * Stream-end sentinel: when `data` equals this value the stream is treated as
   * finished (OpenAI / AI SDK style `[DONE]`) and no reconnect happens.
   * Disabled by default.
   */
  endSignal?: string;
  /** Event allow-list: only these event names are dispatched. All events are dispatched when omitted. */
  events?: string[];
  /** Reconnect when the server closes the stream normally, defaults to true. */
  reconnectOnEnd?: boolean;
  /**
   * Require the response `content-type` to be `text/event-stream`, defaults to true.
   * This catches silent failures such as a gateway returning a 200 HTML page;
   * disable it for non-compliant backends.
   */
  strictContentType?: boolean;
}

/** Parser caps: what a single message may cost, and how the work is sliced. */
export interface LimitOptions {
  /** Cap for a single message buffer in characters, defaults to 1MB, guards against runaway streams. */
  maxBufferSize?: number;
  /**
   * What an oversized message does, defaults to `"close"`:
   * `close` ends the connection with a terminal `protocol` error, `drop` discards
   * that message and keeps streaming (the count is exposed as `dropped`, and the
   * loss is reported through `hooks.gap` with `reason: "drop"`).
   */
  overflowPolicy?: OverflowPolicy;
  /**
   * Dispatch at most this many events per task, then yield to the event loop.
   * A single chunk carrying thousands of events would otherwise parse and
   * deliver all of them in one task, blocking rendering and input. `0` (default)
   * keeps the whole chunk in one task. Values between 1 and 500 are sensible.
   */
  yieldEvery?: number;
}

/**
 * Observers. Every hook is also available as a subscription method
 * (`onStatus`, `onError`, …) and the two forms are equivalent: passing a hook is
 * just the declarative spelling of subscribing in the constructor.
 */
export interface HookOptions {
  /** Fired once the connection is established (response headers received). Same as `client.onOpen()`. */
  open?: (response: Response) => void;
  /** Fired for every message. Same as `client.onMessage()`. */
  message?: (message: SSEMessage) => void;
  /** Fired on every state change. Same as `client.onStatus()`. */
  status?: (status: SSEStatus) => void;
  /** Fired for every failed attempt. Same as `client.onError()`. */
  error?: (error: SSEError, attempt: number) => void;
  /** Fired once when the connection is finally closed. Same as `client.onClose()`. */
  close?: (reason: SSECloseReason, error?: SSEError) => void;
  /**
   * Fired when the stream may not be continuous — a reconnect, a resume after a
   * hidden page or offline period, a `restart`-mode rotation, a dropped message,
   * or a multi-tab takeover. The usual reaction is to refetch a snapshot and call
   * `setResumePoint(snapshot.id)`; the client itself cannot tell what was missed.
   *
   * Fires at most once per episode: the flag resets when a connection opens
   * again, so a long outage does not produce one report per retry.
   */
  gap?: (info: SSEGapInfo) => void;
  /**
   * Fired once per connection, on the first event that carries an id after a
   * request that sent `Last-Event-ID`. It answers the question `gap` can only
   * raise: *did* the server resume, and from where?
   *
   * `skipped` and `continuous` stay `undefined` when ids are not integers — the
   * client refuses to guess an ordering it cannot know.
   */
  resume?: (info: SSEResumeInfo) => void;
  /** Fallback when any handler (event, hook or plugin) throws, defaults to `console.error`. */
  handlerError?: (error: unknown) => void;
}

/**
 * Client options, grouped by what they affect.
 *
 * Only `url` is mandatory: the defaults are the operating point this client was
 * designed around (POST + JSON body, resume with `Last-Event-ID`, exponential
 * backoff, one connection per consumer). Reach into a group when a real
 * constraint forces you to.
 *
 * ```ts
 * new SSEClient({
 *   url: "/api/push/subscribe",
 *   request: { body: { topics: ["alarm"] }, headers: () => auth() },
 *   resume: { persist: true },
 *   retry: { max: 5 },
 *   hooks: { gap: refetchSnapshot },
 * });
 * ```
 */
export interface SSEClientOptions {
  /** Request URL (include your gateway prefix yourself). */
  url: string;
  /** How the request is made: method, body, headers, credentials, fetch. */
  request?: RequestOptions;
  /** Payload decoder, e.g. `(raw) => JSON.parse(raw)`. Defaults to the raw string. */
  parse?: (raw: string) => unknown;
  /** Resume point and its persistence across reloads. */
  resume?: ResumeOptions;
  /** Custom policy, or the backoff knobs used when no policy is given. */
  retry?: RetryPolicy | RetryOptions;
  /** Stream lifecycle: idle watchdog, rotation, hidden-page pause, end sentinel. */
  stream?: StreamOptions;
  /** Parser caps: buffer size, overflow policy, per-task yield. */
  limits?: LimitOptions;
  /** Observers; each one is equivalent to the matching `onXxx()` method. */
  hooks?: HookOptions;
  /** Connect in the constructor, defaults to true. */
  autoStart?: boolean;

  // -------------------------------------------------------------------------
  // Deprecated flat aliases, kept for one minor version.
  //
  // They are normalised into the groups above; a grouped value wins when both
  // are set. `flags` and `onOverflow` are gone rather than deprecated: see the
  // changelog for the migration.
  // -------------------------------------------------------------------------

  /** @deprecated use `request.method` */
  method?: RequestOptions["method"];
  /** @deprecated use `request.body` */
  body?: unknown;
  /** @deprecated use `request.headers` */
  headers?: RequestOptions["headers"];
  /** @deprecated use `request.credentials` */
  credentials?: RequestCredentials;
  /** @deprecated use `request.fetch` */
  fetch?: FetchLike;
  /** @deprecated use `resume.from` */
  resumeFrom?: string;
  /** @deprecated use `resume.persist` */
  persistKey?: string | boolean;
  /** @deprecated use `resume.storage` */
  persistStorage?: ResumeStorage | null;
  /** @deprecated use `stream.idleTimeout` */
  idleTimeout?: number;
  /** @deprecated use `stream.rotate` */
  rotateInterval?: number;
  /** @deprecated use `stream.rotate.mode` */
  rotateMode?: RotateOptions["mode"];
  /** @deprecated use `stream.rotate.timeout` */
  rotateTimeout?: number;
  /** @deprecated use `stream.pauseWhenHidden` */
  pauseWhenHidden?: boolean;
  /** @deprecated use `stream.endSignal` */
  endSignal?: string;
  /** @deprecated use `stream.events` */
  events?: string[];
  /** @deprecated use `stream.reconnectOnEnd` */
  reconnectOnEnd?: boolean;
  /** @deprecated use `stream.strictContentType` */
  strictContentType?: boolean;
  /** @deprecated use `retry.max` */
  maxRetry?: number;
  /** @deprecated use `retry.baseDelay` */
  retryBaseDelay?: number;
  /** @deprecated use `retry.maxDelay` */
  retryMaxDelay?: number;
  /** @deprecated use `retry.stableAfter` */
  stableAfter?: number;
  /** @deprecated use `limits.maxBufferSize` */
  maxBufferSize?: number;
  /** @deprecated use `limits.overflowPolicy` */
  overflowPolicy?: OverflowPolicy;
  /** @deprecated use `limits.yieldEvery` */
  yieldEvery?: number;
  /** @deprecated use `hooks.open` */
  onOpen?: HookOptions["open"];
  /** @deprecated use `hooks.message` */
  onMessage?: HookOptions["message"];
  /** @deprecated use `hooks.status` */
  onStatus?: HookOptions["status"];
  /** @deprecated use `hooks.error` */
  onError?: HookOptions["error"];
  /** @deprecated use `hooks.close` */
  onClose?: HookOptions["close"];
  /** @deprecated use `hooks.gap` */
  onSuspectGap?: HookOptions["gap"];
  /** @deprecated use `hooks.resume` */
  onResume?: HookOptions["resume"];
  /** @deprecated use `hooks.handlerError` */
  onHandlerError?: HookOptions["handlerError"];
}

/**
 * Flat, single-spelling view of the options, produced by `normalizeOptions` and
 * used internally by the client, the share registry and the Vue adapters. Not
 * exported from the package entry point: the groups above are the public shape.
 */
export interface ResolvedSSEClientOptions {
  url: string;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: RequestOptions["headers"];
  credentials?: RequestCredentials;
  fetch?: FetchLike;
  parse?: (raw: string) => unknown;
  resumeFrom?: string;
  persistKey?: string | boolean;
  persistStorage?: ResumeStorage | null;
  idleTimeout?: number;
  rotateInterval?: number;
  rotateMode?: "restart" | "overlap";
  rotateTimeout?: number;
  retry?: RetryPolicy;
  maxRetry?: number;
  retryBaseDelay?: number;
  retryMaxDelay?: number;
  reconnectOnEnd?: boolean;
  stableAfter?: number;
  strictContentType?: boolean;
  maxBufferSize?: number;
  overflowPolicy?: OverflowPolicy;
  yieldEvery?: number;
  endSignal?: string;
  events?: string[];
  pauseWhenHidden?: boolean;
  autoStart?: boolean;
  onHandlerError?: (error: unknown) => void;
  onOpen?: (response: Response) => void;
  onMessage?: (message: SSEMessage) => void;
  onStatus?: (status: SSEStatus) => void;
  onError?: (error: SSEError, attempt: number) => void;
  onClose?: (reason: SSECloseReason, error?: SSEError) => void;
  onSuspectGap?: (info: SSEGapInfo) => void;
  onResume?: (info: SSEResumeInfo) => void;
}

/** Grouped value wins; the flat alias is only a fallback. */
function pick<T>(grouped: T | undefined, flat: T | undefined): T | undefined {
  return grouped !== undefined ? grouped : flat;
}

/**
 * Flatten the grouped options into the single spelling the internals use.
 *
 * Idempotent by design: normalised options can be normalised again (the share
 * registry and the client both call it), and a grouped value always wins over a
 * deprecated alias.
 */
export function normalizeOptions(options: SSEClientOptions): ResolvedSSEClientOptions {
  const request = options.request ?? {};
  const resume = options.resume ?? {};
  const stream = options.stream ?? {};
  const limits = options.limits ?? {};
  const hooks = options.hooks ?? {};

  // `retry` is either a policy (owns the delay) or the knobs of the built-in one.
  const policy = typeof options.retry === "function" ? options.retry : undefined;
  const knobs = options.retry && typeof options.retry === "object" ? options.retry : undefined;
  const rotate = typeof stream.rotate === "number" ? { interval: stream.rotate } : stream.rotate;

  return {
    url: options.url,
    method: pick(request.method, options.method),
    body: pick(request.body, options.body),
    headers: pick(request.headers, options.headers),
    credentials: pick(request.credentials, options.credentials),
    fetch: pick(request.fetch, options.fetch),
    parse: options.parse,
    resumeFrom: pick(resume.from, options.resumeFrom),
    persistKey: pick(resume.persist, options.persistKey),
    persistStorage: pick(resume.storage, options.persistStorage),
    idleTimeout: pick(stream.idleTimeout, options.idleTimeout),
    rotateInterval: pick(rotate?.interval, options.rotateInterval),
    rotateMode: pick(rotate?.mode, options.rotateMode),
    rotateTimeout: pick(rotate?.timeout, options.rotateTimeout),
    retry: policy,
    maxRetry: pick(knobs?.max, options.maxRetry),
    retryBaseDelay: pick(knobs?.baseDelay, options.retryBaseDelay),
    retryMaxDelay: pick(knobs?.maxDelay, options.retryMaxDelay),
    stableAfter: pick(knobs?.stableAfter, options.stableAfter),
    reconnectOnEnd: pick(stream.reconnectOnEnd, options.reconnectOnEnd),
    strictContentType: pick(stream.strictContentType, options.strictContentType),
    endSignal: pick(stream.endSignal, options.endSignal),
    events: pick(stream.events, options.events),
    pauseWhenHidden: pick(stream.pauseWhenHidden, options.pauseWhenHidden),
    maxBufferSize: pick(limits.maxBufferSize, options.maxBufferSize),
    overflowPolicy: pick(limits.overflowPolicy, options.overflowPolicy),
    yieldEvery: pick(limits.yieldEvery, options.yieldEvery),
    autoStart: options.autoStart,
    onHandlerError: pick(hooks.handlerError, options.onHandlerError),
    onOpen: pick(hooks.open, options.onOpen),
    onMessage: pick(hooks.message, options.onMessage),
    onStatus: pick(hooks.status, options.onStatus),
    onError: pick(hooks.error, options.onError),
    onClose: pick(hooks.close, options.onClose),
    onSuspectGap: pick(hooks.gap, options.onSuspectGap),
    onResume: pick(hooks.resume, options.onResume),
  };
}
