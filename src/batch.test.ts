import { afterEach, describe, expect, it, vi } from "vitest";
import { createBatcher } from "./batch";

afterEach(() => {
  vi.useRealTimers();
});

describe("createBatcher coalescing window", () => {
  it("keeps the latest value per key and flushes once per window", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, { id: number; value: number }>({
      key: (item) => item.id,
      interval: 300,
      onFlush,
    });

    batcher.push({ id: 1, value: 1 });
    batcher.push({ id: 2, value: 2 });
    batcher.push({ id: 1, value: 3 });

    expect(batcher.pending).toBe(2);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);

    expect(onFlush).toHaveBeenCalledTimes(1);
    const flushed = onFlush.mock.calls[0][0] as { id: number; value: number }[];
    expect(flushed).toEqual([
      { id: 1, value: 3 },
      { id: 2, value: 2 },
    ]);
    expect(batcher.pending).toBe(0);
  });

  it("flush emits immediately and cancels the timer", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, number>({ key: (value) => value, interval: 300, onFlush });

    batcher.push(1);
    batcher.flush();
    expect(onFlush).toHaveBeenCalledWith([1]);

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("clear drops pending values", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, number>({ key: (value) => value, interval: 300, onFlush });

    batcher.push(1);
    batcher.clear();
    vi.advanceTimersByTime(300);

    expect(onFlush).not.toHaveBeenCalled();
    expect(batcher.pending).toBe(0);
  });

  it("dispose flushes the remaining values", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, number>({ key: (value) => value, interval: 300, onFlush });

    batcher.push(1);
    batcher.dispose();

    expect(onFlush).toHaveBeenCalledWith([1]);
  });
});
