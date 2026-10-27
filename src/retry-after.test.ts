import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import type { RetryContext } from "./client";

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

function rateLimited(retryAfter: string): Response {
  return new Response(null, {
    status: 429,
    headers: { "Retry-After": retryAfter },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Retry-After", () => {
  it("exposes the hint to a custom retry policy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited("1"))),
    );

    const contexts: RetryContext[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: (context) => {
        contexts.push(context);
        return false;
      },
    });

    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]!.error?.status).toBe(429);
    expect(contexts[0]!.error?.retryAfter).toBe(1000);
    expect(client.closed).toBe(true);
  });

  it("accepts an HTTP date", async () => {
    const at = new Date(Date.now() + 3_000).toUTCString();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited(at))),
    );

    const contexts: RetryContext[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: (context) => {
        contexts.push(context);
        return false;
      },
    });

    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]!.error?.retryAfter).toBeGreaterThan(2_000);
    expect(contexts[0]!.error?.retryAfter).toBeLessThanOrEqual(3_000);
    client.close();
  });

  it("takes precedence over the backoff base delay", async () => {
    const stamps: number[] = [];
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      stamps.push(Date.now());
      return Promise.resolve(
        stamps.length === 1 ? rateLimited("0") : hangingResponse(init),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", retryBaseDelay: 5_000 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    // Clamped to the 200ms floor, but far below the 5s exponential base delay.
    expect(stamps[1]! - stamps[0]!).toBeLessThan(1_000);
    client.close();
  });

  it("ignores an unparsable header and falls back to backoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(rateLimited("soon-ish"))),
    );

    const contexts: RetryContext[] = [];
    const client = new SSEClient({
      url: "/s",
      retry: (context) => {
        contexts.push(context);
        return false;
      },
    });

    await vi.waitFor(() => expect(contexts).toHaveLength(1));
    expect(contexts[0]!.error?.retryAfter).toBeUndefined();
    client.close();
  });
});
