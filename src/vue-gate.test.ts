import { nextTick, ref } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllSharedSSEClients, getSharedSSEClientCount } from "./share";
import { useSharedSSE, useSSE } from "./vue";

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
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  closeAllSharedSSEClients();
});

describe("readiness gate (`when`)", () => {
  it("useSSE issues no request until the gate opens and closes when it shuts", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const ready = ref(false);
    const view = useSSE({ url: "/s", when: () => ready.value });
    await nextTick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.status.value).toBe("idle");

    ready.value = true;
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(view.status.value).toBe("open");

    ready.value = false;
    await vi.waitFor(() => expect(view.client.closed).toBe(true));
    // A shut gate is a pause, not a finished stream: same status the shared
    // flavour reports, so a template sees one state regardless of `shared`.
    expect(view.status.value).toBe("idle");
    view.dispose();
  });

  it("useSharedSSE stops consuming and releases the reference while unready", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const ready = ref(false);
    const floor = ref("F1");
    const view = useSharedSSE({
      grace: 0,
      when: () => ready.value,
      subscription: () => ({ url: `/s?floor=${floor.value}` }),
    });
    await nextTick();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.key.value).toBeNull();
    expect(getSharedSSEClientCount()).toBe(0);

    ready.value = true;
    await vi.waitFor(() => expect(view.key.value).not.toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/s?floor=F1");

    floor.value = "F2";
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/s?floor=F2");

    ready.value = false;
    await vi.waitFor(() => expect(view.key.value).toBeNull());
    expect(getSharedSSEClientCount()).toBe(0);

    view.dispose();
  });
});
