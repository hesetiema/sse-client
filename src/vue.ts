import { ref, shallowRef, watchEffect, type Ref, type ShallowRef } from "vue";
import { SSEClient, type SSEClientOptions } from "./client.js";
import type { SSEError } from "./errors.js";
import { useSharedSSEClient, type SharedSSEClientConfig } from "./share.js";
import type { SSEEventMap, SSEMessage, SSEStatus, Unsubscribe } from "./types.js";

/** Options for `useSSE`. */
export interface UseSSEOptions extends SSEClientOptions {
  /** Connect immediately, defaults to true. */
  immediate?: boolean;
  /**
   * Share the connection with every other consumer of the same subscription
   * instead of opening one per component. `true` derives the key from the
   * options (see `deriveShareKey`); pass an object to control the key or the
   * grace period. Defaults to false — one connection per `useSSE` call.
   */
  shared?: boolean | SharedSSEClientConfig;
}

/** Return value of `useSSE`. */
export interface UseSSEReturn<E extends object = SSEEventMap> {
  /**
   * Underlying client, use it to subscribe to specific event names.
   *
   * With `shared`, this is the client currently serving the subscription; the
   * handle, not the component, owns its lifetime, so `dispose()` releasing the
   * last reference closes it.
   */
  client: SSEClient<E>;
  /** Connection state, ready to bind to the UI. */
  status: Ref<SSEStatus>;
  /** Most recent message, updated synchronously. */
  lastEvent: ShallowRef<SSEMessage | null>;
  /** Most recent connection error. */
  error: ShallowRef<SSEError | null>;
  start: () => void;
  /** Stop the connection but keep the composable usable (`start()` reopens it). */
  stop: () => void;
  /** Reconnect while keeping `lastEventId` so the server can resume. */
  restart: () => void;
  /** Subscribe to an event name; the subscription lives until `dispose()`. */
  on: SSEClient<E>["on"];
  /**
   * Unsubscribe everything this composable registered and close (or release) the
   * connection. Idempotent.
   *
   * Cleanup is explicit on purpose: `getCurrentScope()` silently returns
   * `undefined` when the app and the library resolve different copies of Vue
   * (qiankun sub-apps, dedupe disabled), which turns automatic cleanup into a
   * silent connection leak. Call `dispose()` from `onUnmounted`.
   */
  dispose: () => void;
}

/**
 * Thin Vue adapter: connection state as refs, event subscription shortcuts and an
 * explicit `dispose()`. No message history.
 *
 * How many messages a view keeps, whether it downsamples them and how often it
 * repaints are business decisions; keeping them out of the library is what stops
 * it from shipping a default that silently fits nobody. Compose the buffer from
 * `createRingBuffer` and the cadence from `requestAnimationFrame`:
 *
 * ```ts
 * const ring = createRingBuffer<Point>({ capacity: 2_000 });
 * const rows = shallowRef<Point[]>([]);
 *
 * useSSE({
 *   url: "/api/push",
 *   parse: jsonParse,
 *   onMessage: (message) => ring.push(message.data as Point),
 * });
 * onUnmounted(dispose);
 * ```
 *
 * ```ts
 * const { status, lastEvent, on, dispose } = useSSE<{ ALARM: Alarm }>({
 *   url: "/api/push/subscribe",
 *   body: { topics: ["alarm"] },
 *   parse: (raw) => JSON.parse(raw),
 * });
 * on("ALARM", (alarm) => console.log(alarm.level));
 * onUnmounted(dispose);
 * ```
 */
export function useSSE<E extends object = SSEEventMap>(
  options: UseSSEOptions,
): UseSSEReturn<E> {
  const { immediate = true, shared = false, ...clientOptions } = options;

  if (shared) {
    return useSharedSSEImpl<E>(clientOptions, shared, immediate);
  }

  const status = ref<SSEStatus>("idle");
  const lastEvent = shallowRef<SSEMessage | null>(null);
  const error = shallowRef<SSEError | null>(null);
  const offs = new Set<Unsubscribe>();
  let disposed = false;

  const track = (off: Unsubscribe): Unsubscribe => {
    if (disposed) {
      off();
      return off;
    }
    offs.add(off);
    return () => {
      offs.delete(off);
      off();
    };
  };

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
      // One object, O(1): the cheap half of "show me what just arrived".
      lastEvent.value = message;
      clientOptions.onMessage?.(message);
    },
  });

  const on: SSEClient<E>["on"] = ((event: string, handler: (...args: unknown[]) => void) =>
    track(client.on(event as never, handler as never))) as SSEClient<E>["on"];

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

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const off of [...offs]) {
      off();
    }
    offs.clear();
    client.close();
  };

  if (immediate) {
    start();
  }

  return {
    client,
    status,
    lastEvent,
    error,
    start,
    stop,
    restart,
    on,
    dispose,
  };
}

/**
 * Shared-connection flavour of `useSSE`.
 *
 * The component holds a *reference*, never the connection: two components
 * describing the same subscription end up on one connection, and the second one
 * disposing does not cut the first one off.
 */
function useSharedSSEImpl<E extends object>(
  options: SSEClientOptions,
  shared: true | SharedSSEClientConfig,
  immediate: boolean,
): UseSSEReturn<E> {
  const config: SharedSSEClientConfig = typeof shared === "object" ? shared : {};
  // `autoStart: false` keeps `immediate` in control and guarantees that the
  // handle already holds a client when the caller receives one.
  const connectOptions: SSEClientOptions = { ...options, autoStart: false };

  const status = ref<SSEStatus>("idle");
  const lastEvent = shallowRef<SSEMessage | null>(null);
  const error = shallowRef<SSEError | null>(null);
  const offs = new Set<Unsubscribe>();
  let disposed = false;
  let client: SSEClient<E> | null = null;

  const handle = useSharedSSEClient<E>(config);

  // Registered on the handle, which re-attaches them when the subscription moves;
  // `handle.release()` removes them, so they need no bookkeeping here.
  handle.onStatus((next) => {
    status.value = next;
    options.onStatus?.(next);
  });
  handle.onError((err, attempt) => {
    error.value = err;
    options.onError?.(err, attempt);
  });
  handle.onMessage((message) => {
    lastEvent.value = message;
    options.onMessage?.(message);
  });

  const syncClient = () => {
    client = handle.client;
    return client;
  };

  syncClient();
  handle.configure(connectOptions);
  syncClient();

  const track = (off: Unsubscribe): Unsubscribe => {
    if (disposed) {
      off();
      return off;
    }
    offs.add(off);
    return () => {
      offs.delete(off);
      off();
    };
  };

  const start = () => {
    error.value = null;
    if (!handle.configured) {
      handle.configure(connectOptions);
      syncClient();
    }
    handle.client?.start();
  };

  const stop = () => {
    // Reference release, not a hard close: peers keep their connection.
    handle.close();
  };

  const restart = () => {
    if (!handle.configured) {
      start();
      return;
    }
    handle.client?.restart();
  };

  const on: SSEClient<E>["on"] = ((event: string, handler: (...args: unknown[]) => void) =>
    track(
      handle.on(event, handler as (data: unknown, message: SSEMessage) => void),
    )) as SSEClient<E>["on"];

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const off of [...offs]) {
      off();
    }
    offs.clear();
    handle.release();
  };

  if (immediate) {
    start();
  } else {
    status.value = handle.status;
  }

  return {
    get client() {
      return (client ?? syncClient()) as SSEClient<E>;
    },
    status,
    lastEvent,
    error,
    start,
    stop,
    restart,
    on,
    dispose,
  };
}

/** Options for `useSharedSSE`. */
export interface UseSharedSSEOptions extends SharedSSEClientConfig {
  /**
   * Reactive subscription description: every reactive value it reads is tracked.
   * Return `null` or `undefined` to stop consuming.
   */
  subscription?: () => SSEClientOptions | null | undefined;
}

/** Return value of `useSharedSSE`. */
export interface UseSharedSSEReturn<E extends object = SSEEventMap> {
  status: Ref<SSEStatus>;
  lastEvent: ShallowRef<SSEMessage | null>;
  error: ShallowRef<SSEError | null>;
  /** Key of the current subscription, `null` while not consuming. */
  key: Ref<string | null>;
  /** Live client, `null` before the first `configure` or after `stop()`. */
  readonly client: SSEClient<E> | null;
  on: SSEClient<E>["on"];
  /**
   * Point at a subscription manually; `null` stops consuming. The `subscription`
   * getter wins on its next change.
   */
  configure: (options?: SSEClientOptions | null) => string | null;
  start: () => void;
  stop: () => void;
  restart: () => void;
  dispose: () => void;
}

/**
 * Reactive wrapper around `useSharedSSEClient`.
 *
 * The handle is framework-agnostic on purpose; this composable adds the two
 * things a component actually needs: refs instead of getters, and a
 * `subscription` getter that is re-read whenever what it depends on changes.
 *
 * ```ts
 * const floor = ref("F1");
 * const { status, lastEvent, dispose } = useSharedSSE({
 *   grace: 5_000,
 *   subscription: () => ({ url: "/api/push", body: [{ floorId: floor.value }] }),
 * });
 * onUnmounted(dispose);
 * ```
 *
 * Changing `floor` moves *this* component to the connection for that floor and
 * leaves every other consumer alone. Returning `null` stops consuming while the
 * handle stays reusable; `start()` picks the subscription up again.
 *
 * Debounce at the source (update a `ref` on `change`, not on `input`) instead of
 * inside the switch: every different key opens a connection.
 */
export function useSharedSSE<E extends object = SSEEventMap>(
  options: UseSharedSSEOptions = {},
): UseSharedSSEReturn<E> {
  const { subscription, ...config } = options;
  const handle = useSharedSSEClient<E>(config);

  const status = ref<SSEStatus>(handle.status);
  const lastEvent = shallowRef<SSEMessage | null>(null);
  const error = shallowRef<SSEError | null>(null);
  const key = ref<string | null>(null);
  const offs = new Set<Unsubscribe>();
  let disposed = false;

  handle.onStatus((next) => {
    status.value = next;
  });
  handle.onError((err) => {
    error.value = err;
  });
  handle.onMessage((message) => {
    lastEvent.value = message;
  });

  const configure = (next?: SSEClientOptions | null): string | null => {
    if (disposed) {
      return null;
    }
    if (!next?.url) {
      handle.close();
      key.value = null;
      status.value = "idle";
      return null;
    }
    const applied = handle.configure(next);
    key.value = applied;
    error.value = null;
    return applied;
  };

  const track = (off: Unsubscribe): Unsubscribe => {
    if (disposed) {
      off();
      return off;
    }
    offs.add(off);
    return () => {
      offs.delete(off);
      off();
    };
  };

  const on: SSEClient<E>["on"] = ((event: string, handler: (...args: unknown[]) => void) =>
    track(
      handle.on(event, handler as (data: unknown, message: SSEMessage) => void),
    )) as SSEClient<E>["on"];

  let stopSubscription: (() => void) | null = null;
  if (subscription) {
    // `watchEffect` also runs immediately, so the first subscription is applied
    // during setup, before the component renders.
    const watcher: unknown = watchEffect(() => {
      configure(subscription());
    });
    stopSubscription = () => stopWatcher(watcher);
  }

  const start = () => {
    if (disposed) {
      return;
    }
    error.value = null;
    if (!handle.configured && subscription) {
      configure(subscription());
    }
    handle.client?.start();
  };

  const stop = () => {
    handle.close();
    key.value = null;
    status.value = "idle";
  };

  const restart = () => {
    if (!handle.configured) {
      start();
      return;
    }
    handle.client?.restart();
  };

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    stopSubscription?.();
    stopSubscription = null;
    for (const off of [...offs]) {
      off();
    }
    offs.clear();
    handle.release();
    status.value = "closed";
  };

  return {
    status,
    lastEvent,
    error,
    key,
    get client() {
      return handle.client;
    },
    on,
    configure,
    start,
    stop,
    restart,
    dispose,
  };
}

/**
 * Stop a watcher across Vue 3 versions: 3.3/3.4 return a callable, 3.5 returns an
 * object with `stop()`. The peer range allows both, so neither form can be assumed.
 */
function stopWatcher(handle: unknown): void {
  if (typeof handle === "function") {
    (handle as () => void)();
    return;
  }
  (handle as { stop?: () => void }).stop?.();
}
