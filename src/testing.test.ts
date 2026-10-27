import { describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { createMockSSEFetch, serializeFrame } from "./testing";

describe("createMockSSEFetch", () => {
  it("streams frames and records the request", async () => {
    const mock = createMockSSEFetch({
      script: [
        { id: "1", event: "ALARM", data: { level: "high" } },
        { id: "2", event: "ALARM", data: { level: "low" } },
      ],
    });

    const client = new SSEClient({
      url: "/push/subscribe",
      body: [{ subscribeType: "SEWAGE" }],
      headers: { token: "tk" },
      fetch: mock.fetch,
      reconnectOnEnd: false,
      parse: (raw: string) => JSON.parse(raw),
    });

    const levels: unknown[] = [];
    client.on("ALARM", payload => levels.push((payload as { level: string }).level));
    await client.done;

    expect(levels).toEqual(["high", "low"]);
    expect(client.lastEventId).toBe("2");

    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toBe("/push/subscribe");
    expect(mock.calls[0].method).toBe("POST");
    expect(mock.calls[0].headers.get("token")).toBe("tk");
    expect(mock.lastBody()).toEqual([{ subscribeType: "SEWAGE" }]);
  });

  it("scripts per attempt, so a reconnect can be reproduced", async () => {
    const mock = createMockSSEFetch({
      script: attempt =>
        attempt === 0
          ? [{ id: "1", event: "ALARM", data: { n: 1 } }]
          : [{ id: "2", event: "ALARM", data: { n: 2 } }, { id: "3", event: "ALARM", data: { n: 3 } }],
    });

    const client = new SSEClient({
      url: "/s",
      fetch: mock.fetch,
      parse: (raw: string) => JSON.parse(raw),
      retryBaseDelay: 10,
      maxRetry: 1,
    });
    const seen: unknown[] = [];
    client.on("ALARM", payload => {
      seen.push((payload as { n: number }).n);
      if ((payload as { n: number }).n === 3) {
        client.close();
      }
    });

    await client.done;
    expect(seen).toEqual([1, 2, 3]);
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1].headers.get("last-event-id")).toBe("1");
  });

  it("keeps a subscription open until close()", async () => {
    const mock = createMockSSEFetch({ script: [{ event: "PING", data: 1 }], keepOpen: true });
    const client = new SSEClient({ url: "/s", fetch: mock.fetch });
    let pings = 0;
    client.on("PING", () => {
      pings += 1;
    });

    await vi.waitFor(() => expect(pings).toBe(1));
    mock.close();
    client.close();
    expect(pings).toBe(1);
  });

  it("serializes raw and heartbeat frames verbatim", () => {
    expect(serializeFrame({ raw: "data: x\n\n" })).toBe("data: x\n\n");
    expect(serializeFrame({ comment: "ping" })).toBe(": ping\n\n");
    expect(serializeFrame({ id: "9", event: "A", data: "text" })).toBe("id: 9\nevent: A\ndata: text\n\n");
  });

  it("writes one data line per payload line", async () => {
    // A bare newline ends the field: without this split the second line is dropped
    // as a nameless line, and the mock would hide the bug instead of exposing it.
    expect(serializeFrame({ id: "1", data: "a\nb" })).toBe("id: 1\ndata: a\ndata: b\n\n");

    const mock = createMockSSEFetch({ script: [{ id: "1", event: "NOTE", data: "a\nb" }] });
    const client = new SSEClient({
      url: "/s",
      fetch: mock.fetch,
      reconnectOnEnd: false,
      parse: (raw: string) => raw,
    });
    const payloads: string[] = [];
    client.on("NOTE", (payload: string) => payloads.push(payload));
    await client.done;

    expect(payloads).toEqual(["a\nb"]);
  });

  it("keeps custom response headers for every HeadersInit shape", async () => {
    const shapes: HeadersInit[] = [
      { "x-trace": "1" },
      new Headers({ "x-trace": "1" }),
      [["x-trace", "1"]],
    ];
    for (const headers of shapes) {
      const mock = createMockSSEFetch({ headers });
      const response = await mock.fetch("/s", { method: "GET" });
      expect(response.headers.get("x-trace")).toBe("1");
      expect(response.headers.get("content-type")).toBe("text/event-stream");
    }
  });
});
