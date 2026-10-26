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
    // ordered by last push, so the entry touched most recently comes last
    expect(flushed).toEqual([
      { id: 2, value: 2 },
      { id: 1, value: 3 },
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

describe("createBatcher bounds", () => {
  it("evicts the least recently pushed key once maxPending is reached", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, { id: number; value: number }>({
      key: (item) => item.id,
      interval: 300,
      maxPending: 2,
      onFlush,
    });

    batcher.push({ id: 1, value: 1 });
    batcher.push({ id: 2, value: 2 });
    // id 1 is touched again, so it stops being the oldest entry
    batcher.push({ id: 1, value: 10 });
    batcher.push({ id: 3, value: 3 });

    expect(batcher.pending).toBe(2);
    expect(batcher.dropped).toBe(1);

    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledWith([
      { id: 1, value: 10 },
      { id: 3, value: 3 },
    ]);
    expect(batcher.pending).toBe(0);
  });

  it("ignores and counts pushes after dispose instead of restarting the timer", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const batcher = createBatcher<number, number>({ key: (value) => value, interval: 300, onFlush });

    batcher.dispose();
    expect(batcher.disposed).toBe(true);

    batcher.push(1);
    expect(batcher.dropped).toBe(1);
    expect(batcher.pending).toBe(0);

    vi.advanceTimersByTime(600);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
