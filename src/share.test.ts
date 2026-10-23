import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEClient } from "./client";
import { acquireSSEClient, closeAllSharedSSEClients, getSharedSSEClientCount } from "./share";

afterEach(() => {
  closeAllSharedSSEClients();
});

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
