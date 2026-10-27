import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient, type RetryPolicy } from "./client";
import type { SSEMessage } from "./types";

const encoder = new TextEncoder();

/** Build a response that returns text/event-stream */
function textResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * Simulates a server that never ends the stream: reading the body only throws
 * AbortError once the request is aborted, like reader.read() in a browser.
 */
function hangingResponse(init: RequestInit, initial: string[] = []): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of initial) {
        controller.enqueue(encoder.encode(chunk));
      }
      init.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          // the stream may already be closed
        }
      });
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("SSEClient transport", () => {
  it("sends a JSON body and auth headers over POST, routing by event name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        textResponse([
          'event: ALARM\ndata: {"level":"high"}\n\n',
          'event: ALARM\ndata: {"level":"low"}\n\n',
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({
      url: "/push/subscribe",
      body: { topics: ["alarm"] },
      headers: () => ({ token: "tk", "project-id": "p1" }),
      parse: (raw) => JSON.parse(raw),
      reconnectOnEnd: false,
    });
    const levels: unknown[] = [];
    client.on("ALARM", (alarm: { level: string }) => levels.push(alarm.level));
    await client.done;

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/push/subscribe");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ topics: ["alarm"] }));
    const headers = init.headers as Headers;
    expect(headers.get("token")).toBe("tk");
    expect(headers.get("project-id")).toBe("p1");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(levels).toEqual(["high", "low"]);
  });

  it("messages without an event name default to message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(["data: a\n\n"])));
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    const received: SSEMessage[] = [];
    client.onMessage((message) => received.push(message));
    await client.done;
    expect(received).toHaveLength(1);
    expect(received[0]?.event).toBe("message");
    expect(received[0]?.data).toBe("a");
    expect(received[0]?.raw).toBe("a");
  });

  it("supports multiple subscribers per event and stops after unsubscribe", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(["event: T\ndata: 1\n\nevent: T\ndata: 2\n\n"])),
    );
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    const first: unknown[] = [];
    const second: unknown[] = [];
    const off = client.on("T", (data) => first.push(data));
    client.on("T", (data) => second.push(data));
    client.on("T", () => off());
    await client.done;
    expect(first).toEqual(["1"]);
    expect(second).toEqual(["1", "2"]);
  });

  it("the wildcard handler receives every event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(["event: A\ndata: 1\n\nevent: B\ndata: 2\n\n"])),
    );
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    const names: string[] = [];
    client.on("*", (_data, message) => names.push(message.event));
    await client.done;
    expect(names).toEqual(["A", "B"]);
  });

  it("GET requests send no body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse(["data: a\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SSEClient({ url: "/s", method: "GET", body: { a: 1 }, reconnectOnEnd: false });
    await client.done;
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
  });

  it("terminal statuses such as 401 stop after one request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const onClose = vi.fn();
    const client = new SSEClient({ url: "/s", onError, onClose });
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].status).toBe(401);
    expect(onClose).toHaveBeenCalledWith("error", expect.anything());
  });

  it("retries with backoff after 500 and dispatches on success", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(textResponse(["data: ok\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const received: SSEMessage[] = [];

    const client = new SSEClient({
      url: "/s",
      retryBaseDelay: 10,
      maxRetry: 3,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received.map((message) => message.data)).toEqual(["ok"]);
  });

  it("stops after maxRetry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    const client = new SSEClient({ url: "/s", retryBaseDelay: 10, maxRetry: 2, onClose });
    await vi.advanceTimersByTimeAsync(2000);
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(onClose).toHaveBeenCalledWith("error", expect.anything());
  });

  it("sends Last-Event-ID when reconnecting", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse(["id: 7\ndata: a\n\n"]))
      .mockResolvedValueOnce(textResponse(["data: b\n\n"]));
    vi.stubGlobal("fetch", fetchMock);
    const received: SSEMessage[] = [];

    const client = new SSEClient({
      url: "/s",
      retryBaseDelay: 10,
      maxRetry: 1,
      onMessage: (message) => received.push(message),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondHeaders = fetchMock.mock.calls[1][1].headers as Headers;
    expect(secondHeaders.get("Last-Event-ID")).toBe("7");
    // the previous id is reused when the server omits it after a reconnect
    expect(received.map((message) => [message.id, message.data])).toEqual([
      ["7", "a"],
      ["7", "b"],
    ]);
  });

  it("close() aborts a long-lived connection and resolves done", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(hangingResponse(init, ["data: a\n\n"])),
      ),
    );
    const onClose = vi.fn();
    const client = new SSEClient({ url: "/s", onClose });
    await vi.waitFor(() => expect(client.status).toBe("open"));
    client.close();
    await client.done;

    expect(client.closed).toBe(true);
    expect(onClose).toHaveBeenCalledWith("user", undefined);
  });

  it("an idle timeout aborts the attempt and reconnects instead of hanging", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount += 1;
        return Promise.resolve(
          callCount === 1 ? hangingResponse(init) : textResponse(["data: back\n\n"]),
        );
      }),
    );
    const onError = vi.fn();
    const received: SSEMessage[] = [];

    const client = new SSEClient({
      url: "/s",
      idleTimeout: 50,
      retryBaseDelay: 10,
      maxRetry: 2,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
      onError,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await client.done;

    expect(callCount).toBe(2);
    expect(onError.mock.calls[0][0].message).toContain("idle timeout");
    expect(received.map((message) => message.data)).toEqual(["back"]);
  });

  it("proactive rotation reconnects immediately without backoff", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount += 1;
        return Promise.resolve(hangingResponse(init, [`data: msg-${callCount}\n\n`]));
      }),
    );
    const received: SSEMessage[] = [];

    const client = new SSEClient({
      url: "/s",
      rotateInterval: 100,
      retryBaseDelay: 5000,
      onMessage: (message) => received.push(message),
    });
    await vi.advanceTimersByTimeAsync(120);

    // rotation at 100ms triggers an immediate second request (with a 5s backoff there would still be one call)
    expect(callCount).toBe(2);
    client.close();
    await client.done;
    expect(received.map((message) => message.data)).toEqual(["msg-1", "msg-2"]);
  });
});

describe("SSEClient overlap rotation", () => {
  it("takes the candidate over without an error and keeps reading it", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount += 1;
        signals.push(init.signal);
        return Promise.resolve(hangingResponse(init, [`data: msg-${callCount}\n\n`]));
      }),
    );
    const received: SSEMessage[] = [];
    const onError = vi.fn();

    const client = new SSEClient({
      url: "/s",
      rotateInterval: 100,
      rotateMode: "overlap",
      onMessage: (message) => received.push(message),
      onError,
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(received.map((message) => message.data)).toEqual(["msg-1"]);

    await vi.advanceTimersByTimeAsync(60);

    expect(callCount).toBe(2);
    // A handoff is not a failure: no error event, no backoff, no restart.
    expect(onError).not.toHaveBeenCalled();
    expect(client.status).toBe("open");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(10);
    expect(received.map((message) => message.data)).toEqual(["msg-1", "msg-2"]);

    client.close();
    await client.done;
    expect(signals[1]?.aborted).toBe(true);
  });

  it("keeps streaming when the candidate cannot be opened", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount += 1;
        return Promise.resolve(
          callCount === 1
            ? hangingResponse(init, [`data: msg-1\n\n`])
            : new Response("gateway error", { status: 502 }),
        );
      }),
    );
    const onError = vi.fn();

    const client = new SSEClient({
      url: "/s",
      rotateInterval: 100,
      rotateMode: "overlap",
      onError,
    });
    await vi.advanceTimersByTimeAsync(120);

    expect(callCount).toBe(2);
    expect(onError).toHaveBeenCalledTimes(1);
    // The running connection was not traded for a broken one.
    expect(client.status).toBe("open");
    expect(client.closed).toBe(false);

    client.close();
    await client.done;
  });

  it("gives up a hanging candidate after rotateTimeout and keeps streaming", async () => {
    vi.useFakeTimers();
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        callCount += 1;
        if (callCount === 1) {
          return Promise.resolve(hangingResponse(init, ["data: msg-1\n\n"]));
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }),
    );
    const onError = vi.fn();

    const client = new SSEClient({
      url: "/s",
      rotateInterval: 100,
      rotateMode: "overlap",
      rotateTimeout: 20,
      onError,
    });
    await vi.advanceTimersByTimeAsync(150);

    expect(callCount).toBe(2);
    // Our own timeout is not reported as a connection error.
    expect(onError).not.toHaveBeenCalled();
    expect(client.status).toBe("open");

    client.close();
    await client.done;
  });
});

describe("SSEClient extension points", () => {
  it("a custom retry policy overrides the built-in backoff (e.g. refresh the token after a 401)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(textResponse(["data: ok\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    let retried = false;
    const retry: RetryPolicy = ({ error }) => {
      if (error?.status === 401 && !retried) {
        retried = true;
        return 0;
      }
      return false;
    };
    const received: SSEMessage[] = [];
    const client = new SSEClient({
      url: "/s",
      retry,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
    });
    await vi.advanceTimersByTimeAsync(50);
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received.map((message) => message.data)).toEqual(["ok"]);
  });

  it("a retry policy may be async: refresh the token, then reconnect", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("expired", { status: 401 }))
      .mockResolvedValueOnce(textResponse(["data: ok\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    let refreshed = false;
    const refreshToken = vi.fn(async () => {
      refreshed = true;
    });
    const retry: RetryPolicy = async ({ error }) => {
      if (error?.status === 401 && !refreshed) {
        await refreshToken();
        return 0;
      }
      return false;
    };

    const received: SSEMessage[] = [];
    const client = new SSEClient({
      url: "/s",
      retry,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
    });
    await vi.advanceTimersByTimeAsync(50);
    await client.done;

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(received.map((message) => message.data)).toEqual(["ok"]);
  });

  it("a throwing handler does not break the stream", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(["event: T\ndata: 1\n\nevent: T\ndata: 2\n\n"])),
    );
    const onHandlerError = vi.fn();
    const received: unknown[] = [];
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false, onHandlerError });
    client.on("T", (data) => {
      if (data === "1") {
        throw new Error("boom");
      }
      received.push(data);
    });
    await client.done;

    expect(onHandlerError).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["2"]);
  });

  it("a throwing parse skips only that message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(["data: bad\n\ndata: good\n\n"])),
    );
    const onHandlerError = vi.fn();
    const received: unknown[] = [];
    const client = new SSEClient({
      url: "/s",
      reconnectOnEnd: false,
      onHandlerError,
      parse: (raw) => {
        if (raw === "bad") {
          throw new Error("invalid json");
        }
        return raw;
      },
      onMessage: (message) => received.push(message.data),
    });
    await client.done;

    expect(onHandlerError).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["good"]);
  });

  it("parses a real push frame: id, event and JSON payload land correctly", async () => {
    interface FramePayload {
      projectId: string;
      eventType: string;
      data: Array<{ infoCode: string; unit?: string; dataValue: string; dataTime: string }>;
    }
    const frame =
      'id:2113558547804782594\nevent:CLOUD_IOT_DATA_CHANGE\ndata:{"projectId":"Pj9522457558","eventType":"CLOUD_IOT_DATA_CHANGE","data":[{"objectId":"Eq74803828245c938c057f6d43589b378588c191a583","infoCode":"lULoadRate","unit":"%","dataValue":"20.6","dataValueName":"20.6","dataTime":"20261023170000"}]}\n\n';

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([frame])));
    const received: SSEMessage<FramePayload>[] = [];
    const client = new SSEClient({
      url: "/s",
      parse: (raw) => JSON.parse(raw),
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
    });
    await client.done;

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe("2113558547804782594");
    expect(received[0]?.event).toBe("CLOUD_IOT_DATA_CHANGE");
    expect(received[0]?.data.eventType).toBe("CLOUD_IOT_DATA_CHANGE");
    expect(received[0]?.data.data[0]).toMatchObject({
      infoCode: "lULoadRate",
      unit: "%",
      dataValue: "20.6",
      dataTime: "20261023170000",
    });
    expect(client.lastEventId).toBe("2113558547804782594");
  });

  it("state flows connecting → open → closed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse(["data: a\n\n"])));
    const states: string[] = [];
    const client = new SSEClient({
      url: "/s",
      reconnectOnEnd: false,
      onStatus: (status) => states.push(status),
    });
    expect(client.status).toBe("connecting");
    await client.done;
    expect(states).toEqual(["connecting", "open", "closed"]);
  });
});

describe("SSEClient protocol robustness", () => {
  it("a non-SSE content-type is a protocol error and is not retried", async () => {
    // A typical case: a gateway or auth page answers 200 with HTML
    const htmlResponse = () =>
      new Response("<html>login</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(htmlResponse()));
    vi.stubGlobal("fetch", fetchMock);
    const onError = vi.fn();
    const onClose = vi.fn();

    const client = new SSEClient({ url: "/s", onError, onClose });
    await client.done;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].kind).toBe("protocol");
    expect(onError.mock.calls[0][0].retryable).toBe(false);
    expect(onClose).toHaveBeenCalledWith("error", expect.anything());
  });

  it("strictContentType: false accepts non-standard responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("data: a\n\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const received: SSEMessage[] = [];

    const client = new SSEClient({
      url: "/s",
      strictContentType: false,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message),
    });
    await client.done;

    expect(received.map((message) => message.data)).toEqual(["a"]);
  });

  it("a message above the buffer cap terminates the connection", async () => {
    const huge = `data: ${"x".repeat(2048)}`; // no blank line, so this never forms a complete event
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([huge, huge])));
    const onError = vi.fn();

    const client = new SSEClient({ url: "/s", maxBufferSize: 1024, onError });
    await client.done;

    expect(onError.mock.calls[0][0].kind).toBe("protocol");
    expect(onError.mock.calls[0][0].retryable).toBe(false);
  });

  it("overflowPolicy drop discards the oversized message and keeps streaming", async () => {
    const huge = `data: ${"x".repeat(2048)}\n\n`;
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init, [huge, "id: 2\ndata: ok\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const received: string[] = [];
    const gaps: string[] = [];
    const onError = vi.fn();
    const client = new SSEClient({
      url: "/s",
      limits: { maxBufferSize: 1024, overflowPolicy: "drop" },
      hooks: {
        gap: (info) => gaps.push(info.reason),
        error: onError,
        message: (message) => received.push(message.raw),
      },
    });

    await vi.waitFor(() => expect(received).toEqual(["ok"]));
    expect(client.dropped).toBe(1);
    // The count is the metric; the loss itself is the gap signal.
    expect(gaps).toEqual(["drop"]);
    expect(onError).not.toHaveBeenCalled();
    expect(client.status).toBe("open");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.close();
    await client.done;
  });

  it("yieldEvery slices a large chunk across tasks and keeps the order", async () => {
    const yieldMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal("scheduler", { yield: yieldMock });

    const chunk = Array.from({ length: 6 }, (_, i) => `id: ${i + 1}\ndata: ${i + 1}\n\n`).join("");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(textResponse([chunk])));

    const received: string[] = [];
    const client = new SSEClient({
      url: "/s",
      yieldEvery: 2,
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message.raw),
    });
    await client.done;

    expect(received).toEqual(["1", "2", "3", "4", "5", "6"]);
    // 6 events in slices of 2 need at least two pauses before the last slice.
    expect(yieldMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(client.lastEventId).toBe("6");
  });

  it("the events allow-list dispatches only listed names but still advances lastEventId", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          textResponse(["event: NOISE\nid: 1\ndata: n\n\nevent: ALARM\nid: 2\ndata: a\n\n"]),
        ),
    );
    const received: string[] = [];

    const client = new SSEClient({
      url: "/s",
      events: ["ALARM"],
      reconnectOnEnd: false,
      onMessage: (message) => received.push(message.event),
    });
    await client.done;

    expect(received).toEqual(["ALARM"]);
    expect(client.lastEventId).toBe("2");
  });

  it("messages carry receivedAt and once fires a single time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(textResponse(["data: 1\n\ndata: 2\n\n"])),
    );
    const received: SSEMessage[] = [];
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    client.once("message", (data, message) => received.push(message));
    await client.done;

    expect(received).toHaveLength(1);
    expect(typeof received[0]?.receivedAt).toBe("number");
  });

  it("endSignal (e.g. [DONE]) ends the stream without reconnecting or dispatching", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init, ["data: hello\n\ndata: [DONE]\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);
    const received: SSEMessage[] = [];
    const onClose = vi.fn();

    const client = new SSEClient({
      url: "/s",
      endSignal: "[DONE]",
      onMessage: (message) => received.push(message),
      onClose,
    });
    await client.done;

    expect(received.map((message) => message.data)).toEqual(["hello"]);
    expect(onClose).toHaveBeenCalledWith("end", undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
  });

  it("decodes multi-byte characters split across chunks", async () => {
    const bytes = encoder.encode("data: Ü✓😀\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // "data: " is 6 bytes; Ü takes 6..7 (2 bytes), ✓ 8..10 (3), 😀 11..14 (4)
        controller.enqueue(bytes.slice(0, 7)); // inside Ü
        controller.enqueue(bytes.slice(7, 10)); // finishes Ü, inside ✓
        controller.enqueue(bytes.slice(10, 12)); // finishes ✓, inside 😀
        controller.enqueue(bytes.slice(12));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    );
    const received: unknown[] = [];
    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    client.onMessage((message) => received.push(message.data));
    await client.done;

    expect(received).toEqual(["Ü✓😀"]);
  });
});

describe("SSEClient offline handling", () => {
  /** A fake window the test can dispatch events on */
  function stubBrowserWindow() {
    const listeners = new Map<string, Set<() => void>>();
    const fakeWindow = {
      addEventListener: (type: string, handler: () => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      },
      removeEventListener: (type: string, handler: () => void) => {
        listeners.get(type)?.delete(handler);
      },
      dispatch: (type: string) => {
        listeners.get(type)?.forEach((handler) => handler());
      },
    };
    vi.stubGlobal("window", fakeWindow);
    return fakeWindow;
  }

  it("suspends while offline and reconnects immediately when back online", async () => {
    const fakeWindow = stubBrowserWindow();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        calls += 1;
        return Promise.resolve(hangingResponse(init));
      }),
    );

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(client.status).toBe("open"));
    expect(calls).toBe(1);

    fakeWindow.dispatch("offline");
    expect(client.status).toBe("idle");

    // no new request is issued while suspended
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);

    fakeWindow.dispatch("online");
    await vi.waitFor(() => expect(client.status).toBe("open"));
    expect(calls).toBe(2);

    client.close();
    await client.done;
  });

  it("unbinds network listeners after close", async () => {
    const fakeWindow = stubBrowserWindow();
    const fetchMock = vi.fn().mockResolvedValue(textResponse(["data: a\n\n"]));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", reconnectOnEnd: false });
    await client.done;

    // dispatching offline after unbind must not change state (listeners removed)
    fakeWindow.dispatch("offline");
    expect(client.status).toBe("closed");
  });
});

describe("SSEClient suspend and resume", () => {
  /** Fake window + document sharing one listener registry. */
  function stubPage(hidden: boolean) {
    const listeners = new Map<string, Set<() => void>>();
    const page = {
      hidden,
      addEventListener(type: string, handler: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)!.add(handler);
      },
      removeEventListener(type: string, handler: () => void) {
        listeners.get(type)?.delete(handler);
      },
      dispatch(type: string) {
        listeners.get(type)?.forEach((handler) => handler());
      },
      show() {
        page.hidden = false;
        page.dispatch("visibilitychange");
      },
      hide() {
        page.hidden = true;
        page.dispatch("visibilitychange");
      },
    };
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", page);
    return page;
  }

  it("a client created while the page is hidden connects once it becomes visible", async () => {
    const page = stubPage(true);
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init, ["data: a\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", pauseWhenHidden: true });
    expect(client.status).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();

    page.show();
    await vi.waitFor(() => expect(client.status).toBe("open"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(false);

    client.close();
    await client.done;
  });

  it("pauseWhenHidden suspends a live connection and reconnects when visible again", async () => {
    const page = stubPage(false);
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init, ["data: a\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", pauseWhenHidden: true });
    await vi.waitFor(() => expect(client.status).toBe("open"));

    page.hide();
    expect(client.status).toBe("idle");
    // no new request is issued while hidden
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    page.show();
    await vi.waitFor(() => expect(client.status).toBe("open"));
    expect(fetchMock).toHaveBeenCalledTimes(2);

    client.close();
    await client.done;
  });

  it("offline and online in the same tick reconnect instead of closing the client", async () => {
    const page = stubPage(false);
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();

    const client = new SSEClient({ url: "/s", onClose });
    await vi.waitFor(() => expect(client.status).toBe("open"));

    // a network blip shorter than one macrotask
    page.dispatch("offline");
    page.dispatch("online");

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(client.closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    client.close();
    await client.done;
  });
});

describe("SSEClient restart", () => {
  it("reconnects instead of leaving the client closed", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(client.status).toBe("open"));

    client.restart();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(client.status).toBe("open"));
    expect(client.closed).toBe(false);

    client.close();
    await client.done;
  });

  it("keeps Last-Event-ID across a restart", async () => {
    const seen: (string | null)[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("last-event-id"));
      return Promise.resolve(hangingResponse(init, ["id: 7\ndata: a\n\n"]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(client.lastEventId).toBe("7"));

    client.restart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(seen[0]).toBeNull();
    expect(seen[1]).toBe("7");
    expect(client.lastEventId).toBe("7");

    client.close();
    await client.done;
  });

  it("close() cancels a queued restart", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(client.status).toBe("open"));

    client.restart();
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.closed).toBe(true);
    expect(client.status).toBe("closed");
  });
});

