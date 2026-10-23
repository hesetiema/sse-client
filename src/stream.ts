import { SSEError } from "./errors.js";
import { createSSEParser } from "./parser.js";
import type { SSEMessage } from "./types.js";

export interface SSEMessageStreamOptions<T = unknown> {
  /** Payload decoder, e.g. `(raw) => JSON.parse(raw)`. */
  parse?: (raw: string) => T;
  /** Buffer cap in characters for a single message (default 1MB). */
  maxBufferSize?: number;
}

/**
 * Turn a byte stream into a message stream using Web Streams composition —
 * the same shape as AI SDK's `parseJsonEventStream`.
 *
 * Useful when `SSEClient` is not involved: custom transports, Service Workers,
 * edge runtimes. A parse failure (buffer overflow) errors the stream and the
 * consumer decides whether to retry.
 *
 * ```ts
 * const response = await fetch(url, { headers });
 * const reader = response.body!
 *   .pipeThrough(createSSEMessageStream({ parse: JSON.parse }))
 *   .getReader();
 * ```
 */
export function createSSEMessageStream<T = unknown>(
  options: SSEMessageStreamOptions<T> = {},
): TransformStream<Uint8Array, SSEMessage<T>> {
  const decoder = new TextDecoder("utf-8");
  let controller: TransformStreamDefaultController<SSEMessage<T>>;

  const parser = createSSEParser({
    maxBufferSize: options.maxBufferSize,
    onEvent: (event) => {
      let data: unknown = event.data;
      if (options.parse) {
        try {
          data = options.parse(event.data);
        } catch (error) {
          // Drop only this message; the stream keeps flowing.
          console.error("[sse-client] failed to parse message, skipping it", error);
          return;
        }
      }
      controller.enqueue({
        id: event.id,
        event: event.event || "message",
        data: data as T,
        raw: event.data,
        receivedAt: Date.now(),
      });
    },
    onRetry: () => {
      // The plain message stream does not reconnect; `retry:` is handled by SSEClient.
    },
  });

  return new TransformStream<Uint8Array, SSEMessage<T>>({
    start(streamController) {
      controller = streamController;
    },
    transform(chunk) {
      parser.feed(decoder.decode(chunk, { stream: true }));
      if (parser.overflowed) {
        throw new SSEError("SSE buffer size limit exceeded", {
          kind: "protocol",
          retryable: false,
        });
      }
    },
    flush() {
      parser.feed(decoder.decode());
    },
  });
}
