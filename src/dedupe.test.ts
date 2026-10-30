import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";

const encoder = new TextEncoder();

function sseResponse(body: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
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

describe("resume.dedupe", () => {
  it("is off by default: a replay is reported, not dropped", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse("id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 2\ndata: b\n\n"))),
    );

    const received: string[] = [];
    const client = new SSEClient({ url: "/s", autoStart: false });
    client.onMessage((message) => received.push(`${message.id}:${message.data}`));
    client.start();

    await vi.waitFor(() => expect(received).toHaveLength(3));
    client.close();

    expect(received).toEqual(["1:a", "2:b", "2:b"]);
    expect(client.duplicates).toBe(0);
  });

  it("drops an event whose id was already dispatched", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse("id: 1\ndata: a\n\nid: 2\ndata: b\n\nid: 2\ndata: b\n\n"))),
    );

    const received: string[] = [];
    const client = new SSEClient({ url: "/s", resume: { dedupe: true }, autoStart: false });
    client.onMessage((message) => received.push(`${message.id}:${message.data}`));
    client.start();

    await vi.waitFor(() => expect(client.duplicates).toBe(1));
    client.close();

    expect(received).toEqual(["1:a", "2:b"]);
    expect(client.lastEventId).toBe("2");
  });

  it("drops the replayed prefix of a reconnect", async () => {
    // The server resumed inclusively: id 2 is sent again before the new event.
    const bodies = ["id: 1\ndata: a\n\nid: 2\ndata: b\n\n", "id: 2\ndata: b\n\nid: 3\ndata: c\n\n"];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        const body = bodies[Math.min(call, bodies.length - 1)]!;
        call += 1;
        return Promise.resolve(sseResponse(body));
      }),
    );

    const received: string[] = [];
    const client = new SSEClient({
      url: "/s",
      resume: { dedupe: true },
      retry: { baseDelay: 1 },
      autoStart: false,
    });
    client.onMessage((message) => received.push(`${message.id}:${message.data}`));
    client.start();

    await vi.waitFor(() => expect(received).toHaveLength(3));
    client.close();

    expect(received).toEqual(["1:a", "2:b", "3:c"]);
    expect(client.duplicates).toBe(1);
  });

  it("still verifies the resume point for a suppressed first event", async () => {
    // The dedupe must not hide the `skipped === 0` report: it is the only signal
    // that says the server resumed inclusively rather than from the right place.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse("id: 1\ndata: a\n\nid: 2\ndata: b\n\n"))),
    );

    const skipped: Array<number | undefined> = [];
    const client = new SSEClient({ url: "/s", resume: { from: "1", dedupe: true }, autoStart: false });
    client.onResume((info) => skipped.push(info.skipped));
    client.start();

    await vi.waitFor(() => expect(client.lastEventId).toBe("2"));
    client.close();

    // The first identified event is id 1, which is exactly the point sent: replayed.
    expect(skipped).toEqual([0]);
    // Nothing was suppressed here: this instance never dispatched id 1 itself, the
    // seed came from a previous page load.
    expect(client.duplicates).toBe(0);
  });
});
