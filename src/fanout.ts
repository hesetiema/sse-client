import type { SSEMessage, Unsubscribe } from "./types.js";

/** Consumer callback: the parsed payload plus the raw message. */
export type SseEventHandler<T = unknown> = (data: T, message: SSEMessage) => void;

/**
 * Fan-out view over a single connection.
 *
 * One `"*"` subscription on the wire, N consumers in memory. Each consumer gets
 * its own unsubscribe, a throwing consumer cannot break the others, and every
 * event name keeps its latest payload so a late subscriber can render
 * immediately instead of waiting for the next push.
 */
export interface SseFanout {
  /** Subscribe by event name; `"*"` receives every event. */
  on(event: string, handler: SseEventHandler): Unsubscribe;
  /** Most recent payload for an event name. */
  latest<T = unknown>(event: string): T | undefined;
  /** Snapshot of every event name seen so far. */
  latestAll(): Readonly<Record<string, unknown>>;
  /** Number of consumers, for one event or in total. */
  count(event?: string): number;
  /** Drop every consumer and the underlying source subscription. */
  dispose(): void;
}

/** The only thing a fan-out needs from a connection. */
export interface SseFanoutSource {
  on(event: "*", handler: (data: unknown, message: SSEMessage) => void): Unsubscribe;
}

export interface SseFanoutOptions {
  /** Called when a consumer throws, instead of swallowing the error. */
  onHandlerError?: (error: unknown) => void;
  /**
   * Subscribe to the source immediately. Off by default: a fan-out that nobody
   * listens to should not keep a handler (or a snapshot map) alive.
   */
  eager?: boolean;
}

export function createFanout(source: SseFanoutSource, options: SseFanoutOptions = {}): SseFanout {
  const handlers = new Map<string, Set<SseEventHandler>>();
  const latest = new Map<string, unknown>();
  let offSource: Unsubscribe | null = null;
  let disposed = false;

  const dispatch = (event: string, data: unknown, message: SSEMessage) => {
    const invoke = (handler: SseEventHandler) => {
      try {
        handler(data, message);
      } catch (error) {
        if (options.onHandlerError) {
          options.onHandlerError(error);
          return;
        }
        console.error("[sse-client] fan-out handler failed", error);
      }
    };
    handlers.get(event)?.forEach(invoke);
    if (event !== "*") {
      handlers.get("*")?.forEach(invoke);
    }
  };

  const ensureSource = () => {
    if (disposed || offSource) {
      return;
    }
    offSource = source.on("*", (data, message) => {
      const event = message.event || "message";
      latest.set(event, data);
      dispatch(event, data, message);
    });
  };

  const on = (event: string, handler: SseEventHandler): Unsubscribe => {
    if (disposed) {
      return () => undefined;
    }
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    ensureSource();

    return () => {
      const current = handlers.get(event);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (!current.size) {
        handlers.delete(event);
      }
    };
  };

  const count = (event?: string) => {
    if (event) {
      return handlers.get(event)?.size ?? 0;
    }
    let total = 0;
    handlers.forEach(set => {
      total += set.size;
    });
    return total;
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    handlers.clear();
    latest.clear();
    offSource?.();
    offSource = null;
  };

  if (options.eager) {
    ensureSource();
  }

  return {
    on,
    latest: <T = unknown>(event: string) => latest.get(event) as T | undefined,
    latestAll: () => Object.fromEntries(latest),
    count,
    dispose,
  };
}
