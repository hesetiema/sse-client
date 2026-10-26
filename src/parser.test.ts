import { describe, expect, it, vi } from "vitest";
import { createSSEParser, type ParsedEvent, type SSEParser } from "./parser";

function collect(feed: (parser: SSEParser) => void): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const parser = createSSEParser({ onEvent: (event) => events.push(event) });
  feed(parser);
  return events;
}

describe("createSSEParser frame parsing", () => {
  it("parses one event; the event name is empty when omitted (the client defaults to message)", () => {
    expect(collect((parser) => parser.feed("data: hello\n\n"))).toEqual([
      { id: "", event: "", data: "hello" },
    ]);
  });

  it("joins multi-line data with a newline", () => {
    const events = collect((parser) => parser.feed("data: line1\ndata: line2\n\n"));
    expect(events[0]?.data).toBe("line1\nline2");
  });

  it("supports CRLF and does not split a \\r\\n across chunks into two lines", () => {
    const events = collect((parser) => {
      parser.feed("data: a\r");
      parser.feed("\ndata: b\r\n\r\n");
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("a\nb");
  });

  it("comment lines (heartbeats) produce no event", () => {
    const events = collect((parser) => parser.feed(": ping\n\ndata: real\n\n"));
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("real");
  });

  it("applies event and id, inheriting the previous id when omitted", () => {
    const events = collect((parser) => parser.feed("id: 1\nevent: alarm\ndata: a\n\ndata: b\n\n"));
    expect(events).toEqual([
      { id: "1", event: "alarm", data: "a" },
      { id: "1", event: "", data: "b" },
    ]);
  });

  it("reports the reconnect interval requested by the server", () => {
    const onRetry = vi.fn();
    const parser = createSSEParser({ onRetry });
    parser.feed("retry: 3000\ndata: a\n\n");
    expect(onRetry).toHaveBeenCalledWith(3000);
  });

  it("events without data are not dispatched", () => {
    expect(collect((parser) => parser.feed("event: ping\n\n"))).toHaveLength(0);
  });

  it("strips a leading BOM", () => {
    const events = collect((parser) => parser.feed("\uFEFFdata: a\n\n"));
    expect(events[0]?.data).toBe("a");
  });

  it("reset drops the partial line and the id", () => {
    const events: ParsedEvent[] = [];
    const parser = createSSEParser({ onEvent: (event) => events.push(event) });
    parser.feed("id: 9\ndata: partial");
    parser.reset();
    parser.feed("data: fresh\n\n");
    expect(events).toEqual([{ id: "", event: "", data: "fresh" }]);
  });

  it("stops parsing and flags overflowed past maxBufferSize", () => {
    const events: ParsedEvent[] = [];
    const parser = createSSEParser({ maxBufferSize: 16, onEvent: (event) => events.push(event) });
    parser.feed(`data: ${"x".repeat(100)}`);
    expect(parser.overflowed).toBe(true);

    // no further events and no further buffering after overflow
    parser.feed(`data: ${"y".repeat(100)}\n\n`);
    expect(events).toHaveLength(0);
  });

  it("caps the accumulated payload when data lines never terminate the event", () => {
    // every line is short, so the per-line buffer check in feed() never fires
    const parser = createSSEParser({ maxBufferSize: 64 });
    for (let i = 0; i < 100; i += 1) {
      parser.feed(`data: ${"x".repeat(20)}\n`);
    }
    expect(parser.overflowed).toBe(true);
  });
});

describe("createSSEParser work budget", () => {
  it("stops after the budget, then continues on feed('') without losing anything", () => {
    const events: ParsedEvent[] = [];
    const parser = createSSEParser({ onEvent: (event) => events.push(event) });
    const chunk = Array.from({ length: 5 }, (_, i) => `id: ${i + 1}\ndata: ${i + 1}\n\n`).join("");

    parser.feed(chunk, 2);
    expect(events).toHaveLength(2);
    expect(parser.stalled).toBe(true);

    let rounds = 0;
    while (parser.stalled) {
      parser.feed("", 2);
      rounds += 1;
      expect(rounds).toBeLessThan(10);
    }

    expect(events.map((event) => event.data)).toEqual(["1", "2", "3", "4", "5"]);
    expect(parser.stalled).toBe(false);
  });

  it("does not stall when the budget is larger than the chunk", () => {
    const parser = createSSEParser({});
    parser.feed("data: a\n\ndata: b\n\n", 100);
    expect(parser.stalled).toBe(false);
  });

  it("bounds a chunk that dispatches nothing but blank lines", () => {
    // events stay at 0, so only the line cap can stop this
    const parser = createSSEParser({});
    parser.feed("\n".repeat(1000), 1);
    expect(parser.stalled).toBe(true);
  });
});

describe("createSSEParser overflow policy", () => {
  it("drop discards the oversized message and keeps the stream alive", () => {
    const events: ParsedEvent[] = [];
    const parser = createSSEParser({
      maxBufferSize: 64,
      overflowPolicy: "drop",
      onEvent: (event) => events.push(event),
    });

    parser.feed(`data: ${"x".repeat(200)}\n\n`);
    expect(parser.overflowed).toBe(false);
    expect(parser.dropped).toBe(1);

    parser.feed("data: after\n\n");
    expect(events).toEqual([{ id: "", event: "", data: "after" }]);
  });

  it("drop swallows the payload up to the next blank line and resyncs", () => {
    const events: ParsedEvent[] = [];
    const parser = createSSEParser({
      maxBufferSize: 32,
      overflowPolicy: "drop",
      onEvent: (event) => events.push(event),
    });

    for (let i = 0; i < 10; i += 1) {
      parser.feed(`data: ${"x".repeat(20)}\n`);
    }
    // still inside the oversized event: nothing delivered, one drop recorded
    expect(parser.dropped).toBe(1);
    expect(events).toHaveLength(0);

    parser.feed("\nid: 3\ndata: good\n\n");
    expect(events).toEqual([{ id: "3", event: "", data: "good" }]);
  });

  it("drop keeps counting when a message is huge but has no event boundary", () => {
    const parser = createSSEParser({ maxBufferSize: 32, overflowPolicy: "drop" });
    parser.feed(`data: ${"x".repeat(5000)}`);
    expect(parser.dropped).toBe(1);
    expect(parser.overflowed).toBe(false);
  });
});
