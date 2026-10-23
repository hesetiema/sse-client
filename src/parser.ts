/** A parsed event, before any payload decoding. */
export interface ParsedEvent {
  /** Event id; empty string when the server did not send one. */
  id: string;
  /** Event name; empty string when the server did not send one (callers default to "message"). */
  event: string;
  /** Raw payload text; multi-line `data:` fields are joined with a newline. */
  data: string;
}

/** Default cap for a single message buffer: 1MB. */
export const DEFAULT_MAX_BUFFER_SIZE = 1024 * 1024;

export interface SSEParserOptions {
  onEvent?: (event: ParsedEvent) => void;
  /** Reconnect delay requested by the server through a `retry:` field, in milliseconds. */
  onRetry?: (delay: number) => void;
  /** Buffer cap in characters (default 1MB). Once exceeded, parsing stops and `overflowed` flips to true. */
  maxBufferSize?: number;
}

export interface SSEParser {
  /** Feed decoded text. Chunks may split lines or fields arbitrarily; partial input is buffered. */
  feed: (chunk: string) => void;
  /** Drop any partial line and per-connection `id`/`event` state (called before a reconnect). */
  reset: () => void;
  /** Whether the buffer cap was hit (server never terminates a line, or a single message is huge). */
  readonly overflowed: boolean;
}

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Create an SSE frame parser (a subset of the WHATWG spec).
 *
 * Handles the `data` / `event` / `id` / `retry` fields, multi-line payloads,
 * comment lines (`: keep-alive` heartbeats), mixed CRLF/LF, and arbitrarily
 * chunked input.
 */
export function createSSEParser(options: SSEParserOptions = {}): SSEParser {
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

  let buffer = "";
  let isFirstChunk = true;
  let dataLines: string[] = [];
  let eventType = "";
  let lastId = "";
  let overflowed = false;

  const dispatch = () => {
    if (!dataLines.length) {
      // Per spec, an event without `data:` is discarded.
      eventType = "";
      return;
    }
    const event: ParsedEvent = {
      id: lastId,
      event: eventType,
      data: dataLines.join("\n"),
    };
    dataLines = [];
    eventType = "";
    options.onEvent?.(event);
  };

  const handleLine = (line: string) => {
    // An empty line terminates the current event.
    if (!line) {
      dispatch();
      return;
    }
    // Lines starting with a colon are comments (usually heartbeats); ignore them.
    if (line.startsWith(":")) {
      return;
    }
    const colonIndex = line.indexOf(":");
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    let value = colonIndex === -1 ? "" : line.slice(colonIndex + 1);
    // The spec allows exactly one leading space in the value.
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      case "event":
        eventType = value;
        break;
      case "id":
        if (!value.includes("\0")) {
          lastId = value;
        }
        break;
      case "retry":
        if (/^\d+$/.test(value)) {
          options.onRetry?.(Number(value));
        }
        break;
      default:
        break;
    }
  };

  return {
    get overflowed() {
      return overflowed;
    },
    feed(chunk: string) {
      if (!chunk || overflowed) {
        return;
      }
      // Strip a UTF-8 BOM from the first chunk.
      if (isFirstChunk) {
        isFirstChunk = false;
        buffer = chunk.charCodeAt(0) === 0xfeff ? chunk.slice(1) : chunk;
      } else {
        buffer += chunk;
      }

      for (;;) {
        const match = LINE_BREAK.exec(buffer);
        if (!match) {
          break;
        }
        // Wait for the next chunk when the buffer ends with a lone \r, so that
        // a split "\r\n" is not treated as two line breaks.
        if (match[0] === "\r" && match.index === buffer.length - 1) {
          break;
        }
        handleLine(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }

      // No line break for far too long means the payload is not valid SSE:
      // stop early instead of growing the buffer until the process dies.
      if (!overflowed && buffer.length > maxBufferSize) {
        overflowed = true;
        buffer = "";
        dataLines = [];
      }
    },
    reset() {
      buffer = "";
      dataLines = [];
      eventType = "";
      lastId = "";
      overflowed = false;
    },
  };
}
