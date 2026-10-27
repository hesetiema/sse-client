/** Options for `createRingBuffer`. */
export interface RingBufferOptions {
  /**
   * Number of slots. Pushing past it overwrites the oldest entry, which is what
   * keeps memory flat on a stream that never stops; values below 1 are clamped.
   */
  capacity: number;
}

/**
 * Fixed-capacity buffer: `push` is O(1), the allocation happens once, and the
 * oldest value is evicted instead of growing the array.
 *
 * Note what this is *not*: a sliding window. It answers "the last N values", not
 * "the values of the last T seconds" — for the latter the caller must also look
 * at the timestamps, and must not aggregate across a known gap.
 */
export interface RingBuffer<T> {
  readonly capacity: number;
  /** Values currently held, ≤ `capacity`. */
  readonly length: number;
  /** Lifetime count of overwritten values; not reset by `clear()`. */
  readonly evicted: number;
  push: (value: T) => void;
  /** `0` is the oldest retained value. */
  at: (index: number) => T | undefined;
  /** Most recently pushed value, `undefined` when empty. */
  last: () => T | undefined;
  /** Fixed-size copy, oldest first. Allocates; safe to hand to a reactive ref. */
  toArray: () => T[];
  /** Same as `toArray` but writes into `target` and returns it, for allocation-free hot paths. */
  into: (target: T[]) => T[];
  clear: () => void;
}

export function createRingBuffer<T>(options: RingBufferOptions): RingBuffer<T> {
  const requested = Number.isFinite(options.capacity) ? Math.floor(options.capacity) : 1;
  const capacity = Math.max(1, requested);
  const buffer = new Array<T>(capacity);
  /** Next slot to write. */
  let write = 0;
  let length = 0;
  let evicted = 0;

  /** Index of the oldest retained value. */
  const start = (): number => (write - length + capacity) % capacity;

  const into = (target: T[]): T[] => {
    const first = start();
    target.length = length;
    for (let index = 0; index < length; index += 1) {
      target[index] = buffer[(first + index) % capacity] as T;
    }
    return target;
  };

  return {
    capacity,
    get length() {
      return length;
    },
    get evicted() {
      return evicted;
    },
    push(value: T) {
      buffer[write] = value;
      write = (write + 1) % capacity;
      if (length < capacity) {
        length += 1;
      } else {
        evicted += 1;
      }
    },
    at(index: number) {
      if (!Number.isInteger(index) || index < 0 || index >= length) {
        return undefined;
      }
      return buffer[(start() + index) % capacity] as T;
    },
    last() {
      return length === 0 ? undefined : (buffer[(write - 1 + capacity) % capacity] as T);
    },
    toArray() {
      return into([]);
    },
    into,
    clear() {
      write = 0;
      length = 0;
    },
  };
}
