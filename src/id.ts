/**
 * Whether an event id can be used as a resume point.
 *
 * The id takes a round trip the client does not control: it is written by the
 * server, sent back as a `Last-Event-ID` request header, and (when `persist` is
 * on) parked in `sessionStorage`. Every hop trims or rejects something:
 *
 * - `\r`, `\n`, `\0` cannot live inside a header value, so a proxy will either
 *   reject the request or truncate the id to its first line;
 * - leading and trailing whitespace is stripped by header parsing, so `" 42 "`
 *   comes back as `"42"` and no longer matches what the server minted;
 * - an empty id resets the resume cursor per the SSE spec, which is a command,
 *   not a position.
 *
 * Accepting such an id is worse than having none: the next connection asks the
 * server for a position it cannot match, and the run restarts from wherever the
 * server decides — with no gap reported, because nothing looked wrong.
 */
export function isValidEventId(id: string): boolean {
  if (id.length === 0) {
    return false;
  }
  if (id.includes("\0") || id.includes("\r") || id.includes("\n")) {
    return false;
  }
  // `trim` also covers tabs and exotic spaces, all of which a header hop may eat.
  return id === id.trim();
}
