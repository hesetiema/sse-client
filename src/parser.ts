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

/**
 * What to do when one message exceeds `maxBufferSize`:
 * - `close` (default): stop parsing, the client treats it as a terminal protocol error;
 * - `drop`: discard that message, count it in `dropped` and keep reading. The
 *   parser resynchronises on the next blank line, so a stream that never sends
 *   one cannot be resynced — it stays in drop mode and reports a single drop.
 */
export type OverflowPolicy = "close" | "drop";

export interface SSEParserOptions {
  onEvent?: (event: ParsedEvent) => void;
  /** Reconnect delay requested by the server through a `retry:` field, in milliseconds. */
  onRetry?: (delay: number) => void;
  /** Buffer cap in characters (default 1MB). Once exceeded, parsing stops and `overflowed` flips to true. */
  maxBufferSize?: number;
  /** Reaction to an oversized message, defaults to `"close"`. */
  overflowPolicy?: OverflowPolicy;
}

export interface SSEParser {
  /**
   * Feed decoded text. Chunks may split lines or fields arbitrarily; partial input is buffered.
   * `budget` caps the work of a single call: the parser stops after that many events and sets
   * `stalled`, so the caller can yield to the event loop and call `feed("")` to continue.
   */
  feed: (chunk: string, budget?: number) => void;
  /** Drop any partial line and per-connection `id`/`event` state (called before a reconnect). */
  reset: () => void;
  /** Whether the buffer cap was hit under the `close` policy (server never ends a line, or a message is huge). */
  readonly overflowed: boolean;
  /** Whether the last `feed` stopped on its budget with buffered input left. */
  readonly stalled: boolean;
  /** Oversized messages discarded so far; lifetime counter, not cleared by `reset()`. */
  readonly dropped: number;
}

const LINE_BREAK = /\r\n|\r|\n/;
/** A stream of blank lines dispatches nothing, so the budget also caps lines: 8x, same order of magnitude. */
const LINES_PER_EVENT = 8;

/**
 * Create an SSE frame parser (a subset of the WHATWG spec).
 *
 * Handles the `data` / `event` / `id` / `retry` fields, multi-line payloads,
 * comment lines (`: keep-alive` heartbeats), mixed CRLF/LF, and arbitrarily
 * chunked input.
 */
export function createSSEParser(options: SSEParserOptions = {}): SSEParser {
  const maxBufferSize = options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const overflowPolicy = options.overflowPolicy ?? "close";

  let buffer = "";
  let isFirstChunk = true;
  let dataLines: string[] = [];
  let dataSize = 0;
  let eventType = "";
  let lastId = "";
  let overflowed = false;
  let stalled = false;
  /** Inside an oversized event that must be discarded up to the next blank line. */
  let dropping = false;
  let dropped = 0;
  /** Events dispatched by the current `feed` call, for the budget check. */
  let eventsThisCall = 0;

  const resetEvent = () => {
    dataLines = [];
    dataSize = 0;
    eventType = "";
  };

  const dispatch = () => {
    if (dropping) {
      // The oversized event just ended; resume from the next event boundary.
      dropping = false;
      resetEvent();
      eventsThisCall += 1;
      return;
    }
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
    resetEvent();
    eventsThisCall += 1;
    options.onEvent?.(event);
  };

  /** A message exceeded the cap: either stop for good, or throw it away and resync. */
  const overflow = () => {
    if (overflowPolicy === "drop") {
      // Counted here rather than at the blank line: a stream that never sends one
      // would otherwise look clean while swallowing everything.
      dropped += 1;
      dropping = true;
      resetEvent();
      return;
    }
    overflowed = true;
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
    if (dropping) {
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
        dataSize += value.length + 1;
        // The per-line buffer check in feed() cannot see this: a server that
        // keeps sending data lines without ever terminating the event would
        // grow the payload without bound.
        if (dataSize > maxBufferSize) {
          dataLines = [];
          dataSize = 0;
          overflow();
        }
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
    get stalled() {
      return stalled;
    },
    get dropped() {
      return dropped;
    },
    feed(chunk: string, budget = 0) {
      if (overflowed) {
        return;
      }
      if (chunk) {
        // Strip a UTF-8 BOM from the first chunk.
        if (isFirstChunk) {
          isFirstChunk = false;
          buffer = chunk.charCodeAt(0) === 0xfeff ? chunk.slice(1) : chunk;
        } else {
          buffer += chunk;
        }
      } else if (!stalled) {
        // Nothing to continue with.
        return;
      }
      stalled = false;

      const eventLimit = budget > 0 ? budget : 0;
      const lineLimit = budget > 0 ? budget * LINES_PER_EVENT : 0;
      eventsThisCall = 0;
      let lines = 0;

      for (;;) {
        if (overflowed) {
          // Drop the rest of the chunk; the client tears the connection down.
          buffer = "";
          break;
        }
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
        lines += 1;
        // Stop on the budget and let the caller decide when to continue: this is
        // what keeps a 5000-event chunk from becoming one long blocking task.
        if (eventLimit && (eventsThisCall >= eventLimit || lines >= lineLimit)) {
          stalled = true;
          break;
        }
      }

      // No line break for far too long means the payload is not valid SSE:
      // stop early instead of growing the buffer until the process dies.
      if (!overflowed && buffer.length > maxBufferSize) {
        buffer = "";
        overflow();
      }
    },
    reset() {
      buffer = "";
      dataLines = [];
      dataSize = 0;
      eventType = "";
      lastId = "";
      overflowed = false;
      stalled = false;
      dropping = false;
      eventsThisCall = 0;
    },
  };
}
