import { SSEClient, type SSEClientOptions } from "./client.js";
import { SSEError, type SSEErrorKind } from "./errors.js";
import { hashKey } from "./hash.js";
import { normalizeOptions } from "./options.js";
import type {
  SSECloseReason,
  SSEEventMap,
  SSEGapInfo,
  SSEMessage,
  SSEResumeInfo,
  SSEStatus,
  Unsubscribe,
} from "./types.js";

/** This tab's part in the shared connection. */
export type MultiTabRole =
  /** Waiting for the leader lock. */
  | "pending"
  /** Owns the connection and relays what it receives to the other tabs. */
  | "leader"
  /** Receives relayed messages; owns no connection. */
  | "follower"
  /** Multi-tab sharing is unavailable (no Web Locks or no BroadcastChannel): own connection. */
  | "solo";

export interface MultiTabSSEOptions extends SSEClientOptions {
  /**
   * Broadcast channel name. Tabs that use the same name share one connection.
   * Defaults to a key derived from `url` and `method`: two different
   * subscriptions in the same browser never meet.
   */
  channel?: string;
}

/** Runs `hold` while this tab owns the leader lock; resolves when ownership ends. */
export type LockRequester = (name: string, hold: () => Promise<void>) => Promise<void>;

/** Minimal `BroadcastChannel` surface, so tests can inject a fake. */
export interface BroadcastChannelLike {
  postMessage: (value: unknown) => void;
  close: () => void;
  onmessage: ((event: MessageEvent) => void) | null;
}

/** Replaceable platform pieces, mainly for tests. */
export interface MultiTabSSEDeps {
  /** Leader election; defaults to Web Locks. `null` makes the tab `solo`. */
  requestLock?: LockRequester | null;
  /** Relay channel; defaults to `new BroadcastChannel(name)`. `null` makes the tab `solo`. */
  createChannel?: ((name: string) => BroadcastChannelLike | null) | null;
}

/**
 * One connection for every tab of the same app.
 *
 * Five tabs of a dashboard otherwise hold five HTTP connections to the same
 * stream (HTTP/1.1 allows six per origin), make the server fan out five times,
 * and each keeps its own `Last-Event-ID`. Here the tab that wins the Web Lock
 * connects and relays messages over a `BroadcastChannel`; the others receive the
 * same `SSEMessage` objects and replay them to their own subscribers.
 *
 * ```ts
 * const sse = createMultiTabSSE({ url: "/api/push", request: { body: { topics: ["iot"] } } });
 * sse.on("IOT", (point) => store.apply(point)); // every tab, one connection
 * ```
 *
 * Failover: a follower's lock request is already queued, so when the leader tab
 * closes the next one becomes leader and resumes from the last id it saw — the
 * gap is whatever the server produced between the two, which is exactly what
 * `Last-Event-ID` is for.
 *
 * Limitations, all deliberate:
 * - No Web Locks support (or no `BroadcastChannel`) → every tab connects on its
 *   own, identical to `new SSEClient(options)`, instead of a fragile fallback
 *   protocol that can split-brain.
 * - `parse` must return structured-cloneable data (JSON does); a payload that
 *   cannot be cloned is delivered to the leader only.
 * - `onOpen` fires on the leader only: a `Response` cannot be relayed.
 */
export interface MultiTabSSE<E extends object = SSEEventMap> {
  readonly role: MultiTabRole;
  readonly status: SSEStatus;
  /** Resume point observed in this tab, relayed or owned. */
  readonly lastEventId: string;
  /** Real client on `leader`/`solo`, `null` on a follower. */
  readonly client: SSEClient<E> | null;
  on: {
    <K extends Extract<keyof E, string>>(
      event: K,
      handler: (data: E[K], message: SSEMessage) => void,
    ): Unsubscribe;
    (event: "*", handler: (data: unknown, message: SSEMessage) => void): Unsubscribe;
    (event: string, handler: (data: unknown, message: SSEMessage) => void): Unsubscribe;
  };
  onMessage: (handler: (message: SSEMessage) => void) => Unsubscribe;
  onStatus: (handler: (status: SSEStatus) => void) => Unsubscribe;
  onError: (handler: (error: SSEError, attempt: number) => void) => Unsubscribe;
  onClose: (handler: (reason: SSECloseReason) => void) => Unsubscribe;
  /**
   * The stream may not be continuous — relayed from the leader, or reported
   * locally when this tab is promoted. A takeover leaves a window in which no tab
   * was connected, so `reason: "promote"` is worth a snapshot refetch too.
   */
  onSuspectGap: (handler: (info: SSEGapInfo) => void) => Unsubscribe;
  /**
   * Resume verification, relayed from the tab that owns the connection. A follower
   * cannot answer this itself: its resume point is relayed, not observed.
   */
  onResume: (handler: (info: SSEResumeInfo) => void) => Unsubscribe;
  /** Role changes, e.g. a follower being promoted when the leader tab goes away. */
  onRole: (handler: (role: MultiTabRole) => void) => Unsubscribe;
  /** Start the connection on the tab that owns it; a no-op elsewhere. */
  start: () => void;
  /** Stop for this tab: releases the lock or the relay subscription. */
  close: () => void;
}

type Envelope =
  | { k: "message"; m: SSEMessage }
  | { k: "status"; s: SSEStatus }
  | { k: "error"; e: { message: string; kind: SSEErrorKind; status?: number; retryable: boolean } }
  | { k: "close"; r: SSECloseReason }
  | { k: "gap"; g: SSEGapInfo }
  | { k: "resume"; r: SSEResumeInfo };

export function createMultiTabSSE<E extends object = SSEEventMap>(
  options: MultiTabSSEOptions,
  deps: MultiTabSSEDeps = {},
): MultiTabSSE<E> {
  const { channel: channelOption, ...rest } = options;
  // Flatten once: the relay bus owns the hooks, the client gets the rest.
  const resolved = normalizeOptions(rest);
  const {
    onMessage: userOnMessage,
    onStatus: userOnStatus,
    onError: userOnError,
    onClose: userOnClose,
    onSuspectGap: userOnSuspectGap,
    onResume: userOnResume,
    ...clientOptions
  } = resolved;

  const reportHandlerError = (error: unknown) => {
    if (clientOptions.onHandlerError) {
      clientOptions.onHandlerError(error);
      return;
    }
    console.error("[sse-client] a callback threw", error);
  };

  const safe = <A extends unknown[]>(handler: (...args: A) => void, ...args: A) => {
    try {
      handler(...args);
    } catch (error) {
      reportHandlerError(error);
    }
  };

  // ---------------------------------------------------------------------------
  // Local bus: identical for leader, follower and solo, so `on()` never depends
  // on which role this tab happens to hold.
  // ---------------------------------------------------------------------------

  const messageHandlers = new Set<(message: SSEMessage) => void>();
  const statusHandlers = new Set<(status: SSEStatus) => void>();
  const errorHandlers = new Set<(error: SSEError, attempt: number) => void>();
  const closeHandlers = new Set<(reason: SSECloseReason) => void>();
  const gapHandlers = new Set<(info: SSEGapInfo) => void>();
  const resumeHandlers = new Set<(info: SSEResumeInfo) => void>();
  const roleHandlers = new Set<(role: MultiTabRole) => void>();
  const eventHandlers = new Map<string, Set<(data: unknown, message: SSEMessage) => void>>();

  let status: SSEStatus = "idle";
  let lastId = options.resumeFrom ?? "";

  const emitMessage = (message: SSEMessage): void => {
    if (message.id) {
      lastId = message.id;
    }
    for (const handler of [...messageHandlers]) {
      safe(handler, message);
    }
    const named = eventHandlers.get(message.event);
    if (named) {
      for (const handler of [...named]) {
        safe(handler, message.data, message);
      }
    }
    if (message.event !== "*") {
      const wildcard = eventHandlers.get("*");
      if (wildcard) {
        for (const handler of [...wildcard]) {
          safe(handler, message.data, message);
        }
      }
    }
  };

  const emitStatus = (next: SSEStatus): void => {
    if (status === next) {
      return;
    }
    status = next;
    for (const handler of [...statusHandlers]) {
      safe(handler, next);
    }
  };

  const emitError = (error: SSEError, attempt: number): void => {
    for (const handler of [...errorHandlers]) {
      safe(handler, error, attempt);
    }
  };

  const emitClose = (reason: SSECloseReason): void => {
    for (const handler of [...closeHandlers]) {
      safe(handler, reason);
    }
  };

  const emitGap = (info: SSEGapInfo): void => {
    for (const handler of [...gapHandlers]) {
      safe(handler, info);
    }
  };

  const emitResume = (info: SSEResumeInfo): void => {
    for (const handler of [...resumeHandlers]) {
      safe(handler, info);
    }
  };

  if (userOnMessage) messageHandlers.add(userOnMessage);
  if (userOnStatus) statusHandlers.add(userOnStatus);
  if (userOnError) errorHandlers.add(userOnError);
  if (userOnClose) closeHandlers.add(userOnClose);
  if (userOnSuspectGap) gapHandlers.add(userOnSuspectGap);
  if (userOnResume) resumeHandlers.add(userOnResume);

  // ---------------------------------------------------------------------------
  // Platform pieces
  // ---------------------------------------------------------------------------

  const channelName =
    channelOption ??
    `sse-client:${hashKey(`${options.method ?? "POST"} ${options.url}`)}`;

  const locks = typeof navigator !== "undefined" ? (navigator.locks ?? null) : null;
  const requestLock =
    deps.requestLock !== undefined
      ? deps.requestLock
      : locks
        // The DOM signature infers `Promise<Promise<void>>` when the callback is
        // itself async; the lock is released when that inner promise settles.
        ? (name: string, hold: () => Promise<void>) =>
            locks.request(name, () => hold()) as unknown as Promise<void>
        : null;

  const createChannel =
    deps.createChannel !== undefined
      ? deps.createChannel
      : typeof BroadcastChannel === "undefined"
        ? null
        : (name: string) => new BroadcastChannel(name) as unknown as BroadcastChannelLike;

  const canShare = Boolean(requestLock && createChannel);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let role: MultiTabRole = "pending";
  /** Whether this tab has ever been a follower, i.e. a promotion is really a takeover. */
  let everFollower = false;

  const setRole = (next: MultiTabRole): void => {
    if (role === next) {
      return;
    }
    if (next === "follower") {
      everFollower = true;
    }
    role = next;
    for (const handler of [...roleHandlers]) {
      safe(handler, next);
    }
  };

  /**
   * The application's intent, independent of who owns the connection right now.
   * A promoted follower keeps running because `wanted` was already true, while a
   * tab created with `autoStart: false` still waits for `start()`.
   */
  let wanted = clientOptions.autoStart !== false;
  let client: SSEClient<E> | null = null;
  let channel: BroadcastChannelLike | null = null;
  let releaseLock: (() => void) | null = null;
  let closed = false;
  let cloneWarned = false;

  const post = (envelope: Envelope): void => {
    if (!channel) {
      return;
    }
    try {
      channel.postMessage(envelope);
    } catch (error) {
      // A payload that cannot be structured-cloned would throw on every message;
      // warn once and keep the leader's local delivery working.
      if (!cloneWarned) {
        cloneWarned = true;
        reportHandlerError(error);
      }
    }
  };

  const detachClient = (): void => {
    client?.close();
    client = null;
  };

  const becomeLeader = (): void => {
    if (closed) {
      return;
    }
    detachClient();
    setRole("leader");
    client = new SSEClient<E>({
      ...clientOptions,
      // Resume from what the tab saw before taking over, which is the point of
      // the relay: the new leader does not restart from the server's "now".
      resumeFrom: lastId || clientOptions.resumeFrom,
      autoStart: false,
      onStatus: (next) => {
        emitStatus(next);
        post({ k: "status", s: next });
      },
      onError: (error, attempt) => {
        emitError(error, attempt);
        post({
          k: "error",
          e: {
            message: error.message,
            kind: error.kind,
            status: error.status,
            retryable: error.retryable,
          },
        });
      },
      onMessage: (message) => {
        emitMessage(message);
        post({ k: "message", m: message });
      },
      onClose: (reason) => {
        emitClose(reason);
        post({ k: "close", r: reason });
      },
      onSuspectGap: (info) => {
        emitGap(info);
        post({ k: "gap", g: info });
      },
      onResume: (info) => {
        emitResume(info);
        post({ k: "resume", r: info });
      },
    });
    // Taking over means nobody was connected until this tab got the lock: the
    // window is real, and the app has to decide whether to refetch a snapshot.
    if (everFollower && lastId) {
      emitGap({ reason: "promote", lastId, attempt: 0 });
    }
    if (wanted) {
      client.start();
    }
  };

  const becomeSolo = (): void => {
    if (closed || role === "leader" || role === "solo") {
      return;
    }
    setRole("solo");
    client = new SSEClient<E>({
      ...clientOptions,
      autoStart: false,
      onStatus: emitStatus,
      onError: emitError,
      onMessage: emitMessage,
      onClose: emitClose,
      onSuspectGap: emitGap,
      onResume: emitResume,
    });
    if (wanted) {
      client.start();
    }
  };

  const handleEnvelope = (envelope: Envelope): void => {
    switch (envelope.k) {
      case "message":
        emitMessage(envelope.m);
        break;
      case "status":
        emitStatus(envelope.s);
        break;
      case "error":
        emitError(
          new SSEError(envelope.e.message, {
            kind: envelope.e.kind,
            status: envelope.e.status,
            retryable: envelope.e.retryable,
          }),
          0,
        );
        break;
      case "close":
        emitClose(envelope.r);
        break;
      case "gap":
        emitGap(envelope.g);
        break;
      case "resume":
        emitResume(envelope.r);
        break;
    }
  };

  // ---------------------------------------------------------------------------
  // Election
  // ---------------------------------------------------------------------------

  if (canShare && createChannel && requestLock) {
    channel = createChannel(channelName);
    if (channel) {
      channel.onmessage = (event: MessageEvent) => handleEnvelope(event.data as Envelope);
      // Until the lock is granted this tab is a peer, not a leader. Contention is
      // resolved a tick later, so a tab that wins the race flips to `leader`.
      setRole("follower");
      void requestLock(channelName, async () => {
        if (closed) {
          return;
        }
        becomeLeader();
        await new Promise<void>((resolve) => {
          releaseLock = resolve;
        });
      }).catch((error: unknown) => {
        // Election is an optimisation; a broken lock manager must not cost the
        // tab its stream.
        reportHandlerError(error);
        role = "pending";
        becomeSolo();
      });
    } else {
      becomeSolo();
    }
  } else {
    becomeSolo();
  }

  return {
    get role() {
      return role;
    },
    get status() {
      return status;
    },
    get lastEventId() {
      return lastId;
    },
    get client() {
      return client;
    },
    on: ((event: string, handler: (data: unknown, message: SSEMessage) => void) => {
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      const set = handlers;
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    }) as MultiTabSSE<E>["on"],
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    onError(handler) {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    onSuspectGap(handler) {
      gapHandlers.add(handler);
      return () => gapHandlers.delete(handler);
    },
    onResume(handler) {
      resumeHandlers.add(handler);
      return () => resumeHandlers.delete(handler);
    },
    onRole(handler) {
      roleHandlers.add(handler);
      return () => roleHandlers.delete(handler);
    },
    start() {
      wanted = true;
      client?.start();
    },
    close() {
      if (closed) {
        return;
      }
      closed = true;
      wanted = false;
      detachClient();
      channel?.close();
      channel = null;
      releaseLock?.();
      releaseLock = null;
      messageHandlers.clear();
      statusHandlers.clear();
      errorHandlers.clear();
      closeHandlers.clear();
      gapHandlers.clear();
      roleHandlers.clear();
      eventHandlers.clear();
    },
  };
}
