import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import type { SSEGapInfo } from "./types";

const encoder = new TextEncoder();

/** Emits the chunks and then ends the response normally. */
function closedResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** Emits the chunks and keeps the stream open until the request is aborted. */
function openResponse(init: RequestInit, chunks: string[] = []): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onSuspectGap", () => {
  it("reports a reconnect once, with the resume point it will send", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(closedResponse(["id: 5\ndata: x\n\n"]))
      .mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(openResponse(init)),
      );
    vi.stubGlobal("fetch", fetchMock);

    const gaps: SSEGapInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: () => 0,
      onSuspectGap: (info) => gaps.push(info),
    });

    await vi.waitFor(() => expect(gaps).toHaveLength(1));
    expect(gaps[0]).toMatchObject({ reason: "reconnect", lastId: "5", attempt: 1 });

    // The retry opened and stays open: an episode reports once, not per chunk.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await wait(50);
    expect(gaps).toHaveLength(1);

    client.close();
  });

  it("stays silent when no id ever arrived (nothing to resume from)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(closedResponse(["data: x\n\n"]))
      .mockImplementation((_url: string, init: RequestInit) =>
        Promise.resolve(openResponse(init)),
      );
    vi.stubGlobal("fetch", fetchMock);

    const gaps: SSEGapInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: () => 0,
      onSuspectGap: (info) => gaps.push(info),
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await wait(50);
    expect(gaps).toHaveLength(0);
    client.close();
  });

  it("reports a dropped message even without an id, because that is real data loss", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(openResponse(init, ["data: 0123456789\n\n", "data: ok\n\n"])),
      ),
    );

    const gaps: SSEGapInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      maxBufferSize: 8,
      overflowPolicy: "drop",
      onSuspectGap: (info) => gaps.push(info),
    });

    await vi.waitFor(() => expect(client.dropped).toBe(1));
    expect(gaps[0]).toMatchObject({ reason: "drop", lastId: "" });

    client.close();
  });

  it("setResumePoint redirects the next connection", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", resumeFrom: "1" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    client.setResumePoint("99");
    client.restart();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const headers = fetchMock.mock.calls[1]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("99");
    client.close();
  });
});
