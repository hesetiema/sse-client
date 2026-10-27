import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SSEClientOptions } from "./client";
import { createRingBuffer } from "./ring";
import { closeAllSharedSSEClients, getSharedSSEClientCount } from "./share";
import { useSharedSSE, useSSE } from "./vue";

const encoder = new TextEncoder();

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
          // ignore: the stream may already be closed
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
  closeAllSharedSSEClients();
});

describe("useSSE", () => {
  it("dispatches messages into refs and dispose() tears everything down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(hangingResponse(init, ['event: A\ndata: {"v":1}\n\n'])),
      ),
    );

    const received: number[] = [];
    const view = useSSE<{ A: { v: number } }>({
      url: "/s",
      parse: (raw) => JSON.parse(raw),
    });
    view.on("A", (payload) => received.push(payload.v));

    await vi.waitFor(() => expect(view.lastEvent.value?.data).toEqual({ v: 1 }));
    expect(view.status.value).toBe("open");
    expect(view.error.value).toBeNull();
    expect(received).toEqual([1]);

    view.dispose();
    expect(view.client.closed).toBe(true);

    // the subscription registered through the composable is gone as well
    const clientHandlers = (
      view.client as unknown as { eventHandlers: Map<string, Set<unknown>> }
    ).eventHandlers;
    expect(clientHandlers.get("A")?.size ?? 0).toBe(0);
  });

  it("stops without losing the composable, and dispose() is idempotent", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = useSSE({ url: "/s" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.stop();
    expect(view.client.closed).toBe(true);

    // `start()` queues itself while the aborted loop is still unwinding.
    view.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.dispose();
    view.dispose();
    expect(view.client.closed).toBe(true);
  });

  it("leaves the view window to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(hangingResponse(init, ["data: 1\n\ndata: 2\n\ndata: 3\n\n"])),
      ),
    );

    // The documented composition: the hook delivers, the caller decides how much to keep.
    const ring = createRingBuffer<string>({ capacity: 2 });
    const view = useSSE({
      url: "/s",
      onMessage: (message) => ring.push(message.data as string),
    });

    await vi.waitFor(() => expect(ring.length).toBe(2));
    expect(ring.toArray()).toEqual(["2", "3"]);
    expect(ring.evicted).toBe(1);
    expect(view.lastEvent.value?.data).toBe("3");

    view.dispose();
  });

  it("shared: one connection serves two components, and one disposing keeps it", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init, ['event: A\ndata: {"v":1}\n\n'])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const viewA = useSSE<{ A: { v: number } }>({
      url: "/s",
      parse: (raw) => JSON.parse(raw),
      shared: true,
    });
    const viewB = useSSE<{ A: { v: number } }>({
      url: "/s",
      parse: (raw) => JSON.parse(raw),
      shared: true,
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(getSharedSSEClientCount()).toBe(1);

    await vi.waitFor(() => expect(viewA.lastEvent.value?.data).toEqual({ v: 1 }));
    expect(viewB.lastEvent.value?.data).toEqual({ v: 1 });
    expect(viewB.status.value).toBe("open");

    viewA.dispose();
    expect(viewA.client.closed).toBe(false);
    expect(getSharedSSEClientCount()).toBe(1);

    viewB.dispose();
    expect(viewA.client.closed).toBe(true);
    expect(getSharedSSEClientCount()).toBe(0);
  });

  it("shared: different subscriptions keep their own connection", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const viewA = useSSE({ url: "/s", body: [{ floorId: "F1" }], shared: true });
    const viewB = useSSE({ url: "/s", body: [{ floorId: "F2" }], shared: true });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(viewA.client).not.toBe(viewB.client);

    viewA.dispose();
    expect(viewA.client.closed).toBe(true);
    expect(viewB.client.closed).toBe(false);
    viewB.dispose();
  });
});

describe("useSharedSSE", () => {
  it("follows a reactive subscription", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const floor = ref("F1");
    const view = useSharedSSE({
      subscription: () => ({ url: "/s", body: [{ floorId: floor.value }] }),
    });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(view.key.value).not.toBeNull();

    floor.value = "F2";
    await nextTick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect((fetchMock.mock.calls[1]![1] as RequestInit).body).toBe(
      JSON.stringify([{ floorId: "F2" }]),
    );

    view.dispose();
    expect(getSharedSSEClientCount()).toBe(0);
  });

  it("ignores changes that do not alter the derived key", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const parser = ref<(raw: string) => unknown>((raw) => JSON.parse(raw));
    const view = useSharedSSE({ subscription: () => ({ url: "/s", parse: parser.value }) });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // `parse` is not part of the key: the same connection keeps serving.
    parser.value = (raw) => raw;
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    view.dispose();
  });

  it("stops consuming when the subscription returns null", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const subscription = ref<SSEClientOptions | null>({ url: "/s" });
    const view = useSharedSSE({ subscription: () => subscription.value });

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    subscription.value = null;
    await nextTick();

    expect(view.key.value).toBeNull();
    expect(view.status.value).toBe("idle");
    expect(getSharedSSEClientCount()).toBe(0);

    view.dispose();
  });

  it("can be pointed at a subscription manually", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(hangingResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = useSharedSSE();
    expect(view.client).toBeNull();
    expect(view.key.value).toBeNull();

    view.on("IOT", () => {});
    const key = view.configure({ url: "/s", body: [{ floorId: "F1" }] });

    expect(key).not.toBeNull();
    expect(view.key.value).toBe(key);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    view.dispose();
    expect(getSharedSSEClientCount()).toBe(0);
  });
});
