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
  /** Called once per window with the latest value per key, in first-seen order. */
  onFlush: (values: V[]) => void;
}

export interface Batcher<V> {
  /** Accept a value; replaces any pending value with the same key. */
  push: (value: V) => void;
  /** Flush immediately and cancel the pending window. */
  flush: () => void;
  /** Drop pending values without flushing. */
  clear: () => void;
  /** Flush and release the timer (call on unmount). */
  dispose: () => void;
  /** Number of values waiting to be flushed. */
  readonly pending: number;
}

export function createBatcher<K, V>(options: BatcherOptions<K, V>): Batcher<V> {
  const interval = options.interval ?? 300;
  const buffer = new Map<K, V>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer.size) {
      return;
    }
    const values = [...buffer.values()];
    buffer.clear();
    options.onFlush(values);
  };

  return {
    push(value: V) {
      buffer.set(options.key(value), value);
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
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      buffer.clear();
    },
    dispose() {
      flush();
    },
    get pending() {
      return buffer.size;
    },
  };
}
