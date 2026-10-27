import { describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { createFanout } from "./fanout";
import { createMockSSEFetch } from "./testing";
import type { SSEMessage } from "./types";

const buildMessage = (event: string, data: unknown, id = "1"): SSEMessage => ({ id, event, data, raw: "" });

/** Minimal stand-in for a connection: records how many source subscriptions exist. */
function fakeSource() {
  const handlers = new Set<(data: unknown, message: SSEMessage) => void>();
  const on = vi.fn((_event: "*", handler: (data: unknown, message: SSEMessage) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });
  return {
    on,
    emit: (event: string, data: unknown, id = "1") => {
      for (const handler of [...handlers]) {
        handler(data, buildMessage(event, data, id));
      }
    },
    size: () => handlers.size,
  };
}

describe("createFanout", () => {
  it("serves many consumers from a single source subscription", () => {
    const source = fakeSource();
    const fanout = createFanout(source);

    const first: unknown[] = [];
    const second: unknown[] = [];
    fanout.on("ALARM", payload => first.push(payload));
    fanout.on("ALARM", payload => second.push(payload));

    source.emit("ALARM", { level: "high" });

    expect(source.on).toHaveBeenCalledTimes(1);
    expect(first).toEqual([{ level: "high" }]);
    expect(second).toEqual([{ level: "high" }]);
    expect(fanout.count("ALARM")).toBe(2);
    expect(fanout.count()).toBe(2);
  });

  it("keeps the latest payload per event for late consumers", () => {
    const source = fakeSource();
    const fanout = createFanout(source);

    const off = fanout.on("IOT", () => undefined);
    source.emit("IOT", { v: 1 });
    source.emit("IOT", { v: 2 });
    off();

    expect(fanout.latest("IOT")).toEqual({ v: 2 });
    expect(fanout.latestAll()).toEqual({ IOT: { v: 2 } });
    expect(fanout.latest("MISSING")).toBeUndefined();
  });

  it("delivers wildcard consumers and isolates a throwing one", () => {
    const source = fakeSource();
    const onHandlerError = vi.fn();
    const fanout = createFanout(source, { onHandlerError });

    const seen: string[] = [];
    fanout.on("ALARM", () => {
      throw new Error("boom");
    });
    fanout.on("*", (_payload, message) => seen.push(message.event));

    source.emit("ALARM", { level: "low" });

    expect(seen).toEqual(["ALARM"]);
    expect(onHandlerError).toHaveBeenCalledTimes(1);
  });

  it("drops consumers and the source subscription on dispose", () => {
    const source = fakeSource();
    const fanout = createFanout(source);
    const handler = vi.fn();

    fanout.on("ALARM", handler);
    expect(source.size()).toBe(1);

    fanout.dispose();
    expect(source.size()).toBe(0);
    expect(fanout.count()).toBe(0);

    source.emit("ALARM", { ignored: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("is memoised on the client and follows real messages", async () => {
    const mock = createMockSSEFetch({
      script: [
        { event: "ALARM", data: { level: "high" }, id: "1" },
        { event: "ALARM", data: { level: "low" }, id: "2" },
      ],
    });
    const client = new SSEClient({ url: "/push", fetch: mock.fetch, reconnectOnEnd: false, parse: (raw: string) => JSON.parse(raw) });
    const fanout = client.fanout();

    expect(client.fanout()).toBe(fanout);

    const levels: unknown[] = [];
    fanout.on("ALARM", payload => levels.push((payload as { level: string }).level));
    await client.done;

    expect(levels).toEqual(["high", "low"]);
    expect(fanout.latest("ALARM")).toEqual({ level: "low" });
  });
});
