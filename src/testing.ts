import type { FetchLike } from "./client.js";

/**
 * Test helpers for driving the client without a server.
 *
 * The client only needs `fetch`, so a fake `fetch` is enough to reproduce every
 * scenario that matters — a reconnect, a resume, a hung gateway, a rotation —
 * in-process and deterministically, in Node or in a browser runner.
 *
 * ```ts
 * const mock = createMockSSEFetch({
 *   script: [{ event: "ALARM", data: { level: "high" }, id: "1" }],
 * });
 * const client = new SSEClient({ url: "/push", fetch: mock.fetch, reconnectOnEnd: false });
 * await client.done;
 * expect(mock.lastBody()).toEqual({ topics: ["alarm"] });
 * ```
 */

/** One frame written to the stream. */
export interface MockSSEFrame {
  /** `event:` name; defaults to the raw `data` message. */
  event?: string;
  /** Payload; objects are JSON-encoded, strings are written as-is. */
  data?: unknown;
  /** `id:` field, used for `Last-Event-ID` resume tests. */
  id?: string;
  /** Comment line, e.g. a heartbeat. */
  comment?: string;
  /** Verbatim frame text; wins over `event`/`data`/`id`. */
  raw?: string;
  /** Delay in milliseconds before this frame is written. */
  delay?: number;
}

/** Frames for one connection, or a function of the attempt (0-based). */
export type MockSSEScript = MockSSEFrame[] | ((attempt: number, request: MockSSERequest) => MockSSEFrame[]);

/** A captured request. */
export interface MockSSERequest {
  url: string;
  method: string;
  headers: Headers;
  /** JSON-parsed body when it was JSON, the raw value otherwise. */
  body: unknown;
  /** 0 for the first connection, 1 for the first reconnect, ... */
  attempt: number;
}

export interface MockSSEOptions {
  /** What to stream. Defaults to an empty stream that ends immediately. */
  script?: MockSSEScript;
  /** HTTP status, defaults to 200. */
  status?: number;
  /** Extra response headers. */
  headers?: HeadersInit;
  /** `content-type`, defaults to `text/event-stream`. */
  contentType?: string;
  /** Keep the stream open after the script ends (a live subscription). */
  keepOpen?: boolean;
  /** Never settle the request, simulating a hung gateway. */
  hang?: boolean;
}

export interface MockSSEFetch {
  /** Pass as the client's `fetch` option. */
  fetch: FetchLike;
  /** Every request the client made, in order. */
  calls: MockSSERequest[];
  /** Close every open stream gracefully. */
  close: () => void;
  /** Body of the most recent request. */
  lastBody: <T = unknown>() => T | undefined;
}

const encoder = new TextEncoder();

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Serialize a frame the way a server would. */
export function serializeFrame(frame: MockSSEFrame): string {
  if (frame.raw !== undefined) {
    return frame.raw;
  }
  const lines: string[] = [];
  if (frame.id !== undefined) {
    lines.push(`id: ${frame.id}`);
  }
  if (frame.event) {
    lines.push(`event: ${frame.event}`);
  }
  if (frame.comment) {
    lines.push(`: ${frame.comment}`);
  }
  if (frame.data !== undefined) {
    const text = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
    // One `data:` line per line of the payload. A bare newline would end the field,
    // and everything after it would be dropped as a nameless line — the mock would
    // then hide the very bug a multi-line payload is supposed to expose.
    for (const line of text.split(/\r?\n/)) {
      lines.push(`data: ${line}`);
    }
  }
  return `${lines.join("\n")}\n\n`;
}

/** Parse a request body so assertions do not have to deal with strings. */
function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    return body ?? undefined;
  }
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function createMockSSEFetch(options: MockSSEOptions = {}): MockSSEFetch {
  const { script = [], status = 200, headers, contentType = "text/event-stream", keepOpen = false, hang = false } = options;
  const calls: MockSSERequest[] = [];
  const controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();

  const fetchImpl: FetchLike = async (url, init) => {
    const attempt = calls.length;
    const request: MockSSERequest = {
      url,
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: parseBody(init.body as BodyInit | null | undefined),
      attempt,
    };
    calls.push(request);

    if (hang) {
      // A request that never settles: only an abort can end it, like a stalled gateway.
      const signal = init.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        // The client may close before the request is even issued; a listener added
        // after the fact would never fire and the promise would hang forever.
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort);
      });
    }

    const frames = typeof script === "function" ? script(attempt, request) : script;

    /** `cancel()` gets no controller, so the start callback hands it over. */
    let active: ReadableStreamDefaultController<Uint8Array> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        active = controller;
        controllers.add(controller);
        const abort = () => {
          controllers.delete(controller);
          try {
            controller.error(new DOMException("The operation was aborted.", "AbortError"));
          } catch {
            // already closed
          }
        };
        init.signal?.addEventListener("abort", abort);
        try {
          for (const frame of frames) {
            if (frame.delay) {
              await sleep(frame.delay);
            }
            if (init.signal?.aborted) {
              return;
            }
            controller.enqueue(encoder.encode(serializeFrame(frame)));
          }
          if (!keepOpen) {
            controllers.delete(controller);
            controller.close();
          }
        } catch {
          // Stream was cancelled or aborted mid-script; nothing left to do.
        }
      },
      cancel() {
        // Consumer walked away (client.close()); forget the controller so `close()`
        // does not keep a dead stream (and its buffer) alive.
        if (active) {
          controllers.delete(active);
          active = null;
        }
      },
    });

    // Merge through `Headers` instead of spreading: a `Headers` instance or a tuple
    // array spreads to nothing, which silently dropped every custom header.
    const responseHeaders = new Headers({ "Content-Type": contentType });
    new Headers(headers).forEach((value, key) => {
      responseHeaders.set(key, value);
    });

    return new Response(stream, { status, headers: responseHeaders });
  };

  const close = () => {
    for (const controller of [...controllers]) {
      controllers.delete(controller);
      try {
        controller.close();
      } catch {
        // already closed
      }
    }
  };

  return {
    fetch: fetchImpl,
    calls,
    close,
    lastBody: <T = unknown>() => calls[calls.length - 1]?.body as T | undefined,
  };
}
