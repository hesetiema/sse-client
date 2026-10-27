import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { deriveShareKey } from "./share";

const encoder = new TextEncoder();

/** Live response: stays open until the request is aborted. */
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
          // already closed
        }
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("request options", () => {
  it("defaults credentials to same-origin and accepts an override", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe("same-origin");
    client.close();

    const crossOrigin = new SSEClient({ url: "/s", credentials: "include" });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect((fetchMock.mock.calls[1][1] as RequestInit).credentials).toBe("include");
    crossOrigin.close();
  });

  it("re-evaluates a body factory on every reconnect", async () => {
    let floorId = "F1";
    const bodies: unknown[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(hangingResponse(init));
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", body: () => [{ floorId }] });
    await vi.waitFor(() => expect(bodies.length).toBe(1));
    expect(bodies[0]).toEqual([{ floorId: "F1" }]);

    floorId = "F2";
    client.restart();
    await vi.waitFor(() => expect(bodies.length).toBe(2));
    expect(bodies[1]).toEqual([{ floorId: "F2" }]);
    client.close();
  });

  it("appends valueless query flags without disturbing the rest of the URL", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const plain = new SSEClient({ url: "/push/subscribe", flags: ["GRID_MAP"] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(plain.url).toBe("/push/subscribe?GRID_MAP");
    expect(fetchMock.mock.calls[0][0]).toBe("/push/subscribe?GRID_MAP");
    plain.close();

    const withQuery = new SSEClient({ url: "/push?a=1#frag", flags: ["?GRID_MAP"] });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(withQuery.url).toBe("/push?a=1&GRID_MAP#frag");
    withQuery.close();
  });
});

describe("plugins", () => {
  it("runs plugins, keeps them isolated and tears them down on close", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const teardown = vi.fn();
    const seen: string[] = [];
    const client = new SSEClient({ url: "/s" });

    client.use(instance => {
      seen.push(instance.status);
      instance.onStatus(status => seen.push(status));
      return teardown;
    });
    // A broken plugin must not prevent the connection.
    client.use(() => {
      throw new Error("broken plugin");
    });

    await vi.waitFor(() => expect(client.status).toBe("open"));
    client.close();

    expect(seen[0]).toBe("connecting");
    expect(seen).toContain("open");
    expect(teardown).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("routes plugin failures through onHandlerError instead of the console", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onHandlerError = vi.fn();
    const client = new SSEClient({ url: "/s", onHandlerError });

    client.use(() => {
      throw new Error("setup boom");
    });
    client.use(() => () => {
      throw new Error("teardown boom");
    });

    await vi.waitFor(() => expect(client.status).toBe("open"));
    client.close();

    expect(onHandlerError).toHaveBeenCalledTimes(2);
    expect(onHandlerError.mock.calls.map(([error]) => (error as Error).message)).toEqual([
      "setup boom",
      "teardown boom",
    ]);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

describe("share keys", () => {
  it("includes flags and resolves body factories", () => {
    const base = deriveShareKey({ url: "/s", body: { a: 1 } });
    const viaFactory = deriveShareKey({ url: "/s", body: () => ({ a: 1 }) });
    expect(viaFactory).toBe(base);

    const withFlag = deriveShareKey({ url: "/s", body: { a: 1 }, flags: ["GRID_MAP"] });
    expect(withFlag).not.toBe(base);

    const changedFilter = deriveShareKey({ url: "/s", body: () => ({ a: 2 }) });
    expect(changedFilter).not.toBe(base);
  });
});
