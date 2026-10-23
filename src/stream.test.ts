import { describe, expect, it, vi } from "vitest";
import { createSSEMessageStream } from "./stream";
import { SSEError } from "./errors";
import type { SSEMessage } from "./types";

const encoder = new TextEncoder();

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of stream) {
    items.push(item);
  }
  return items;
}

describe("createSSEMessageStream message stream", () => {
  it("assembles a byte stream into messages", async () => {
    const messages = await collect(
      byteStream(["event: A\ndata: 1\n\n", "data: 2\n\ndata: 3\n\n"]).pipeThrough(
        createSSEMessageStream(),
      ),
    );

    expect(messages.map((message) => [message.event, message.data])).toEqual([
      ["A", "1"],
      ["message", "2"],
      ["message", "3"],
    ]);
    expect(typeof messages[0]?.receivedAt).toBe("number");
  });

  it("supports parse and drops only the failing message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const messages = await collect(
      byteStream(['data: {"v":1}\n\n', "data: not-json\n\n", 'data: {"v":2}\n\n']).pipeThrough(
        createSSEMessageStream<{ v: number }>({ parse: (raw) => JSON.parse(raw) }),
      ),
    );

    expect(messages.map((message) => message.data.v)).toEqual([1, 2]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("errors the stream when the buffer overflows", async () => {
    const body = byteStream([`data: ${"x".repeat(64)}`]);
    const stream = body.pipeThrough(createSSEMessageStream({ maxBufferSize: 16 }));

    await expect(collect(stream as ReadableStream<SSEMessage>)).rejects.toBeInstanceOf(SSEError);
  });
});
