/**
 * Coalescing window for high-frequency streams.
 *
 * A single entity is often pushed several times within a few hundred
 * milliseconds (IoT points, device state). Writing every message to state
 * causes render storms, so messages are merged by a business key while keeping
 * the latest value, and flushed once per window.
 *
 * ```ts
 * const batcher = createBatcher<number, Point>({
 *   key: (p) => p.pointId,
 *   interval: 300,
 *   maxPending: 2000, // never hold more than 2000 entities in one window
 *   onFlush: (points) => store.applyPoints(points),
 * });
 * client.on("IOT", (p) => batcher.push(p));
 * ```
 */
export interface BatcherOptions<K, V> {
  /** Business key used to merge values; only the last value per key survives. */
  key: (value: V) => K;
  /** Coalescing window in milliseconds (default 300). */
  interval?: number;
  /** Called once per window with the latest value per key, ordered by their last push. */
  onFlush: (values: V[]) => void;
  /**
   * Cap on pending entries, unlimited by default. When the window is full the
   * key pushed least recently is evicted, so a burst of unique keys cannot grow
   * the buffer without bound — the count is reported through `dropped`.
   */
  maxPending?: number;
}

export interface Batcher<V> {
  /** Accept a value; replaces any pending value with the same key. */
  push: (value: V) => void;
  /** Flush immediately and cancel the pending window. */
  flush: () => void;
  /** Drop pending values without flushing. */
  clear: () => void;
  /** Flush and release the timer (call on unmount). Further `push` calls are ignored. */
  dispose: () => void;
  /** Number of values waiting to be flushed. */
  readonly pending: number;
  /** Values evicted by `maxPending`, plus values pushed after `dispose()`. */
  readonly dropped: number;
  /** Whether `dispose()` has been called. */
  readonly disposed: boolean;
}

export function createBatcher<K, V>(options: BatcherOptions<K, V>): Batcher<V> {
  const interval = options.interval ?? 300;
  const maxPending = Math.max(1, options.maxPending ?? Infinity);
  const buffer = new Map<K, V>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let dropped = 0;
  let disposed = false;

  const cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancel();
    if (!buffer.size) {
      return;
    }
    const values = [...buffer.values()];
    buffer.clear();
    options.onFlush(values);
  };

  return {
    push(value: V) {
      if (disposed) {
        // A late callback after unmount must not resurrect the timer.
        dropped += 1;
        return;
      }
      const key = options.key(value);
      // Re-insert so eviction follows the last update, not the first sighting.
      if (buffer.has(key)) {
        buffer.delete(key);
      }
      buffer.set(key, value);
      while (buffer.size > maxPending) {
        const oldest = buffer.keys().next();
        if (oldest.done) {
          break;
        }
        buffer.delete(oldest.value);
        dropped += 1;
      }
      if (timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, interval);
    },
    flush,
    clear() {
      cancel();
      buffer.clear();
    },
    dispose() {
      flush();
      disposed = true;
    },
    get pending() {
      return buffer.size;
    },
    get dropped() {
      return dropped;
    },
    get disposed() {
      return disposed;
    },
  };
}
