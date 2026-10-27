import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import {
  acquireSSEClient,
  closeAllSharedSSEClients,
  deriveShareKey,
  getSharedSSEClientCount,
  useSharedSSEClient,
} from "./share";
import type { SSEGapInfo, SSEMessage, SSEResumeInfo, SSEStatus } from "./types";

afterEach(() => {
  closeAllSharedSSEClients();
  vi.useRealTimers();
});

const message = (event: string, data: unknown): SSEMessage => ({
  id: "1",
  event,
  data,
  raw: "",
  receivedAt: 0,
});

/** Reach the private dispatcher so tests do not need a real stream. */
const dispatch = (client: unknown, event: string, data: unknown) => {
  (client as { dispatch: (m: SSEMessage) => void }).dispatch(message(event, data));
};

const idleClient = () => new SSEClient({ url: "/s", autoStart: false });

describe("acquireSSEClient connection sharing", () => {
  it("reuses one connection per key and calls create once", () => {
    const create = vi.fn(() => new SSEClient({ url: "/s", autoStart: false }));

    const first = acquireSSEClient("alarm", create);
    const second = acquireSSEClient("alarm", create);

    expect(create).toHaveBeenCalledTimes(1);
    expect(first.client).toBe(second.client);
    expect(getSharedSSEClientCount()).toBe(1);
  });

  it("closes only when the reference count reaches zero", () => {
    const first = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));
    const second = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));

    first.release();
    expect(first.client.closed).toBe(false);
    expect(getSharedSSEClientCount()).toBe(1);

    second.release();
    expect(first.client.closed).toBe(true);
    expect(getSharedSSEClientCount()).toBe(0);
  });

  it("different keys are independent", () => {
    const alarm = acquireSSEClient("alarm", () => new SSEClient({ url: "/alarm", autoStart: false }));
    const iot = acquireSSEClient("iot", () => new SSEClient({ url: "/iot", autoStart: false }));

    expect(alarm.client).not.toBe(iot.client);
    expect(getSharedSSEClientCount()).toBe(2);
  });

  it("release is idempotent and cannot free another reference", () => {
    const first = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));
    const second = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));

    first.release();
    first.release();
    expect(first.client.closed).toBe(false);
    expect(getSharedSSEClientCount()).toBe(1);

    second.release();
    expect(first.client.closed).toBe(true);
  });

  it("re-creates the connection after it was released", () => {
    const first = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));
    first.release();

    const second = acquireSSEClient("alarm", () => new SSEClient({ url: "/s", autoStart: false }));
    expect(second.client).not.toBe(first.client);
    expect(second.client.closed).toBe(false);
  });
});

describe("deriveShareKey", () => {
  it("treats arrays as sets and ignores object key order", () => {
    const a = deriveShareKey({ url: "/s", body: [{ ids: [1, 2], type: "X" }] });
    const b = deriveShareKey({ url: "/s", body: [{ type: "X", ids: [2, 1] }] });

    expect(a).toBe(b);
  });

  it("keeps different subscriptions apart", () => {
    const a = deriveShareKey({ url: "/s", body: [{ floorId: "F1" }] });
    const b = deriveShareKey({ url: "/s", body: [{ floorId: "F2" }] });
    const c = deriveShareKey({ url: "/other", body: [{ floorId: "F1" }] });

    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("can keep array order significant", () => {
    const a = deriveShareKey({ url: "/s", body: [{ ids: [1, 2] }] });
    const b = deriveShareKey({ url: "/s", body: [{ ids: [2, 1] }] }, { sortArrays: false });

    expect(a).not.toBe(b);
    expect(b).toBe(deriveShareKey({ url: "/s", body: [{ ids: [2, 1] }] }, { sortArrays: false }));
  });

  it("separates event allow-lists", () => {
    const a = deriveShareKey({ url: "/s", events: ["A"] });
    const b = deriveShareKey({ url: "/s", events: ["A", "B"] });

    expect(a).not.toBe(b);
  });
});

describe("useSharedSSEClient", () => {
  it("buffers listeners until configure, then delivers to them", () => {
    const create = vi.fn(idleClient);
    const handle = useSharedSSEClient({ create });
    const received: unknown[] = [];

    handle.on("A", (data) => received.push(data));
    expect(handle.configured).toBe(false);
    expect(handle.client).toBeNull();
    expect(handle.status).toBe("idle");
    expect(create).not.toHaveBeenCalled();

    const key = handle.configure({ url: "/s" });
    expect(key).toBe(handle.key);
    expect(handle.configured).toBe(true);

    dispatch(handle.client, "A", { v: 1 });
    expect(received).toEqual([{ v: 1 }]);
    handle.release();
  });

  it("does nothing when configured twice with the same subscription", () => {
    const create = vi.fn(idleClient);
    const handle = useSharedSSEClient({ create });

    handle.configure({ url: "/s", body: [{ ids: [1, 2] }] });
    const first = handle.client;
    handle.configure({ url: "/s", body: [{ ids: [2, 1] }] });

    expect(create).toHaveBeenCalledTimes(1);
    expect(handle.client).toBe(first);
    handle.release();
  });

  it("moves listeners to the new connection and releases the old one", () => {
    const create = vi.fn(idleClient);
    const handle = useSharedSSEClient({ create });
    const received: unknown[] = [];

    handle.on("A", (data) => received.push(data));
    handle.configure({ url: "/s", body: [{ floorId: "F1" }] });
    const first = handle.client;

    handle.configure({ url: "/s", body: [{ floorId: "F2" }] });
    const second = handle.client;

    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);
    expect(getSharedSSEClientCount()).toBe(1);

    dispatch(first, "A", "stale");
    expect(received).toEqual([]);
    dispatch(second, "A", "fresh");
    expect(received).toEqual(["fresh"]);
    handle.release();
  });

  it("moves to an existing connection instead of opening a duplicate", () => {
    const create = vi.fn(idleClient);
    const a = useSharedSSEClient({ create });
    const b = useSharedSSEClient({ create });

    a.configure({ url: "/s", body: [{ floorId: "F1" }] });
    b.configure({ url: "/s", body: [{ floorId: "F1" }] });
    expect(create).toHaveBeenCalledTimes(1);

    b.configure({ url: "/s", body: [{ floorId: "F2" }] });
    expect(create).toHaveBeenCalledTimes(2);

    // a is untouched by b's switch: its client is still open and delivering
    expect(a.client?.closed).toBe(false);
    const received: unknown[] = [];
    a.on("A", (data) => received.push(data));
    dispatch(a.client, "A", 1);
    expect(received).toEqual([1]);

    a.release();
    b.release();
  });

  it("keeps the connection open during the grace period", () => {
    vi.useFakeTimers();
    const create = vi.fn(idleClient);
    const first = useSharedSSEClient({ create, grace: 5000 });
    first.configure({ url: "/s" });
    const client = first.client;
    first.release();

    expect(client?.closed).toBe(false);
    expect(getSharedSSEClientCount()).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(client?.closed).toBe(true);
    expect(getSharedSSEClientCount()).toBe(0);
  });

  it("a remount during the grace period reuses the connection", () => {
    vi.useFakeTimers();
    const create = vi.fn(idleClient);
    const first = useSharedSSEClient({ create, grace: 5000 });
    first.configure({ url: "/s" });
    const client = first.client;
    first.release();

    const second = useSharedSSEClient({ create, grace: 5000 });
    second.configure({ url: "/s" });

    expect(create).toHaveBeenCalledTimes(1);
    expect(second.client).toBe(client);
    expect(client?.closed).toBe(false);

    vi.advanceTimersByTime(5000);
    expect(client?.closed).toBe(false);
    second.release();
  });

  it("unsubscribing stops delivery and release is idempotent", () => {
    const handle = useSharedSSEClient({ create: idleClient });
    const received: unknown[] = [];

    const off = handle.on("A", (data) => received.push(data));
    handle.configure({ url: "/s" });
    dispatch(handle.client, "A", 1);
    off();
    dispatch(handle.client, "A", 2);
    expect(received).toEqual([1]);

    const client = handle.client;
    handle.release();
    handle.release();
    expect(client?.closed).toBe(true);
  });

  it("ignores configure and subscriptions after release", () => {
    const create = vi.fn(idleClient);
    const handle = useSharedSSEClient({ create });
    handle.release();

    expect(handle.configure({ url: "/s" })).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(handle.on("A", () => {})).toBeTypeOf("function");
  });

  /** Minimal client stub: only the two continuity channels these tests exercise. */
  function signalClient() {
    const gaps = new Set<(info: SSEGapInfo) => void>();
    const resumes = new Set<(info: SSEResumeInfo) => void>();
    return {
      status: "idle" as SSEStatus,
      closed: false,
      close() {},
      onSuspectGap(handler: (info: SSEGapInfo) => void) {
        gaps.add(handler);
        return () => gaps.delete(handler);
      },
      onResume(handler: (info: SSEResumeInfo) => void) {
        resumes.add(handler);
        return () => resumes.delete(handler);
      },
      emitGap(info: SSEGapInfo) {
        for (const handler of [...gaps]) {
          handler(info);
        }
      },
      emitResume(info: SSEResumeInfo) {
        for (const handler of [...resumes]) {
          handler(info);
        }
      },
    };
  }

  it("delivers gap and resume reports from the client it ends up on", () => {
    const created: ReturnType<typeof signalClient>[] = [];
    const create = vi.fn(() => {
      const stub = signalClient();
      created.push(stub);
      return stub as unknown as SSEClient;
    });
    const handle = useSharedSSEClient({ create });
    const gaps: SSEGapInfo[] = [];
    const resumes: SSEResumeInfo[] = [];

    // Bound before `configure`: the handle has no client yet.
    handle.onSuspectGap((info) => gaps.push(info));
    handle.onResume((info) => resumes.push(info));

    handle.configure({ url: "/s", body: [{ floorId: "F1" }] });
    const first = created[0]!;
    first.emitGap({ reason: "reconnect", lastId: "1", attempt: 1 });
    first.emitResume({ lastId: "1", firstId: "2", skipped: 1, continuous: true, attempt: 1 });

    expect(gaps).toEqual([{ reason: "reconnect", lastId: "1", attempt: 1 }]);
    expect(resumes).toEqual([
      { lastId: "1", firstId: "2", skipped: 1, continuous: true, attempt: 1 },
    ]);

    // A different subscription swaps the client; the subscription has to follow it,
    // otherwise the consumer stays attached to a connection nobody reads.
    handle.configure({ url: "/s", body: [{ floorId: "F2" }] });
    const second = created[1]!;
    first.emitGap({ reason: "reconnect", lastId: "2", attempt: 2 });
    second.emitGap({ reason: "resume", lastId: "3", attempt: 0 });

    expect(gaps).toHaveLength(2);
    expect(gaps[1]).toEqual({ reason: "resume", lastId: "3", attempt: 0 });
    handle.release();
  });

  it("close releases the reference but keeps the handle reusable", () => {
    const handle = useSharedSSEClient({ create: idleClient });
    handle.configure({ url: "/s" });
    const received: unknown[] = [];
    handle.on("A", (data) => received.push(data));

    handle.close();
    expect(handle.configured).toBe(false);
    expect(getSharedSSEClientCount()).toBe(0);

    handle.configure({ url: "/s" });
    dispatch(handle.client, "A", "again");
    expect(received).toEqual(["again"]);
    handle.release();
  });
});
