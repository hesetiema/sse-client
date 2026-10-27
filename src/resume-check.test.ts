import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import type { SSEResumeInfo } from "./types";

const encoder = new TextEncoder();

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("onResume", () => {
  it("proves a continuous resume when ids advance by one", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(closedResponse(["id: 10\ndata: a\n\n"]))
        .mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(openResponse(init, ["id: 11\ndata: b\n\n"])),
        ),
    );

    const infos: SSEResumeInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: () => 0,
      onResume: (info) => infos.push(info),
    });

    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ lastId: "10", firstId: "11", skipped: 1, continuous: true });
    client.close();
  });

  it("reports the hole when the server ignored Last-Event-ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(closedResponse(["id: 10\ndata: a\n\n"]))
        .mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(openResponse(init, ["id: 99\ndata: b\n\n"])),
        ),
    );

    const infos: SSEResumeInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: () => 0,
      onResume: (info) => infos.push(info),
    });

    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ skipped: 89, continuous: false });
    client.close();
  });

  it("refuses to judge opaque ids", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(closedResponse(["id: abc\ndata: a\n\n"]))
        .mockImplementation((_url: string, init: RequestInit) =>
          Promise.resolve(openResponse(init, ["id: def\ndata: b\n\n"])),
        ),
    );

    const infos: SSEResumeInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: () => 0,
      onResume: (info) => infos.push(info),
    });

    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({
      lastId: "abc",
      firstId: "def",
      skipped: undefined,
      continuous: undefined,
    });
    client.close();
  });

  it("also verifies the very first request when resumeFrom seeded it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(openResponse(init, ["id: 6\ndata: a\n\n"])),
      ),
    );

    const infos: SSEResumeInfo[] = [];
    const client = new SSEClient({
      url: "/s",
      resumeFrom: "5",
      onResume: (info) => infos.push(info),
    });

    await vi.waitFor(() => expect(infos).toHaveLength(1));
    expect(infos[0]).toMatchObject({ lastId: "5", firstId: "6", skipped: 1, continuous: true });
    client.close();
  });

  it("stays silent when the request carried no resume point", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init, ["id: 1\ndata: a\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const infos: SSEResumeInfo[] = [];
    const client = new SSEClient({ url: "/s", onResume: (info) => infos.push(info) });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(infos).toHaveLength(0);
    client.close();
  });
});
