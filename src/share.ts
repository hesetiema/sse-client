import { SSEClient, type SSEClientOptions } from "./client.js";
import type { SSEError } from "./errors.js";
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

/** Handle for a shared connection. */
export interface SharedSSEHandle<E extends object = SSEEventMap> {
  client: SSEClient<E>;
  /** Release one reference; the connection closes when the last reference is released. */
  release: () => void;
}

type AnyClient = SSEClient<SSEEventMap>;
type ClientFactory = (options: SSEClientOptions) => AnyClient;
type Binder = (client: AnyClient) => Unsubscribe;

interface SharedEntry {
  key: string;
  client: AnyClient;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, SharedEntry>();

const noop = () => {};

// ---------------------------------------------------------------------------
// Key derivation
// ---------------------------------------------------------------------------

interface KeyOptions {
  /**
   * Compare arrays as sets, so `["a","b"]` and `["b","a"]` share a connection
   * (default true). Subscription payloads are usually id lists, where order
   * carries no meaning; pass false when it does.
   */
  sortArrays?: boolean;
}

/** Deterministic serialization: object keys sorted, JSON-encodable values only. */
const stringifyForKey = (value: unknown, sortArrays: boolean): string => {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => stringifyForKey(item, sortArrays));
    if (sortArrays) {
      parts.sort();
    }
    return `[${parts.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stringifyForKey(record[key], sortArrays)}`);
  return `{${fields.join(",")}}`;
};

/**
 * Derive a stable share key from the subscription itself, so two callers that
 * describe the same subscription land on the same connection without agreeing
 * on a hand-written key.
 *
 * Only what reaches the server (url, method, body) and what changes what a
 * consumer receives (event allow-list) is compared. Decoders and other callbacks
 * cannot be compared, so pass an explicit key when two consumers need the same
 * subscription parsed differently. A `body` factory is invoked once per call, so
 * the key tracks whatever the factory currently reads.
 *
 * Grouped and flat spellings normalise to the same key, which is what lets the
 * two forms share a connection during the deprecation window.
 */
export function deriveShareKey(options: SSEClientOptions, keyOptions: KeyOptions = {}): string {
  const sortArrays = keyOptions.sortArrays ?? true;
  const resolved = normalizeOptions(options);
  // A body factory is resolved here as well: `configure()` runs when the reactive
  // source changes, so the key follows filters and instance ids.
  const body =
    typeof resolved.body === "function" ? (resolved.body as () => unknown)() : resolved.body;
  return hashKey(
    stringifyForKey(
      {
        url: resolved.url,
        method: resolved.method ?? "POST",
        body: body ?? null,
        events: resolved.events ?? null,
      },
      sortArrays,
    ),
  );
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function acquireEntry(key: string, create: () => AnyClient): SharedEntry {
  const existing = registry.get(key);
  if (existing) {
    existing.refs += 1;
    if (existing.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    return existing;
  }
  const entry: SharedEntry = { key, client: create(), refs: 1, timer: null };
  registry.set(key, entry);
  return entry;
}

/**
 * @param immediate drop the connection right away (the subscription changed);
 *   otherwise keep it for `grace` ms so a remount does not reconnect.
 */
function releaseEntry(entry: SharedEntry, immediate: boolean, grace: number): void {
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0) {
    return;
  }
  if (immediate || grace <= 0) {
    destroyEntry(entry);
    return;
  }
  if (entry.timer) {
    return;
  }
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.refs > 0) {
      return;
    }
    destroyEntry(entry);
  }, grace);
}

function destroyEntry(entry: SharedEntry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (registry.get(entry.key) === entry) {
    registry.delete(entry.key);
  }
  entry.client.close();
}

/** Make `release` idempotent so a double call cannot free someone else's reference. */
function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) {
      return;
    }
    called = true;
    fn();
  };
}

/**
 * Share a connection by key, using reference counting.
 *
 * When several components consume the same subscription they should not open one
 * connection each: HTTP/1.1 allows only six per origin, so push channels can
 * starve regular requests, and the server would receive duplicate subscriptions.
 *
 * ```ts
 * const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, request: { body } }));
 * onScopeDispose(release);
 * ```
 *
 * The options of the first caller win; later calls with the same key reuse that
 * connection and ignore their own options. For subscriptions that change over
 * time (filters, floors, tenants), use `useSharedSSEClient` instead: it can move
 * a consumer to another connection without touching its peers.
 */
export function acquireSSEClient<E extends object = SSEEventMap>(
  key: string,
  create: () => SSEClient<E>,
): SharedSSEHandle<E> {
  const entry = acquireEntry(key, () => create() as unknown as AnyClient);
  return {
    client: entry.client as unknown as SSEClient<E>,
    release: once(() => releaseEntry(entry, false, 0)),
  };
}

/** Close and drop every shared connection (mainly for tests and teardown). */
export function closeAllSharedSSEClients(): void {
  for (const entry of [...new Set(registry.values())]) {
    destroyEntry(entry);
  }
  registry.clear();
}

/** Number of live shared connections, useful for tests and diagnostics. */
export function getSharedSSEClientCount(): number {
  return registry.size;
}

/** Live connections with their reference counts, useful for diagnostics. */
export function getSharedSSEClients(): { key: string; refs: number }[] {
  return [...registry].map(([key, entry]) => ({ key, refs: entry.refs }));
}

// ---------------------------------------------------------------------------
// Reconfigurable handle
// ---------------------------------------------------------------------------

/** Options for `useSharedSSEClient`. */
export interface SharedSSEClientConfig {
  /**
   * How long an unreferenced connection stays open, in milliseconds (default 0:
   * close at once). Set it to a few seconds when components remount on every
   * route change, so the connection survives the gap instead of reconnecting.
   */
  grace?: number;
  /** Custom key derivation, defaults to `deriveShareKey`. */
  keyOf?: (options: SSEClientOptions) => string;
  /** Client factory, defaults to `(options) => new SSEClient(options)`. */
  create?: ClientFactory;
}

/**
 * A consumer's view of a shared connection.
 *
 * The point of a handle (rather than a bare client) is that the *subscription*
 * is allowed to change: filters, floors, tenants and time ranges all mean
 * "unsubscribe from A, subscribe to B". Doing that on a shared client would
 * reconfigure the connection for everybody else using it, so the handle keeps
 * the listener bookkeeping and moves it to the matching connection instead.
 *
 * ```ts
 * const handle = useSharedSSEClient({ grace: 5000 });
 * handle.on("IOT", (payload) => store.apply(payload)); // buffered: no connection yet
 * handle.configure({ url, body: [{ floorId }] });      // reuse or open the matching one
 * handle.configure({ url, body: [{ floorId: next }] });// switch connections, peers untouched
 * onScopeDispose(() => handle.release());              // refcount, not a hard close
 * ```
 */
export interface SharedSSEClientHandle<E extends object = SSEEventMap> {
  /** Key of the current subscription, `null` before the first `configure`. */
  readonly key: string | null;
  /** Underlying client, `null` before the first `configure`. */
  readonly client: SSEClient<E> | null;
  /** Connection state; `idle` while unconfigured. */
  readonly status: SSEStatus;
  /** Whether `configure` has been called with a URL. */
  readonly configured: boolean;
  /**
   * Point the handle at the subscription described by `options`.
   *
   * Same key: nothing happens (no reconnect). Different key: listeners move to
   * the matching connection, which is reused when somebody already holds it.
   * Empty options stop the subscription but keep the handle usable.
   */
  configure: (options?: SSEClientOptions) => string | null;
  /** Stop consuming: release the reference and drop listeners until the next `configure`. */
  close: () => void;
  /** Return the reference for good; idempotent. */
  release: () => void;
  /** Subscribe to one event name. Works before `configure`. */
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
  onOpen: (handler: (response: Response) => void) => Unsubscribe;
  onClose: (handler: (reason: SSECloseReason, error?: SSEError) => void) => Unsubscribe;
  /**
   * "The stream may not be continuous", from whichever client currently serves the
   * subscription. Bound here rather than on `client`: the handle replaces its client
   * on every `configure()`, and a listener left on the old one would go silent.
   */
  onSuspectGap: (handler: (info: SSEGapInfo) => void) => Unsubscribe;
  /** Resume verification from the current client (see `onSuspectGap`). */
  onResume: (handler: (info: SSEResumeInfo) => void) => Unsubscribe;
}

/**
 * Create a handle for a shared connection that can be pointed at different
 * subscriptions over its lifetime. Nothing connects until `configure` is called,
 * so listeners can be registered first — the usual order in component setup.
 */
export function useSharedSSEClient<E extends object = SSEEventMap>(
  config: SharedSSEClientConfig = {},
): SharedSSEClientHandle<E> {
  const grace = Math.max(0, config.grace ?? 0);
  const keyOf = config.keyOf ?? ((options: SSEClientOptions) => deriveShareKey(options));
  const create: ClientFactory =
    config.create ?? ((options) => new SSEClient(options) as unknown as AnyClient);

  let entry: SharedEntry | null = null;
  /** Registered listeners, re-attached whenever the underlying client changes. */
  const binders = new Set<Binder>();
  const bound = new Map<Binder, Unsubscribe>();
  let released = false;
  let disposed = false;

  const currentClient = () => entry?.client ?? null;

  const attach = (binder: Binder) => {
    const current = currentClient();
    if (!current || bound.has(binder)) {
      return;
    }
    bound.set(binder, binder(current));
  };

  const detachAll = () => {
    for (const off of bound.values()) {
      try {
        off();
      } catch {
        // A client may already be closed; unbinding must stay best-effort.
      }
    }
    bound.clear();
  };

  const listen = (binder: Binder): Unsubscribe => {
    if (disposed) {
      return noop;
    }
    binders.add(binder);
    attach(binder);
    return () => {
      const off = bound.get(binder);
      bound.delete(binder);
      binders.delete(binder);
      off?.();
    };
  };

  const configure = (options?: SSEClientOptions): string | null => {
    if (disposed) {
      return null;
    }
    if (!options?.url) {
      close();
      return null;
    }
    const key = keyOf(options);
    if (entry && entry.key === key) {
      return key;
    }

    // Move the listeners off the old client before the connection may be closed.
    detachAll();
    const previous = entry;
    entry = acquireEntry(key, () => create(options));
    for (const binder of binders) {
      attach(binder);
    }
    if (previous) {
      // A subscription change is not a remount: keeping the old link would park
      // an unused connection until the grace period expires.
      releaseEntry(previous, true, 0);
    }
    return key;
  };

  const close = () => {
    if (disposed) {
      return;
    }
    detachAll();
    const previous = entry;
    entry = null;
    if (previous) {
      releaseEntry(previous, false, grace);
    }
  };

  const release = () => {
    if (released) {
      return;
    }
    released = true;
    close();
    binders.clear();
    disposed = true;
  };

  const on = (event: string, handler: (data: unknown, message: SSEMessage) => void) =>
    listen((client) => client.on(event, handler));

  return {
    get key() {
      return entry?.key ?? null;
    },
    get client() {
      return currentClient() as unknown as SSEClient<E> | null;
    },
    get status() {
      return entry?.client.status ?? "idle";
    },
    get configured() {
      return entry !== null;
    },
    configure,
    close,
    release,
    on: on as unknown as SharedSSEClientHandle<E>["on"],
    onMessage: (handler) => listen((client) => client.onMessage(handler)),
    onStatus: (handler) => listen((client) => client.onStatus(handler)),
    onError: (handler) => listen((client) => client.onError(handler)),
    onOpen: (handler) => listen((client) => client.onOpen(handler)),
    onClose: (handler) => listen((client) => client.onClose(handler)),
    onSuspectGap: (handler) => listen((client) => client.onSuspectGap(handler)),
    onResume: (handler) => listen((client) => client.onResume(handler)),
  };
}
