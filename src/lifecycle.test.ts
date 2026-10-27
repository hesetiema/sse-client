import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";

function hangingResponse(init: RequestInit): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      init.signal?.addEventListener("abort", () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
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
});

describe("start / close ordering", () => {
  it("reconnects when start() follows close() in the same tick", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    client.close();
    // The loop has not unwound yet: this used to be a silent no-op.
    client.start();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(client.closed).toBe(false);
    client.close();
  });

  it("restart() keeps the resume point", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", resumeFrom: "7" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    client.restart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const headers = fetchMock.mock.calls[1]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("7");
    client.close();
  });

  it("ignores repeated start() while already running", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    client.start();
    client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    client.close();
  });

  it("does not resurrect a client closed while suspended", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", pauseWhenHidden: true });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // `offline` is observed through window events, which do not exist in Node;
    // simulate the state the same way the lifecycle listener would.
    (client as unknown as { suspend: (reason: string) => void }).suspend("offline");
    client.close();
    expect(client.closed).toBe(true);

    client.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(client.closed).toBe(false);
    client.close();
  });
});
