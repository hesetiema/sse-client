import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { isValidEventId } from "./id";
import type { SSEGapInfo } from "./types";
import type { ResumeStorage } from "./resume";

const encoder = new TextEncoder();

function sseResponse(body: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
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

describe("isValidEventId", () => {
  it("accepts opaque server-owned ids", () => {
    expect(isValidEventId("42")).toBe(true);
    expect(isValidEventId("memory:v1:run-9/17")).toBe(true);
    expect(isValidEventId("0")).toBe(true);
  });

  it("rejects an empty id, which the spec reads as a cursor reset", () => {
    expect(isValidEventId("")).toBe(false);
  });

  it("rejects characters that cannot survive a header round trip", () => {
    expect(isValidEventId("4\n2")).toBe(false);
    expect(isValidEventId("4\r2")).toBe(false);
    expect(isValidEventId("4\u00002")).toBe(false);
  });

  it("rejects whitespace every hop would trim", () => {
    expect(isValidEventId(" 42")).toBe(false);
    expect(isValidEventId("42 ")).toBe(false);
    expect(isValidEventId("\t42")).toBe(false);
  });
});

describe("an id the resume cursor cannot carry", () => {
  it("is refused, and the message is delivered under the previous id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse("id: 1\ndata: a\n\nid: 42 \ndata: b\n\n"))),
    );

    const gaps: SSEGapInfo[] = [];
    const received: string[] = [];
    const client = new SSEClient({ url: "/s", autoStart: false });
    client.onSuspectGap((info) => gaps.push(info));
    client.onMessage((message) => received.push(`${message.id}:${message.data}`));
    client.start();

    await vi.waitFor(() => expect(received).toHaveLength(2));
    client.close();

    expect(received).toEqual(["1:a", "1:b"]);
    // The position never advanced: a resume from "42 " would be unmatched by the
    // server and silently restart the stream somewhere arbitrary.
    expect(client.lastEventId).toBe("1");
    expect(client.invalidIds).toBe(1);
    // Reported through its own slot, so it cannot mask the `reconnect` gap that
    // follows the closed stream.
    const idGaps = gaps.filter((info) => info.reason === "id");
    expect(idGaps).toHaveLength(1);
    expect(idGaps[0]).toMatchObject({ lastId: "1" });
  });

  it("is reported once per client, not once per event", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(sseResponse("id: a \ndata: 1\n\nid: b \ndata: 2\n\n"))),
    );

    const gaps: SSEGapInfo[] = [];
    const client = new SSEClient({ url: "/s", autoStart: false });
    client.onSuspectGap((info) => gaps.push(info));
    client.start();

    await vi.waitFor(() => expect(client.invalidIds).toBe(2));
    client.close();

    expect(gaps).toHaveLength(1);
  });

  it("cannot be installed with setResumePoint", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse("")));
    vi.stubGlobal("fetch", fetchMock);

    const client = new SSEClient({ url: "/s", resumeFrom: "7", autoStart: false });
    client.setResumePoint("8 ");
    client.setResumePoint("9");

    expect(client.invalidIds).toBe(1);
    expect(client.lastEventId).toBe("7");

    // The accepted point is the one the next request carries; the refused one
    // never reaches the wire.
    client.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("9");
    client.close();
  });

  it("is dropped from a stored resume point instead of poisoning every reconnect", () => {
    const storage = memoryStorage();
    // A proxy that re-serialised the header, or a hand-edited sessionStorage.
    storage.setItem("alarm", " 100 ");

    const client = new SSEClient({
      url: "/s",
      persistKey: "alarm",
      persistStorage: storage,
      autoStart: false,
    });

    expect(client.lastEventId).toBe("");
    expect(client.invalidIds).toBe(1);
    client.close();
  });
});
