import { afterEach, describe, expect, it, vi } from "vitest";
import { createMultiTabSSE, type LockRequester, type MultiTabRole } from "./multi-tab";
import type { SSEGapInfo, SSEMessage, SSEResumeInfo } from "./types";

const encoder = new TextEncoder();

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

/** Emits the chunks and then ends the response normally. */
function closedResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** FIFO exclusive lock: the second tab waits until the first one releases. */
function createFakeLocks(): LockRequester {
  let held = false;
  const queue: (() => void)[] = [];
  return (_name, hold) =>
    new Promise<void>((resolve) => {
      const run = () => {
        held = true;
        void hold().finally(() => {
          held = false;
          const next = queue.shift();
          if (next) {
            next();
          }
          resolve();
        });
      };
      if (held) {
        queue.push(run);
      } else {
        run();
      }
    });
}

const opened: (() => void)[] = [];

function newTab<T extends object>(
  channel: string,
  locks: LockRequester,
  options: Record<string, unknown> = {},
) {
  const tab = createMultiTabSSE<T>(
    { url: "/s", channel, parse: (raw) => JSON.parse(raw), ...options },
    { requestLock: locks, createChannel: (name) => new BroadcastChannel(name) },
  );
  opened.push(tab.close);
  return tab;
}

afterEach(() => {
  for (const close of opened.splice(0)) {
    close();
  }
  vi.unstubAllGlobals();
});

describe("createMultiTabSSE", () => {
  it("connects once and relays messages to the follower tab", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(
        openResponse(init, ['id: 7\nevent: IOT\ndata: {"v":1}\n\n']),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const locks = createFakeLocks();
    const channel = `mt-relay-${Math.random()}`;
    // Start paused so the follower exists before the first byte arrives; a tab
    // that joins later legitimately misses what was already relayed.
    const leader = newTab<{ IOT: { v: number } }>(channel, locks, { autoStart: false });
    const follower = newTab<{ IOT: { v: number } }>(channel, locks, { autoStart: false });

    expect(leader.role).toBe("leader");
    expect(follower.role).toBe("follower");
    expect(follower.client).toBeNull();

    const followerMessages: SSEMessage[] = [];
    follower.onMessage((message) => followerMessages.push(message));

    leader.start();
    await vi.waitFor(() => expect(followerMessages).toHaveLength(1));
    expect(followerMessages[0]!.data).toEqual({ v: 1 });
    expect(follower.lastEventId).toBe("7");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("attributes events on the follower like a local client would", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        Promise.resolve(openResponse(init, ['event: IOT\ndata: {"v":2}\n\n'])),
      ),
    );

    const locks = createFakeLocks();
    const channel = `mt-events-${Math.random()}`;
    const leader = newTab(channel, locks, { autoStart: false });
    const follower = newTab<{ IOT: { v: number } }>(channel, locks, { autoStart: false });

    const seen: number[] = [];
    follower.on("IOT", (point) => seen.push(point.v));
    follower.on("*", () => seen.push(-1));

    leader.start();
    await vi.waitFor(() => expect(seen).toEqual([2, -1]));
  });

  it("promotes a follower when the leader closes, resuming from the relayed id", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init, ['id: 41\ndata: {"a":1}\n\n'])),
    );
    vi.stubGlobal("fetch", fetchMock);

    const locks = createFakeLocks();
    const channel = `mt-failover-${Math.random()}`;
    const leader = newTab(channel, locks, { autoStart: false });
    // The follower keeps the default `autoStart`, so promotion connects on its own.
    const follower = newTab(channel, locks);

    const roles: MultiTabRole[] = [];
    const gaps: SSEGapInfo[] = [];
    follower.onRole((role) => roles.push(role));
    follower.onSuspectGap((info) => gaps.push(info));

    leader.start();
    await vi.waitFor(() => expect(follower.lastEventId).toBe("41"));

    leader.close();
    await vi.waitFor(() => expect(follower.role).toBe("leader"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const headers = fetchMock.mock.calls[1]![1].headers as Headers;
    expect(headers.get("Last-Event-ID")).toBe("41");

    // A takeover leaves a window with no connection at all: the app must hear about it.
    expect(roles).toEqual(["leader"]);
    expect(gaps).toContainEqual({ reason: "promote", lastId: "41", attempt: 0 });
  });

  it("relays the leader's gap signal to the followers", async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      calls += 1;
      return Promise.resolve(
        calls === 1 ? closedResponse(['id: 5\ndata: {"a":1}\n\n']) : openResponse(init),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const locks = createFakeLocks();
    const channel = `mt-gap-${Math.random()}`;
    const leader = newTab(channel, locks, { autoStart: false, retry: () => 0 });
    const follower = newTab(channel, locks, { autoStart: false });

    const gaps: SSEGapInfo[] = [];
    follower.onSuspectGap((info) => gaps.push(info));

    leader.start();
    await vi.waitFor(() => expect(gaps).toHaveLength(1));
    expect(gaps[0]).toMatchObject({ reason: "reconnect", lastId: "5" });
  });

  it("relays the leader's resume report to the followers", async () => {
    let calls = 0;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? closedResponse(['id: 5\ndata: {"a":1}\n\n'])
          : openResponse(init, ['id: 7\ndata: {"a":2}\n\n']),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const locks = createFakeLocks();
    const channel = `mt-resume-${Math.random()}`;
    const leader = newTab(channel, locks, { autoStart: false, retry: () => 0 });
    const follower = newTab(channel, locks, { autoStart: false });

    const resumes: SSEResumeInfo[] = [];
    follower.onResume((info) => resumes.push(info));

    leader.start();
    await vi.waitFor(() => expect(resumes).toHaveLength(1));
    expect(resumes[0]).toMatchObject({
      lastId: "5",
      firstId: "7",
      skipped: 2,
      continuous: false,
    });
  });

  it("falls back to one connection per tab without a lock manager", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      Promise.resolve(openResponse(init)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tab = createMultiTabSSE({ url: "/s" }, { requestLock: null });
    opened.push(tab.close);

    expect(tab.role).toBe("solo");
    expect(tab.client).not.toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("close() is idempotent", () => {
    const tab = createMultiTabSSE({ url: "/s" }, { requestLock: null });
    expect(tab.role).toBe("solo");
    tab.close();
    tab.close();
    expect(tab.client).toBeNull();
  });
});
