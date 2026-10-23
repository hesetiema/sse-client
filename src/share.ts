import type { SSEClient } from "./client.js";
import type { SSEEventMap } from "./types.js";

/** Handle for a shared connection. */
export interface SharedSSEHandle<E extends object = SSEEventMap> {
  client: SSEClient<E>;
  /** Release one reference; the connection closes when the last reference is released. */
  release: () => void;
}

interface SharedEntry {
  client: SSEClient<object>;
  refs: number;
}

const registry = new Map<string, SharedEntry>();

/**
 * Share a connection by key, using reference counting.
 *
 * When several components consume the same subscription they should not open one
 * connection each: HTTP/1.1 allows only six per origin, so push channels can
 * starve regular requests, and the server would receive duplicate subscriptions.
 *
 * ```ts
 * const { client, release } = acquireSSEClient("alarm", () => new SSEClient({ url, body }));
 * onScopeDispose(release);
 * ```
 *
 * The options of the first caller win; later calls with the same key reuse that
 * connection and ignore their own options.
 */
export function acquireSSEClient<E extends object = SSEEventMap>(
  key: string,
  create: () => SSEClient<E>,
): SharedSSEHandle<E> {
  const existing = registry.get(key);
  if (existing) {
    existing.refs += 1;
    return {
      client: existing.client as unknown as SSEClient<E>,
      release: once(() => release(key)),
    };
  }
  const client = create();
  registry.set(key, { client: client as unknown as SSEClient<object>, refs: 1 });
  return {
    client,
    release: once(() => release(key)),
  };
}

/** Close and drop every shared connection (mainly for tests and teardown). */
export function closeAllSharedSSEClients(): void {
  for (const entry of [...registry.values()]) {
    entry.client.close();
  }
  registry.clear();
}

/** Number of live shared connections, useful for tests and diagnostics. */
export function getSharedSSEClientCount(): number {
  return registry.size;
}

function release(key: string): void {
  const entry = registry.get(key);
  if (!entry) {
    return;
  }
  entry.refs -= 1;
  if (entry.refs > 0) {
    return;
  }
  registry.delete(key);
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
