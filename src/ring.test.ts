import { describe, expect, it } from "vitest";
import { createRingBuffer } from "./ring";

describe("createRingBuffer", () => {
  it("overwrites the oldest value once capacity is reached", () => {
    const ring = createRingBuffer<number>({ capacity: 3 });

    ring.push(1);
    ring.push(2);
    expect(ring.length).toBe(2);
    expect(ring.evicted).toBe(0);

    ring.push(3);
    ring.push(4);
    ring.push(5);

    expect(ring.length).toBe(3);
    expect(ring.evicted).toBe(2);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.at(0)).toBe(3);
    expect(ring.last()).toBe(5);
  });

  it("keeps order across many wraps", () => {
    const ring = createRingBuffer<number>({ capacity: 4 });
    for (let value = 0; value < 100; value += 1) {
      ring.push(value);
    }
    expect(ring.toArray()).toEqual([96, 97, 98, 99]);
  });

  it("returns undefined for indexes outside the retained range", () => {
    const ring = createRingBuffer<string>({ capacity: 4 });
    expect(ring.at(0)).toBeUndefined();
    expect(ring.last()).toBeUndefined();

    ring.push("a");
    expect(ring.at(-1)).toBeUndefined();
    expect(ring.at(1)).toBeUndefined();
    expect(ring.at(0.5)).toBeUndefined();
  });

  it("reuses the target array in into()", () => {
    const ring = createRingBuffer<number>({ capacity: 3 });
    ring.push(1);
    ring.push(2);

    const target: number[] = [];
    const first = ring.into(target);
    expect(first).toBe(target);
    expect(first).toEqual([1, 2]);

    ring.push(3);
    const second = ring.into(target);
    expect(second).toBe(target);
    expect(second).toEqual([1, 2, 3]);
  });

  it("toArray allocates a fresh array so a reactive ref can compare identities", () => {
    const ring = createRingBuffer<number>({ capacity: 2 });
    ring.push(1);
    expect(ring.toArray()).not.toBe(ring.toArray());
  });

  it("clear drops the values but keeps the lifetime eviction counter", () => {
    const ring = createRingBuffer<number>({ capacity: 2 });
    ring.push(1);
    ring.push(2);
    ring.push(3);
    ring.clear();

    expect(ring.length).toBe(0);
    expect(ring.toArray()).toEqual([]);
    expect(ring.evicted).toBe(1);

    ring.push(4);
    expect(ring.toArray()).toEqual([4]);
  });

  it("clamps a non-positive capacity to one slot", () => {
    const ring = createRingBuffer<number>({ capacity: 0 });
    ring.push(1);
    ring.push(2);
    expect(ring.capacity).toBe(1);
    expect(ring.toArray()).toEqual([2]);
  });
});
