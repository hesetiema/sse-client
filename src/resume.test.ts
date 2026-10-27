import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import type { ResumeStorage } from "./resume";

const encoder = new TextEncoder();

/** A stream that emits the given chunks and then blocks until the request is aborted. */
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

function memoryStorage(): ResumeStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resume point", () => {
  it("seeds the first request from resumeFrom", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", resumeFrom: "42" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("42");
    client.close();
  });

  it("picks the stored point up on the next page load", async () => {
    const storage = memoryStorage();
    storage.setItem("alarm", "100");
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({
      url: "/s",
      persistKey: "alarm",
      persistStorage: storage,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("100");
    client.close();
  });

  it("an explicit resumeFrom wins over the stored point", async () => {
    const storage = memoryStorage();
    storage.setItem("alarm", "stale");
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({
      url: "/s",
      resumeFrom: "fresh",
      persistKey: "alarm",
      persistStorage: storage,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const headers = fetchMock.mock.calls[0]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("fresh");
    client.close();
  });

  it("coalesces writes and flushes the last id on close", async () => {
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          openResponse(init, [
            "id: 1\ndata: a\n\n",
            "id: 2\ndata: b\n\n",
            "id: 3\ndata: c\n\n",
          ]),
        ),
      ),
    );

    const client = new SSEClient({ url: "/s", persistKey: "alarm", persistStorage: storage });
    await vi.waitFor(() => expect(client.lastEventId).toBe("3"));

    // Three events, one write at most: persistence must not be per message.
    expect(setItem.mock.calls.length).toBeLessThanOrEqual(1);
    expect(storage.entries.get("alarm")).toBeUndefined();

    client.close();
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(storage.entries.get("alarm")).toBe("3");
  });

  it("derives a stable key when persistKey is true", () => {
    const storage = memoryStorage();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(openResponse({}))));

    const first = new SSEClient({
      url: "/s",
      body: { topics: ["a"] },
      persistKey: true,
      persistStorage: storage,
      autoStart: false,
    });
    const second = new SSEClient({
      url: "/s",
      body: { topics: ["a"] },
      persistKey: true,
      persistStorage: storage,
      autoStart: false,
    });
    // Nothing is written before an id exists, but both instances must agree on the key,
    // which is what makes the second page load resume where the first stopped.
    expect((first as unknown as { persistKey: string }).persistKey).toBe(
      (second as unknown as { persistKey: string }).persistKey,
    );
    expect((first as unknown as { persistKey: string }).persistKey).toContain("sse-client:resume:");

    first.close();
    second.close();
  });

  it("works without a storage (SSR, sandboxed iframe)", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init, ["id: 9\ndata: x\n\n"])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", persistKey: "alarm", persistStorage: null });
    await vi.waitFor(() => expect(client.lastEventId).toBe("9"));
    client.close();
    expect(client.closed).toBe(true);
  });
});
