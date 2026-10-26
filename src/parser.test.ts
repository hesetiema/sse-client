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
