import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { normalizeOptions } from "./options";
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

  it("reads the same settings from the request group", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => Promise.resolve(hangingResponse(init)));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({
      url: "/s",
      request: {
        body: { topics: ["alarm"] },
        credentials: "include",
        headers: { "x-demo": "1" },
      },
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(init.body).toBe(JSON.stringify({ topics: ["alarm"] }));
    expect(new Headers(init.headers as HeadersInit).get("x-demo")).toBe("1");
    client.close();
  });
});

describe("option groups", () => {
  it("flattens every group into the single spelling the internals use", () => {
    const body = () => [{ floorId: "F1" }];
    const status = () => undefined;

    const flat = normalizeOptions({
      url: "/s",
      request: { method: "GET", body, credentials: "include", headers: { a: "b" } },
      parse: JSON.parse,
      resume: { from: "7", persist: "alarm", storage: null },
      retry: { max: 3, baseDelay: 250, maxDelay: 1_000, stableAfter: 5_000 },
      stream: {
        idleTimeout: 12_000,
        rotate: { interval: 60_000, mode: "overlap", timeout: 2_000 },
        pauseWhenHidden: true,
        endSignal: "[DONE]",
        events: ["ALARM"],
        reconnectOnEnd: false,
        strictContentType: false,
      },
      limits: { maxBufferSize: 2_048, overflowPolicy: "drop", yieldEvery: 20 },
      hooks: { status, gap: () => undefined },
      autoStart: false,
    });

    expect(flat).toMatchObject({
      url: "/s",
      method: "GET",
      credentials: "include",
      resumeFrom: "7",
      persistKey: "alarm",
      persistStorage: null,
      maxRetry: 3,
      retryBaseDelay: 250,
      retryMaxDelay: 1_000,
      stableAfter: 5_000,
      idleTimeout: 12_000,
      rotateInterval: 60_000,
      rotateMode: "overlap",
      rotateTimeout: 2_000,
      pauseWhenHidden: true,
      endSignal: "[DONE]",
      events: ["ALARM"],
      reconnectOnEnd: false,
      strictContentType: false,
      maxBufferSize: 2_048,
      overflowPolicy: "drop",
      yieldEvery: 20,
      autoStart: false,
    });
    expect(flat.body).toBe(body);
    expect(flat.parse).toBe(JSON.parse);
    expect(flat.onStatus).toBe(status);
    expect(flat.retry).toBeUndefined();
  });

  it("accepts a rotation interval as a number", () => {
    expect(normalizeOptions({ url: "/s", stream: { rotate: 30_000 } }).rotateInterval).toBe(30_000);
  });

  it("keeps a policy function and ignores the backoff knobs it owns", () => {
    const policy = () => 100;
    const flat = normalizeOptions({ url: "/s", retry: policy, maxRetry: 9 });
    expect(flat.retry).toBe(policy);
    // A flat alias still lands; the policy simply ignores it at runtime.
    expect(flat.maxRetry).toBe(9);
  });

  it("lets the group win over the deprecated flat alias", () => {
    const flat = normalizeOptions({
      url: "/s",
      credentials: "omit",
      idleTimeout: 1_000,
      onStatus: () => undefined,
      request: { credentials: "include" },
      stream: { idleTimeout: 5_000 },
    });
    expect(flat.credentials).toBe("include");
    expect(flat.idleTimeout).toBe(5_000);
  });

  it("is idempotent, so a normalised object can be normalised again", () => {
    const once = normalizeOptions({ url: "/s", stream: { idleTimeout: 3_000 } });
    expect(normalizeOptions(once)).toEqual(once);
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
  it("resolves body factories and ignores what does not reach the server", () => {
    const base = deriveShareKey({ url: "/s", body: { a: 1 } });
    const viaFactory = deriveShareKey({ url: "/s", body: () => ({ a: 1 }) });
    expect(viaFactory).toBe(base);

    const changedFilter = deriveShareKey({ url: "/s", body: () => ({ a: 2 }) });
    expect(changedFilter).not.toBe(base);

    // Nothing on the wire changes, so the decoder must not split the connection.
    const withParse = deriveShareKey({ url: "/s", body: { a: 1 }, parse: JSON.parse });
    expect(withParse).toBe(base);
  });

  it("derives one key for the grouped and the flat spelling", () => {
    const flat = deriveShareKey({ url: "/s", body: { a: 1 }, events: ["ALARM"] });
    const grouped = deriveShareKey({
      url: "/s",
      request: { body: { a: 1 } },
      stream: { events: ["ALARM"] },
    });
    expect(grouped).toBe(flat);
  });
});
