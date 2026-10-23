import {
  getCurrentScope,
  onScopeDispose,
  ref,
  shallowRef,
  type Ref,
  type ShallowRef,
} from "vue";
import { SSEClient, type SSEClientOptions } from "./client.js";
import type { SSEError } from "./errors.js";
import type { SSEEventMap, SSEMessage, SSEStatus } from "./types.js";

/** Options for `useSSE`. */
export interface UseSSEOptions extends SSEClientOptions {
  /** Connect immediately, defaults to true. */
  immediate?: boolean;
  /** How many recent messages to keep, defaults to 200. Pass 0 to keep only the latest one. */
  maxEvents?: number;
}

/** Return value of `useSSE`. */
export interface UseSSEReturn<E extends object = SSEEventMap> {
  /** Underlying client, use it to subscribe to specific event names. */
  client: SSEClient<E>;
  /** Connection state, ready to bind to the UI. */
  status: Ref<SSEStatus>;
  /** Most recent message. */
  lastEvent: ShallowRef<SSEMessage | null>;
  /** Recent messages, kept in a ring buffer. */
  events: ShallowRef<SSEMessage[]>;
  /** Most recent connection error. */
  error: ShallowRef<SSEError | null>;
  start: () => void;
  stop: () => void;
  /** Reconnect while keeping `lastEventId` so the server can resume. */
  restart: () => void;
  /** Subscribe to an event name and unsubscribe automatically when the scope is disposed. */
  on: SSEClient<E>["on"];
}

/**
 * Vue composable: auto-reconnect, message ring buffer, cleanup on unmount.
 *
 * ```ts
 * interface AlarmEvent { level: "high" | "low"; deviceId: string }
 * const { lastEvent, on, status } = useSSE<{ ALARM: AlarmEvent }>({
 *   url: "/api/push/subscribe",
 *   body: { topics: ["alarm"] },
 *   parse: (raw) => JSON.parse(raw),
 * });
 * on("ALARM", (alarm) => console.log(alarm.level));
 * ```
 */
export function useSSE<E extends object = SSEEventMap>(
  options: UseSSEOptions,
): UseSSEReturn<E> {
  const { immediate = true, maxEvents = 200, ...clientOptions } = options;

  const status = ref<SSEStatus>("idle");
  const lastEvent = shallowRef<SSEMessage | null>(null);
  const events = shallowRef<SSEMessage[]>([]);
  const error = shallowRef<SSEError | null>(null);

  const client = new SSEClient<E>({
    ...clientOptions,
    autoStart: false,
    onStatus: (next) => {
      status.value = next;
      clientOptions.onStatus?.(next);
    },
    onError: (err, attempt) => {
      error.value = err;
      clientOptions.onError?.(err, attempt);
    },
    onMessage: (message) => {
      lastEvent.value = message;
      if (maxEvents > 0) {
        const keep = maxEvents - 1;
        const next = keep > 0 ? events.value.slice(-keep) : [];
        next.push(message);
        // Replace the array so a shallowRef triggers, without deep-proxying payloads.
        events.value = next;
      }
      clientOptions.onMessage?.(message);
    },
  });

  const start = () => {
    error.value = null;
    client.start();
  };

  const stop = () => {
    client.close();
  };

  const restart = () => {
    client.restart();
  };

  // Subscriptions follow the scope: unmounting a component (or a qiankun
  // sub-app) unsubscribes automatically.
  const on: SSEClient<E>["on"] = ((event: string, handler: (...args: unknown[]) => void) => {
    const unsubscribe = client.on(event as never, handler as never);
    if (getCurrentScope()) {
      onScopeDispose(unsubscribe);
    }
    return unsubscribe;
  }) as SSEClient<E>["on"];

  if (immediate) {
    start();
  }

  if (getCurrentScope()) {
    onScopeDispose(stop);
  }

  return { client, status, lastEvent, events, error, start, stop, restart, on };
}
