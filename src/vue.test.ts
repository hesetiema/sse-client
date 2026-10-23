import { effectScope } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSSE } from "./vue";

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
});

describe("useSSE", () => {
  it("dispatches messages into refs and cleans up on scope dispose", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(hangingResponse(init, ['event: A\ndata: {"v":1}\n\n'])),
      ),
    );

    const scope = effectScope();
    const received: number[] = [];
    // on() must be called during setup so it is unsubscribed with the scope
    const result = scope.run(() => {
      const view = useSSE<{ A: { v: number } }>({
        url: "/s",
        parse: (raw) => JSON.parse(raw),
      });
      view.on("A", (payload) => received.push(payload.v));
      return view;
    });
    expect(result).toBeDefined();
    const { client, status, lastEvent, error } = result!;

    await vi.waitFor(() => expect(lastEvent.value?.data).toEqual({ v: 1 }));
    expect(status.value).toBe("open");
    expect(error.value).toBeNull();
    expect(received).toEqual([1]);

    scope.stop();
    expect(client.closed).toBe(true);

    // the subscription is gone after the scope is disposed
    const clientHandlers = (client as unknown as { eventHandlers: Map<string, Set<unknown>> })
      .eventHandlers;
    expect(clientHandlers.get("A")?.size ?? 0).toBe(0);
  });

  it("maxEvents caps the ring buffer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(
          hangingResponse(init, ["data: 1\n\n", "data: 2\n\n", "data: 3\n\n"]),
        ),
      ),
    );

    const scope = effectScope();
    const { events } = scope.run(() => useSSE({ url: "/s", maxEvents: 2 }))!;

    await vi.waitFor(() => expect(events.value).toHaveLength(2));
    expect(events.value.map((message) => message.data)).toEqual(["2", "3"]);
    scope.stop();
  });
});
