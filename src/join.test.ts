import { afterEach, describe, expect, it, vi } from "vitest";
import { JOIN_START_OFFSET, createJoinClient, deriveJoinUrl } from "./join";

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

describe("deriveJoinUrl", () => {
  it("adds the start offset and the run id", () => {
    expect(deriveJoinUrl("/api/chat", { runId: "r9" })).toBe(
      `/api/chat?offset=${JOIN_START_OFFSET}&runId=r9`,
    );
  });

  it("keeps existing query parameters and the hash fragment", () => {
    expect(deriveJoinUrl("/api/chat?tenant=t1#log", { runId: "r9" })).toBe(
      `/api/chat?tenant=t1&offset=${JOIN_START_OFFSET}&runId=r9#log`,
    );
  });

  it("honours a backend that spells its parameters differently", () => {
    expect(
      deriveJoinUrl("/api/chat", {
        runId: "r9",
        params: { offset: "from", runId: "run" },
        startOffset: "0",
      }),
    ).toBe("/api/chat?from=0&run=r9");
  });

  it("replaces a parameter that is already on the url instead of repeating it", () => {
    expect(deriveJoinUrl("/api/chat?runId=stale", { runId: "r9" })).toBe(
      `/api/chat?runId=r9&offset=${JOIN_START_OFFSET}`,
    );
  });
});

describe("createJoinClient", () => {
  it("replays over a read-only GET and hands the tail back", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(sseResponse("id: 1\ndata: a\n\nid: 3\ndata: c\n\n")),
    );
    vi.stubGlobal("fetch", fetchMock);

    const received: string[] = [];
    const { client, done } = createJoinClient({
      url: "/api/chat?tenant=t1",
      join: { runId: "r9" },
      // A live client would be resuming from here; a from-start join must not.
      resume: { from: "5" },
      request: { headers: { Authorization: "Bearer t" } },
    });
    client.onMessage((message) => received.push(`${message.id}:${message.data}`));

    await expect(done).resolves.toBe("3");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/chat?tenant=t1&offset=-1&runId=r9");
    expect(init!.method).toBe("GET");
    // Asking for an offset and a cursor in the same request lets the server pick.
    expect((init!.headers as Headers).get("Last-Event-ID")).toBeNull();
    expect((init!.headers as Headers).get("Authorization")).toBe("Bearer t");
    expect(init!.body).toBeUndefined();

    expect(received).toEqual(["1:a", "3:c"]);
    // A replay is finite: it ends instead of reconnecting past the last offset.
    expect(client.closed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves done with an empty string when the server sends no ids", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse("data: a\n\n"))));

    const { done } = createJoinClient({ url: "/api/chat", join: { runId: "r9" } });

    // Without ids there is nothing to continue from: the snapshot is the truth.
    await expect(done).resolves.toBe("");
  });

  it("leaves the live subscription's stored resume point alone", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(sseResponse("id: 2\ndata: b\n\n"))));

    const entries = new Map<string, string>([["chat", "1"]]);
    const storage = {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      },
    };

    const { done } = createJoinClient({
      url: "/api/chat",
      join: { runId: "r9" },
      resume: { persist: "chat", storage },
    });

    await expect(done).resolves.toBe("2");
    // A replay is a reader, not the owner: `done` is the only handover, so the
    // live client's stored position is neither advanced nor cleared.
    expect(entries.get("chat")).toBe("1");
  });

  it("starts on its own even when the caller asks it not to", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(sseResponse("id: 1\ndata: a\n\n")));
    vi.stubGlobal("fetch", fetchMock);

    const { done } = createJoinClient({ url: "/api/chat", join: { runId: "r9" }, autoStart: false });

    await expect(done).resolves.toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
